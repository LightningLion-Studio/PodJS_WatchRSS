import {SqlFixture,vector,productCipherHost,noteValue} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serviceInfo} from './p2-fixture';
import {initializeMemoSchema} from '../../src/notes/repository';
import {jsonBytes,bytes,parseCanonicalJson,canonical} from '../../src/sync-v2/protocol';
import {unhex,sha256Hex} from '@podjs/framework/crypto';
import {descriptorOid} from '../../src/sync-v2/identity';
import {signControl} from '../../src/sync-v2/signing';
import {TrustedClock} from '../../src/sync-v2/trusted-time';
export const f=vector('identity-bootstrap'),scope=f.context.scope,legacy='00000000-0000-0000-0000-000000000002';
const user=f.context.accountId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
export const account={userId:user,backendBaseUrl:'http://127.0.0.1:18991',watchDeviceToken:'synthetic-only'};
export class ProductBackend extends SyntheticIndexBackend {
 applied:any[]=[];onApplied?:()=>Promise<void>;
 present=true;devices=new Map<string,any>();registrations:any[]=[];publishedBodies:string[]=[];failBeforePublishOnce=false;
 override window():any{const w:any=super.window();w.refs=[...this.devices.values()].filter(d=>d.commitOid).map(d=>({deviceId:d.ref.split('/')[2],commitOid:d.commitOid,refRevision:d.revision})).sort((a,b)=>a.deviceId.localeCompare(b.deviceId));return w;}
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2','')),json=(v:any)=>({status:200,headers:{},body:jsonBytes({version:2,scope,...v})});
  if(path==='/acks/applied'){await this.onApplied?.();this.applied.push(parseCanonicalJson(r.body));return json({accepted:true});}
  if(path==='/repo/descriptor')return this.present?json({descriptorOid:descriptorOid(f.descriptor),descriptor:f.descriptor,recoveryOid:'id-key-recovery:sha256:'+sha256Hex(jsonBytes(f.capsule))}):{status:404,headers:{},body:jsonBytes({error:{code:'object_missing'}})};
  if(path.startsWith('/repo/id-key-recovery/'))return {status:200,headers:{},body:jsonBytes(f.capsule)};
  if(path==='/checkpoint'){const w=this.window(),cp=await signControl(crypto,'','wrss.sync.v2/checkpoint-sign',{scope,checkpointId:'c'.repeat(32),serverRevision:this.serverRevision,refs:w.refs,account:this.account,historyFloorRevision:'0',historyFloorMillis:0,windowId:w.windowId,issuedAtMillis:100,expiresAtMillis:300000});return json(cp);}
  if(path==='/devices/signing-key'){const v=parseCanonicalJson(r.body);this.registrations=this.registrations.filter(x=>x.body.deviceId!==v.body.deviceId);this.registrations.push(v);return json({deviceId:v.body.deviceId,keyId:v.body.keyId,registered:true});}
  if(path==='/devices/signing-keys'){const bindings=[];for(const v of [...this.registrations].sort((a,b)=>(a.body.deviceId+a.body.keyId).localeCompare(b.body.deviceId+b.body.keyId)))bindings.push({...v,deviceMapping:await signControl(crypto,'','wrss.sync.v2/device-mapping',{scope,deviceId:v.body.deviceId,keyId:v.body.keyId,legacyDeviceId:legacy,approvalRevision:'0'})});return json({bindings,revocationRevision:'0'});}
  if(path==='/account/publish'){const ref=parseCanonicalJson(r.body).device.body.ref;this.device=this.devices.get(ref)??{ref,commitOid:null,revision:'0'};this.publishedBodies.push(Buffer.from(r.body).toString('base64'));if(this.failBeforePublishOnce){this.failBeforePublishOnce=false;throw Error('synthetic_request_lost');}}
  const result=await super.request(r);if(path==='/account/publish'&&result.status===200)this.devices.set(this.device.ref,{...this.device});
  if(path==='/state-refs'){const v=parseCanonicalJson(r.body),t=this.tables.get(v.body.stateOid),registered=this.registrations[0];Object.assign(t,{authorDeviceId:registered.body.deviceId,keyId:registered.body.keyId});}
  return result;
 }
}
export async function fixture(optionsDb:{path?:string;mode?:string}={}){
 const db=new SqlFixture(optionsDb.path,optionsDb.mode),secrets=new Map<string,string>(),local=productCipherHost();await initializeSchema(db as any);await new SyncSavedStateStore(db as any).initializeDevice(legacy);await initializeMemoSchema(db);const n=noteValue();await db.execute('INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[n.noteId,null,n.title,n.markdown,n.plainText,n.contentHash,n.baseContentHash,n.baseMarkdown,0,n.createdAt,n.updatedAt,n.modifiedBy,0,0]);
 const raw=(s:string)=>Buffer.from(s,'base64'),out=(b:Uint8Array)=>Buffer.from(b).toString('base64');
 const host:any=async(method:string,a:any)=>{
  if(method==='secure.get'){const value=secrets.get(a.key);return value===undefined?{exists:false}:{exists:true,value,totalChars:value.length,offset:0,version:1};}
  if(method==='secure.compareAndSet'){if((secrets.get(a.key)??null)!==a.expected)return {updated:false};secrets.set(a.key,a.value);return {updated:true};}
  if(method==='sql.query')return db.query(a.sql,a.params);
  if(method==='sql.transaction'){db.programCipher=localProjectionCipher(async(method,args)=>method==='secure.get'?readCloudSecure(host,String(args.key)):host(method,args),canonical([options.account.backendBaseUrl,options.account.userId]));return db.transaction(a.statements);}
  if(method==='crypto.v2.signingKey')return {publicKeySec1:out(publicBytes)};
  if(method==='crypto.v2.sign')return {signatureBase64:out(await crypto.sign('',raw(a.dataBase64)))};
  if(method==='crypto.v2.verify')return {valid:await crypto.verify(raw(a.publicKeySec1),raw(a.dataBase64),raw(a.signatureBase64))};
  if(method==='crypto.hkdfSha256')return {keyBase64:out(await crypto.hkdf(raw(a.inputBase64),raw(a.saltBase64),raw(a.infoBase64)))};
  if(method==='crypto.v2.encrypt')return {ciphertextBase64:out(await crypto.encrypt(raw(a.keyBase64),raw(a.nonceBase64),raw(a.dataBase64),raw(a.aadBase64)))};
  if(method==='runtime.delay')return {};
  if(method==='file.stat')return {usableBytes:512*1024*1024};
  return local.host(method,a);
 };
 const server=new ProductBackend(),options={host,transport:server,account,legacyDeviceId:legacy,allowLoopback:true,keys:{currentKeyVersion:async()=>f.descriptor.body.wrappingKeyVersion,accountKey:async()=>unhex(f.wrapKeyHex)},repository:new SqlLibrarySessionRepository(db as any,{codec,text,uri:{parseUri:text.parseUri,parseAndroid:text.parseUri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:()=>100}),session:async()=>account,bootstrap:async()=>({accountId:f.context.accountId,syncV2:serviceInfo,devices:[{deviceId:legacy,revokedAt:null}]}),now:()=>100,clock:new TrustedClock(()=>100)};
 db.programCipher=localProjectionCipher(async(method,a)=>method==='secure.get'?readCloudSecure(host,String(a.key)):host(method,a),canonical([account.backendBaseUrl,account.userId]));
 return {db,secrets,server,options};
}

import {initializeSchema} from '../../src/core/schema';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {gzipSync,gunzipSync} from 'node:zlib';
const codec={sha256:async(b:Uint8Array)=>sha256Hex(b),encode:async(b:any)=>gzipSync(encodeBodyJson(b)),decode:async(b:Uint8Array)=>gunzipSync(b).toString()};
const text={parseUri:async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async(s:string)=>s};

import {SyncSavedStateStore} from '../../src/sync/saved-state';

import {localProjectionCipher} from '../../src/sync-v2/host';
import {readCloudSecure} from '../../src/cloud/secure-read';
import {encodeBodyJson} from '../../src/sync/article-body';
