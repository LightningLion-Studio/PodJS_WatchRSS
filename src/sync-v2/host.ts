import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import type {CloudHostRequest} from '../cloud/host-ports';
import {canonical,jsonBytes,parseCanonicalJson,digest} from './protocol';
import type {LocalCipher} from './store';
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
 return {
  async seal(aad,value){const input=jsonBytes(value);if(input.length>768*1024)throw Error('object_too_large');const out=await host<{nonceBase64:string;ciphertextBase64:string}>('crypto.aesGcmEncrypt',{keyBase64:await key(true),aadBase64:encodeBase64(jsonBytes(aad)),dataBase64:encodeBase64(input)});return canonical(out);},
  async open(aad,sealed){const value=JSON.parse(sealed),out=await host<{dataBase64:string}>('crypto.aesGcmDecrypt',{keyBase64:await key(false),aadBase64:encodeBase64(jsonBytes(aad)),nonceBase64:value.nonceBase64,ciphertextBase64:value.ciphertextBase64});return parseCanonicalJson(decodeBase64(out.dataBase64));},
 };
}
export function projectionSql(host:CloudHostRequest){return {
 query:(sql:string,params:readonly unknown[]=[])=>host<Record<string,unknown>[]>('sql.query',{sql,params}),
 transaction:async(statements:{sql:string;params?:readonly unknown[]}[])=>{await host('sql.transaction',{statements,mode:'immediate'});},
 };}
