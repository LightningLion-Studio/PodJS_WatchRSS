import {test,expect} from 'bun:test';
import {binaryRuntime,nonce} from '../helpers/library-binary-runtime';
import {BinaryByteTransport} from '../../src/sync/library-binary/transport';
import {encodeFrame,decodeFrame} from '../../src/sync/library-binary/codec';
import {capabilityDigest,requestDigest,preparationDigest,selectionDigest,objectId,objectsRoot,planDigest,pageDigest,receiptsRoot} from '../../src/sync/library-binary/digests';
import {hash,utf8,type Envelope,type Row,type ObjectDescriptor,type Capability,type BeginPayload} from '../../src/sync/library-binary/wire';
import {negotiate} from '../../src/sync/library-binary/routing';
import {HostServiceError} from '@podjs/framework/services';
async function ready(f:Awaited<ReturnType<typeof binaryRuntime>>){const s=f.session(),legacy=async(r:Row)=>{await s.connection.writeFrame(r);const reply=await s.connection.readFrame(3000);await s.connection.writeFrame({action:'ack',success:true,applied:true});return reply;};const probe=await legacy({action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportedLibraryBinaryVersions:[2],supportsPersistentSession:true,requestPersistentSession:true});await legacy({action:'syncAccount',version:1,deviceId:'phone',account:{userId:'b2-host'}});return {s,probe,legacy};}
function request(phase:Envelope['phase'],payload:Row,job:string|null=null,plan:string|null=null,epoch:number|null=null):Envelope{return {action:'syncLibraryBinary',version:2,type:'request',phase,jobId:job,planDigest:plan,epoch,requestId:nonce(),requestDigest:requestDigest(job,plan,phase,payload),payload};}
export {ready,request};
test('real legacy session → switch → raw DATA → durable business receipt, with terminal resume',async()=>{
 let busy=true;const f=await binaryRuntime({fault:m=>{if(busy&&m.endsWith('.stage')){busy=false;throw Error('BUSY');}}});try{
  const {s,probe}=await ready(f);expect(probe.libraryBinary).toBeDefined();const cap=probe.libraryBinary as unknown as Capability;
  await s.connection.writeFrame({action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}});expect((await s.connection.readFrame(3000)).success).toBe(true);
  const io=new BinaryByteTransport(s.connection.detachStream()),call=async(r:Envelope)=>{await io.writeFrame(encodeFrame({kind:'control',envelope:r}));const a=decodeFrame(await io.readFrame());if(a.kind!=='control')throw Error('control expected');expect(a.envelope.success).toBe(true);return a.envelope;};
  const selection=negotiate(cap,cap)!,phoneSnapshot={snapshotId:'phone',manifestDigest:'a'.repeat(64),fromExclusive:0,toInclusive:0};
  const offer=request('prepare',{step:'offer',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',phoneCapabilities:cap,phoneSnapshot,watchSnapshot:null});const offered=await call(offer),watchSnapshot=offered.result!.watchSnapshot;
  const job=nonce(),bindings=[{jobId:job,direction:'phoneToWatch',intent:'create',selection}];await call(request('prepare',{step:'confirm',offerRequestId:offer.requestId,bindings,preparationDigest:preparationDigest(String(offered.result!.offerDigest),bindings as any)}));
  const bytes=Uint8Array.from({length:65555},(_,i)=>i&255),metadataUtf8=JSON.stringify({storageKey:'picture.png',sha256:hash(bytes),size:bytes.length});const d:ObjectDescriptor={objectId:'',kind:'noteAsset',schemaVersion:1,businessId:'picture.png',contentVersion:hash(bytes),encoding:'raw',size:bytes.length,sha256:hash(bytes),chunkBytes:65536,chunkHashes:[hash(bytes.slice(0,65536)),hash(bytes.slice(65536))],metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),dependsOn:[]};d.objectId=objectId(d);
  const p={intent:'create',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',direction:'phoneToWatch',phoneSnapshot,watchSnapshot,selection,selectionDigest:selectionDigest(selection),objectCount:1,objectsRoot:objectsRoot([d.objectId]),pageObjectCounts:[1]} as BeginPayload;const plan=planDigest(p);const began=await call(request('begin',p as unknown as Row,job,plan));const epoch=began.epoch!;
  const hb=await call(request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0},job,plan,epoch));expect(hb.result!.state).toBe('PLANNING');expect(f.stats().stageCalls).toBe(0);
  await call(request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(plan,0,0,[d],'0'.repeat(64)),entries:[d]},job,plan,epoch));
  let seq=1;for(let i=0;i<2;i++){const digest=requestDigest(job,plan,'putChunk',{objectId:d.objectId,chunkIndex:i}),id=nonce();for(;;){await io.writeFrame(encodeFrame({kind:'data',streamId:1,objectSlot:0,epoch,txSeq:seq++,chunkIndex:i,requestId:id,requestDigest:digest,payload:bytes.slice(i*65536,(i+1)*65536)}));const ack=decodeFrame(await io.readFrame());if(ack.kind==='ack')break;expect(ack.kind).toBe('control');if(ack.kind==='control')expect(ack.envelope.error!.code).toBe('BUSY');}}

  const applied=await call(request('apply',{objectId:d.objectId},job,plan,epoch));expect(applied.result!.state).toBe('APPLIED');const rows=await f.db.query('SELECT * FROM library_binary_assets');expect(rows.length).toBe(1);expect((await f.files.hash('notes/assets/picture.png')).sha256).toBe(d.sha256);
  const done=await call(request('complete',{objectCount:1,receiptsRoot:receiptsRoot([applied.result!.receipt as any]),ackToInclusive:0},job,plan,epoch));expect(done.result!.state).toBe('COMPLETE');await s.running;expect(f.stats().peak).toBe(65536);
  const resumed=await ready(f);await resumed.s.connection.writeFrame({action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}});await resumed.s.connection.readFrame(3000);const resumedIo=new BinaryByteTransport(resumed.s.connection.detachStream());const resumedCall=async(r:Envelope)=>{await resumedIo.writeFrame(encodeFrame({kind:'control',envelope:r}));const answer=decodeFrame(await resumedIo.readFrame());if(answer.kind!=='control')throw Error('control expected');expect(answer.envelope.success).toBe(true);return answer.envelope;};const resumedOffer=request('prepare',{step:'offer',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',phoneCapabilities:cap,phoneSnapshot,watchSnapshot});const resumedOffered=await resumedCall(resumedOffer);const resumedBindings=[{jobId:job,direction:'phoneToWatch',intent:'resume',selection}];await resumedCall(request('prepare',{step:'confirm',offerRequestId:resumedOffer.requestId,bindings:resumedBindings,preparationDigest:preparationDigest(String(resumedOffered.result!.offerDigest),resumedBindings as any)}));const terminal=await resumedCall(request('begin',{...p,intent:'resume'} as unknown as Row,job,plan));expect(terminal.result!.state).toBe('COMPLETE');expect(terminal.result!.completion).toEqual(done.result);await resumed.s.running;expect((await f.db.query('SELECT * FROM library_binary_assets')).length).toBe(1);

 }finally{await f.dispose();}
},15000);
test('release off retains the baseline probe and never initializes B2 storage',async()=>{const f=await binaryRuntime({enabled:false});try{const s=f.session();await s.connection.writeFrame({action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportedLibraryBinaryVersions:[2]});const r=await s.connection.readFrame(3000);expect(r.libraryBinary).toBeUndefined();await s.connection.writeFrame({action:'ack',success:true,applied:true});await s.running;expect(await f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'library_binary_%'")).toEqual([]);}finally{await f.dispose();}});

test('off executes the complete v1 handshake with byte-identical baseline responses',async()=>{
 const {existsSync}=await import('node:fs'),{resolve}=await import('node:path'),{pathToFileURL}=await import('node:url');const base=process.env.B2_LEGACY_BASELINE_ROOT??resolve(import.meta.dir,'../../../PodJS_WatchRSS');if(!existsSync(resolve(base,'src/sync/session.ts')))throw Error('baseline checkout required');
 const Baseline=(await import(pathToFileURL(resolve(base,'src/sync/session.ts')).href)).LibrarySyncSession,{LibrarySyncSession}=await import('../../src/sync/session'),{encodeFrame:legacyEncode}=await import('../../src/sync/protocol');
 const f=await binaryRuntime({enabled:false});try{const input=[{action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportedLibraryBinaryVersions:[2],supportsPersistentSession:true,requestPersistentSession:true},{action:'ack',success:true,applied:true},{action:'syncAccount',version:1,account:{userId:'b2-host'}},{action:'ack',success:true,applied:true},{action:'syncSession',phase:'complete'},{action:'ack',success:true,applied:true}];
  async function run(Session:any,binary?:any){const queue=structuredClone(input),out:Uint8Array[]=[];const connection={readFrame:async()=>queue.shift()!,writeFrame:async(r:Row)=>{out.push(legacyEncode(r));},close:async()=>{}};await new Session(connection,{deviceId:async()=>'watch',configurePeer:()=>{}},{binary,now:()=>0,handleAction:async(r:Row)=>({success:true,action:r.action,version:1})}).run();return out;}
  expect(await run(LibrarySyncSession,f.service)).toEqual(await run(Baseline));expect(await f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'library_binary_%'")).toEqual([]);
 }finally{await f.dispose();}
});

test('actual RFCOMM owner feeds all three recovery STOP rules without a fourth attempt',async()=>{
 async function dropped(f:Awaited<ReturnType<typeof binaryRuntime>>){const {s,probe}=await ready(f);const cap=probe.libraryBinary as unknown as Capability;await s.connection.writeFrame({action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}});await s.connection.readFrame(3000);await s.pair.close();return s.running.then(()=>{throw Error('failure expected');},e=>e);}
 for(const rule of ['search','tenSeconds','noProgress']){const f=await binaryRuntime();let at=0;f.ports.now=()=>at;try{
  let error=await dropped(f);expect(error.stopAutomaticRecovery).toBe(false);
  if(rule==='search'){for(let i=1;i<=3;i++){error=f.service.failed(Error('SocketTimeout'));expect(error.stopAutomaticRecovery).toBe(i===3);}}
  if(rule==='tenSeconds'){for(let i=1;i<=2;i++){at=i*5000;error=await dropped(f);expect(error.stopAutomaticRecovery).toBe(i===2);}}
  if(rule==='noProgress'){for(let i=1;i<=3;i++){at=i*20000;error=await dropped(f);expect(error.stopAutomaticRecovery).toBe(i===3);}}
 }finally{await f.dispose();}}
},15000);

test('foreground listener stops on the B2 fatal result instead of scheduling a retry',async()=>{
 const {ForegroundSyncController}=await import('../../src/sync/foreground');let starts=0,delays=0;const c=new ForegroundSyncController({createListener:()=>({start:async()=>{starts++;throw Object.assign(Error('HASH_MISMATCH'),{stopAutomaticRecovery:true});},stop:()=>{}}),delay:()=>{delays++;return {result:new Promise(()=>{}),cancel:()=>{}};},keepScreenOn:()=>{},acquireMedia:()=>{},releaseMedia:()=>{}});c.update({resumed:true,interactive:true,exclusive:false,permission:true,enabled:true});await new Promise(r=>setTimeout(r,10));expect(starts).toBe(1);expect(delays).toBe(0);await c.dispose();
});

test('a host stream reset after the B2 switch remains eligible for automatic reconnect',async()=>{
 let inject=false;
 // The paired native probe supplies the code from the real PodServices mapping.
 const hostCode=process.env.WRSS_R16_STREAM_RESET_CODE??'host_error';
 const f=await binaryRuntime({readFault:()=>{
  if(inject){inject=false;throw new HostServiceError(hostCode,'Connection reset');}
 }});
 try{
  const {s,probe}=await ready(f);
  await s.connection.writeFrame({action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),
   payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(probe.libraryBinary as unknown as Capability)}});
  expect((await s.connection.readFrame(3000)).success).toBe(true);
  inject=true;
  await s.pair.phone.write(Uint8Array.of(0));
  const failure=await s.running.then(()=>{throw Error('failure expected');},error=>error);
  expect(failure).toMatchObject({message:'reset',stopAutomaticRecovery:false});

  const {ForegroundSyncController}=await import('../../src/sync/foreground');
  let starts=0,retry!:()=>void,finish!:()=>void;
  const controller=new ForegroundSyncController({
   createListener:()=>({start:async()=>{
    if(++starts===1)throw failure;
    await new Promise<void>(resolve=>{finish=resolve;});
    return [];
   },stop:()=>finish?.()}),
   delay:ms=>({result:new Promise<void>(resolve=>{if(ms===500)retry=resolve;}),cancel:()=>retry?.()}),
   keepScreenOn(){},acquireMedia(){},releaseMedia(){},
  });
  try{
   controller.update({resumed:true,interactive:true,exclusive:false,permission:true,enabled:true});
   for(let turn=0;turn<12;turn++)await Promise.resolve();
   expect(starts).toBe(1);
   expect(retry).toBeDefined();
   retry();
   for(let turn=0;turn<12;turn++)await Promise.resolve();
   expect(starts).toBe(2);
  }finally{await controller.dispose();}
 }finally{await f.dispose();}
});

test('automatic B2 switch is Bluetooth-only and opt-in while the shared v1 allowlist stays frozen',async()=>{
 const {BluetoothActionPolicy,foregroundRequestFilter}=await import('../../src/sync/action-policy');
 const r={action:'syncLibraryBinary',version:2,type:'request',phase:'switch'};let enabled=true;const policy=new BluetoothActionPolicy(()=>enabled);
 expect(foregroundRequestFilter(r)?.success).toBe(false);expect(new BluetoothActionPolicy().filterRequest(r)?.success).toBe(false);expect(policy.filterRequest(r)).toBeUndefined();
 for(const changed of [{version:1},{type:'response'},{phase:'begin'}])expect(policy.filterRequest({...r,...changed})?.success).toBe(false);
 enabled=false;expect(policy.filterRequest(r)?.success).toBe(false);
});

test('v1 business pins the physical connection through reprobe and account confirmation',async()=>{
 const f=await binaryRuntime();
 const probe={action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',
  supportsPersistentSession:true,requestPersistentSession:true};
 const capableProbe={...probe,supportedLibraryBinaryVersions:[2]};
 const account={action:'syncAccount',version:1,deviceId:'phone',account:{userId:'b2-host'}};
 const business={action:'syncLlmTokenUsage',version:1,deviceId:'phone'};
 const ack={action:'ack',success:true,applied:true};
 type Session=ReturnType<typeof f.session>;
 async function legacy(s:Session,request:Row){
  await s.connection.writeFrame(request);
  const response=await s.connection.readFrame(3000);
  expect(response.success).toBe(true);
  await s.connection.writeFrame(ack);
  return response;
 }
 function switchRequest(cap:unknown):Row {
  return {action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),
   payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap as Capability)}};
 }
 try{
  for(const initial of [probe,capableProbe]){
   const s=f.session();
   try{
    const first=await legacy(s,initial);
    expect(Boolean(first.libraryBinary)).toBe(initial===capableProbe);
    await legacy(s,account);
    await legacy(s,business);
    // Keep the pin even across a probe that clears all B2 negotiation data.
    await legacy(s,probe);
    const repeated=await legacy(s,capableProbe);
    await legacy(s,account);
    await s.connection.writeFrame(switchRequest(repeated.libraryBinary));
    await expect(s.running).rejects.toThrow('AUTH_REVOKED');
   }finally{await s.pair.close();await s.running.catch(()=>{});}
  }
  const fresh=f.session();
  try{
   const negotiated=await legacy(fresh,capableProbe);
   await legacy(fresh,account);
   await fresh.connection.writeFrame(switchRequest(negotiated.libraryBinary));
   expect((await fresh.connection.readFrame(3000)).success).toBe(true);
  }finally{await fresh.pair.close();await fresh.running.catch(()=>{});}
 }finally{await f.dispose();}
});
