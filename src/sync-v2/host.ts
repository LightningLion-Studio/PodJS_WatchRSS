import {materializeSqlPrograms} from '@podjs/framework/sql-program';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import type {CloudHostRequest} from '../cloud/host-ports';
import {canonical,jsonBytes,parseCanonicalJson,digest} from './protocol';
import {CHUNKED_AEAD_BLOCK_BYTES,hostAesGcmPort,sealChunked,openChunked,isChunkedEnvelope} from '@podjs/framework/chunked-aead';
import type {LocalCipher} from './store';
/** Largest plaintext of one sealed local value (one storage row). */
export const LOCAL_SEAL_LIMIT=768*1024;
/** Reuses the approved host's AES-GCM API for LOCAL storage only. Its generated
 * nonce is outside AAD; this is never the v2 sealed-object wire operation. */
export function localProjectionCipher(host:CloudHostRequest,accountScope:string):LocalCipher {
 const keyName='watchrss.syncv2.local-key.'+digest(accountScope);
 let pending:Promise<string>|undefined;
 const key=(create:boolean)=>pending??=(async()=>{
  const found=await host<string|null>('secure.get',{key:keyName});if(found){if(decodeBase64(found).length!==32)throw Error('invalid_local_key');return found;}
  // Reading an existing ciphertext must never bootstrap a replacement key.
  if(!create)throw Error('local_key_not_persisted');
  const fresh=(await host<{bytesBase64:string}>('crypto.random',{bytes:32})).bytesBase64;
  if(decodeBase64(fresh).length!==32)throw Error('invalid_local_key');
  const result=await host<{updated:boolean}>('secure.compareAndSet',{key:keyName,expected:null,value:fresh});
  if(result.updated)return fresh;const winner=await host<string|null>('secure.get',{key:keyName});if(!winner||decodeBase64(winner).length!==32)throw Error('local_key_not_persisted');return winner;
 })().catch(error=>{pending=undefined;throw error;});
 // N1: one host AES-GCM call takes at most 256 KiB. Values above one block use
 // the framework chunked AEAD; smaller values keep the original single-call form.
 const blocks=hostAesGcmPort(host as any,async()=>key(true)),reader=hostAesGcmPort(host as any,async()=>key(false));
 return {
  blocks,
  async nativeKey(){return {keyBase64:await key(false),aadJson:true};},
  async seal(aad,value){const input=jsonBytes(value);if(input.length>LOCAL_SEAL_LIMIT)throw Error('object_too_large');if(input.length>CHUNKED_AEAD_BLOCK_BYTES)return sealChunked(blocks,jsonBytes(aad),input);const out=await host<{nonceBase64:string;ciphertextBase64:string}>('crypto.aesGcmEncrypt',{keyBase64:await key(true),aadBase64:encodeBase64(jsonBytes(aad)),dataBase64:encodeBase64(input)});return canonical(out);},
  async open(aad,sealed){if(isChunkedEnvelope(sealed))return parseCanonicalJson(await openChunked(reader,jsonBytes(aad),sealed,LOCAL_SEAL_LIMIT));const value=JSON.parse(sealed),out=await host<{dataBase64:string}>('crypto.aesGcmDecrypt',{keyBase64:await key(false),aadBase64:encodeBase64(jsonBytes(aad)),nonceBase64:value.nonceBase64,ciphertextBase64:value.ciphertextBase64});return parseCanonicalJson(decodeBase64(out.dataBase64));},
 };
}
export function projectionSql(host:CloudHostRequest){return {
 query:(sql:string,params:readonly unknown[]=[])=>host<Record<string,unknown>[]>('sql.query',{sql,params}),
 transaction:async(statements:{sql:string;params?:readonly unknown[]}[])=>{await host('sql.transaction',{statements:await materializeSqlPrograms(statements),mode:'immediate',...((statements as any[]).some(s=>s.program?.validateOnly)?{validateOnly:true}:{})});},
 };}
