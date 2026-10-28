import { expect, test } from "bun:test";
import { WatchAccountStore, WatchTokenManager, WatchAccountState, SecureStorage } from "../../src/account";
import { utf8Encode } from "../../src/cloud";
import type { HttpTransport, HttpResponse } from "../../src/cloud";

class MemoryStorage implements SecureStorage { values=new Map<string,string>();async get(key:string){return this.values.get(key)??null;}async set(key:string,value:string){this.values.set(key,value);}async remove(key:string){this.values.delete(key);} }
const state: WatchAccountState = { userId: "u", phoneMasked: "1****", installId: "i", watchDeviceToken: "old", tokenExpiresAtMillis: 1, watchRefreshToken: "refresh", refreshTokenExpiresAtMillis: 999999, backendBaseUrl: "https://cloud.test", posthogHost: "", posthogProjectApiKey: "", entitlement: { plan: "free", active: true, expiresAtMillis: 0, features: [] }, telemetryConfig: { anonymousEnabled: true, diagnosticsEnabled: false, sampleRate: 1 }, updatedAtMillis: 1 };
const ok = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: utf8Encode(JSON.stringify(value)) });

test("concurrent refresh calls share one request", async () => {
  let release!: () => void, started!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0; const transport: HttpTransport = { async request() { calls++; started(); await response; return ok({ watchAccessToken: "new", accessTokenExpiresAt: 100000, watchRefreshToken: "next", refreshTokenExpiresAt: 200000, entitlement: { plan: "member", active: true, expiresAt: 3, features: ["cloud"] } }); } };
  const store = new WatchAccountStore(new MemoryStorage()); await store.save(state); const manager = new WatchTokenManager(store, { backendBaseUrl: "https://cloud.test", transport }, () => 0);
  const requests = [manager.freshAccessToken(), manager.freshAccessToken()];
  await requestStarted; expect(calls).toBe(1); release();
  const result = await Promise.all(requests); expect(result).toEqual(["new", "new"]); expect(calls).toBe(1);
});

test("transient refresh failure keeps the good session", async () => {
  const storage = new MemoryStorage(); const store = new WatchAccountStore(storage); await store.save(state); const transport: HttpTransport = { async request() { return { status: 503, headers: {}, body: utf8Encode("temporary") }; } }; const manager = new WatchTokenManager(store, { backendBaseUrl: "https://cloud.test", transport }, () => 0);
  await expect(manager.freshAccessToken()).rejects.toThrow(); expect((await store.read())?.watchRefreshToken).toBe("refresh"); expect((await store.read())?.watchDeviceToken).toBe("old");
});

test('phone reassignment refreshes only the mask and tokens, preserving user and library ownership',async()=>{
 for(const mask of ['139****9999',undefined]){
  const storage=new MemoryStorage();let clears=0;
  const store=new WatchAccountStore({...storage,get:storage.get.bind(storage),set:storage.set.bind(storage),remove:storage.remove.bind(storage),clearCloudScope:async()=>{clears++;}});
  await store.save(state);const before=storage.values.get('watchrss.library.owner');
  const manager=new WatchTokenManager(store,{backendBaseUrl:state.backendBaseUrl,transport:{request:async()=>ok({watchAccessToken:'new',watchRefreshToken:'next',accessTokenExpiresAt:999999,refreshTokenExpiresAt:9999999,phoneMasked:mask,entitlement:{plan:'free',active:true}})}},()=>0);
  const result=await manager.freshAccount(true);
  expect(result.phoneMasked).toBe(mask??state.phoneMasked);expect(result.userId).toBe(state.userId);
  expect(storage.values.get('watchrss.library.owner')).toBe(before);expect(clears).toBe(0);
 }
});

test('seven-day notice stays outside synchronized account data; refresh and cancellation preserve ownership',async()=>{
 const storage=new MemoryStorage(),store=new WatchAccountStore(storage);await store.save({...state,tokenExpiresAtMillis:9e15});
 let pending:any={appealId:'appeal',status:'cooling',effectiveAt:1893456000000,phoneMasked:'139****0000',cancellable:true};const calls:string[]=[];
 const manager=new WatchTokenManager(store,{backendBaseUrl:state.backendBaseUrl,transport:{request:async q=>{calls.push(q.method+' '+q.url);if(q.method==='POST'){pending=null;return ok({status:'cancelled'});}return ok({userId:state.userId,phoneMasked:state.phoneMasked,pendingPhoneChange:pending});}}},()=>0);
 const owner=storage.values.get('watchrss.library.owner');const result=await manager.refreshProfile();expect(result.pendingPhoneChange?.message).toContain('2030年1月1日');expect(storage.values.get('state_json')).not.toContain('pendingPhoneChange');
 expect((await manager.cancelPhoneAppeal('appeal')).pendingPhoneChange).toBeNull();expect(storage.values.get('watchrss.library.owner')).toBe(owner);expect(calls.length).toBe(3);
});

test('late safety profile cannot overwrite a newer committed watch token pair',async()=>{
 const storage=new MemoryStorage(),store=new WatchAccountStore(storage);await store.save({...state,tokenExpiresAtMillis:9e15});
 const manager=new WatchTokenManager(store,{backendBaseUrl:state.backendBaseUrl,transport:{request:async()=>{await store.save({...state,watchRefreshToken:'newer',watchDeviceToken:'newer-access'});return ok({userId:state.userId,phoneMasked:'139****0000',pendingPhoneChange:null});}}},()=>0);
 await expect(manager.refreshProfile()).rejects.toThrow('账号已变更');expect((await store.read())?.watchRefreshToken).toBe('newer');
});

test('recheck low 8: runtime opens the signed-in account independently of the local library owner',async()=>{
 const {createCloudRuntime}=await import('../../src/cloud/runtime');const storage=new MemoryStorage(),store=new WatchAccountStore(storage);await store.save({...state,tokenExpiresAtMillis:9e15});storage.values.set('watchrss.library.owner',JSON.stringify([state.backendBaseUrl,'another-owner']));let opened=false,ownerChecks=0;
 store.assertLibraryOwner=async()=>{ownerChecks++;throw Error('library_owner_mismatch');};
 const runtime=createCloudRuntime(async<T>(method:string)=>{if(method==='cloud.acquire')return{acquired:true} as T;if(method==='cloud.release')return{} as T;if(method==='file.list')return{entries:[]} as T;if(method==='discovery.networkSnapshot')return{active:true,validated:true,wifi:true,metered:false} as T;throw Error('unexpected '+method);},async()=>{opened=true;throw Error('fixture stops before cloud I/O');},{require(){}},store);
 expect(await runtime.service.syncNow()).toBe(false);expect(opened).toBe(true);expect(ownerChecks).toBe(0);expect((await store.read())?.userId).toBe(state.userId);
});
