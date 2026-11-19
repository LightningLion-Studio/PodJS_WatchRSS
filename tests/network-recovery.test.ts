import {test,expect} from 'bun:test';
import {NetworkRecovery,isTransportFailure,networkReadClient} from '../src/network/recovery.ts';
import {internetAvailability,observeInternet,type NetworkSnapshot} from '../src/onboarding/network.ts';
import type {InternetStatus} from '../src/onboarding/state.ts';
const transport=()=>Object.assign(new Error('offline'),{code:'network_error'});
const turn=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function fixture(initial:InternetStatus='unavailable'){
 let listener:(s:InternetStatus)=>void=()=>{},status=initial,stops=0,checks=0;
 const scope=new NetworkRecovery({observe:fn=>{listener=fn;fn(status);return()=>{stops++;};},check:async()=>{checks++;return status;}});
 scope.setActive(true);
 return {scope,set:(next:InternetStatus)=>{status=next;listener(next);},checkAs:(next:InternetStatus)=>{status=next;},stops:()=>stops,checks:()=>checks};
}
test('four system states and validated preferred transports use the shared monitor',()=>{
 const raw={active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:false};
 for(const value of ['checking','unavailable','bluetooth','available'] as const)expect(internetAvailability({...raw,internetStatusOverride:value})).toBe(value);
 expect(internetAvailability({...raw,bluetooth:true})).toBe('bluetooth');
 expect(internetAvailability({...raw,bluetooth:true,wifi:true})).toBe('available');
 expect(internetAvailability({...raw,bluetooth:true,validated:false})).toBe('unavailable');
});
test('offline alone does not block; failed transport arms mask, recovery retries exactly once',async()=>{
 const f=fixture();expect(f.scope.blocking).toBe(false);let calls=0;
 const result=f.scope.run(async()=>{if(++calls===1)throw transport();return 'loaded';});await turn();
 expect(f.scope.blocking).toBe(true);f.set('checking');expect(f.scope.blocking).toBe(true);
 f.set('available');expect(f.scope.blocking).toBe(false);expect(await result).toBe('loaded');
 f.set('unavailable');f.set('available');expect(calls).toBe(2);f.scope.dispose();
});
test('retry rechecks rather than assuming online; a failed second attempt does not loop',async()=>{
 const f=fixture();let calls=0;const error=transport();
 const result=f.scope.run(async()=>{calls++;throw error;}).catch(e=>e);await turn();
 await f.scope.retry();expect(calls).toBe(1);expect(f.checks()).toBe(2);expect(f.scope.blocking).toBe(true);
 f.checkAs('available');await f.scope.retry();expect(await result).toBe(error);expect(calls).toBe(2);expect(f.scope.blocking).toBe(false);f.scope.dispose();
});
test('HTTP, API, cancellation, signing and local storage errors never arm a network mask',async()=>{
 for(const error of [{kind:'http',httpStatus:503},{code:'network_error',status:404},{code:'host_error',message:'http_status:502'}, {code:'host_error',message:'upstream timed out',cause:{httpStatus:503}}, {code:'REQUEST_FAILED'},{kind:'api'}, {code:'cancelled'},Error('disk full')]){
  const f=fixture();expect(isTransportFailure(error)).toBe(false);expect(await f.scope.run(async()=>{throw error;}).catch(e=>e)).toBe(error);expect(f.scope.blocking).toBe(false);f.scope.dispose();
 }
 for(const error of [{code:'timeout'},{code:'ENOTFOUND'},{code:'webview_load_-8'},{code:'host_error',message:'Unable to resolve host test.invalid'},{kind:'transport'}])expect(isTransportFailure(error)).toBe(true);
});
test('Bluetooth is advisory and a recovered Bluetooth route retries pending work',async()=>{
 const f=fixture('bluetooth'),error=transport();
 expect(await f.scope.run(async()=>{throw error;}).catch(e=>e)).toBe(error);expect(f.scope.bluetooth).toBe(true);expect(f.scope.blocking).toBe(false);
 f.scope.dismissBluetooth();expect(f.scope.bluetooth).toBe(false);await f.scope.run(async()=>true);expect(f.scope.bluetooth).toBe(false);
 f.set('available');f.set('bluetooth');expect(f.scope.bluetooth).toBe(true);f.set('unavailable');let calls=0;
 const result=f.scope.run(async()=>{if(++calls===1)throw error;return 7;});await turn();f.set('bluetooth');expect(await result).toBe(7);expect(f.scope.blocking).toBe(false);f.scope.dispose();
});
test('usable local data prevents the mask and can release a pending failure',async()=>{
 const f=fixture(),error=transport();let usable=true,calls=0;
 expect(await f.scope.run(async()=>{calls++;throw error;},()=>usable).catch(e=>e)).toBe(error);expect(f.scope.blocking).toBe(false);
 usable=false;const result=f.scope.run(async()=>{calls++;throw error;},()=>usable).catch(e=>e);await turn();expect(f.scope.blocking).toBe(true);
 usable=true;f.scope.refreshUsable();expect(await result).toBe(error);expect(calls).toBe(2);expect(f.scope.blocking).toBe(false);f.scope.dispose();
});
test('route/lifecycle disposal cancels recovery and ignores a later online event',async()=>{
 const f=fixture();let calls=0;const result=f.scope.run(async()=>{calls++;throw transport();}).catch(e=>e);await turn();
 f.scope.setActive(false);expect((await result).code).toBe('cancelled');expect(f.stops()).toBe(1);f.set('available');expect(calls).toBe(1);expect(f.scope.blocking).toBe(false);f.scope.dispose();
});
test('closed result metadata preserves HTTP behavior and recovers actual transport only',async()=>{
 const f=fixture(),server={ok:false,code:'REQUEST_FAILED',httpStatus:500},offline={ok:false,code:'REQUEST_FAILED',networkFailure:true};
 expect(await f.scope.result(async()=>server)).toBe(server);expect(f.scope.blocking).toBe(false);let calls=0;
 const promise=f.scope.result(async()=>++calls===1?offline:{ok:true,data:9});await turn();expect(f.scope.blocking).toBe(true);f.set('available');expect(await promise).toEqual({ok:true,data:9});expect(calls).toBe(2);f.scope.dispose();
});
test('read client retains this and keeps mutations outside automatic recovery',async()=>{
 const f=fixture();class Client {value=3;calls=0;async read(){this.calls++;if(this.calls===1)throw transport();return this.value;}async mutate(){throw transport();}}
 const client=new Client(),wrapped=networkReadClient(client,f.scope,['read']);
 const promise=wrapped.read();await turn();expect(f.scope.blocking).toBe(true);f.set('available');expect(await promise).toBe(3);expect(client.calls).toBe(2);
 f.set('unavailable');await expect(wrapped.mutate()).rejects.toMatchObject({code:'network_error'});expect(f.scope.blocking).toBe(false);f.scope.dispose();
});
test('real Douyin client preserves only actual transport metadata through its result boundary',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');
 for(const [error,expected] of [[{code:'network_error'},true],[{code:'timeout'},true],[{code:'host_error',message:'http_status:503'},false],[Error('signer_or_disk_failure'),false]] as const){
  const values=new Map<string,string>();const client=new DouyinClient({transport:{async request(){throw error;}},signer:{sign:()=> 'synthetic-signature'},secureStorage:{get:async key=>values.get(key)??null,set:async(key,value)=>{values.set(key,value);},remove:async key=>{values.delete(key);}}});
  await client.applyCookie('sessionid=synthetic-session');const result=await client.fetchFeedPage({count:1});
  expect(result.ok).toBe(false);expect(isTransportFailure(result)).toBe(expected);
 }
});
test('a fresh failure rechecks a route even before the offline callback arrives',async()=>{
 const f=fixture('available');f.checkAs('unavailable');let calls=0;
 const result=f.scope.run(async()=>{if(++calls===1)throw transport();return 'ok';});await turn();expect(f.scope.blocking).toBe(true);
 f.set('available');expect(await result).toBe('ok');expect(calls).toBe(2);f.scope.dispose();
});
test('unknown status cannot turn a transport failure into confirmed offline',async()=>{
 const scope=new NetworkRecovery({observe:fn=>{fn('checking');return()=>{};},check:async()=>{throw Error('observation unavailable');}});scope.setActive(true);
 await expect(scope.run(async()=>{throw transport();})).rejects.toMatchObject({code:'network_error'});expect(scope.blocking).toBe(false);expect(scope.status).toBe('checking');scope.dispose();
});
test('a newer connectivity event wins over an older snapshot response',async()=>{
 let change!:(s:InternetStatus)=>void,resolve!:(s:InternetStatus)=>void;
 const scope=new NetworkRecovery({observe:fn=>{change=fn;fn('available');return()=>{};},check:()=>new Promise(done=>resolve=done)});scope.setActive(true);let calls=0;
 const result=scope.run(async()=>{if(++calls===1)throw transport();return 'ok';});await turn();change('unavailable');resolve('available');await turn();expect(scope.blocking).toBe(true);expect(scope.status).toBe('unavailable');change('available');expect(await result).toBe('ok');scope.dispose();
});
test('transport wrappers preserve typed causes without converting file failures into offline',()=>{
 expect(isTransportFailure({kind:'transport',cause:{code:'network_error'}})).toBe(true);
 expect(isTransportFailure({code:'cloud_sync_run_failed',cause:{code:'timeout'}})).toBe(true);
 expect(isTransportFailure({kind:'transport',cause:Error('disk full')})).toBe(false);
 expect(isTransportFailure({kind:'transport',cause:{code:'host_error',message:'http_status:500'}})).toBe(false);
});


test('Wi-Fi recovery clears the mask even if the observer never saw the outage',async()=>{
 const wifi:NetworkSnapshot={active:true,internet:true,validated:true,wifi:true,cellular:false,bluetooth:false};
 const offline={...wifi,validated:false};
 let snapshot=wifi,changed!:()=>void,calls=0;
 const scope=new NetworkRecovery({
  observe:fn=>observeInternet({
   snapshot:async()=>snapshot,
   subscribe:fn=>{changed=fn;return()=>{};},
  },fn,true),
  check:async()=>internetAvailability(snapshot),
 });
 scope.setActive(true);
 const error=transport();
 try{
  await turn();
  expect(scope.status).toBe('available');
  snapshot=offline;
  const result=scope.run(async()=>{if(++calls===1)throw error;return 'loaded';}).catch(e=>e);
  await turn();
  expect(scope.blocking).toBe(true);

  snapshot=wifi;
  changed();
  await turn();
  expect(scope.blocking).toBe(false);
  expect(await result).toBe('loaded');
  changed();
  await turn();
  expect(calls).toBe(2);
 }finally{scope.dispose();}
});

test('playback progress with no pending network work does not wake overlay subscribers',()=>{
 const f=fixture('available');let events=0;f.scope.subscribe(()=>events++);
 for(let tick=0;tick<24;tick++)f.scope.refreshUsable();
 expect(events).toBe(0);
 f.set('bluetooth');expect(events).toBe(1);
 f.scope.dispose();
});
