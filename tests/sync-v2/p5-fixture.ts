import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';
import {scope,idKey,SqlFixture,binding,noteValue,cipher} from './fixture';
import {FileHost} from './p3-fixture';
import {recoveryCipher} from './p3b-fixture';
import {WatchProjectionStore} from '../../src/sync-v2/store';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {WatchRecovery} from '../../src/sync-v2/recovery';
import {WatchSpaceStore} from '../../src/sync-v2/space-store';
import {WatchAccountControl} from '../../src/sync-v2/account-control';
import {WatchAccountBusinessSql} from '../../src/sync-v2/account-business';
import {SyncV2Http,parseNetwork} from '../../src/sync-v2/http';
import {canonical,jsonBytes,parseCanonicalJson,entityKey,nextD64} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {fromWire} from '../../src/sync-v2/business';
import {initializeMemoSchema} from '../../src/notes/repository';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {watchMaterializer} from '../../src/sync-v2/materializer';
export const keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1};
export const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
export class P5Backend extends SyntheticIndexBackend {
 history=new Map<string,{retiredAtMillis:number;expiresAtMillis:number}>();clock=100;restore=true;choiceCalls=0;acks:any[]=[];onChoice?:(()=>Promise<void>);onAck?:(()=>Promise<void>);loseChoice=false;
 async request(r:any):Promise<any>{const u=new URL(r.url),path=decodeURIComponent(u.pathname.replace('/functions/v1/sync/v2','')),body=r.body&&r.headers['Content-Type']!=='application/octet-stream'?parseNetwork(r.body):undefined;
  const json=(x:any)=>({status:200,headers:{},body:jsonBytes({version:2,scope,...x})}),error=(code:string)=>({status:code==='snapshot_expired'?410:409,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
  if(path==='/history'){return json({items:[...this.history].map(([commitOid,v])=>({commitOid,...v,authorDeviceId:'a'.repeat(32)})),pageToken:null});}
  if(path==='/history/prepare'){if(!this.restore)return error('feature_disabled');const h=this.history.get(body.targetCommitOid);if(!h||h.expiresAtMillis<=this.clock)return error('snapshot_expired');if(body.expectedAccountRevision!==this.account.revision||body.expectedRollbackGeneration!==this.account.rollbackGeneration)return error('choice_stale');const target=parseCanonicalJson(this.objects.get(body.targetCommitOid)!);const response={version:2,scope,targetCommitOid:body.targetCommitOid,treeRoot:target.body.treeRoot,leaseId:'a'.repeat(32),expiresAtMillis:this.clock+600000};this.requests.set(body.requestId,response);return json(response);}
  if(path==='/choices/cloud'){this.choiceCalls++;await this.onChoice?.();if(body.expectedAccountRevision!==this.account.revision||body.expectedRollbackGeneration!==this.account.rollbackGeneration)return error('choice_stale');const response={version:2,scope,choiceId:body.choiceId,account:{...this.account},confirmedAccount:{...this.account},auditRevision:this.serverRevision};this.requests.set(body.requestId,response);if(this.loseChoice){this.loseChoice=false;throw Error('choice_response_lost');}return json(response);}
  if(path==='/acks/applied'){await this.onAck?.();this.acks.push(body);const response={version:2,scope,accepted:true,serverRevision:this.serverRevision};this.requests.set(body.requestId,response);return json(response);}
  if(path==='/account')return json(this.window());
  const old={...this.account},response=await super.request(r);
  if(path==='/capabilities'){const v=parseNetwork(response.body);v.flags.historyRestore=this.restore;return {...response,body:jsonBytes(v)};}
  if(path==='/account/publish'&&response.status===200&&old.commitOid&&old.commitOid!==this.account.commitOid)this.history.set(old.commitOid,{retiredAtMillis:this.clock,expiresAtMillis:this.clock+604800000});return response;
 }
}
export async function p5Fixture(options:{root?:string}={}){
 const root=options.root??mkdtempSync(join(tmpdir(),'wrss-p5-')),db=new SqlFixture(join(root,'state.sqlite')),server=new P5Backend();await initializeMemoSchema(db as any);
 const value=noteValue('n');db.raw.query('INSERT OR IGNORE INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('n',null,value.title,value.markdown,value.plainText,value.contentHash,value.baseContentHash,value.baseMarkdown,0,1,2,'watch',0,0);
 const projection=db.store(),cache=new WatchSpaceStore(db,cipher,new ContentFiles(new FileHost(join(root,'files')).request),'6'.repeat(64));await cache.init();
 const recovery=new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=>randomBytes(16).toString('hex'),trustedNow:()=>server.clock,source:async refs=>{if(refs.length)throw Error('closure_incomplete');return [];},reserve:async()=>async()=>{}});
 let reserveFails=false,prepares=0;const native=new WatchAccountBusinessSql(db,projection,scope,idKey,{recoveryValue:async id=>{const c=await projection.readCandidate(id);return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},async row=>{if(row.bodyRevision!==null)throw Error('closure_incomplete');},async()=>{if(reserveFails)throw Error('quota_exceeded');return async()=>{};});await native.initialize();await projection.initialize();
 const source=await SqlBusinessSource.open(db,watchMaterializer(db,{cloudRestoreMetadata:async()=>{throw Error('no article body');}} as any)),http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,true,true),publisher=new WatchIndexPublisher(projection,http,crypto,keys,()=>server.clock),reader=new WatchCloudIndex(projection,http,crypto,keys,approved,async()=>{},()=>server.clock);
 const business={prepare:async(...args:Parameters<typeof native.prepare>)=>{prepares++;return native.prepare(...args);},recoveryValue:(id:string)=>native.recoveryValue(id),verifyBody:native.verifyBody,reserve:native.reserve},make=(gate=true)=>new WatchAccountControl({store:projection,http,publisher,reader,crypto,approved,business,recovery,trustedNow:()=>server.clock,historyRestore:gate,choiceApply:gate,author:async()=>({deviceId:'a'.repeat(32),alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision}})});
 async function scan(){const cp=await projection.checkpoint();if(!cp)await projection.beginScan(binding);else if(cp.phase==='complete')await projection.beginTailWindow();for(;;){const cp=await projection.checkpoint();if(cp?.phase==='complete')break;if(cp?.phase==='tail')await projection.catchUpPage(source);else await projection.scanPage(source);}}
 async function publish(){await scan();await publisher.prepare('a'.repeat(32),'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));const result=await publisher.flush();await reader.pull(server.window());return result;}
 async function edit(title:string){await db.execute('UPDATE memo_notes SET title=?,updated_at=updated_at+1 WHERE note_id=?',[title,'n']);await scan();}
 const control=make();return {root,db,server,projection,cache,recovery,native,reader,publisher,http,source,control,make,publish,edit,scan,get prepares(){return prepares;},set reserveFails(v:boolean){reserveFails=v;},close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
export async function dirtyRollback(f:Awaited<ReturnType<typeof p5Fixture>>,edit?:()=>Promise<void>){const first=await f.publish();await f.edit('before rollback');await f.publish();if(edit)await edit();else await f.edit('offline edit');
 // A second device's explicit rollback is a valid new signed account commit.
 const signed=parseCanonicalJson(f.server.objects.get(f.server.account.commitOid)!),target=parseCanonicalJson(f.server.objects.get(first.account.commitOid)!);const {signCommit}=await import('../../src/sync-v2/signing'),commit=await signCommit(crypto,'key',{...signed.body,deviceSequence:nextD64(signed.body.deviceSequence),previousOwnCommit:f.server.device.commitOid,accountParent:f.server.account.commitOid,rollbackGeneration:'1',treeRoot:target.body.treeRoot,mergedParents:[first.account.commitOid],operation:{kind:'rollback',rollbackTarget:first.account.commitOid,resolvesGeneration:null}});
 f.server.objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));f.server.account={commitOid:commit.oid,revision:nextD64(f.server.account.revision),rollbackGeneration:'1'};f.server.device={...f.server.device,commitOid:commit.oid,revision:nextD64(f.server.device.revision)};f.server.serverRevision=nextD64(f.server.serverRevision);await f.reader.pull(f.server.window());return first;
}
