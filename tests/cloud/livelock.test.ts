import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {WatchCloudRecords,type RecordPorts,type RecordDocument} from '../../src/cloud/records';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {crypto,key,enabled} from './k2-crypto';
import {utf8Encode} from '../../src/cloud/types';
const rc={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')},epoch='lazy-epoch';
async function seed(documents:RecordDocument[]){
 const {CloudRecordCodec}=await import('../../src/cloud/records');const codec=new CloudRecordCodec(rc);let text:string|undefined;const rows:import('../../src/cloud/records').RecordRow[]=[];
 for(let i=0;i<documents.length;i++){const doc=documents[i],id=await codec.id(key,'user',doc);rows.push({recordId:id,revision:String(i+1),envelope:await codec.encode(key,'user',id,1,doc),tombstone:false});}
 const p:RecordPorts={userId:'user',epoch,anchorVersion:1,version:1,crypto:rc,key:async()=>key.slice(),current:async()=>{},assertUpload:async()=>{},readState:async()=>text,writeState:async v=>{text=v;},get:async after=>{const items=rows.filter(r=>Number(r.revision)>Number(after)).slice(0,50);return {formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],items,cursor:items.at(-1)?.revision??after,headRevision:String(rows.length),hasMore:Number(items.at(-1)?.revision??after)<rows.length};},push:async()=>{throw Error('unexpected upload');},export:async()=>[],apply:async()=>0};
 await new WatchCloudRecords(p).pull();return JSON.parse(text!);
}
test('production delta cache advances SQL units across restarts, skips completed groups and never uploads before replay',async()=>{
 const f=await dbFixture();try{
  const docs:RecordDocument[]=Array.from({length:60},(_,i)=>({kind:'article',value:{...article({articleId:String(i+1).padStart(64,'0'),url:'https://lazy.example/'+i,rssSourceUrl:'https://lazy.example/rss',independentSaved:false,isRead:true,readingProgress:.6,readingPositionChangedAt:100+i}),contentText:undefined,contentHtml:undefined}}));for(const d of docs){delete d.value.contentText;delete d.value.contentHtml;}
  const state=await seed(docs),files=new Map<string,Uint8Array>(),seen=new Set<string>();let elapsed=0,raw=0,projection=0,rounds=0,appends=0;
  const fs={read:async(p:string)=>files.get(p)?.slice(),writeAtomic:async(p:string,b:Uint8Array)=>{files.set(p,b.slice());},append:async(p:string,b:Uint8Array,offset:number)=>{const old=files.get(p)??new Uint8Array();expect(old.length).toBe(offset);const next=new Uint8Array(old.length+b.length);next.set(old);next.set(b,old.length);files.set(p,next);appends++;elapsed+=20;},hash:async(p:string)=>crypto.sha256(files.get(p)!)};
  let cache=new WatchCloudCache(fs,crypto.sha256,enabled);files.set((await cache.scope('user'))+'/records.json',utf8Encode(JSON.stringify(state)));
  const open=()=>{cache=new WatchCloudCache(fs,crypto.sha256,enabled);const adapter=new WatchCloudLibraryAdapter(f.repo,'watch',cloudCrypto,enabled);const current=async()=>{if(elapsed>=20000)throw Error('cloud_sync_deadline_exceeded');};const p:RecordPorts={userId:'user',epoch,anchorVersion:1,version:1,lazyProjections:true,now:()=>elapsed,remainingMillis:()=>20000-elapsed,crypto:{...rc,decrypt:async(k,a,n,b)=>{if(new TextDecoder().decode(a).startsWith('watchrss-cloud-record-v1:'))raw++;else projection++;return rc.decrypt(k,a,n,b);}},key:async()=>key.slice(),current,assertUpload:current,readState:()=>cache.records('user'),writeState:v=>cache.storeRecords('user',v),readStateObject:()=>cache.recordsValue('user'),writeStateObject:v=>cache.storeRecordsValue('user',v),checkpoint:async()=>{throw Error('whole_cache_cleanup_forbidden');},get:async after=>({formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],items:[],cursor:after,headRevision:after,hasMore:false}),push:async()=>{throw Error('must not publish incomplete replay');},export:async()=>[],hydrate:async()=>{throw Error('startup hydration forbidden');},apply:async ds=>{for(const d of ds){expect(seen.has(d.value.articleId)).toBe(false);seen.add(d.value.articleId);}const n=await adapter.applyRecords(ds);elapsed+=ds.length*1000;return n;}};return new WatchCloudRecords(p);};
  while(seen.size<60){rounds++;elapsed=0;const r=open(),before=seen.size,oldProjection=projection;await r.pull();expect(projection).toBe(oldProjection);expect(await r.flushInteractions()).toBe(0);expect(await r.flush()).toBe(0);try{await r.reapply('same-inventory');}catch(e){expect(String(e)).toContain('cloud_sync_deadline_exceeded');}expect(seen.size).toBeGreaterThan(before);expect(elapsed).toBeLessThan(20000);expect(rounds).toBeLessThan(8);}
  expect(raw).toBe(0);expect(appends).toBeGreaterThan(0);expect((await f.repo.cloudReadingCandidates()).filter(a=>a.isRead&&Math.abs(a.readingProgress-.6)<1e-6)).toHaveLength(60);
  elapsed=0;const done=open(),oldProjection=projection;await done.pull();await done.reapply('same-inventory');expect(projection).toBe(oldProjection);expect(seen.size).toBe(60);
  // A forged progress hint cannot suppress authenticated application.
  const value=await cache.recordsValue('user');const binding=Object.keys(value.replayDone)[0];value.replayDone[binding]={...value.replayDone[binding],proof:'f'.repeat(64)};await cache.storeRecordsValue('user',value);seen.clear();elapsed=0;const retry=open();await retry.pull();await expect(retry.reapply('same-inventory')).rejects.toThrow('cloud_sync_deadline_exceeded');expect(seen.size).toBeGreaterThan(0);
 }finally{f.sql.close();}
});
test('background diagnostics persist closed numeric records events and omit arbitrary strings',async()=>{
 const lines:string[]=[];const d=backgroundDiagnostics(async<T>(method:string,args:Record<string,unknown>)=>{expect(method).toBe('log.append');expect(args.path).toBe('app_log.txt');expect((args.text as string).length).toBeLessThanOrEqual(7000);lines.push(args.text as string);return {} as T;});
 d.report(JSON.stringify({event:'records-work',stage:'projection-load',lane:'pull',units:47,durationMillis:123,outcome:'complete',decryptions:0,projectionDecryptions:1,category:'timeout',code:'cloud_sync_deadline_exceeded',token:'never-log',url:'https://secret.invalid',message:'private body'}));d.report(JSON.stringify({event:'private body',stage:'secret'}));await d.flush();const log=lines.join('');expect(log).toContain('projection-load');expect(log).toContain('cloud_sync_deadline_exceeded');expect(log).toContain('timeout');expect(log).toContain('"projectionDecryptions":1');expect(log).not.toContain('never-log');expect(log).not.toContain('secret');expect(log).not.toContain('private body');
});

test('real coordinator counts preparation checkpoints as progress and reaches the final mock head ACK across bounded workers',async()=>{
 const {fixture}=await import('./service-fixture'),{CloudRecordCodec}=await import('../../src/cloud/records'),{WatchCloudSyncService}=await import('../../src/cloud/service'),{SnapshotRestoreCheckpoint}=await import('../../src/cloud/snapshot-checkpoint');
 const f=await fixture(),e='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',codec=new CloudRecordCodec(rc),docs:RecordDocument[]=[],records:Record<string,any>={};
 for(let i=0;i<300;i++){const d:RecordDocument={kind:'rss-state',value:{sourceId:'source',articleIdHash:i.toString(16).padStart(64,'0'),isRead:true,readingProgress:.5,readingPositionChangedAt:100+i}};docs.push(d);records[await codec.id(key,'user',d)]={revision:'1',hash:await codec.hash(d)};}
 const files=f.blobs,fs={read:async(p:string)=>files.get(p)?.slice(),writeAtomic:async(p:string,b:Uint8Array)=>{files.set(p,b.slice());},append:async(p:string,b:Uint8Array,offset:number)=>{const old=files.get(p)??new Uint8Array();expect(old.length).toBe(offset);const next=new Uint8Array(old.length+b.length);next.set(old);next.set(b,old.length);files.set(p,next);},hash:async(p:string)=>crypto.sha256(files.get(p)!)};
 const initial=new WatchCloudCache(fs,crypto.sha256,enabled);files.set((await initial.scope('user'))+'/records.json',utf8Encode(JSON.stringify({epoch:e,cursor:'0',rows:{},records})));
 await f.phone();let elapsed=0;const current=async()=>{if(elapsed>=290000)throw Error('cloud_sync_deadline_exceeded');};f.session.assertCurrent=current;
 await f.state.acceptEpoch(e);await f.state.rememberContentGeneration(f.content().contentGeneration);const journal=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,current,()=>elapsed).open(e,f.content().contentGeneration);await journal.begin();await journal.phaseDone('records');journal.close();
 let work=JSON.parse((await f.state.restoreJournal())!).work;
 let complete=false,round=0;
 for(;round<5&&!complete;round++){elapsed=0;const cache=new WatchCloudCache(fs,crypto.sha256,enabled);
  f.session.records=async()=>new WatchCloudRecords({userId:'user',epoch:e,anchorVersion:1,version:1,lazyProjections:true,crypto:{...rc,hmac:async(...args)=>{elapsed+=2000;return rc.hmac(...args);}},key:async()=>key.slice(),current,check:()=>{if(elapsed>=290000)throw Error('cloud_sync_deadline_exceeded');},now:()=>elapsed,remainingMillis:()=>290000-elapsed,assertUpload:current,readState:()=>cache.records('user'),writeState:v=>cache.storeRecords('user',v),readStateObject:()=>cache.recordsValue('user'),writeStateObject:v=>cache.storeRecordsValue('user',v),readPreparation:()=>cache.recordPreparation('user'),writePreparation:v=>cache.storeRecordPreparation('user',v),checkpoint:async()=>{throw Error('full cleanup forbidden');},get:async after=>({formatVersion:1,libraryEpoch:e,keyVersionFloor:0,keyCommitments:[],items:[],cursor:after,headRevision:after,hasMore:false}),push:async()=>{throw Error('unchanged ACK must not push');},export:async()=>docs,apply:async()=>0});
  const service=new WatchCloudSyncService({...((f.service as any).ports),now:()=>elapsed},enabled);complete=await service.syncNow(true,'recent128');
  expect(elapsed).toBeLessThan(300000);expect(service.status.errorCode).not.toBe('cloud_snapshot_progress_stalled');expect(service.status.retryable).not.toBe(false);
  const next=JSON.parse((await f.state.restoreJournal())!).work;expect(next).toBeGreaterThan(work);work=next;
 }
 expect(complete).toBe(true);expect(round).toBe(3);expect(f.heads.has('watch')).toBe(true);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(true);
});

test('headless pure digest helpers avoid service IPC without installing a host/UI surface',async()=>{
 const globals=globalThis as any,old=globals.__podByteCodecs,oldPod=globals.pod;delete globals.pod;
 globals.__podByteCodecs={sha256Bytes:(data:Uint8Array)=>data.length<=262144?new Uint8Array(Bun.CryptoHasher.hash('sha256',data)):null};
 try{const {createCloudHostPorts}=await import('../../src/cloud/host-ports');const p=createCloudHostPorts(async()=>{throw Error('digest IPC forbidden');},enabled);expect(await p.crypto.sha256(utf8Encode('abc'))).toBe(await crypto.sha256(utf8Encode('abc')));expect(globals.pod).toBeUndefined();}finally{globals.__podByteCodecs=old;if(oldPod!==undefined)globals.pod=oldPod;}
});

test('diagnostic shutdown drains at most two bounded appends after a burst',async()=>{
 let calls=0,release!:()=>void;const lines:string[]=[];const gate=new Promise<void>(resolve=>release=resolve);
 const d=backgroundDiagnostics(async<T>(_method:string,args:Record<string,unknown>)=>{calls++;lines.push(args.text as string);expect((args.text as string).length).toBeLessThanOrEqual(7000);if(calls===1)await gate;return {} as T;});
 for(let i=0;i<10000;i++)d.report(JSON.stringify({event:'records-work',stage:'checkpoint',units:i,durationMillis:1,outcome:'complete'}));
 expect(calls).toBe(1);release();await d.flush();expect(calls).toBeLessThanOrEqual(2);expect(lines.join('')).toContain('"units":9999');expect(lines.join('')).toContain('"dropped":');
});

test('completed projections resolve a new inventory unit on demand and preserve remote clocks and source options',async()=>{
 const f=await dbFixture();try{
  const {rssSourceKey,rssArticleId}=await import('../../src/cloud/rss-identity');const feed='https://demand.example/rss',url='https://demand.example/late',sourceId=await rssSourceKey(feed,crypto.sha256),id=await rssArticleId({link:url,guid:'late-guid'},crypto.sha256),articleIdHash=await crypto.sha256(utf8Encode(id));
  const remote:RecordDocument={kind:'rss-state',value:{sourceId,articleIdHash,sourceDeviceId:'phone',isRead:true,readingProgress:.75,readingPositionBytes:9,readingPositionContentHash:'body',readingPositionChangedAt:700}},source:RecordDocument={kind:'source',value:{url:feed,sourceId:'old-pool',title:'Feed',updatedAt:1,useOriginalContent:true}};
  const state=await seed([source,remote]),files=new Map<string,Uint8Array>(),fs={read:async(p:string)=>files.get(p)?.slice(),writeAtomic:async(p:string,b:Uint8Array)=>{files.set(p,b.slice());},append:async(p:string,b:Uint8Array,offset:number)=>{const old=files.get(p)??new Uint8Array();expect(old.length).toBe(offset);files.set(p,new Uint8Array([...old,...b]));},hash:async(p:string)=>crypto.sha256(files.get(p)!)};
  const init=new WatchCloudCache(fs,crypto.sha256,enabled);files.set((await init.scope('user'))+'/records.json',utf8Encode(JSON.stringify(state)));
  const open=()=>{const cache=new WatchCloudCache(fs,crypto.sha256,enabled),adapter=new WatchCloudLibraryAdapter(f.repo,'watch',cloudCrypto,enabled);const ports:RecordPorts={userId:'user',epoch,version:1,anchorVersion:1,lazyProjections:true,crypto:rc,key:async()=>key.slice(),current:async()=>{},assertUpload:async()=>{},readState:()=>cache.records('user'),writeState:v=>cache.storeRecords('user',v),readStateObject:()=>cache.recordsValue('user'),writeStateObject:v=>cache.storeRecordsValue('user',v),get:async after=>({formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],items:[],cursor:after,headRevision:after,hasMore:false}),push:async()=>{throw Error('remote state must not be rewound');},export:async()=>[],project:(d,b)=>adapter.projectRecord(d,b),inventoryLookups:v=>adapter.inventoryRecordLookups(v),hydrate:ds=>adapter.hydrateRecords(ds),reapply:()=>adapter.applyReadingStates(),apply:ds=>adapter.applyRecords(ds)};return {r:new WatchCloudRecords(ports),adapter,ports};};
  let v=open();await v.r.pull();await v.r.reapply('same-heads');expect(await f.repo.cloudReadingCandidates()).toHaveLength(0);
  // A new guest does not hydrate the already completed group in pull/reapply.
  v=open();await v.r.pull();await v.r.reapply('same-heads');
  const inventory:any={url:feed,sourceId:'new-pool',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[{url,guid:'late-guid',title:'Late',excerpt:'',contentText:'body',contentHtml:null,imageUrl:null,contentHash:null}]};
  await v.adapter.mergeInventory(inventory,{checkpoint:{has:()=>false,commit:async()=>{},check:async()=>{},result:()=>0},skipReading:true});
  expect((await f.repo.cloudReadingCandidates())[0].readingProgress).toBe(0);await v.r.reapplyInventory(inventory);
  expect((await f.repo.cloudReadingCandidates())[0]).toMatchObject({isRead:true,readingProgress:.75,readingPositionChangedAt:700,readingPositionBytes:9});
  const local={kind:'rss-state',value:{...remote.value,isRead:false,readingProgress:0,readingPositionChangedAt:0}};
  expect(v.adapter.projectRecord(local,remote).value).toMatchObject({isRead:true,readingProgress:.75,readingPositionChangedAt:700});
  expect(v.adapter.projectRecord({...local,value:{...local.value,readingPositionChangedAt:800}},remote).value).toMatchObject({isRead:false,readingPositionChangedAt:800});
  expect(v.adapter.projectRecord({kind:'source',value:{url:feed,sourceId:'',title:'Feed',updatedAt:1}},source).value).toMatchObject({sourceId:'old-pool',useOriginalContent:true});
  expect(v.adapter.projectRecord({kind:'source',value:{url:feed,useOriginalContent:undefined}},source).value.useOriginalContent).toBe(true);
  expect(v.adapter.projectRecord({kind:'source',value:{url:feed,useOriginalContent:false}},source).value.useOriginalContent).toBe(false);
 }finally{f.sql.close();}
});

test('118s one-time reading-index preparation does not poison later fast replay batches',async()=>{
 const docs:RecordDocument[]=Array.from({length:300},(_,n)=>({kind:'rss-state',value:{sourceId:'synthetic',articleIdHash:String(n).padStart(64,'0'),sourceDeviceId:'phone',isRead:true,readingPositionChangedAt:100+n}})),state=await seed(docs),seen=new Set<string>(),sizes:number[]=[];let now=50000,cold=true,checkpoints=0;
 const current=async()=>{if(now>=290000)throw Error('cloud_sync_deadline_exceeded');};
 const r=new WatchCloudRecords({userId:'user',epoch,anchorVersion:1,version:1,lazyProjections:true,now:()=>now,remainingMillis:()=>290000-now,crypto:rc,key:async()=>key.slice(),current,assertUpload:current,readState:async()=>{throw Error('object cache required');},writeState:async()=>{throw Error('object cache required');},readStateObject:async()=>state,writeStateObject:async()=>{},get:async after=>({formatVersion:1,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],items:[],cursor:after,headRevision:after,hasMore:false}),push:async()=>{throw Error('push forbidden');},export:async()=>[],apply:async(ds,work)=>{if(cold){cold=false;await work!('reading-index',1,async()=>{now+=118082;});}sizes.push(ds.length);for(const d of ds){expect(seen.has(d.value.articleIdHash)).toBe(false);seen.add(d.value.articleIdHash);}now+=ds.length*100;return ds.length;}});
 await r.pull();await r.reapply('cold-index',async()=>{checkpoints++;now+=40;});expect(seen.size).toBe(300);expect(Math.max(...sizes)).toBeGreaterThanOrEqual(8);expect(now).toBeLessThan(290000);expect(checkpoints).toBe(sizes.length);
});
