/** Correct-behavior regressions adapted from T-REVIEW-PODJS-NOTES-r2 probes:
 * independent.test.ts: first migration skips bodyless tombstones
 * body-limit.test.ts: carrier boundary and fully validated real book JSONL.
 * All sources/keys/backend state are fixtures; HTTP uses memory transport only.
 * No network, device or production IO. */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {crypto as snapshotCrypto,key} from '../cloud/k2-crypto';
import {crypto as signer,publicBytes,SyntheticIndexBackend,publishingFixture,serverPin} from './p2-fixture';
import {scope,idKey,binding} from './fixture';
import {b64} from '../../src/sync-v2/wire';
import {jsonBytes,entityKey} from '../../src/sync-v2/protocol';
import {prepareCarrier,openCarrier,carrierBodyRevision,bodyObjectName,type BodyKind} from '../../src/sync-v2/body-channel-codec';
import {WatchBodyChannel,independentBodyResolver} from '../../src/sync-v2/body-channel';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {WatchAccountControl} from '../../src/sync-v2/account-control';
import {BodyChannelHttp} from '../../src/sync-v2/body-channel-http';
import {SyncV2Http} from '../../src/sync-v2/http';
import {readTree} from '../../src/sync-v2/merkle';
import {verifyCommit} from '../../src/sync-v2/signing';
import {bodyChannelRepository} from '../../src/sync-v2/body-channel-repository';
import {candidates} from '../../src/sync-v2/business';
import {validateBookPackage,splitBookLines} from '../../src/books/package';
import book from '../fixtures/cli-single-txt-book.json';
const author='a'.repeat(32),anchor={commitOid:'commit:sha256:'+'a'.repeat(64),revision:'1',rollbackGeneration:'0'};
const hash=(raw:Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
const empty={bodyRevision:null,promiseId:null,recipeOid:null,opaqueContentId:null,contentBytes:null};

for(const kind of ['asset','book'] as const)for(const explicit of [false,true])test(`RVNOTES2-01 ${kind} first bodyless tombstone publishes via ${explicit?'explicit':'R0'} without resolver`,async()=>{
 const id=kind==='asset'?'deleted.png':book.bookId,e=entityKey(idKey,scope.repoId,kind,id),server=new SyntheticIndexBackend(),f=await publishingFixture(server);let resolves=0,reads=0,pending=0,proofs=0;
 const value=kind==='asset'?{assetId:id,mime:'image/png',originalFilename:id,updatedAt:200,sourceDeviceId:'watch',deleted:true,deletedAt:200}:{bookId:id,fingerprint:book.fingerprint,title:'Deleted',chapterCount:1,deletedChapters:[],deletionClock:200,deleted:true,deletedAt:200,updatedAt:200,sourceDeviceId:'watch',sourceUrl:book.sourceUrl,kind:'txt'};
 const repository={read:async()=>{reads++;throw Error('must not read deleted body');},validate:async()=>{throw Error('must not validate deleted body');},install:async()=>{throw Error('must not install deleted body');}},resolver=independentBodyResolver(repository,async()=>null,()=>{pending++;});
 const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,false,true),keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1};
 const publisher=new WatchIndexPublisher(f.store,http,signer,keys,()=>100,async entry=>{if(!['book','asset'].includes(entry.candidate.meta.kind))return null;resolves++;throw Error('publisher must bypass resolver for tombstone');}),reader=new WatchCloudIndex(f.store,http,signer,keys,approved,async()=>{},()=>100);
 const scan=async(rows:any[],schema:string)=>{await f.store.beginScan({...binding,schema});await f.store.scanPage({page:async()=>({rows,after:'done',done:true}),changed:async()=>[]});};
 try{
  if(explicit){await scan([],'empty-account');await publisher.prepare(author,'key',{commitOid:null,revision:'0'},'1'.repeat(32));await publisher.flush();await reader.pull(server.window());}
  await scan([{kind,logicalId:id,value}],'deleted-'+kind);const candidate=await f.store.readCandidate(e);
  expect(await resolver({entityKey:e,candidate},null)).toEqual(empty);expect(reads).toBe(0);expect(pending).toBe(0);
  if(explicit){
   const state=await f.store.readStableState(),stale={bodyRevision:'2'.repeat(32),promiseId:'3'.repeat(32),recipeOid:null,opaqueContentId:null,contentBytes:null},record={entityKey:e,rowSequence:'1',candidate,manifest:stale};
   const control=new WatchAccountControl({store:f.store,http,publisher,reader,crypto:signer,approved,resolveBody:resolver,business:{prepare:async()=>[],reserve:async()=>async()=>{},verifyBody:async()=>{proofs++;throw Error('deletion must not require body proof');}},trustedNow:()=>100} as any);
   const plan=await (control as any).prepareApply(state,[record]);await plan.release();
   await publisher.prepareExplicit({kind:'resolve-local',expected:await f.store.readStableState(),deviceId:author,alias:'key',own:{commitOid:server.device.commitOid,revision:server.device.revision},requestId:'6'.repeat(32),records:[record]});
  }else await publisher.prepare(author,'key',{commitOid:null,revision:'0'},'6'.repeat(32));
  await publisher.flush();const signed=JSON.parse(new TextDecoder().decode(server.objects.get(server.account.commitOid)!));
  await verifyCommit(signer,b64(publicBytes),signed,server.account.commitOid,scope);const rows=await readTree(scope,signed.body.treeRoot,async oid=>server.objects.get(oid)!);const row=rows.find(r=>r.entityKey===e)!;
  expect(row).toBeDefined();expect(row.deleted).toBe(true);expect(Object.fromEntries(Object.keys(empty).map(k=>[k,row[k]]))).toEqual(empty);expect(resolves).toBe(0);expect(reads).toBe(0);expect(proofs).toBe(0);
  if(!explicit){expect((await f.store.readState()).hasUnsentEdits).toBe(false);await reader.pull(server.window());const state=await f.store.readState(),entry=await f.store.cloudRow(state.cloud.current.treeRoot,e);expect(entry.state.payload.deletedAt).toBe(200);expect(state.hasUnsentEdits).toBe(false);}
 }finally{f.db.close();}
});

async function prepare(kind:BodyKind,raw:Uint8Array,id=kind==='asset'?'image.png':'1'.repeat(64)){
 const e=entityKey(idKey,scope.repoId,kind,id),bound={kind,logicalId:id,entityKey:e,bodyRevision:carrierBodyRevision(kind,e,hash(raw))};
 return {...await prepareCarrier({crypto:snapshotCrypto,signer,alias:'key',authorDeviceId:author,scope,anchor,binding:bound,key:key.slice(),keyVersion:1,objects:[{name:bodyObjectName(kind,id),bytes:raw,compress:false}]}),binding:bound,raw};
}
for(const kind of ['asset','book'] as const)for(const size of kind==='asset'?[262144,262145,5242880,5242881]:[262144,262145])test(`RVNOTES2-02 ${kind} carrier boundary ${size}`,async()=>{
 const raw=new Uint8Array(size).fill(17),p=await prepare(kind,raw);let reads=0,yields=0;
 const open=()=>openCarrier({descriptor:p.descriptor,scope,binding:p.binding,crypto:snapshotCrypto,signer,publicKey:b64(publicBytes),key:async()=>key.slice(),read:async h=>{reads++;return p.objects.get(h)!;},yieldControl:async()=>{yields++;}});
 if(size===5242881){await expect(open()).rejects.toThrow('object_too_large');expect(reads).toBe(1);expect(yields).toBe(0);}
 else{const out=(await open()).get(bodyObjectName(kind,p.binding.logicalId))!;expect(out).toEqual(raw);expect(hash(out)).toBe(hash(raw));expect(yields).toBe(Math.ceil(size/262144)-1);}
},60000);

/** Independent byte transport fixture: actual BodyChannelHttp handles scope,
 * reserve/PUT/complete and bounded GET. No live endpoint is contacted. */
function memoryBodyHttp(p:Awaited<ReturnType<typeof prepare>>){
 const stored=new Map<string,Uint8Array>(),sizes=new Map([p.descriptor.body.manifest,...p.descriptor.body.chunks].map(o=>[o.sha256,o.sizeBytes]));let ready=false,reserves=0,puts=0;
 const json=(v:any)=>({status:200,headers:{},body:jsonBytes({version:1,purpose:'p6-body.v1',scope,...v})});
 const http=new BodyChannelHttp({enabled:true,origin:'http://127.0.0.1:18991',policy:{accountBaseUrl:'http://127.0.0.1:18991',allowLoopback:true},scope,session:async()=>({accessToken:'synthetic',legacyDeviceId:'r2',legacyEpoch:'epoch',legacyGeneration:'1'}),check:async()=>{},transport:{request:async r=>{
  const u=new URL(r.url),path=u.pathname.replace('/functions/v1/cloud/bodies/v1',''),parts=path.split('/');expect(r.headers.Authorization).toBe('Bearer synthetic');
  if(path==='/reserve'){reserves++;return json({carrierId:p.descriptor.body.carrierId,state:ready?'ready':'reserved',expiresAtMillis:600000,objects:[...sizes].map(([sha256,sizeBytes])=>({sha256,sizeBytes,offset:stored.get(sha256)?.length??0}))});}
  if(r.method==='PUT'){
   const sha=parts[4]!,at=Number(parts[6]),old=stored.get(sha)??new Uint8Array(),data=r.body!;expect(old.length).toBe(at);expect(data.length).toBeLessThanOrEqual(65536);expect(hash(data)).toBe(r.headers['x-watchrss-sync-part-sha256']);puts++;
   const next=new Uint8Array(at+data.length);next.set(old);next.set(data,at);stored.set(sha,next);return json({});
  }
  if(path.endsWith('/complete')){for(const [sha,size]of sizes){expect(stored.get(sha)?.length).toBe(size);expect(hash(stored.get(sha)!)).toBe(sha);}ready=true;return json({carrierId:p.descriptor.body.carrierId,state:'ready'});}
  if(path==='/carriers')return json({carriers:ready?[{carrierId:p.descriptor.body.carrierId,descriptor:p.descriptor}]:[],nextAfter:null});
  if(r.method==='GET'&&parts[3]==='objects'){const raw=stored.get(parts[4]!)!,at=Number(u.searchParams.get('offset'));return {status:200,headers:{'x-watchrss-body-total-bytes':String(raw.length),'x-watchrss-body-offset':String(at)},body:raw.slice(at,at+65536)};}
  throw Error('unexpected test path '+path);
 }}});return {http,reserves:()=>reserves,puts:()=>puts};
}

for(const kind of ['asset','book'] as const)test(`RVNOTES2-02 ${kind} full receive and local ready-carrier verification preserve large bytes`,async()=>{
 const sourceUrl='watchrss://import/online-v1/'+'a'.repeat(64),raw=kind==='asset'?new Uint8Array(5*1024*1024).fill(23):new TextEncoder().encode(JSON.stringify({format:'watchrss-book',version:1,title:'R2 large book',chapterCount:1,sourceUrl,kind:'txt'})+'\n'+JSON.stringify({chapterIndex:1,title:'chapter',contentText:'x'.repeat(270000),contentHtml:null,url:sourceUrl})+'\n');
 const valid=kind==='book'?await validateBookPackage(splitBookLines((async function*(){yield new TextDecoder().decode(raw);})()),async b=>hash(b)):null,id=valid?.bookId??'large.png',p=await prepare(kind,raw,id);
 const value=kind==='asset'?{assetId:id,mime:'image/png',originalFilename:id,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}:{bookId:id,fingerprint:valid!.fingerprint,title:'Renamed metadata',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl,kind:'txt'},c=candidates(kind,id,p.binding.entityKey,value);
 let local:Uint8Array|undefined,installs=0,yields=0;const repo=bodyChannelRepository({cloudBookBody:async()=>local,cloudNoteAsset:async()=>{if(!local)throw Error('cloud_note_asset_missing');return local;},receiveCloudBook:async(_id:string,bytes:Uint8Array)=>{installs++;local=bytes.slice();},mergeCloudNoteAsset:async(_id:string,bytes:Uint8Array,expected:string|null)=>{expect(expected).toBeNull();installs++;local=bytes.slice();return 1;}} as any);await repo.validate(kind,id,value,raw);
 const entry={row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,recipeOid:null,deleted:false},meta:c.meta,state:c.state},cache=new Map<string,Uint8Array>(),projection={readState:async()=>({account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),cloudRow:async()=>entry,cloudRows:async(_r:string,after:string)=>after?[]:[entry]};
 const wire=memoryBodyHttp(p);await wire.http.upload(p.descriptor,async h=>p.objects.get(h)!);expect(wire.puts()).toBeGreaterThan(1);
 const channel=()=>new WatchBodyChannel({http:wire.http,scope,projection:projection as any,crypto:snapshotCrypto,signer,approved,author:async()=>({deviceId:author,alias:'key'}),key:async()=>key.slice(),currentKey:async()=>({key:key.slice(),version:1}),files:{read:async p=>cache.get(p),writeAtomic:async(p,b)=>{cache.set(p,b.slice());}},root:'r2',repository:repo,check:async()=>{},yieldControl:async()=>{yields++;}});
 expect(raw.length).toBeGreaterThan(262144);expect(await channel().sync()).toEqual({pending:0,errors:[]});expect(installs).toBe(1);expect(local).toEqual(raw);expect(hash(local!)).toBe(hash(raw));expect(yields).toBe(Math.ceil(raw.length/262144)-1);
 expect(await channel().sync()).toEqual({pending:0,errors:[]});expect(installs).toBe(1);expect(wire.reserves()).toBe(1);expect(local).toEqual(raw);expect(yields).toBe(Math.ceil(raw.length/262144)-1);
},60000);

for(const kind of ['asset','book'] as const)test(`RVNOTES2-01 live ${kind} cannot borrow a deleted body's empty descriptor`,async()=>{
 const id=kind==='asset'?'deleted.png':book.bookId,e=entityKey(idKey,scope.repoId,kind,id),value=kind==='asset'?{assetId:id,mime:'image/png',originalFilename:id,updatedAt:200,sourceDeviceId:'watch',deleted:false,deletedAt:0}:{bookId:id,fingerprint:book.fingerprint,title:'Restored',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:200,sourceDeviceId:'watch',sourceUrl:book.sourceUrl,kind:'txt'},live=candidates(kind,id,e,value),deleted=candidates(kind,id,e,{...value,deleted:true,deletedAt:199});let reads=0;
 const resolver=independentBodyResolver({read:async()=>{reads++;return undefined;},validate:async()=>{},install:async()=>{}},async()=>null);
 for(const description of [empty,{...empty,bodyRevision:'a'.repeat(32),promiseId:'b'.repeat(32)}])await expect(resolver({entityKey:e,candidate:live},{candidate:deleted,manifest:description} as any)).rejects.toThrow('body_channel_source_missing');
 expect(reads).toBe(2);
});
