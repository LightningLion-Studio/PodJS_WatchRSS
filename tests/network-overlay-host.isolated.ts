import {expect,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {transformSync}=require('@babel/core');
plugin({
 name:'network-overlay-host-solid',
 setup(builder){
  builder.onLoad({filter:/\.tsx$/},async ({path})=>({
   contents:transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[
    [require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],
    [require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}],
   ]}).code,
   loader:'js',
  }));
 },
});

type Request={t:'service.request';id:number;method:string;args:{milliseconds?:number;subscriptionId?:string}};
type Cancel={t:'service.cancel';id:number;reason:string};

function hostFixture(){
 const emitted:(Request|Cancel)[]=[];
 const pending=new Map<number,Request>();
 const timers=new Map<number,number>();
 const events:unknown[]=[];
 let clock=0,snapshotSequence=0;
 (globalThis as {pod?:unknown}).pod={
  capabilities:()=>JSON.stringify(['net.discovery','runtime.timer']),
  takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
  emit:(line:string)=>{
   const message=JSON.parse(line) as Request|Cancel;
   if(message.t==='service.request'){
    emitted.push(message);
    pending.set(message.id,message);
    switch(message.method){
     case 'runtime.delay':timers.set(message.id,clock+message.args.milliseconds!);break;
     case 'discovery.networkSubscribe':reply(message.id,{subscriptionId:message.args.subscriptionId});break;
     case 'discovery.networkUnsubscribe':reply(message.id,{released:true});break;
    }
   }else if(message.t==='service.cancel'){
    emitted.push(message);
    pending.delete(message.id);
    timers.delete(message.id);
   }
  },
 };
 function reply(id:number,value?:unknown){
  pending.delete(id);
  timers.delete(id);
  events.push({t:'service.result',id,ok:true,value});
 }
 const flush=async()=>{for(let i=0;i<30;i++){__pumpPodEvents();await Promise.resolve();}};
 return {
  emitted,
  snapshots:()=>[...pending.values()].filter(message=>message.method==='discovery.networkSnapshot'),
  delays:()=>[...timers.keys()],
  async advance(ms:number){
   clock+=ms;
   for(const [id,due] of timers)if(due<=clock)reply(id);
   await flush();
  },
  response(id:number,validated:boolean){
   reply(id,{active:true,internet:true,validated,wifi:true,cellular:false,bluetooth:false,snapshotSequence:++snapshotSequence});
   return flush();
  },
  failSnapshot(id:number){
   pending.delete(id);
   events.push({t:'service.result',id,ok:false,code:'host_error',message:'snapshot unavailable'});
   return flush();
  },
  async onlineEvent(){
   const subscription=emitted.find(message=>message.t==='service.request'&&message.method==='discovery.networkSubscribe') as Request;
   events.push({t:'network.changed',subscriptionId:subscription.args.subscriptionId,value:{source:'default',reason:'available'}});
   await flush();
  },
  reply,flush,
 };
}

const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {serviceResourceCounts}=await import('@podjs/framework/services');
const {createHostNetworkRecovery}=await import('../src/ui/network-recovery.tsx');

async function openWaitingRoute(){
 const host=hostFixture();
 const network=createHostNetworkRecovery();
 network.setActive(true);
 const offline={code:'network_error'};
 let work=0,usable=false;
 await host.flush();
 await host.response(host.snapshots()[0]!.id,false);
 const result=network.run(async()=>{if(++work===1)throw offline;return 'loaded';},()=>usable).catch(error=>error);
 await host.flush();
 await host.response(host.snapshots()[0]!.id,false);
 expect(network.blocking).toBe(true);
 return {host,network,offline,result,work:()=>work,restoreCache:()=>{usable=true;network.refreshUsable();}};
}

test('a slow poll skips the next tick and its timeout frees the real host request',async()=>{
 const {host,network,result,work}=await openWaitingRoute();
 try{
  await host.advance(5000);
  const slow=host.snapshots()[0]!.id;
  await host.advance(5000);
  expect(host.snapshots().map(request=>request.id)).toEqual([slow]);
  await host.advance(5000);
  expect(host.emitted).toContainEqual(expect.objectContaining({t:'service.cancel',id:slow,reason:'timeout'}));
  expect(network.blocking).toBe(true);
  await host.response(slow,true);
  expect(work()).toBe(1);

  await host.advance(5000);
  expect(host.snapshots()).toHaveLength(1);
  await host.response(host.snapshots()[0]!.id,true);
  expect(await result).toBe('loaded');
  expect(network.blocking).toBe(false);
  expect(work()).toBe(2);
  expect(serviceResourceCounts().pending).toBe(0);
 }finally{
  network.dispose();
  await host.flush();
 }
});

for(const exit of ['observer','manual','cache','background','dispose'] as const){
 test(`recovery cancels real host snapshots on ${exit} and ignores their late replies`,async()=>{
  const {host,network,result,offline,work,restoreCache}=await openWaitingRoute();
  try{
   await host.advance(5000);
   const slow=host.snapshots()[0]!.id;
   const priorTimers=host.delays();
   if(exit==='observer'){
    await host.onlineEvent();
    const observer=host.snapshots().find(request=>request.id!==slow)!;
    await host.response(observer.id,true);
   }else if(exit==='manual'){
    const retry=network.retry();
    const manual=host.snapshots().find(request=>request.id!==slow)!;
    const cancel=host.emitted.findIndex(message=>message.t==='service.cancel'&&message.id===slow);
    const sent=host.emitted.findIndex(message=>message.t==='service.request'&&message.id===manual.id);
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(sent);
    await host.advance(5000);
    expect(host.snapshots().map(request=>request.id)).toEqual([manual.id]);
    await host.response(manual.id,true);
    await retry;
   }else if(exit==='cache'){
    restoreCache();
   }else if(exit==='background'){
    network.setActive(false);
   }else{
    network.dispose();
   }
   await host.flush();
   expect(host.emitted).toContainEqual(expect.objectContaining({t:'service.cancel',id:slow}));
   expect(host.snapshots()).toHaveLength(0);
   expect(host.delays()).toHaveLength(0);
   expect(serviceResourceCounts().pending).toBe(0);
   expect(network.blocking).toBe(false);
   const outcome=await result;
   if(exit==='observer'||exit==='manual')expect(outcome).toBe('loaded');
   else if(exit==='cache')expect(outcome).toBe(offline);
   else expect(outcome).toMatchObject({networkRecoveryCancelled:true});

   const emitted=host.emitted.length;
   for(const timer of priorTimers)host.reply(timer);
   await host.response(slow,true);
   await host.advance(20000);
   expect(host.emitted).toHaveLength(emitted);
   expect(work()).toBe(exit==='observer'||exit==='manual'?2:1);
  }finally{
   network.dispose();
   await host.flush();
  }
 });
}


test('closing the overlay cancels an active manual check and settles its retry',async()=>{
 const {host,network,offline,result,work,restoreCache}=await openWaitingRoute();
 try{
  const retry=network.retry();
  const manual=host.snapshots()[0]!.id;
  expect(network.overlayStatus).toBe('checking');
  restoreCache();
  await host.flush();
  expect(host.emitted).toContainEqual(expect.objectContaining({t:'service.cancel',id:manual}));
  await retry;
  expect(await result).toBe(offline);
  await host.response(manual,true);
  await host.advance(20000);
  expect({work:work(),pending:serviceResourceCounts().pending,blocking:network.blocking})
   .toEqual({work:1,pending:0,blocking:false});
 }finally{
  network.dispose();
  await host.flush();
 }
});

test.each([true,false])('concurrent recovery uses a fresh check, with offline confirmation=%p',async(confirmOffline)=>{
 const {host,network,result,offline,work}=await openWaitingRoute();
 try{
  let failSecond!:(error:unknown)=>void,secondCalls=0,secondSettled=false;
  const second=network.run(async()=>{
   if(++secondCalls===1)await new Promise<void>((_,reject)=>failSecond=reject);
   return 'second loaded';
  }).catch(error=>error).finally(()=>{secondSettled=true;});

  await host.advance(5000);
  const obsolete=host.snapshots()[0]!.id;
  await host.onlineEvent();
  await host.failSnapshot(host.snapshots().at(-1)!.id);
  expect(network.status).toBe('checking');

  failSecond(offline);
  await host.flush();
  const fresh=host.snapshots().find(request=>request.id!==obsolete);
  await host.response(obsolete,false);
  if(fresh&&confirmOffline)await host.response(fresh.id,false);
  const settledBeforeRecovery=secondSettled;

  await host.onlineEvent();
  await host.response(host.snapshots().at(-1)!.id,true);
  const outcomes=await Promise.all([result,second]);
  expect({freshCheck:!!fresh,settledBeforeRecovery,calls:[work(),secondCalls],outcomes}).toEqual({
   freshCheck:true,settledBeforeRecovery:false,calls:[2,2],outcomes:['loaded','second loaded'],
  });
  expect(serviceResourceCounts().pending).toBe(0);
 }finally{
  network.dispose();
  await host.flush();
 }
});

test.each([false,true])('shared initial check invalidation ignores a late snapshot with validated=%p',async(lateOnline)=>{
 const host=hostFixture(),network=createHostNetworkRecovery();
 const offline={code:'network_error'};
 network.setActive(true);
 try{
  await host.flush();
  await host.response(host.snapshots()[0]!.id,true);
  const calls=[0,0],settled=[false,false];
  const results=calls.map((_,index)=>network.run(async()=>{
   if(++calls[index]===1)throw offline;
   return `loaded ${index}`;
  }).catch(error=>error).finally(()=>{settled[index]=true;}));
  await host.flush();
  expect(host.snapshots()).toHaveLength(1);
  const obsolete=host.snapshots()[0]!.id;

  await host.onlineEvent();
  await host.failSnapshot(host.snapshots().at(-1)!.id);
  await host.response(obsolete,lateOnline);
  expect({calls,settled,status:network.status,blocking:network.blocking})
   .toEqual({calls:[1,1],settled:[false,false],status:'checking',blocking:false});

  if(lateOnline)await host.onlineEvent();
  else await host.advance(5000);
  await host.response(host.snapshots().at(-1)!.id,true);
  expect(await Promise.all(results)).toEqual(['loaded 0','loaded 1']);
  expect(calls).toEqual([2,2]);
  expect(serviceResourceCounts().pending).toBe(0);
 }finally{
  network.dispose();
  await host.flush();
 }
});
