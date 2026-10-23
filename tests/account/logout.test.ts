import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {WatchAccountStore} from '../../src/account/store';
import {WatchTokenManager} from '../../src/account/token';
import {revokeAccountCloud,clearAccountCloud} from '../../src/account/cloud-cleanup';
import type {WatchAccountState} from '../../src/account/types';
import type {HttpTransport} from '../../src/cloud/types';
import {contentFixture} from '../cloud/content-fixture';
const epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff';
const account:WatchAccountState={userId:'logout-user',backendBaseUrl:'https://backend.invalid',watchDeviceToken:'expired-bearer',watchRefreshToken:'refresh',tokenExpiresAtMillis:1,refreshTokenExpiresAtMillis:9e15,installId:'i',phoneMasked:'',posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:1,entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1}};
const response=(value:unknown,status=200)=>({status,headers:{},body:new TextEncoder().encode(JSON.stringify(value))});
async function fixture(mode:'ok'|'401'|'503'|'malformed'|'network'|'revoke-fails'){
 const events:string[]=[],values=new Map<string,string>();let accountWrites=0;
 const legacy='watchrss.cloud.keys.'+createHash('sha256').update(account.userId).digest('hex');values.set(legacy,'old-key');values.set('another-account-key','keep');
 const http:HttpTransport={request:async r=>{
  if(r.url.endsWith('/refresh')){events.push('refresh');expect(JSON.parse(Buffer.from(r.body!).toString())).toEqual({refreshToken:'refresh'});expect(r.headers.authorization).toBeUndefined();if(mode==='network')throw Error('offline');if(mode==='401'||mode==='503')return response({},Number(mode));return response(mode==='malformed'?{}:{watchAccessToken:'fresh-bearer',watchRefreshToken:'rotated-refresh',accessTokenExpiresAt:9e15,refreshTokenExpiresAt:9e15});}
  expect(r.headers.authorization).toBe('Bearer fresh-bearer');
  if(r.url.endsWith('/bootstrap')){events.push('bootstrap');return response({...contentFixture,libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],member:{},devices:[],keyEnvelopes:[]});}
  expect(r.url).toEndWith('/cloud/devices/watch/revoke');events.push('revoke');expect(r.headers['x-watchrss-library-epoch']).toBe(epoch);return response({},mode==='revoke-fails'?503:200);
 }};
 const host=async<T>(method:string,args:any):Promise<T>=>{
  if(method==='sql.query')return[{device_id:'watch'}] as T;
  if(method==='crypto.hash')return{digestBase64:createHash('sha256').update(Buffer.from(args.dataBase64,'base64')).digest('base64')} as T;
  if(method==='secure.update'){events.push('cloud-clear');for(const k of values.keys())if(args.removePrefixes.some((p:string)=>k.startsWith(p)))values.delete(k);return{} as T;}
  if(method==='file.list')return{entries:[]} as T;throw Error('unexpected '+method);
 };
 const store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{if(k==='state_json')accountWrites++;values.set(k,v);},remove:k=>{events.push('session-clear');values.delete(k);},revokeCloudScope:state=>revokeAccountCloud(host,state,http),clearCloudScope:state=>clearAccountCloud(host,state)});await store.save(account);
 return{store,http,events,values,legacy,get accountWrites(){return accountWrites;}};
}
test('recheck low 9a: logout refreshes once before self-revoke under the store lock without saving rotating credentials',async()=>{
 const f=await fixture('ok');await f.store.clear();expect(f.events).toEqual(['refresh','bootstrap','revoke','session-clear','cloud-clear']);expect(await f.store.read()).toBeNull();expect(f.accountWrites).toBe(1);expect(f.values.has(f.legacy)).toBe(false);expect(f.values.get('another-account-key')).toBe('keep');expect(f.values.has('watchrss.library.owner')).toBe(true);
});
test('recheck low 9a: refresh 401/503/malformed/network failure and revoke failure all finish local cleanup',async()=>{
 for(const mode of ['401','503','malformed','network','revoke-fails'] as const){const f=await fixture(mode);await f.store.clear();expect(f.events).toEqual(mode==='revoke-fails'?['refresh','bootstrap','revoke','session-clear','cloud-clear']:['refresh','session-clear','cloud-clear']);expect(await f.store.read()).toBeNull();expect(f.accountWrites).toBe(1);expect(f.values.has(f.legacy)).toBe(false);expect(f.values.get('another-account-key')).toBe('keep');}
});
test('401 token invalidation clears locally without the explicit logout refresh/revoke flow',async()=>{
 const f=await fixture('401'),tokens=new WatchTokenManager(f.store,{backendBaseUrl:account.backendBaseUrl,transport:f.http});await expect(tokens.freshAccount(true)).rejects.toThrow('401');expect(f.events).toEqual(['refresh','session-clear','cloud-clear']);expect(await f.store.read()).toBeNull();expect(f.accountWrites).toBe(1);
});
