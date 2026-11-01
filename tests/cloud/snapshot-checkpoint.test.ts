import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fixture} from './service-fixture';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {crypto,key,enabled} from './k2-crypto';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {writeWrss} from '../../src/cloud/wrss';

async function controlled(){
 const f=await fixture();let now=0,sourceDecryptions=0,pulls=0,interactions=0,decryptMillis=0,applyMillis=0,windowStarted=0;const sourceAesWall:number[]=[];
 const metrics:any[]=[],statuses:string[]=[];
 const codec=new WatchCloudCodec({...crypto,decrypt:async(k,aad,nonce,cipher)=>{if(utf8Decode(aad).startsWith('watchrss-cloud-chunk-v1:')&&now-windowStarted+decryptMillis>=300000)throw Error('cloud_sync_deadline_exceeded');const started=performance.now(),out=await crypto.decrypt(k,aad,nonce,cipher);if(utf8Decode(aad).startsWith('watchrss-cloud-chunk-v1:')){sourceAesWall.push(performance.now()-started);sourceDecryptions++;now+=decryptMillis;}return out;}},enabled);
 f.session.codec=codec;f.session.records=async()=>({pull:async()=>{pulls++;now+=90000;return 0;},flushInteractions:async()=>{interactions++;now+=26000;return 0;},reapply:async()=>0,flush:async()=>0}) as any;
 const original=f.session.library.restorePayloads;f.session.library.restorePayloads=async(...args)=>{const r=await original(...args);now+=applyMillis;return r;};
 const make=()=>{windowStarted=now;const service=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'unused',exclusive:async fn=>fn(),now:()=>now,snapshotDiagnostic:s=>metrics.push(JSON.parse(s))},enabled);service.subscribe(()=>statuses.push(service.status.message));return service;};
 return {f,codec,metrics,statuses,make,sourceAesWall,time:()=>now,delay:(decode:number,apply=0)=>{decryptMillis=decode;applyMillis=apply;},counts:()=>({sourceDecryptions,pulls,interactions}),advance:(n:number)=>{now+=n;}};
}
test('snapshot restart resumes source AEAD chunks and committed objects, skipping records warmup until the restore handoff',async()=>{
 const c=await controlled(),{f}=c;await f.phone({objects:Array.from({length:15},(_,i)=>({name:'reader/'+i+'.txt',bytes:utf8Encode('body-'+i),compress:false}))});
 f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});c.delay(70000,10000);
 let complete=false,rounds=0,previous=0;for(;rounds<12&&!complete;rounds++){const service=c.make();complete=await service.syncNow();const n=c.counts().sourceDecryptions;expect(n>=previous).toBe(true);previous=n;expect(service.status.errorCode).not.toBe('cloud_snapshot_progress_stalled');}
 expect(complete).toBe(true);expect(rounds).toBeGreaterThan(3);expect(c.counts()).toEqual({sourceDecryptions:15,pulls:2,interactions:2});expect(f.merged).toHaveLength(15);
 expect(f.calls.filter(r=>new URL(r.url).host==='objects.invalid')).toHaveLength(16);expect(c.statuses.some(s=>/^正在恢复云快照 \d+%$/.test(s))).toBe(true);expect(await f.state.applied('phone',true)).toBe(1);
});
test('one multi-chunk object keeps verified decoded chunks across a process-style journal/cache reconstruction',async()=>{
 const c=await controlled(),{f}=c;const body=new Uint8Array(9*1024*1024);for(let i=0;i<body.length;i++)body[i]=(i*47+i%251)%256;const remote=await f.phone({objects:[{name:'reader/large.txt',bytes:body,compress:false}]});
 f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});c.delay(80000);
 let complete=false;for(let i=0;i<15&&!complete;i++)complete=await c.make().syncNow();expect(complete).toBe(true);expect(c.counts().sourceDecryptions).toBe(remote.snap.manifest.objects[0].chunks.length);expect(f.merged).toEqual(['reader/large.txt']);
 const chunks=new Set(remote.snap.manifest.objects[0].chunks.map(x=>x.ciphertextSha256));expect(f.calls.filter(r=>new URL(r.url).host==='objects.invalid'&&chunks.has(new URL(r.url).pathname.slice(1)))).toHaveLength(chunks.size);
});
test('projection ciphertext is scope-bound, tamper repairs from source, and clear/epoch/generation invalidate receipts',async()=>{
 const c=await controlled(),{f}=c;const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch-a','generation-a');await cp.begin();const token=await cp.token('synthetic-head/object');await cp.write(token,utf8Encode('private-checkpoint-body'));expect(utf8Decode((await cp.read(token))!)).toBe('private-checkpoint-body');
 expect([...f.blobs.values()].some(b=>utf8Decode(b).includes('private-checkpoint-body'))).toBe(false);
 const projectionPaths=[...f.blobs.keys()].filter(k=>k.includes('/restore-v1/')),bodyPath=projectionPaths.find(p=>!p.endsWith('/'+token+'.bin'))!;f.blobs.get(bodyPath)![15]^=1;expect(await cp.read(token)).toBeUndefined();await cp.write(token,utf8Encode('private-checkpoint-body'));expect(utf8Decode((await cp.read(token))!)).toBe('private-checkpoint-body');cp.close();
 const next=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch-b','generation-a');expect(next.active).toBe(false);expect(await next.read(token)).toBeUndefined();next.close();await f.state.clearContent();expect(await f.state.restoreJournal()).toBeUndefined();
});
test('two deadline windows with no durable units yield a persistent retryable stall code',async()=>{
 const c=await controlled(),{f}=c;await f.phone();await f.state.acceptEpoch('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff');await f.state.rememberContentGeneration(f.content().contentGeneration);const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',f.content().contentGeneration);await cp.begin();cp.close();
 f.session.client.snapshotHeads=async()=>{c.advance(300000);return [...f.heads.values()];};let service=c.make();expect(await service.syncNow()).toBe(false);expect(service.status.errorCode).toBeUndefined();service=c.make();expect(await service.syncNow()).toBe(false);expect(service.status).toMatchObject({errorCode:'cloud_snapshot_progress_stalled',retryable:true});expect(c.counts().pulls).toBe(0);
});
test('inventory source checkpoints survive a deadline; a new completed cycle still refreshes the same sources',async()=>{
 const c=await controlled(),{f}=c;f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});f.session.library.publicSources=async()=>Array.from({length:5},(_,i)=>({url:'https://pool.invalid/'+i,title:'Feed',description:'',siteUrl:'',imageUrl:'',createdAt:1,sortOrder:i,isPinned:false,sourceDeviceId:'watch',updatedAt:1,deleted:false,deletedAt:0}));const calls:number[]=[];
 f.session.client.resolveRssSource=async(url)=>{calls.push(Number(url.split('/').at(-1)));c.advance(80000);return {sourceId:'id',url,title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[]};};f.session.library.mergeInventory=async()=>0;
 let done=false;for(let i=0;i<8&&!done;i++)done=await c.make().syncNow();expect(done).toBe(true);expect(calls).toEqual([0,1,2,3,4]);const before=calls.length;await c.make().syncNow();expect(calls.length).toBeGreaterThan(before);
});

test('real WRSS/SQLite applies 500 originals in durable row batches across deadlines without replaying committed rows',async()=>{
 const c=await controlled(),{f}=c,db=await dbFixture();try{
  const entries=new Map<string,Uint8Array>(),rows:any[]=[];for(let i=0;i<500;i++){const a=article({articleId:await cloudCrypto.stableId('https://original.invalid/'+i),url:'https://original.invalid/'+i,title:'Original '+i,contentHtml:null,contentText:'原文-'+i+'x'.repeat(32768),contentHash:'body-'+i,readingPositionChangedAt:30+i,readingProgress:.5}),stem='bodies/'+await crypto.sha256(utf8Encode(a.articleId));rows.push({...a,contentText:undefined,contentHtml:undefined,contentTextEntry:stem+'.txt',contentHtmlEntry:null});entries.set(stem+'.txt',utf8Encode(a.contentText));}
  entries.set('manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3})));entries.set('articles.json',utf8Encode(JSON.stringify(rows)));const remote=await f.phone({objects:[{name:'private-library.wrss',bytes:writeWrss(entries),compress:false}]});
  const listeners:boolean[]=[],track=db.repo.setCloudProgress.bind(db.repo);db.repo.setCloudProgress=sink=>{listeners.push(!!sink);track(sink);};
  const counts=new Map<string,number>(),merge=db.repo.mergeCloud.bind(db.repo);db.repo.mergeCloud=async(...args)=>{const n=await merge(...args);for(const a of args[1])counts.set(a.articleId,(counts.get(a.articleId)??0)+1);c.advance(1200*args[1].length);return n;};
  f.session.library=new WatchCloudLibraryAdapter(db.repo,'watch',cloudCrypto,enabled);f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});c.delay(1000);
  let done=false,rounds=0;for(;rounds<12&&!done;rounds++){if(rounds)f.session.library=new WatchCloudLibraryAdapter(db.repo,'watch',cloudCrypto,enabled);f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});done=await c.make().syncNow();}
  expect(done).toBe(true);expect(rounds).toBeGreaterThan(2);expect((db.sql.query('SELECT count(*) n FROM articles').get() as any).n).toBe(500);expect(counts.size).toBe(500);expect([...counts.values()].every(n=>n===1)).toBe(true);expect(c.counts().sourceDecryptions).toBe(remote.snap.manifest.objects[0].chunks.length);expect(await f.state.applied('phone',true)).toBe(1);expect(listeners).toEqual(Array.from({length:rounds},()=>[true,false]).flat());
 }finally{db.sql.close();}
},30000);

test('300 MiB / 2400 real AES objects on disk finish repeated 300s windows with one download/decrypt per source chunk',async()=>{
 const c=await controlled(),{f}=c,dir=await mkdtemp(join(tmpdir(),'snapshot-scale-')),sql=new Database(join(dir,'journal.sqlite'));sql.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;CREATE TABLE secure(k TEXT PRIMARY KEY,v TEXT);CREATE TABLE restored(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL,hash TEXT NOT NULL)');
 let downloadBytes=0,expectedBytes=0;const store={get:async(k:string)=>(sql.query('SELECT v FROM secure WHERE k=?').get(k) as any)?.v,set:async(k:string,v:string)=>{sql.query('INSERT OR REPLACE INTO secure VALUES(?,?)').run(k,v);},update:async(values:Record<string,string>,prefixes:string[])=>{sql.transaction(()=>{for(const prefix of prefixes)sql.query('DELETE FROM secure WHERE substr(k,1,?)=?').run(prefix.length,prefix);for(const [k,v]of Object.entries(values))sql.query('INSERT OR REPLACE INTO secure VALUES(?,?)').run(k,v);})();}};
 const blobs={read:async(p:string)=>{try{return new Uint8Array(await readFile(join(dir,'cache',p)));}catch(e){if((e as any).code==='ENOENT')return;throw e;}},writeAtomic:async(p:string,b:Uint8Array)=>{const path=join(dir,'cache',p);await mkdir(dirname(path),{recursive:true});await writeFile(path,b);},removeTree:async(p:string)=>{await rm(join(dir,'cache',p),{recursive:true,force:true});}};
 const originalDownload=f.session.client.download.bind(f.session.client);f.session.client.download=async(...args)=>{const b=await originalDownload(...args);downloadBytes+=b.length;return b;};
 const assemble=()=>{f.session.cache=new WatchCloudCache(blobs,crypto.sha256,enabled);f.session.state=new WatchCloudStateStore(store,'user','watch',enabled);};assemble();
 f.session.library={publicSources:async()=>[],mergeInventory:async()=>0,exportPayloads:async()=>({objects:[],fingerprint:'empty'}),restorePayloads:async(payload)=>{for(const [name,b]of payload){expect(sql.query('SELECT name FROM restored WHERE name=?').get(name)).toBeNull();await writeFile(join(dir,'body-'+name.split('/')[1]),b);sql.query('INSERT INTO restored VALUES(?,?,?)').run(name,b.length,await crypto.sha256(b));c.advance(50);}return {changed:payload.size,pending:0,abandoned:0,warnings:[]};}};
 try{
  const perHead=800;for(let h=0;h<3;h++){const objects=Array.from({length:perHead},(_,i)=>{const bytes=new Uint8Array(128*1024).fill((h*perHead+i)%251);new DataView(bytes.buffer).setUint32(0,h*perHead+i);return {name:'reader/'+(h*perHead+i)+'.txt',bytes,compress:false};});const remote=await f.phone({sourceDeviceId:'phone-'+h,snapshotId:'scale-'+h,sequence:1,objects});expectedBytes+=remote.snap.encryptedManifest.length+[...remote.snap.newChunks.values()].reduce((n,b)=>n+b.length,0);}
  c.delay(1500);let done=false,rounds=0,previous=0;for(;rounds<30&&!done;rounds++){assemble();const service=c.make();done=await service.syncNow();const n=c.counts().sourceDecryptions;expect(n>previous||done||service.status.message.includes('检查点')).toBe(true);previous=n;expect(service.status.errorCode).not.toBe('cloud_snapshot_progress_stalled');}
  expect(done).toBe(true);expect(rounds).toBeGreaterThan(8);expect((sql.query('SELECT count(*) n,sum(bytes) bytes FROM restored').get() as any)).toEqual({n:2400,bytes:300*1024*1024});expect(downloadBytes).toBe(expectedBytes);expect(c.counts()).toEqual({sourceDecryptions:2400,pulls:2,interactions:2});
  const summary={logicalBytes:300*1024*1024,objects:2400,rounds,downloadBytes,expectedBytes,...c.counts(),deadlineClock:'logical',sourceAesWallP95Millis:[...c.sourceAesWall].sort((a,b)=>a-b)[Math.floor(c.sourceAesWall.length*.95)],maxChunkMillis:Math.max(...c.metrics.filter(m=>m.stage==='chunk'&&!m.cached).map(m=>m.durationMillis))};console.info('SNAPSHOT_SCALE',JSON.stringify(summary));
 }finally{sql.close();await rm(dir,{recursive:true,force:true});}
},120000);

test('a crash after the final encrypted part write reuses that source chunk even before its ledger counter commits',async()=>{
 const c=await controlled(),{f}=c;const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('same-epoch','same-generation'),token=await cp.token('chunk-under-test');let fail=true;
 const store=f.state.storeRestoreJournal.bind(f.state);f.state.storeRestoreJournal=async(...args)=>{if(fail&&args[1]!==undefined){fail=false;throw Error('synthetic durable counter interruption');}return store(...args);};
 await expect(cp.write(token,utf8Encode('complete verified part'))).rejects.toThrow('synthetic durable');expect(utf8Decode((await cp.read(token))!)).toBe('complete verified part');cp.close();
});
test('account cancellation after source AEAD cannot publish a local apply proof or cloud ACK',async()=>{
 const c=await controlled(),{f}=c;await f.phone();let valid=true;
 const check=async()=>{if(!valid)throw Error('cloud_operation_superseded');};f.session.assertCurrent=check;
 const original=c.codec.restore.bind(c.codec);c.codec.restore=async(...args)=>{const result=await original(...args);valid=false;return result;};f.session.restoreCheckpoint={cache:f.cache,state:f.state,codec:c.codec,assertCurrent:check};
 expect(await c.make().syncNow()).toBe(false);expect(f.merged).toEqual([]);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(c=>c.url.endsWith('/ack'))).toBe(false);
});

test('corrupt cached source ciphertext repairs exactly once instead of pinning a pending object forever',async()=>{
 const c=await controlled(),{f}=c,{snap}=await f.phone({objects:[{name:'reader/corrupt.txt',bytes:utf8Encode('original'),compress:false}]});const [hash,blob]=[...snap.newChunks][0];await f.cache.storeChunk('user',hash,blob);const path=[...f.blobs.keys()].find(p=>p.endsWith('/'+hash+'.bin'))!;f.blobs.get(path)![0]^=1;f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});
 expect(await c.make().syncNow()).toBe(true);expect(c.counts().sourceDecryptions).toBe(1);expect(f.merged).toEqual(['reader/corrupt.txt']);expect(f.calls.filter(r=>new URL(r.url).host==='objects.invalid'&&new URL(r.url).pathname.endsWith(hash))).toHaveLength(1);
});

test('a later stuck export has a fixed no-progress outcome after restored heads, rather than resetting the restore loop forever',async()=>{
 const c=await controlled(),{f}=c;await f.phone({objects:[{name:'reader/complete.txt',bytes:utf8Encode('complete')}]});f.session.library.exportPayloads=async()=>{c.advance(300000);return {objects:[],fingerprint:'empty'};};
 let stalled=false;for(let i=0;i<4;i++){const service=c.make();expect(await service.syncNow()).toBe(false);if(service.status.errorCode==='cloud_snapshot_progress_stalled'){stalled=true;expect(service.status.retryable).toBe(true);break;}}
 expect(stalled).toBe(true);expect(f.merged).toEqual(['reader/complete.txt']);expect(c.counts().sourceDecryptions).toBe(1);
});

test('an unknown incompatible manifest remains opaque even if its future object directory is not an array',async()=>{
 const c=await controlled(),{f}=c,m={format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:'opaque-head',sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},features:{incompat:['future.snapshot.v99'],roCompat:[]},objects:{futureDirectory:true},credentialEnvelopes:{}};
 const salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/manifest/v2/opaque-head')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:opaque-head'),utf8Encode(JSON.stringify(m))),bytes=new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext])),hash=await crypto.sha256(bytes);derived.fill(0);
 f.objects.set(hash,bytes);f.heads.set('phone',{id:'opaque-head',sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,manifestSha256:hash,manifestSizeBytes:bytes.length,parentHeads:{},observedHeads:{}});f.session.client.snapshot=async()=>({manifestUrl:'https://objects.invalid/'+hash,chunks:[]});f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});
 const service=c.make();expect(await service.syncNow()).toBe(false);expect(service.status.formatCompatibility).toMatchObject({opaque:1,upgradeRequired:true});expect(f.merged).toEqual([]);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
});

test('200 entryRefs into one 40 MiB backing use authenticated ranges rather than rebuilding/decrypting the whole ZIP per entry',async()=>{
 const c=await controlled(),{f}=c,entries=new Map<string,Uint8Array>();entries.set('padding.bin',new Uint8Array(15*1024*1024));for(let i=0;i<200;i++)entries.set('text/'+i+'.txt',new Uint8Array(128*1024).fill(i));const backing=writeWrss(entries),{snap,head}=await f.phone({objects:[{name:'private-library.wrss',bytes:backing,compress:false}]});
 const m={...snap.manifest,objects:[...snap.manifest.objects,...Array.from({length:200},(_,i)=>({name:'reader/ref-'+i+'.txt',features:{incompat:['r48.entry-ref.v1'],roCompat:[]},originalBytes:128*1024,entryRef:{object:'private-library.wrss',entryPath:'text/'+i+'.txt',encoding:'identity'}}))]};
 const salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/manifest/v2/'+head.id)),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:'+head.id),utf8Encode(JSON.stringify(m))),bytes=new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext])),hash=await crypto.sha256(bytes);derived.fill(0);f.objects.set(hash,bytes);f.heads.set('phone',{...head,manifestSha256:hash,manifestSizeBytes:bytes.length});f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});
 f.session.client.snapshot=async()=>({manifestUrl:'https://objects.invalid/'+hash,chunks:snap.manifest.objects.flatMap(o=>o.chunks.map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:'https://objects.invalid/'+c.ciphertextSha256})))});
 await c.make().syncNow();expect(c.counts().sourceDecryptions).toBe(snap.manifest.objects[0].chunks.length);expect(f.merged).toHaveLength(201);expect(await f.state.applied('phone',true)).toBe(1);const rangeDecryptBytes=c.metrics.filter(m=>m.stage==='checkpoint-range-piece').reduce((n,m)=>n+m.bytes,0);expect(rangeDecryptBytes).toBeLessThan(backing.length*3);console.info('SNAPSHOT_ENTRY_REFS',JSON.stringify({entries:200,backingBytes:backing.length,sourceDecryptions:c.counts().sourceDecryptions,rangeDecryptBytes}));
},30000);

test('a legacy reader arriving after a different head materializes its metadata is not stranded behind an exhausted lookup iterator',async()=>{
 const c=await controlled(),{f}=c,db=await dbFixture();try{const a=article({articleId:await cloudCrypto.stableId('https://legacy.invalid/body'),url:'https://legacy.invalid/body',contentHtml:null,contentText:'legacy original'}),stem='bodies/'+await crypto.sha256(utf8Encode(a.articleId)),archive=writeWrss(new Map([['manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3}))],['articles.json',utf8Encode(JSON.stringify([{...a,contentText:undefined,contentHtml:undefined,contentTextEntry:stem+'.txt',contentHtmlEntry:null}]))],[stem+'.txt',utf8Encode(a.contentText)]])),name='reader/'+(await crypto.sha256(utf8Encode(a.articleId))).slice(0,32)+'/'+(await crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)+'.txt';
  await f.phone({sourceDeviceId:'phone-a',sequence:1,objects:[{name:'reader/orphan.txt',bytes:utf8Encode('orphan')},{name:'private-library.wrss',bytes:archive,compress:false}]});await f.phone({sourceDeviceId:'phone-b',sequence:1,objects:[{name,bytes:utf8Encode(a.contentText)}]});f.session.library=db.adapter;f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});
  expect(await c.make().syncNow()).toBe(true);expect(await f.state.applied('phone-b',true)).toBe(1);expect(await f.state.warned('phone-b',f.heads.get('phone-b')!.id)).toBe(false);expect((await db.repo.cloudSnapshot(true)).articles[0].contentText).toBe(a.contentText);
 }finally{db.sql.close();}
});

test('one 500-entry public inventory commits bounded SQLite batches, preserves its response checkpoint and avoids repeated pool fetches',async()=>{
 const c=await controlled(),{f}=c,db=await dbFixture();try{
  const source={url:'https://pool.invalid/rss',title:'Pool',description:'',siteUrl:'',imageUrl:'',createdAt:1,sortOrder:1,isPinned:false,sourceDeviceId:'watch',updatedAt:1,deleted:false,deletedAt:0};await db.repo.mergeCloud([source],[],'watch');
  const merge=db.repo.mergeCloud.bind(db.repo);let materialized=0;db.repo.mergeCloud=async(...args)=>{const n=await merge(...args);materialized+=args[1].length;c.advance(24000);return n;};let fetched=0;
  f.session.client.resolveRssSource=async()=>{fetched++;return {sourceId:'pool-id',url:source.url,title:'Pool',description:'',siteUrl:null,imageUrl:null,items:Array.from({length:500},(_,i)=>({url:'https://news.invalid/'+i,title:'Item '+i,excerpt:'',contentHtml:null,imageUrl:null,guid:'guid-'+i,contentText:'body '+i,contentHash:'hash-'+i}))};};
  f.session.library=db.adapter;f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});let complete=false;for(let i=0;i<10&&!complete;i++)complete=await c.make().syncNow();expect(complete).toBe(true);expect(fetched).toBe(1);expect(materialized).toBe(500);expect((db.sql.query('SELECT count(*) n FROM articles').get() as any).n).toBe(500);expect((db.sql.query('SELECT count(*) n FROM cloud_rss_article_ids').get() as any).n).toBe(500);
 }finally{db.sql.close();}
},30000);

test('legacy one-stream gzip exceeding the host contiguous-buffer limit gives a fixed capacity code without retry or false ACK',async()=>{
 const c=await controlled(),{f}=c,packed=await crypto.gzip(utf8Encode('too large for test host')),remote=await f.phone({objects:[{name:'private-library.wrss',bytes:packed,compress:false}]});remote.snap.manifest.objects[0].encoding='gzip';remote.snap.manifest.objects[0].originalBytes=23;
 const m=remote.snap.manifest,salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/manifest/v2/'+m.snapshotId)),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:'+m.snapshotId),utf8Encode(JSON.stringify(m))),bytes=new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext])),hash=await crypto.sha256(bytes);derived.fill(0);f.objects.set(hash,bytes);f.heads.set('phone',{...remote.head,manifestSha256:hash,manifestSizeBytes:bytes.length});f.session.restoreCheckpoint={cache:f.cache,state:f.state,codec:new WatchCloudCodec({...crypto,contiguousOutputLimit:8},enabled)};
 const service=c.make();expect(await service.syncNow()).toBe(false);expect(service.status).toMatchObject({errorCode:'cloud_snapshot_unit_capacity',retryable:false});expect(await f.state.applied('phone',true)).toBe(0);expect(f.merged).toEqual([]);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
});

test('provisional stream output stays unreadable until the final secure publish, across part and receipt interruptions',async()=>{
 const {SnapshotRestoreCheckpoint}=await import('../../src/cloud/snapshot-checkpoint');
 const f=await fixture(),body=new Uint8Array(2*262144+17).fill(37),source=await crypto.gzip(body),token='a'.repeat(64)+'-object',child='a'.repeat(64)+'-chunk-0';
 let stopAfter=1,calls=0,invalidHash=false;
 const codec=f.session.codec,stream=async(_key:Uint8Array,parts:any[],length:number,prefix:string,aadPrefix:string,maximum:number,offset:number,receipt:(v:any)=>Promise<void>)=>{
  expect(length).toBe(source.length);expect(maximum).toBe(body.length);
  for(let at=offset;at<body.length;at+=262144){const part=body.subarray(at,at+262144),sealed=await codec.sealRestoreProjection(key,aadPrefix+at,part);f.blobs.set(prefix+at+'.bin',sealed);calls++;await receipt({offset:at,bytes:part.length,done:at+part.length===body.length});if(calls===stopAfter)throw Error('cloud_sync_deadline_exceeded');}
  return invalidHash?'0'.repeat(64):crypto.sha256(body);
 };
 (codec as any).streamRestoreGzip=stream;
 const open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('stream-epoch','generation');
 let cp=await open();await cp.begin();await cp.write(child,source);
 await expect(cp.gunzip(token,[child],body.length,await crypto.sha256(body))).rejects.toThrow('cloud_sync_deadline_exceeded');expect(cp.committed).toBe(true);expect(cp.has('decoded:'+token)).toBe(false);expect(await cp.read(token)).toBeUndefined();const provisional=(await cp.index(token))!;expect(provisional.parts.at(-1)).toBe(token+'-pending');expect(provisional.lengths.at(-1)).toBe(0);expect(provisional.parts.some(id=>!Object.prototype.hasOwnProperty.call((cp as any).value.projections,id))).toBe(true);await expect(cp.range(token,0,1)).rejects.toThrow('cloud_snapshot_projection_missing');const previous=cp.work;cp.close();
 cp=await open();expect(cp.work).toBe(previous);stopAfter=100;invalidHash=true;await expect(cp.gunzip(token,[child],body.length,await crypto.sha256(body))).rejects.toThrow('cloud_snapshot_projection_integrity');expect(await cp.read(token)).toBeUndefined();expect(cp.has('decoded:'+token)).toBe(false);cp.close();
 cp=await open();invalidHash=false;const before=calls;await cp.gunzip(token,[child],body.length,await crypto.sha256(body));expect(calls).toBe(before);expect(await cp.read(token)).toEqual(body);expect((await cp.index(token))!.parts).not.toContain(token+'-pending');cp.close();
 cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('different-epoch','generation');expect(cp.has('decoded:'+token)).toBe(false);expect(await cp.read(token)).toBeUndefined();cp.close();
});

test('outgoing materialization after a ranged inbound restore reopens the full projection instead of its empty marker',async()=>{
 const {restoreSnapshots}=await import('../../src/cloud/snapshot-restore');const f=await fixture();
 const archive=writeWrss(new Map([['manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3}))],['articles.json',utf8Encode('[]')],['padding.bin',new Uint8Array(9*1024*1024).fill(37)]]));
 await f.phone({objects:[{name:'private-library.wrss',bytes:archive,compress:false}]});f.session.client.setEpoch((await f.session.client.bootstrap()).libraryEpoch);f.session.client.setContentGeneration(f.content().contentGeneration);f.session.library.restorePayloads=async()=>({changed:0,pending:0,abandoned:0,warnings:[]});
 const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('ranged-epoch','generation');await cp.begin();
 const restored=await restoreSnapshots({session:f.session,heads:[...f.heads.values()],full:true,journal:cp,current:async()=>{},manifest:(h,b)=>f.session.codec.decryptManifest(key,h.id,b),hash:crypto.sha256,supported:()=>true,now:()=>0,status:()=>{},changed:()=>{}});
 const manifest=restored.snapshots[0].manifest;expect(await restored.readObject(manifest,manifest.objects[0])).toEqual(archive);cp.close();
});
