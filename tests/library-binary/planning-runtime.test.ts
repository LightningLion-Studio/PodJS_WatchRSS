import {test,expect} from 'bun:test';
import {binaryRuntime,nonce} from '../helpers/library-binary-runtime';
import {BinaryByteTransport} from '../../src/sync/library-binary/transport';
import {encodeFrame,decodeFrame} from '../../src/sync/library-binary/codec';
import {capabilityDigest,requestDigest,preparationDigest,selectionDigest,objectId,objectsRoot,planDigest,pageDigest} from '../../src/sync/library-binary/digests';
import {hash,utf8,type Envelope,type Row,type ObjectDescriptor,type Capability,type BeginPayload} from '../../src/sync/library-binary/wire';
import {negotiate} from '../../src/sync/library-binary/routing';
class Clock {
 now=0;tasks:{at:number;run:()=>void;cancelled:boolean}[]=[];
 sleep=(ms:number)=>{const t={at:this.now+ms,run:()=>{},cancelled:false};const result=new Promise<void>(r=>{t.run=r;});this.tasks.push(t);return {result,cancel:()=>{t.cancelled=true;}};};
 async advance(ms:number){this.now+=ms;for(const t of this.tasks.splice(0)){if(t.cancelled)continue;if(t.at<=this.now)t.run();else this.tasks.push(t);}await new Promise(r=>setTimeout(r,5));}
}
async function setup(f:Awaited<ReturnType<typeof binaryRuntime>>){
 const s=f.session();const legacy=async(r:Row)=>{await s.connection.writeFrame(r);const reply=await s.connection.readFrame(3000);await s.connection.writeFrame({action:'ack',success:true,applied:true});return reply;};
 const probe=await legacy({action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportedLibraryBinaryVersions:[2],supportsPersistentSession:true,requestPersistentSession:true}),cap=probe.libraryBinary as unknown as Capability;await legacy({action:'syncAccount',version:1,deviceId:'phone',account:{userId:'b2-host'}});
 await s.connection.writeFrame({action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}});await s.connection.readFrame(3000);const io=new BinaryByteTransport(s.connection.detachStream(),f.ports.now),pending=new Map<string,{resolve:(r:Envelope)=>void;reject:(e:unknown)=>void}>();
 const pump=(async()=>{for(;;){const frame=decodeFrame(await io.readFrame());if(frame.kind!=='control')throw Error('unexpected frame');const p=pending.get(frame.envelope.requestId);if(!p)throw Error('unknown request');pending.delete(frame.envelope.requestId);p.resolve(frame.envelope);}})();void pump.catch(e=>{for(const p of pending.values())p.reject(e);pending.clear();});
 const job=nonce();let plan='',epoch:number|null=null;
 function request(phase:Envelope['phase'],payload:Row):Envelope{return {action:'syncLibraryBinary',version:2,type:'request',phase,jobId:phase==='prepare'?null:job,planDigest:phase==='prepare'?null:plan,epoch:['prepare','begin'].includes(phase)?null:epoch,requestId:nonce(),requestDigest:requestDigest(phase==='prepare'?null:job,phase==='prepare'?null:plan,phase,payload),payload};}
 async function send(r:Envelope){const answer=new Promise<Envelope>((resolve,reject)=>pending.set(r.requestId,{resolve,reject}));void answer.catch(()=>{});await io.writeFrame(encodeFrame({kind:'control',envelope:r}));return answer;}
 const selection=negotiate(cap,cap)!,phoneSnapshot={snapshotId:'phone',manifestDigest:'a'.repeat(64),fromExclusive:0,toInclusive:0};const offer=request('prepare',{step:'offer',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',phoneCapabilities:cap,phoneSnapshot,watchSnapshot:null}),offered=await send(offer);const bindings=[{direction:'phoneToWatch' as const,jobId:job,intent:'create' as const,selection}];await send(request('prepare',{step:'confirm',offerRequestId:offer.requestId,bindings,preparationDigest:preparationDigest(String(offered.result!.offerDigest),bindings)}));
 const objects:ObjectDescriptor[]=Array.from({length:6},(_,i)=>{const bytes=new Uint8Array([i]),metadataUtf8=JSON.stringify({storageKey:'asset-'+i+'.png',sha256:hash(bytes),size:1});const d:ObjectDescriptor={objectId:'',kind:'noteAsset',schemaVersion:1,businessId:'asset-'+i+'.png',contentVersion:hash(bytes),encoding:'raw',size:1,sha256:hash(bytes),chunkBytes:65536,chunkHashes:[hash(bytes)],metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),dependsOn:[]};d.objectId=objectId(d);return d;}).sort((a,b)=>a.objectId<b.objectId?-1:1);
 const p={intent:'create',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',direction:'phoneToWatch',phoneSnapshot,watchSnapshot:offered.result!.watchSnapshot,selection,selectionDigest:selectionDigest(selection),objectCount:6,objectsRoot:objectsRoot(objects.map(o=>o.objectId)),pageObjectCounts:[6]} as BeginPayload;plan=planDigest(p);epoch=(await send(request('begin',p as unknown as Row))).epoch;
 return {s,pump,send,request,objects,job,page:()=>request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(plan,0,0,objects,'0'.repeat(64)),entries:objects})};
}

test('PLANNING heartbeat bypasses 48 seconds of progressing native index work in the actual owner',async()=>{
 const clock=new Clock();let slow=false,steps=0;const f=await binaryRuntime({fault:async(m,a)=>{if(slow&&m==='file.resumable.status'&&a.operation==='object'){steps++;await clock.sleep(8000).result;}}});f.ports.now=()=>clock.now;f.ports.sleep=clock.sleep;
 try{const x=await setup(f);slow=true;let done=false;const manifest=x.send(x.page()).then(r=>{done=true;return r;});await new Promise(r=>setTimeout(r,10));let heartbeats=0;
  for(let i=1;i<=60&&!done;i++){await clock.advance(1000);if(i%10===0&&!done){const hb=await x.send(x.request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0}));expect(hb.success).toBe(true);expect(hb.result!.state).toBe('PLANNING');expect(hb.result!.items).toEqual([]);expect(hb.result!.nextManifestPage).toBe(0);heartbeats++;}}
  const result=await manifest;expect(result.success).toBe(true);expect(result.result!.state).toBe('READY');expect(steps).toBe(6);expect(heartbeats).toBeGreaterThanOrEqual(4);expect(f.stats().stageCalls).toBe(0);slow=false;await x.send(x.request('cancel',{reason:'USER_CANCEL'})).catch(()=>{});await x.s.running.catch(()=>{});await x.pump.catch(()=>{});
 }finally{await f.dispose();}
},15000);

test('local cancellation persists a tombstone before a paused PLANNING owner releases its connection',async()=>{
 const f=await binaryRuntime();try{const x=await setup(f);x.s.owner.stop();await x.s.running.catch(()=>{});await x.pump.catch(()=>{});const cancelled=await f.db.query('SELECT job_id FROM library_binary_cancellations');expect(cancelled).toEqual([{job_id:x.job}]);expect((await f.db.query('SELECT state FROM library_binary_jobs'))[0]!.state).toBe('CANCELLED');expect((await f.db.query('SELECT * FROM library_binary_assets')).length).toBe(0);}finally{await f.dispose();}
});
