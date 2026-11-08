import {readSqlProgram} from '@podjs/framework/sql-program';
import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,randomBytes,hkdfSync,createPublicKey,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonical} from '../../src/sync-v2/protocol';
import {WatchProjectionStore,type LocalCipher} from '../../src/sync-v2/store';
import {ProjectionGate} from '../../src/sync-v2/gate';
import type {IdentityCrypto} from '../../src/sync-v2/identity';
export const sharedRoot=process.env.WRSS_SYNCV2_SPEC_ROOT??resolve(import.meta.dir,'../../../.codex-tmp/cloud-v2/syncv2');
export const vector=(name:string)=>JSON.parse(readFileSync(sharedRoot+'/vectors/'+name+'.json','utf8'));
export const scope={repoId:'01'.repeat(16),libraryEpoch:'1',contentGeneration:'2'};
export const idKey=Uint8Array.from({length:32},()=>17),libraryId='aa'.repeat(16);
export const binding={schema:'frozen-v2-rc6',descriptorPin:vector('identity-bootstrap').descriptorOid??'repo-descriptor:sha256:'+'a'.repeat(64),accountScope:'synthetic',capability:'local-projection-v1'};
export const account=vector('rc6-contracts').window;
export const err=(fn:()=>unknown)=>{try{fn();return null;}catch(e){return (e as Error).message;}};
export const identityCrypto:IdentityCrypto={
 hkdf:async(k,s,i)=>new Uint8Array(hkdfSync('sha256',k,s,i,32)),
 decrypt:async(k,a,n,b)=>{const d=createDecipheriv('aes-256-gcm',k,n);d.setAAD(a);d.setAuthTag(b.subarray(-16));return new Uint8Array(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]));},
 verify:async(k,m,s)=>verify('sha256',m,{key:createPublicKey({key:Buffer.from(k),type:'spki',format:'der'}),dsaEncoding:'ieee-p1363'},s),
};
const localKey=Buffer.alloc(32,0x55);
export const cipher:LocalCipher={
 async nativeKey(){return {keyBase64:localKey.toString("base64"),aadJson:false};},
 async seal(aad,value){const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',localKey,nonce);c.setAAD(Buffer.from(aad));return JSON.stringify({nonceBase64:nonce.toString('base64'),ciphertextBase64:Buffer.concat([c.update(canonical(value),'utf8'),c.final(),c.getAuthTag()]).toString('base64')});},
 blocks:{
  async encrypt(aad,plain){const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',localKey,nonce);c.setAAD(aad);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]))};},
  async decrypt(aad,nonce,b){const d=createDecipheriv('aes-256-gcm',localKey,nonce);d.setAAD(aad);d.setAuthTag(b.subarray(-16));return new Uint8Array(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]));},
 },
 async open(aad,value){const v=JSON.parse(value),b=Buffer.from(v.ciphertextBase64??v.ciphertext,v.ciphertextBase64?'base64':'hex'),d=createDecipheriv('aes-256-gcm',localKey,Buffer.from(v.nonceBase64??v.nonce,v.nonceBase64?'base64':'hex'));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]).toString('utf8'));},
};
/** Product bounds of the Android background runtime (N1): one host request or
 * reply is at most 1 MiB of JSON; one crypto.aesGcm* input at most 256 KiB. */
export const PRODUCT_LIMITS={requestBytes:1024*1024,replyBytes:1024*1024,aesBytes:256*1024};
/** Host simulator for the PRODUCT local cipher (src/sync-v2/host.ts), with the
 * Android AES-GCM input bound and the 1 MiB request/reply bound enforced. */
export function productCipherHost(){
 const secrets=new Map<string,string>(),stats={aesCalls:0,maxAesBytes:0,maxRequestBytes:0};
 const limited=(b:Buffer)=>{if(b.length>PRODUCT_LIMITS.aesBytes)throw Error('chunk_too_large');stats.maxAesBytes=Math.max(stats.maxAesBytes,b.length);return b;};
 const host=async(method:string,args:any):Promise<any>=>{const size=JSON.stringify({method,args}).length;stats.maxRequestBytes=Math.max(stats.maxRequestBytes,size);if(size>PRODUCT_LIMITS.requestBytes)throw Error('request_too_large');
  const b=(k:string)=>limited(Buffer.from(args[k],'base64'));
  if(method==='secure.get')return secrets.get(args.key)??null;
  if(method==='secure.compareAndSet'){if((secrets.get(args.key)??null)!==args.expected)return {updated:false};secrets.set(args.key,args.value);return {updated:true};}
  if(method==='crypto.random')return {bytesBase64:randomBytes(args.bytes).toString('base64')};
  if(method==='crypto.aesGcmEncrypt'){stats.aesCalls++;const key=Buffer.from(args.keyBase64,'base64'),nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(b('aadBase64'));return {nonceBase64:nonce.toString('base64'),ciphertextBase64:Buffer.concat([c.update(b('dataBase64')),c.final(),c.getAuthTag()]).toString('base64')};}
  if(method==='crypto.aesGcmDecrypt'){stats.aesCalls++;const key=Buffer.from(args.keyBase64,'base64'),data=b('ciphertextBase64'),d=createDecipheriv('aes-256-gcm',key,b('nonceBase64'));d.setAAD(b('aadBase64'));d.setAuthTag(data.subarray(-16));const out=Buffer.concat([d.update(data.subarray(0,-16)),d.final()]).toString('base64');if(out.length>PRODUCT_LIMITS.replyBytes)throw Error('reply_too_large');return {dataBase64:out};}
  throw Error('permission_denied');
 };
 return {host,stats};
}
export class SqlFixture {
 readonly raw:Database;calls=0;maxRows=0;maxTxBytes=0;maxReplyBytes=0;sql:string[]=[];
 /** Cipher that opens SQL program pages; the product tests set the product cipher. */
 programCipher:LocalCipher=cipher;
 /** When set, requests and replies above the product bounds fail like the host. */
 limits:{requestBytes:number;replyBytes:number}|null=null;
 crashAt:number|null=null;afterCommit=false;
 constructor(path=':memory:',mode='DELETE'){this.raw=new Database(path);this.raw.exec('PRAGMA journal_mode='+mode);this.raw.exec('PRAGMA synchronous=FULL');}
 async query(q:string,p:readonly unknown[]=[]):Promise<Record<string,unknown>[]>{this.calls++;this.sql.push(q);if(this.limits&&JSON.stringify({sql:q,params:p}).length>this.limits.requestBytes)throw Error('request_too_large');const rows=this.raw.query(q).all(...p as any[]) as Record<string,unknown>[];this.maxRows=Math.max(this.maxRows,rows.length);if(this.limits){const n=JSON.stringify(rows).length;this.maxReplyBytes=Math.max(this.maxReplyBytes,n);if(n>this.limits.replyBytes)throw Error('reply_too_large');}return rows;}
 async execute(q:string,p:readonly unknown[]=[]){await this.transaction([{sql:q,params:p}]);}
 async transaction(statements:{sql:string;params?:readonly unknown[]}[]){this.calls++;const txBytes=JSON.stringify(statements).length;this.maxTxBytes=Math.max(this.maxTxBytes,txBytes);if(this.limits&&txBytes>this.limits.requestBytes)throw Error('request_too_large');this.raw.exec('BEGIN IMMEDIATE');try{let i=0;for(const s of statements){if(this.crashAt===i++)throw Error('injected_crash');this.sql.push(s.sql);if((s as any).program){for await(const op of readSqlProgram(this,this.programCipher,(s as any).program))this.raw.query(op.sql).run(...(op.params??[]) as any[]);}else this.raw.query(s.sql).run(...(s.params??[]) as any[]);}if(this.crashAt===i)throw Error('injected_crash');this.raw.exec((statements as any[]).some(s=>s.program?.validateOnly)?'ROLLBACK':'COMMIT');}catch(e){this.raw.exec('ROLLBACK');throw e;}if(this.afterCommit)throw Error('injected_after_commit');}
 store(enabled=true){return new WatchProjectionStore(this,cipher,new ProjectionGate(enabled),scope,libraryId,idKey);}
 close(){this.raw.close();}
}
export const noteValue=(id='n')=>({noteId:id,folderId:null,title:'title '+id,markdown:'local\ntext',plainText:'local text',contentHash:'h',baseContentHash:'base-h',baseMarkdown:'ancestor',pinned:false,createdAt:1,updatedAt:2,modifiedBy:'watch',deleted:false,deletedAt:0});

/** Test boundary seed: a fully authenticated legacy-compatible state version.
 * Product callers always use the authoritative journal/state CAS. */
export async function fixtureStateVersion(db:SqlFixture,version:string){const state=await db.store().readState();state.stateVersion=version;return {sql:'UPDATE syncv2_state SET state_version=?,body=? WHERE scope=?',params:[version,await cipher.seal(canonical({domain:'wrss.sync.v2/local-projection',version:2,scope,libraryId,purpose:'state',id:''}),state),canonical(scope)]};}
