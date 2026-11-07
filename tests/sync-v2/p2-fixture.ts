import {expect} from 'bun:test';
import {createCipheriv,createDecipheriv,createPublicKey,createPrivateKey,generateKeyPairSync,hkdfSync,randomBytes,sign,verify} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {hex,unhex,lengthPrefixFields} from '@podjs/framework/crypto';
import {createSyncV2Crypto} from '@podjs/framework/crypto';
import {vector,scope,idKey,SqlFixture,binding,noteValue,cipher,libraryId} from './fixture';
import {canonical,jsonBytes,bytes,parseCanonicalJson,nextD64,entityKey,digest} from '../../src/sync-v2/protocol';
import {b64,unb64,indexRow,commitBody} from '../../src/sync-v2/wire';
import {sealV2,openV2,objectOid,type EnvelopeCrypto} from '../../src/sync-v2/sealed';
import {verifyCommit,lowSignature,accountIdFromUserId,signingAlias,signedMessage,type SigningPort} from '../../src/sync-v2/signing';
import {authenticatePath} from '../../src/sync-v2/head-pins';
import {buildTree,readTree} from '../../src/sync-v2/merkle';
import * as notes from '../../src/sync-v2/notes-conflict';
import {WatchServiceKeyPin,SERVICE_KEY_CHANGED} from '../../src/sync-v2/service-key';
import {SyncV2Http,parseNetwork,P2_CLOSED_GATES} from '../../src/sync-v2/http';
import {watchMaterializer} from '../../src/sync-v2/materializer';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {observeAccount} from '../../src/sync-v2/state';
import {candidates,fromWire} from '../../src/sync-v2/business';
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
export const publicBytes=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]);
function pub(sec:Uint8Array){return createPublicKey({key:{kty:'EC',crv:'P-256',x:b64(sec.subarray(1,33)),y:b64(sec.subarray(33))},format:'jwk'});}
function low(raw:Uint8Array){const n=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),s=BigInt('0x'+hex(raw.subarray(32)));return Buffer.concat([raw.subarray(0,32),Buffer.from((s>n/2n?n-s:s).toString(16).padStart(64,'0'),'hex')]);}
export const crypto:EnvelopeCrypto&SigningPort={
 async random(n){return randomBytes(n);},async hkdf(k,s,i){return new Uint8Array(hkdfSync('sha256',k,s,i,32));},
 async encrypt(k,n,input,aad){const c=createCipheriv('aes-256-gcm',k,n);c.setAAD(aad);return Buffer.concat([c.update(input),c.final(),c.getAuthTag()]);},
 async decrypt(k,n,input,aad){const d=createDecipheriv('aes-256-gcm',k,n);d.setAAD(aad);d.setAuthTag(input.subarray(-16));return Buffer.concat([d.update(input.subarray(0,-16)),d.final()]);},
 async gunzip(input,n){const out=gunzipSync(input);if(out.length!==n)throw Error('invalid_encoding');return out;},
 async signingKey(){return publicBytes;},async sign(_,input){return low(sign('sha256',input,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}));},async verify(key,input,sig){return verify('sha256',input,{key:pub(key),dsaEncoding:'ieee-p1363'},sig);},
};
export const serviceInfo={receiptKeyId:'e'.repeat(32),receiptSigningPublicKey:b64(new Uint8Array(pair.publicKey.export({format:'der',type:'spki'}))),algorithm:'ES256' as const};
export function serverPin(){const values=new Map<string,string>();return new WatchServiceKeyPin({get:async k=>values.get(k),compareAndSet:async(k,old,value)=>{if((values.get(k)??null)!==old)return false;values.set(k,value);return true;}},'0'.repeat(31)+'1',async()=>({accountId:'0'.repeat(31)+'1',syncV2:serviceInfo}));}
export class SyntheticIndexBackend {
 objects=new Map<string,Uint8Array>();partials=new Map<string,Uint8Array>();totals=new Map<string,number>();tables=new Map<string,any>();requests=new Map<string,any>();
 account:any={commitOid:null,revision:'0',rollbackGeneration:'0'};device:any={ref:'refs/devices/'+'a'.repeat(32)+'/index',commitOid:null,revision:'0'};serverRevision='9007199254740992';events=0;losePublish=false;busy=false;calls:Record<string,number>={};
 async receipt(id:string,total:number,offset:number){return {body:{version:2,scope,oid:id,totalBytes:total,durableOffset:offset,storeId:'f'.repeat(32),receiptRevision:'9007199254740993',createdAtMillis:100,expiresAtMillis:600000},signature:''} as any;}
 async signedReceipt(id:string,total:number,offset:number){const r=await this.receipt(id,total,offset);r.signature=b64(await crypto.sign('',signedMessage('wrss.sync.v2/object-receipt-sign',r.body)));return r;}
 window(){return {version:2,scope,windowId:'1'.repeat(32),expiresAtMillis:300000,serverRevision:this.serverRevision,refs:[],account:{...this.account},historyFloorRevision:'0',checkpointOid:null,pageToken:null};}
 async request(r:any):Promise<any>{
  const url=new URL(r.url),path=decodeURIComponent(url.pathname.replace('/functions/v1/sync/v2',''));this.calls[path]=(this.calls[path]??0)+1;const json=(x:any,status=200)=>({status,headers:{},body:jsonBytes({version:2,scope,...x})}),error=(code:string)=>({status:409,headers:{},body:jsonBytes({error:{code,retryable:true,retryAfterMillis:null,details:{}}})});
  const body=r.body&&r.headers['Content-Type']!=='application/octet-stream'?parseNetwork(r.body):undefined;
  if(path==='/capabilities')return json({minVersion:2,maxVersion:2,features:[],maxPartBytes:65536,historyDays:7,receiptKeyId:serviceInfo.receiptKeyId,receiptSigningPublicKey:serviceInfo.receiptSigningPublicKey,flags:{read:true,indexWrite:true,contentWrite:false,relay:false,gc:false,historyRestore:false}});
  if(path==='/negotiate')return json(this.window());
  if(path.startsWith('/requests/'))return json(this.requests.has(path.slice(10))?{status:'succeeded',response:this.requests.get(path.slice(10))}:{status:'unknown',response:null});
  if(path==='/objects/have-want'){const objects=[];for(const id of body.oids){const raw=this.objects.get(id),part=this.partials.get(id);objects.push(raw?{oid:id,status:'present',totalBytes:raw.length,durableOffset:raw.length,receipt:await this.signedReceipt(id,raw.length,raw.length)}:part?{oid:id,status:'partial',totalBytes:this.totals.get(id),durableOffset:part.length,receipt:await this.signedReceipt(id,this.totals.get(id)!,part.length)}:{oid:id,status:'missing',totalBytes:null,durableOffset:0,receipt:null});}return json({windowId:body.windowId,objects});}
  if(path==='/objects/reserve'){for(const o of body.objects)this.totals.set(o.oid,o.totalBytes);return json({reservationId:'2'.repeat(32),expiresAtMillis:600000,objects:body.objects.map((o:any)=>({...o,durableOffset:this.partials.get(o.oid)?.length??0})),reservedBytes:body.objects.reduce((n:number,o:any)=>n+o.totalBytes,0)});}
  if(path==='/objects/batch-get'){const objects=[],nextOids:string[]=[];for(const oid of body.oids){const raw=this.objects.get(oid);if(!raw)return error('object_missing');const item={oid,bytes:b64(raw)};if(jsonBytes({version:2,scope,objects:[...objects,item],nextOids}).length>262144)nextOids.push(oid);else objects.push(item);}return json({objects,nextOids});}
  const part=path.match(/^\/objects\/(.+)\/parts\/(\d+)$/);if(part){const id=part[1]!,offset=Number(part[2]),old=this.partials.get(id)??new Uint8Array();expect(offset).toBe(old.length);const raw=new Uint8Array(old.length+r.body.length);raw.set(old);raw.set(r.body,old.length);this.partials.set(id,raw);return json({oid:id,durableOffset:raw.length,receipt:await this.signedReceipt(id,this.totals.get(id)!,raw.length)});}
  const complete=path.match(/^\/objects\/(.+)\/complete$/);if(complete){const id=complete[1]!,raw=this.partials.get(id)!;expect(raw.length).toBe(body.totalBytes);if(id.startsWith('commit:'))expect(objectOid('commit',jsonBytes(parseCanonicalJson(raw).body))).toBe(id);else expect(objectOid(id.split(':')[0]!,raw)).toBe(id);this.objects.set(id,raw);return json({oid:id,receipt:await this.signedReceipt(id,raw.length,raw.length)});}
  if(path==='/state-refs'){const raw=jsonBytes(body),id=objectOid('state-refs',raw);this.objects.set(id,raw);const table={parentOid:body.body.stateOid,refsOid:id,authorDeviceId:'a'.repeat(32),keyId:'b'.repeat(32),totalBytes:raw.length};this.tables.set(body.body.stateOid,table);return json({...table,accepted:true});}
  if(path==='/account/publish'){
   if(this.busy)return error('cloud_account_busy');const id=body.account.body.newCommitOid,value=parseCanonicalJson(this.objects.get(id)!);await verifyCommit(crypto,b64(publicBytes),value,id,scope);for(const update of [body.account,body.device])expect(await crypto.verify(publicBytes,signedMessage('wrss.sync.v2/ref-update-sign',update.body),unb64(update.signature))).toBe(true);
   if(this.account.commitOid!==body.account.body.expectedOid||this.account.revision!==body.account.body.expectedRevision)return error('ref_conflict');
   const rows=await readTree(scope,value.body.treeRoot,async id=>this.objects.get(id)!);for(const row of rows){expect(this.objects.has(row.metaOid)).toBe(true);expect(this.objects.has(row.stateOid)).toBe(true);expect(this.tables.has(row.stateOid)).toBe(true);}
   this.account={commitOid:id,revision:nextD64(this.account.revision),rollbackGeneration:value.body.rollbackGeneration};this.device={ref:body.device.body.ref,commitOid:id,revision:nextD64(this.device.revision)};this.serverRevision=nextD64(this.serverRevision);this.events++;const result={version:2,scope,account:this.account,device:this.device,serverRevision:this.serverRevision};this.requests.set(body.account.body.requestId,result);if(this.losePublish){this.losePublish=false;throw Error('synthetic_response_lost');}return json(result);
  }
  if(path.startsWith('/state-refs/'))return json(this.tables.get(path.slice(12)));
  if(path==='/account/ancestry'){const head=url.searchParams.get('head')!,stop=url.searchParams.get('stop')==='null'?null:url.searchParams.get('stop'),headers:any[]=[];let next:string|null=head;for(let i=0;i<64&&next!==null&&next!==stop;i++){const envelope=parseCanonicalJson(this.objects.get(next)!);headers.push({commitOid:next,headerOid:objectOid('commit-header',jsonBytes(envelope)),...envelope});next=envelope.body.accountParent;}return json({head,stop,headers,nextOid:next,complete:next===stop});}
  if(path.startsWith('/objects/')){const id=path.slice(9),raw=this.objects.get(id);return raw?{status:200,headers:{ETag:id,'Content-Length':String(raw.length)},body:raw}:error('object_missing');}
  throw Error('unexpected synthetic route '+path);
 }
}
export async function publishingFixture(server:SyntheticIndexBackend){
 const db=new SqlFixture(),store=db.store();await store.initialize();await store.beginScan(binding);let done=false;await store.scanPage({page:async()=>({rows:done?[]:[{kind:'article',logicalId:'article-private',value:{articleId:'article-private',url:'https://private.invalid/article',title:'private title'},addedAtMillis:50}],after:'done',done:true}),changed:async()=>[]});
 const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin());const {WatchIndexPublisher}=await import('../../src/sync-v2/publisher');return {db,store,http,publisher:new WatchIndexPublisher(store,http,crypto,{id:idKey,content:Buffer.alloc(32,0x22),version:1},()=>100)};
}
