/** Correct-behavior regressions from T-REVIEW-PODJS-NOTES-r3's four known-reference
 * probes. Only fixtures and memory transport are used; no external evidence IO. */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {crypto as signer,publicBytes,serverPin} from './p2-fixture';
import {P5Backend} from './p5-fixture';
import {scope,idKey,binding,SqlFixture} from './fixture';
import {b64} from '../../src/sync-v2/wire';
import {entityKey} from '../../src/sync-v2/protocol';
import {candidates} from '../../src/sync-v2/business';
import {carrierBodyRevision} from '../../src/sync-v2/body-channel-codec';
import {independentBodyResolver} from '../../src/sync-v2/body-channel';
import {bodyChannelRepository} from '../../src/sync-v2/body-channel-repository';
import {tombstoneBodyDescription,emptyBodyDescription} from '../../src/sync-v2/body-binding';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchAccountControl} from '../../src/sync-v2/account-control';
import {SyncV2Http} from '../../src/sync-v2/http';
import {readTree} from '../../src/sync-v2/merkle';
import {verifyCommit} from '../../src/sync-v2/signing';
import book from '../fixtures/cli-single-txt-book.json';
const author='a'.repeat(32),fields=(r:any)=>Object.fromEntries(Object.keys(emptyBodyDescription()).map(k=>[k,r[k]]));
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
function entity(kind:'asset'|'book',deleted:boolean){
 const id=kind==='asset'?'r3.png':book.bookId,e=entityKey(idKey,scope.repoId,kind,id);
 const value=kind==='asset'?{assetId:id,mime:'image/png',originalFilename:id,updatedAt:deleted?200:100,sourceDeviceId:'watch',deleted,deletedAt:deleted?200:0}:{bookId:id,fingerprint:book.fingerprint,title:'R3 book',chapterCount:1,deletedChapters:[],deletionClock:0,deleted,deletedAt:deleted?200:0,updatedAt:deleted?200:100,sourceDeviceId:'watch',sourceUrl:book.sourceUrl,kind:'txt'};
 return {id,e,value,candidate:candidates(kind,id,e,value)};
}
for(const kind of ['asset','book'] as const)for(const explicit of [false,true])test(`RVNOTES3-01 ${kind} ${explicit?'explicit choice':'ordinary'} deletion retains the current authenticated description without original`,async()=>{
 const server=new P5Backend(),db=new SqlFixture(),store=db.store();await store.initialize();
 const keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1},http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,false,true),reader=new WatchCloudIndex(store,http,signer,keys,approved,async()=>{},()=>100),live=entity(kind,false),dead=entity(kind,true);
 const raw=kind==='asset'?new Uint8Array([0,255,127]):new TextEncoder().encode(book.packageUtf8),revision=carrierBodyRevision(kind,live.e,createHash('sha256').update(raw).digest('hex'));
 // Distinct promiseId proves the five fields are copied, not regenerated.
 const known={bodyRevision:revision,promiseId:'f'.repeat(32),recipeOid:null,opaqueContentId:null,contentBytes:null};let present=true,resolves=0,reads=0,proofs=0,preflights=0,commits=0;
 const validator=bodyChannelRepository({} as any),actual=independentBodyResolver({read:async()=>{reads++;return present?raw:undefined;},validate:validator.validate,install:async()=>{}},async()=>null),resolver=async(e:any,old:any)=>{resolves++;const body=await actual(e,old);return !old&&body?{...body,promiseId:known.promiseId}:body;},pub=new WatchIndexPublisher(store,http,signer,keys,()=>100,resolver);
 const scan=async(v:any,label:string)=>{await store.beginScan({...binding,schema:label});await store.scanPage({page:async()=>({rows:[{kind,logicalId:live.id,value:v}],after:'done',done:true}),changed:async()=>[]});};
 const current=async()=>{const commit=JSON.parse(new TextDecoder().decode(server.objects.get(server.account.commitOid)!));await verifyCommit(signer,b64(publicBytes),commit,server.account.commitOid,scope);return (await readTree(scope,commit.body.treeRoot,async oid=>server.objects.get(oid)!)).find(r=>r.entityKey===live.e)!;};
 try{
  await scan(live.value,'r3-live');await pub.prepare(author,'key',{commitOid:null,revision:'0'},'4'.repeat(32));await pub.flush();await reader.pull(server.window());expect(fields(await current())).toEqual(known);
  const state=await store.readState(),prior=await store.cloudRow(state.cloud.current.treeRoot,live.e);present=false;await scan(dead.value,'r3-delete');const candidate=await store.readCandidate(dead.e);
  expect(await actual({entityKey:dead.e,candidate},prior)).toEqual(known);
  expect(await actual({entityKey:dead.e,candidate},{candidate:live.candidate,manifest:known})).toEqual(known);
  if(explicit){
   const control=new WatchAccountControl({store,http,publisher:pub,reader,crypto:signer,approved,resolveBody:resolver,choiceApply:true,author:async()=>({deviceId:author,alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision}}),business:{prepare:async()=>[],reserve:async()=>async()=>{},verifyBody:async()=>{proofs++;throw Error('tombstone must not require body proof');}},trustedNow:()=>100,recovery:{ports:{}}} as any);
   const preflight=pub.preflightRecords.bind(pub);pub.preflightRecords=rows=>{expect(fields(rows.find(r=>r.entityKey===dead.e).manifest)).toEqual(known);preflights++;return preflight(rows);};
   // Preflight must replace a supplied stale/local descriptor using current tree.
   const stale={...known,bodyRevision:'0'.repeat(32),promiseId:'1'.repeat(32)},plan=await (control as any).prepareApply(await store.readStableState(),[{entityKey:dead.e,rowSequence:'2',candidate,manifest:stale}]);await plan.release();
   const before=await store.readState();await store.controlUpdate(before,{...before,pendingChoice:{generation:'0',inboxKeys:[]}});
   const view=(await control.pendingChoice())!,selected=(control as any).plans.get(view.proof).local.find((r:any)=>r.entityKey===dead.e);expect(fields(selected.manifest)).toEqual(known);
   // Commit must normalize again, rather than trust the process-local preview.
   selected.manifest=stale;const prepare=pub.prepareExplicit.bind(pub);pub.prepareExplicit=async input=>{expect(fields(input.records.find(r=>r.entityKey===dead.e).manifest)).toEqual(known);commits++;return prepare(input);};
   await control.chooseLocal(view.proof,'5'.repeat(32));expect(preflights).toBeGreaterThanOrEqual(3);expect(commits).toBe(1);expect((await store.readState()).pendingChoice).toBeNull();
   // The public explicit publisher must independently reject a stale supplied
   // descriptor, even without the account-choice normalization that precedes it.
   await prepare({kind:'resolve-local',expected:await store.readStableState(),deviceId:author,alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision},requestId:'6'.repeat(32),records:[{entityKey:dead.e,rowSequence:'3',candidate:await store.readCandidate(dead.e),manifest:stale}]});
   await control.resumePublication();expect(fields(await current())).toEqual(known);
  }else{await pub.prepare(author,'key',{commitOid:server.device.commitOid,revision:server.device.revision},'5'.repeat(32));await pub.flush();await reader.pull(server.window());}
  const after=await current();expect(after.deleted).toBe(true);expect(fields(after)).toEqual(known);expect(resolves).toBe(1);expect(reads).toBe(1);expect(proofs).toBe(0);expect((await store.readState()).hasUnsentEdits).toBe(false);
 }finally{db.close();}
});

for(const kind of ['book','asset'] as const)test(`RVNOTES3-01 ${kind} keeps every completed recipe field and has no local-manifest fallback`,()=>{
 const dead=entity(kind,true).candidate,live=entity(kind,false).candidate,known={bodyRevision:'1'.repeat(32),promiseId:null,recipeOid:'recipe:sha256:'+'2'.repeat(64),opaqueContentId:'3'.repeat(64),contentBytes:12345};
 for(const current of [{row:known},{candidate:live,manifest:known}]){const got=tombstoneBodyDescription(dead,current);expect(got).toEqual(known);expect(got).not.toBe(known);}
 expect(tombstoneBodyDescription(dead,null)).toEqual(emptyBodyDescription());expect(tombstoneBodyDescription(dead,{row:emptyBodyDescription()})).toEqual(emptyBodyDescription());expect(tombstoneBodyDescription(live,{row:known})).toBeNull();
});
