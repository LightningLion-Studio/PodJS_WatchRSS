import {test,expect} from 'bun:test';
import {fixture} from './service-fixture';
import {crypto,key,enabled} from './k2-crypto';
import {WatchCloudCodec,type RestoreCodecCheckpoint} from '../../src/cloud/codec';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {restoreSnapshots} from '../../src/cloud/snapshot-restore';
import {RestoreProgressTracker,restoreProgressDiagnostic,type RestoreProgress} from '../../src/cloud/restore-progress';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
import {ReadBatch} from '@podjs/framework/read-batch';
const gates=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const copy=<T>(x:T):T=>JSON.parse(JSON.stringify(x));

async function runFixture(){
 const f=await fixture();f.client.setEpoch('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff');f.client.setContentGeneration(f.content().contentGeneration);
 const a=await f.phone({sourceDeviceId:'one',objects:[{name:'reader/a',bytes:new Uint8Array(700000).fill(11),compress:true}]});
 const b=await f.phone({sourceDeviceId:'two',objects:[{name:'reader/b',bytes:new Uint8Array(380000).fill(29),compress:false}]});
 const open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch','generation');
 const run=(cp:SnapshotRestoreCheckpoint,progress:(p:RestoreProgress)=>void)=>restoreSnapshots({session:f.session,heads:[a.head,b.head],full:true,journal:cp,current:async()=>{},manifest:(h,bytes)=>f.session.codec.decryptManifest(key,h.id,bytes),hash:crypto.sha256,supported:()=>true,now:()=>0,status:()=>{},changed:()=>{},progress});
 return {f,a,b,open,run};
}

test('two-head progress resumes legacy receipts, stays monotonic and persists exact totals only with ACK completion',async()=>{
 const {f,a,b,open,run}=await runFixture();let cp=await open();await cp.begin();
 // Seed exactly the old v1 format before any progress metadata exists.
 const old=a.head.manifestSha256+'-o0';await cp.commit('download:'+a.snap.manifest.objects[0].chunks[0].ciphertextSha256,a.snap.manifest.objects[0].chunks[0].ciphertextBytes);await cp.write(old+'-chunk-0',new Uint8Array(700000).fill(11));
 const oldHeader=JSON.parse((await f.state.restoreJournal())!);expect(oldHeader.restoreProgress).toBeUndefined();const oldWork=cp.work;cp.close();
 const progress:RestoreProgress[]=[];const apply=f.session.library.restorePayloads;let stop=true;
 f.session.library.restorePayloads=async(...args)=>{if(stop){stop=false;throw Error('cloud_sync_deadline_exceeded');}return apply(...args);};
 cp=await open();await expect(run(cp,p=>progress.push(copy(p)))).rejects.toThrow('deadline');expect(cp.has('decoded:'+old+'-chunk-0')).toBe(true);expect(cp.work).toBeGreaterThanOrEqual(oldWork);const persisted=copy(cp.progress);cp.close();
 cp=await open();await run(cp,p=>progress.push(copy(p)));const last=cp.progress!;
 expect(last.ready).toBe(true);expect(last.headsTotal).toBe(2);expect(last.headsDone).toBe(2);
 for(const phase of ['download','decompress','apply','projection'] as const){expect(last[phase].done).toBe(last[phase].total);expect(last[phase].doneBytes).toBe(last[phase].totalBytes);for(let i=1;i<progress.length;i++){expect(progress[i][phase].done).toBeGreaterThanOrEqual(progress[i-1][phase].done);expect(progress[i][phase].doneBytes).toBeGreaterThanOrEqual(progress[i-1][phase].doneBytes);}}
 expect(last.apply.total).toBe(2);expect(last.projection.total).toBe(5);expect(last.decompress.total).toBe(1);expect(last.download.total).toBe(new Set([...a.snap.manifest.objects[0].chunks,...b.snap.manifest.objects[0].chunks].map(c=>c.ciphertextSha256)).size);
 expect(progress.some(p=>p.apply.done===2&&p.headsDone<2)).toBe(true);expect(JSON.parse((await f.state.restoreJournal())!).restoreProgress.state).toEqual(last);expect(persisted!.headsDone).toBe(0);cp.close();
});

test('ACK failure never reports head complete; retry reconciles applied v1 objects without replay',async()=>{
 const {f,open,run}=await runFixture();f.flags({failAck:true});let cp=await open();await cp.begin();await expect(run(cp,()=>{})).rejects.toThrow();expect(cp.progress!.headsDone).toBe(0);const applied=f.merged.length;cp.close();f.flags({failAck:false});cp=await open();await run(cp,()=>{});expect(cp.progress!.headsDone).toBe(2);expect(f.merged.length).toBe(applied+1);cp.close();
});

test('one lookahead overlaps current verification and rejects unverified ciphertext before any apply',async()=>{
 const f=await fixture(),body=new Uint8Array(3*1024*1024);for(let i=0;i<body.length;i++)body[i]=(i*31+i%113)%256;
 const snap=await f.phone({objects:[{name:'reader/a',bytes:body,compress:false}]});const o=snap.snap.manifest.objects[0];expect(o.chunks.length).toBeGreaterThan(1);
 const started=gates(),release=gates();let calls=0,active=0,maxActive=0,writes=0,overlap=false;
 const codec=new WatchCloudCodec({...crypto,sha256:async bytes=>{if(bytes.length===o.chunks[0].ciphertextBytes&&calls>0){await started.promise;overlap=true;release.resolve();}return crypto.sha256(bytes);}},enabled);
 const fetch=async(c:typeof o.chunks[number])=>{calls++;active++;maxActive=Math.max(maxActive,active);if(c===o.chunks[1]){started.resolve();await release.promise;}active--;const b=f.objects.get(c.ciphertextSha256)!.slice();if(c===o.chunks[1])b[b.length-1]^=1;return b;};
 const work:RestoreCodecCheckpoint={check:async()=>{},read:async()=>undefined,write:async()=>{writes++;},prefetch:fetch};
 await expect(codec.restore(key,snap.snap.manifest,h=>fetch(o.chunks.find(c=>c.ciphertextSha256===h)!),[o],work)).rejects.toThrow();expect(overlap).toBe(true);expect(maxActive).toBeLessThanOrEqual(1);expect(writes).toBe(1);
});

test('cancellation drains pending fetch under lease and never commits its bytes',async()=>{
 const f=await fixture(),body=new Uint8Array(3*1024*1024);for(let i=0;i<body.length;i++)body[i]=i%253;
 const snap=await f.phone({objects:[{name:'reader/a',bytes:body,compress:false}]}),o=snap.snap.manifest.objects[0];const pending=gates(),release=gates();let cancelled=false,settled=false,writes=0;
 const codec=new WatchCloudCodec({...crypto,sha256:async b=>{if(b.length===o.chunks[0].ciphertextBytes){await pending.promise;cancelled=true;}return crypto.sha256(b);}},enabled);
 const check=async()=>{if(cancelled)throw Error('cloud_sync_suspended');};
 const work:RestoreCodecCheckpoint={check,read:async()=>undefined,write:async()=>{writes++;},prefetch:async c=>{if(c===o.chunks[1]){pending.resolve();await release.promise;}return f.objects.get(c.ciphertextSha256)!;}};
 const run=codec.restore(key,snap.snap.manifest,async()=>{throw Error('unexpected');},[o],work).finally(()=>{settled=true;});
 await pending.promise;await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);release.resolve();await expect(run).rejects.toThrow('cloud_sync_suspended');expect(writes).toBe(0);expect(settled).toBe(true);
});

test('projection source unit shares one bounded account lease',async()=>{
 const f=await fixture();let reads=0,batches=0;const batch=new ReadBatch<string,boolean>(async()=>{reads++;return true;});
 const check=async()=>{await batch.get('account');};const write=f.cache.storeRestoreProjection.bind(f.cache),store=f.state.storeRestoreJournalEntry.bind(f.state);
 f.cache.storeRestoreProjection=async(...args)=>{await check();return write(...args);};f.state.storeRestoreJournalEntry=async(...args)=>{await check();return store(...args);};
 f.session.restoreCheckpoint={state:f.state,cache:f.cache,codec:f.session.codec,assertCurrent:check,readBatch:async fn=>{batches++;return batch.run(fn);}};
 const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('e','g');reads=0;batches=0;await cp.write(await cp.token('x'),new Uint8Array(3*262144));expect(batches).toBe(1);expect(reads).toBe(1);cp.close();
});

test('release restore_progress schema drops all ids, free text and fractional/negative counts',async()=>{
 const rows:string[]=[];const d=backgroundDiagnostics(async<T>(_method:string,args:Record<string,unknown>)=>{rows.push(String(args.text));return null as T;});
 const p=restoreProgressDiagnostic({version:1,ready:true,full:true,headsTotal:2,headsDone:1,download:{total:1109,done:184,totalBytes:88647085,doneBytes:63867663},decompress:{total:2,done:1,totalBytes:100,doneBytes:50},apply:{total:2,done:0,totalBytes:100,doneBytes:0},projection:{total:4,done:2,totalBytes:100,doneBytes:50}});
 d.report(JSON.stringify({...p,id:'secret',scope:'secret',stage:'download',method:'file.read',projectionDone:-1,applyDone:1.5}));await d.flush();const text=rows.join('');expect(text).not.toMatch(/secret|stage|method|projectionDone\"|applyDone\"/);expect(text).toContain('"event":"restore_progress"');expect(text).toContain('"downloadTotal":1109');
});


test('progress rolls back with a failed atomic receipt and cannot invent applied work',async()=>{
 const {f,a,open}=await runFixture();const cp=await open();await cp.begin();
 await cp.planProgress('target',[{manifest:a.snap.manifest,manifestHash:a.head.manifestSha256,alreadyApplied:false,objects:a.snap.manifest.objects}],true);
 const before=cp.progress,header=await f.state.restoreJournal();f.state.storeRestoreJournalEntry=async()=>{throw Error('atomic failure');};
 await expect(cp.commit('applied:'+a.head.manifestSha256+'-o0')).rejects.toThrow('atomic failure');
 expect(cp.progress).toEqual(before);expect(await f.state.restoreJournal()).toBe(header);cp.close();
});
