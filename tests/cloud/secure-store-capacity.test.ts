import {expect,test} from 'bun:test';
import {WatchAccountStore} from '../../src/account/store';
import {WatchTokenManager} from '../../src/account/token';
import type {WatchAccountState,SecureStorage} from '../../src/account/types';
import {createCloudRuntime} from '../../src/cloud/runtime';
import {cloudFormatFailure} from '../../src/cloud/format-diagnostic';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
import {enabled} from './k2-crypto';

const codes=['secure_quota','secure_store_too_large','secure_read_failed','secure_store_corrupt'] as const;
const error=(code:string)=>Object.assign(Error(code),{name:'HostServiceError',code});
const state:WatchAccountState={userId:'fixture',phoneMasked:'',installId:'fixture',watchDeviceToken:'synthetic-access',tokenExpiresAtMillis:1,watchRefreshToken:'synthetic-refresh',refreshTokenExpiresAtMillis:9e15,backendBaseUrl:'https://backend.invalid',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1};

test('secure read IO/size failures propagate through account/token reads without logout, cleanup, rebind or HTTP',async()=>{
 for(const code of codes){
  const values=new Map<string,string>();let fail=false;const actions:string[]=[];
  const storage:SecureStorage={get:key=>{if(fail)throw error(code);return values.get(key)??null;},set:(key,value)=>{actions.push('set');values.set(key,value);},remove:key=>{actions.push('remove');values.delete(key);},clearCloudScope:async()=>{actions.push('clear');},revokeCloudScope:async()=>{actions.push('revoke');}};
  const accounts=new WatchAccountStore(storage);await accounts.save(state);const before=[...values];actions.length=0;fail=true;
  await expect(accounts.read()).rejects.toThrow(code);
  const tokens=new WatchTokenManager(accounts,{backendBaseUrl:state.backendBaseUrl,transport:{request:async()=>{actions.push('HTTP');throw Error('unexpected HTTP');}}});
  await expect(tokens.freshAccount()).rejects.toThrow(code);
  await expect(accounts.save(state)).rejects.toThrow(code);
  expect(actions).toEqual([]);expect([...values]).toEqual(before);fail=false;expect((await accounts.read())?.watchRefreshToken).toBe('synthetic-refresh');
 }
});

test('secure quota on account publication preserves stored identity and never clears cloud scope',async()=>{
 const values=new Map<string,string>();let full=false;const destructive:string[]=[];
 const accounts=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{if(full)throw error('secure_quota');values.set(key,value);},remove:()=>{destructive.push('remove');},clearCloudScope:async()=>{destructive.push('clear');},revokeCloudScope:async()=>{destructive.push('revoke');}});
 await accounts.save(state);const before=[...values];full=true;
 await expect(accounts.save({...state,watchDeviceToken:'replacement'},state)).rejects.toThrow('secure_quota');
 expect([...values]).toEqual(before);expect(destructive).toEqual([]);
});

test('production cloud runtime emits closed secure codes into format-sync/app_log diagnostics and preserves every key',async()=>{
 for(const code of codes){const calls:string[]=[],events:any[]=[];
  const runtime=createCloudRuntime(async<T>(method:string)=>{calls.push(method);if(method==='cloud.acquire')return {acquired:true} as T;if(method==='cloud.release')return {} as T;if(method==='file.list')return {entries:[]} as T;if(method==='discovery.networkSnapshot')return {active:true,validated:true,wifi:true,metered:false} as T;if(method==='secure.get')throw error(code);throw Error('unexpected operation: '+method);},async()=>{throw Error('repository must stay lazy');},enabled,undefined,undefined,undefined,{formatDiagnostic:value=>events.push(JSON.parse(value))});
  expect(await runtime.service.syncNow()).toBe(false);expect(events.at(-1)).toMatchObject({outcome:'failed',code,category:'storage',stage:'session_open'});
  expect(calls.at(-1)).toBe('cloud.release');expect(calls.some(method=>['secure.set','secure.delete','secure.update','secure.compareAndSet','crypto.ecdhPublicKey','http.request'].includes(method))).toBe(false);
  expect(JSON.parse(recordFailureDiagnostic(error(code))).code).toBe(code);expect(cloudFormatFailure(error(code))).toBe('storage');
 }
 const privateError=Object.assign(Error('secure_quota: PRIVATE https://private.invalid/?token=secret'),{code:'secure_quota: secret'});
 expect(JSON.stringify(JSON.parse(recordFailureDiagnostic(privateError)))).not.toMatch(/PRIVATE|private.invalid|secret/);
});
