import {test,expect} from 'bun:test';
import {RfcommLibraryListener,HostSyncByteStream,WATCH_RSS_RFCOMM_UUID,WATCH_RSS_RFCOMM_NAME,type RfcommPorts} from '../../src/sync/rfcomm.ts';
import {encodeFrame,FrameDecoder,type JsonObject} from '../../src/sync/protocol.ts';
import type {LibrarySessionRepository} from '../../src/sync/session.ts';
const operation=<T>(value:T)=>({result:Promise.resolve(value),cancel(){}});
function setup(request:JsonObject={action:'syncLibrary',phase:'probe',version:14}){const chunks=[encodeFrame(request),encodeFrame({action:'responseAck',success:true,phase:'applied',applied:true})];let offset=0;const closed=new Set<string>(),listenCalls:unknown[]=[],sent:JsonObject[]=[],decoder=new FrameDecoder();
 const ports:RfcommPorts={radio:{requestPermission:()=>operation("granted" as const),status:async()=>({available:true,permission:'granted',enabled:true}),listen:(name,uuid)=>{listenCalls.push([name,uuid]);return operation({id:'listener-1'});},accept:()=>operation({id:'stream-1',remoteName:'Phone',remoteAddress:'fixture'}),close:async id=>{closed.add(id);return {closed:true};}},streams:{read:(_id,max)=>{const head=chunks[0];if(!head)return operation({eof:true,dataBase64:''});const bytes=head.slice(offset,offset+Math.min(max,7));offset+=bytes.length;if(offset===head.length){chunks.shift();offset=0;}return operation({eof:false,dataBase64:Buffer.from(bytes).toString('base64')});},write:(_id,bytes)=>{sent.push(...decoder.push(bytes));return operation({written:bytes.length});},close:async id=>{closed.add(id);return {closed:true};}}};
 const repository={deviceId:async()=>'watch'} as LibrarySessionRepository;return {ports,closed,listenCalls,sent,listener:new RfcommLibraryListener(repository,ports)};
}
test('RFCOMM native identity carries a full probe session over fragmented byte reads',async()=>{const f=setup();const results=await f.listener.start();expect(f.listenCalls).toEqual([[WATCH_RSS_RFCOMM_NAME,WATCH_RSS_RFCOMM_UUID]]);expect(results).toHaveLength(1);expect(f.sent[0]).toMatchObject({success:true,action:'syncLibrary',phase:'probe',deviceId:'watch'});expect(f.closed).toEqual(new Set(['listener-1','stream-1']));});
test('stop while accepting cancels the host request and closes the listener',async()=>{const f=setup();let cancelled=false;let pendingReject:(error:Error)=>void=()=>{};let accepting!:()=>void;const ready=new Promise<void>(r=>accepting=r);f.ports.radio.accept=()=>{accepting();return {result:new Promise((_r,reject)=>pendingReject=reject),cancel(){cancelled=true;pendingReject(new Error('cancelled'));}};};const running=f.listener.start();await ready;f.listener.stop();await expect(running).rejects.toThrow('cancelled');expect(cancelled).toBe(true);expect(f.closed.has('listener-1')).toBe(true);});
test('stop during peer notification closes the accepted stream before running protocol work',async()=>{const f=setup();await expect(f.listener.start({onPeer:()=>f.listener.stop()})).rejects.toThrow('cancelled');expect(f.sent).toEqual([]);expect(f.closed).toEqual(new Set(['listener-1','stream-1']));});
test('permission failure opens no listener and simultaneous start is rejected',async()=>{const f=setup();f.ports.radio.status=async()=>({available:true,permission:'required',enabled:false});const first=f.listener.start();await expect(f.listener.start()).rejects.toThrow('already active');await expect(first).rejects.toThrow('权限');expect(f.listenCalls).toEqual([]);});
test('host stream checks complete write counts and makes close idempotent',async()=>{let closed=0;const f=setup();f.ports.streams.write=()=>operation({written:1});f.ports.streams.close=async()=>{closed++;return {closed:true};};const stream=new HostSyncByteStream('s',f.ports.streams);await expect(stream.write(new Uint8Array([1,2]))).rejects.toThrow('Incomplete');await stream.close();await stream.close();expect(closed).toBe(1);await expect(stream.read(1,10)).rejects.toThrow('closed');});
test('debug timeout overrides the default accept deadline',async()=>{const f=setup();const accept=f.ports.radio.accept;let timeout=0;f.ports.radio.accept=(id,ms)=>{timeout=ms??0;return accept(id,ms);};await f.listener.start({acceptTimeoutMs:4321});expect(timeout).toBe(4321);});

import {foregroundRequestFilter} from '../../src/sync/action-policy.ts';
test('RFCOMM automatic denies extra actions while active listener default allows them',async()=>{
 for(const filterRequest of [foregroundRequestFilter,undefined]){
  const f=setup({action:'pullDebugLog'});let handled=0;
  await f.listener.start({filterRequest,handleAction:async()=>{handled++;return {success:true,action:'pullDebugLog'};}});
  expect(f.sent[0]?.success).toBe(!filterRequest);expect(handled).toBe(filterRequest?0:1);
 }
});

import {LocalTransferActivity} from '../../src/sync/local-transfer';
import {CloudForegroundExecution} from '../../src/cloud/execution';
import {WatchCloudScheduler} from '../../src/cloud/scheduler';
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
test('passive RFCOMM listen/120s accept timeout never holds the cloud pause; only a decoded request fences it',async()=>{
 const activity=new LocalTransferActivity(),execution=new CloudForegroundExecution(true),events:boolean[]=[];
 activity.subscribe(active=>{events.push(active);execution.foreground(!active);});
 // Three consecutive automatic accepts time out, while the same cloud run is valid.
 const check=execution.begin();
 for(let i=0;i<3;i++){const f=setup();let reject!:(e:Error)=>void,accepting!:()=>void;const ready=new Promise<void>(resolve=>accepting=resolve);
  f.ports.radio.accept=()=>{accepting();return {result:new Promise((_r,r)=>reject=r),cancel(){reject(Error('cancelled'));}};};
  const run=f.listener.start({acquireSession:()=>activity.acquire()});await ready;check();expect(activity.active).toBe(false);reject(Error('accept timeout 120000'));await expect(run).rejects.toThrow('timeout');check();
 }
 expect(events).toEqual([]);
 const f=setup(),write=f.ports.streams.write;let finish!:()=>void,writing!:()=>void;const ready=new Promise<void>(r=>writing=r),wait=new Promise<void>(r=>finish=r);
 f.ports.streams.write=(...args)=>{const result=write(...args);writing();return {result:wait.then(()=>result.result),cancel(){finish();}};};
 const run=f.listener.start({acquireSession:()=>activity.acquire()});await ready;
 expect(activity.active).toBe(true);expect(check).toThrow('cloud_sync_suspended');finish();await run;expect(activity.active).toBe(false);expect(events).toEqual([true,false]);execution.begin()();expect(check).toThrow('cloud_sync_suspended');
});
test('a real decoded local session resumes the interrupted manual cloud run on close, also on protocol failure',async()=>{
 for(const failed of [false,true]){const activity=new LocalTransferActivity(),execution=new CloudForegroundExecution(true),f=setup(),write=f.ports.streams.write;
  let finishCloud!:(success:boolean)=>void,finishLocal!:()=>void,writing!:()=>void,calls=0;const ready=new Promise<void>(r=>writing=r),localWait=new Promise<void>(r=>finishLocal=r);
  const scheduler=new WatchCloudScheduler({sync:async()=>{calls++;return calls===1?new Promise<boolean>(r=>finishCloud=r):true;},now:()=>0,delay:()=>()=>{},scheduleWorker:async()=>{},cancelWorker:async()=>{}},{require(){}});
  activity.subscribe(active=>{execution.foreground(!active);scheduler.hold(active);});
  const cloud=scheduler.manual('all');await settle();const check=execution.begin();
  f.ports.streams.write=(...args)=>{const result=write(...args);writing();return {result:localWait.then(()=>{if(failed)throw Error('peer disconnected');return result.result;}),cancel(){finishLocal();}};};
  const local=f.listener.start({acquireSession:()=>activity.acquire()});const outcome=local.catch(e=>e);await ready;expect(check).toThrow('cloud_sync_suspended');finishCloud(false);await cloud;await settle();expect(calls).toBe(1);scheduler.foreground(true);expect(calls).toBe(1);finishLocal();const result=await outcome;if(failed)expect(String(result)).toContain('peer disconnected');await settle();expect(activity.active).toBe(false);expect(calls).toBe(2);scheduler.dispose();
 }
});
