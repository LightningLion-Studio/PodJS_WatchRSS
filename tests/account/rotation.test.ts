import {test,expect} from 'bun:test';
import {WatchAccountStore} from '../../src/account/store';
import {WatchTokenManager} from '../../src/account/token';
import {withAccountLease} from '../../src/account/lease';
import {WatchCloudClient} from '../../src/cloud/client';
import type {WatchAccountState,SecureStorage} from '../../src/account/types';
import {utf8Encode,type HttpTransport} from '../../src/cloud/types';
import {contentFixture} from '../cloud/content-fixture';
const state:WatchAccountState={userId:'u',phoneMasked:'',installId:'i',watchDeviceToken:'old',tokenExpiresAtMillis:1,watchRefreshToken:'refresh',refreshTokenExpiresAtMillis:9e15,backendBaseUrl:'https://backend.invalid',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1};
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
const response=(value:unknown,status=200)=>({status,headers:{},body:utf8Encode(JSON.stringify(value))});
const rotated={watchAccessToken:'new',accessTokenExpiresAt:9e15,watchRefreshToken:'next',refreshTokenExpiresAt:9e15};
function fixture(){
 const values=new Map<string,string>();let held=false,revokes=0,cleanups=0;
 const host=async<T>(method:string)=>{if(method==='secure.acquire'){const acquired=!held;if(acquired)held=true;return{acquired} as T;}if(method==='secure.release'){held=false;return{} as T;}throw Error(method);};
 const storage:SecureStorage={get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);},exclusive:action=>withAccountLease(host,action),revokeCloudScope:async()=>{revokes++;},clearCloudScope:async()=>{cleanups++;}};
 return{storage,values,store:new WatchAccountStore(storage),get held(){return held;},get revokes(){return revokes;},get cleanups(){return cleanups;}};
}
test('1040 regression: independent token managers share rotation through durable account serialization',async()=>{
 const f=fixture();await f.store.save(state);let calls=0;const entered=deferred(),finish=deferred();
 const http:HttpTransport={request:async()=>{calls++;entered.resolve();await finish.promise;return response(rotated);}};
 const requests=Array.from({length:20},()=>new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:http}).freshAccount(true));
 await entered.promise;expect(calls).toBe(1);expect(f.held).toBe(true);finish.resolve();const result=await Promise.all(requests);
 expect(calls).toBe(1);expect(result.every(a=>a.watchRefreshToken==='next')).toBe(true);expect((await f.store.read())?.watchDeviceToken).toBe('new');expect(f.held).toBe(false);expect(f.revokes).toBe(0);
});
test('separate guest stores cannot refresh while another owns the host lease; retry rereads the committed pair',async()=>{
 const f=fixture();await f.store.save(state);const second=new WatchAccountStore(f.storage),entered=deferred(),finish=deferred();let calls=0;
 const http:HttpTransport={request:async()=>{calls++;entered.resolve();await finish.promise;return response(rotated);}};
 const first=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:http}),other=new WatchTokenManager(second,{backendBaseUrl:state.backendBaseUrl,transport:http});
 const task=first.freshAccount();await entered.promise;await expect(other.freshAccount()).rejects.toThrow('account_busy');expect(calls).toBe(1);expect((await second.read())?.watchRefreshToken).toBe('refresh');
 finish.resolve();await task;expect((await other.freshAccount(true,'old')).watchRefreshToken).toBe('next');expect(calls).toBe(1);expect(f.revokes).toBe(0);
});
test('host lease is held until token pair is durably published, including a slow secure set',async()=>{
 const f=fixture();await f.store.save(state);const entered=deferred(),commit=deferred();const write=f.storage.set;
 f.storage.set=async(k,v)=>{if(k==='state_json'){entered.resolve();await commit.promise;}await write(k,v);};
 let calls=0;const transport:HttpTransport={request:async()=>{calls++;return response(rotated);}};
 const task=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport}).freshAccount();await entered.promise;expect(f.held).toBe(true);
 const other=new WatchTokenManager(new WatchAccountStore(f.storage),{backendBaseUrl:state.backendBaseUrl,transport});await expect(other.freshAccount()).rejects.toThrow('account_busy');expect(calls).toBe(1);commit.resolve();await task;expect(f.held).toBe(false);
});
test('confirmed refresh 401 expires locally once under the lease and never invokes R10 refresh/self-revoke',async()=>{
 const f=fixture();await f.store.save(state);let calls=0;const transport:HttpTransport={request:async()=>{calls++;return response({error:'invalid_refresh_token'},401);}};
 const results=await Promise.allSettled(Array.from({length:5},()=>new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport}).freshAccount(true)));
 expect(results.every(r=>r.status==='rejected')).toBe(true);expect(calls).toBe(1);expect(await f.store.read()).toBeNull();expect(f.revokes).toBe(0);expect(f.cleanups).toBe(1);expect(f.values.has('watchrss.library.owner')).toBe(true);expect(f.held).toBe(false);
});
test('delayed 401 for an older access token reuses a concurrently rotated pair instead of rotating it again',async()=>{
 const f=fixture();await f.store.save({...state,tokenExpiresAtMillis:9e15});const requestEntered=deferred(),denied=deferred();let rotations=0;const auth:string[]=[];
 const tokens=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{request:async()=>{rotations++;return response(rotated);}}});
 const client=new WatchCloudClient({request:async r=>{auth.push(r.headers.authorization);if(auth.length===1){requestEntered.resolve();await denied.promise;return response({},401);}return response({...contentFixture,member:{}});}},{baseUrl:state.backendBaseUrl,accessToken:'unused',refreshToken:(force,rejected)=>tokens.freshAccessToken(force,rejected)},{sha256:async()=>''},{require(){}});
 const task=client.bootstrap();await requestEntered.promise;await new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{request:async()=>{rotations++;return response(rotated);}}}).freshAccount(true);denied.resolve();await task;
 expect(auth).toEqual(['Bearer old','Bearer new']);expect(rotations).toBe(1);expect((await f.store.read())?.watchRefreshToken).toBe('next');expect(f.revokes).toBe(0);
});
test('explicit logout waits for rotation, then revokes using the newest committed account before removing it',async()=>{
 const f=fixture();await f.store.save(state);const entered=deferred(),finish=deferred();let revokedToken='';f.storage.revokeCloudScope=async a=>{revokedToken=a.watchRefreshToken;};
 const task=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{request:async()=>{entered.resolve();await finish.promise;return response(rotated);}}}).freshAccount();await entered.promise;const logout=f.store.clear();expect(await f.store.read()).not.toBeNull();finish.resolve();await task;await logout;expect(revokedToken).toBe('next');expect(await f.store.read()).toBeNull();expect(f.held).toBe(false);
});
test('refresh network/503/malformed responses preserve account and release the cross-guest lease',async()=>{
 for(const mode of ['network','503','malformed']){const f=fixture();await f.store.save(state);const transport:HttpTransport={request:async()=>{if(mode==='network')throw Error('offline');return response({},mode==='503'?503:200);}};await expect(new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport}).freshAccount()).rejects.toThrow();expect((await f.store.read())?.watchRefreshToken).toBe('refresh');expect(f.held).toBe(false);expect(f.revokes).toBe(0);expect(f.cleanups).toBe(0);}
});

test('ordinary sync backs off across repeated pre-send failures without opening a recovery window',async()=>{
 const f=fixture();
 await f.store.save(state);
 let now=1_000,calls=0,online=false;
 const tokens=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{async request(request){
  request.beforeDispatch?.();
  calls++;
  if(!online)throw Object.assign(Error('failed to connect to unit.invalid (port 443) after 8000ms'),{code:'host_error'});
  return response(rotated);
 }}},()=>now);
 for(let attempt=1;attempt<=3;attempt++){
  await expect(tokens.freshAccount()).rejects.toThrow('failed to connect');
  expect(calls).toBe(attempt);
  expect(f.values.has('state_json.refresh-attempt')).toBe(false);
  expect(await f.store.read()).toEqual(state);
  now+=60_000;
 }
 online=true;
 expect((await tokens.freshAccount()).watchRefreshToken).toBe('next');
 expect(calls).toBe(4);
 expect(f.cleanups).toBe(0);
});

test('ordinary sync gives up replay after a lost response and preserves local data and ownership',async()=>{
 const f=fixture();
 await f.store.save(state);
 f.values.set('business-data','local draft');
 let now=1_000,calls=0;
 const tokens=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{async request(request){
  request.beforeDispatch?.();
  calls++;
  now+=10_000;
  throw Object.assign(Error('timeout'),{code:'host_error',nativeTransportFailure:true});
 }}},()=>now);
 await expect(tokens.freshAccount()).rejects.toThrow('需要重新登录');
 expect(calls).toBe(2);
 expect(await f.store.read()).toEqual({...state,needsRelogin:true});
 expect(f.values.get('business-data')).toBe('local draft');
 expect(f.values.has('watchrss.library.owner')).toBe(true);
 expect(f.cleanups).toBe(0);
 expect(f.revokes).toBe(0);
 now+=60_000;
 await expect(tokens.freshAccount()).rejects.toThrow('需要重新登录');
 expect(calls).toBe(2);
 // Account resynchronization supplies a fresh generation, which takes over.
 await f.store.save({...state,watchRefreshToken:'replacement',watchDeviceToken:'replacement-access',tokenExpiresAtMillis:9e15});
 expect((await tokens.freshAccount()).watchDeviceToken).toBe('replacement-access');
 expect((await f.store.read())?.needsRelogin).toBeUndefined();
 expect(f.values.get('business-data')).toBe('local draft');
});

test('ordinary sync saves a successful late reply to a replay sent inside the window',async()=>{
 const f=fixture();
 await f.store.save(state);
 let now=1_000,calls=0;
 const tokens=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{async request(request){
  request.beforeDispatch?.();
  if(++calls===1){now+=10_000;throw Error('connection reset');}
  now+=11_000;
  return response(rotated);
 }}},()=>now);
 expect((await tokens.freshAccount()).watchRefreshToken).toBe('next');
 expect((await f.store.read())?.needsRelogin).toBeUndefined();
 expect(calls).toBe(2);
 expect(f.cleanups).toBe(0);
});

test('network recovery inside the window can finish an ambiguous rotation after a pre-send retry failure',async()=>{
 const f=fixture();
 await f.store.save(state);
 let now=1_000,calls=0;
 const tokens=new WatchTokenManager(f.store,{backendBaseUrl:state.backendBaseUrl,transport:{async request(request){
  request.beforeDispatch?.();
  if(++calls===1){now+=10_000;throw Error('timeout');}
  if(calls===2)throw Object.assign(Error('connect timed out'),{code:'connect_timeout'});
  return response(rotated);
 }}},()=>now);
 await expect(tokens.freshAccount()).rejects.toThrow('connect timed out');
 expect(f.values.has('state_json.refresh-attempt')).toBe(true);
 now+=5_000;
 expect((await tokens.freshAccount()).watchRefreshToken).toBe('next');
 expect((await f.store.read())?.needsRelogin).toBeUndefined();
 expect(f.cleanups).toBe(0);
});
