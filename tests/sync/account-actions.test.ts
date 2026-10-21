import {expect, test} from 'bun:test';
import {WatchAccountStore} from '../../src/account/store.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';

const parseJava = async (value: string) => {
  try {
    const parsed = new URL(value);
    return {valid:true,scheme:parsed.protocol.slice(0,-1),host:parsed.hostname || null};
  } catch {
    return {valid:false,scheme:null,host:null};
  }
};

const request = {
  version:1,action:'syncAccount',deviceId:'phone-device',
  account:{userId:' user-1 ',phoneMasked:' 138****1234 ',installId:'phone-install',
    watchDeviceToken:'old-token',watchAccessToken:'new-token',tokenExpiresAt:2,
    accessTokenExpiresAt:123456,watchRefreshToken:'refresh-token',refreshTokenExpiresAt:234567,
    backendBaseUrl:'https://api.example.com/',posthogHost:'',posthogProjectApiKey:''},
  entitlement:{plan:'member',active:true,expiresAt:345678,features:[' cloud ','', 'notes']},
  telemetry:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},
};

test('phone syncAccount commits secure storage before acknowledging and exposes no token in its reply', async () => {
  const values=new Map<string,string>();let notifications=0;
  const store=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{values.set(key,value);},remove:key=>{values.delete(key);}});
  store.subscribe(()=>notifications++);
  const handle=createApplicationActionHandler({notes:{} as never,deviceId:async()=> 'watch-device',
    notesChanged:()=>{},accountStore:store,accountUriParse:parseJava});
  const reply=await handle(request);
  expect(reply).toEqual({success:true,version:1,action:'syncAccount',deviceId:'watch-device',
    boundUserId:'user-1',telemetryBacklog:0});
  expect(JSON.stringify(reply)).not.toMatch(/new-token|refresh-token/);
  expect(notifications).toBe(1);
  expect(await store.read()).toMatchObject({userId:'user-1',phoneMasked:'138****1234',
    watchDeviceToken:'new-token',tokenExpiresAtMillis:123456,watchRefreshToken:'refresh-token',
    backendBaseUrl:'https://api.example.com',entitlement:{features:['cloud','notes']}});
});

test('invalid account frames preserve the previous binding and never acknowledge success', async () => {
  const values=new Map<string,string>();let writes=0,notifications=0;
  const store=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{if(key==='state_json')writes++;values.set(key,value);},remove:key=>{values.delete(key);}});
  await store.save({userId:'old-user',phoneMasked:'',installId:'',watchDeviceToken:'old',
    tokenExpiresAtMillis:1,watchRefreshToken:'',refreshTokenExpiresAtMillis:0,backendBaseUrl:'https://old.example',
    posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},
    telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1});
  store.subscribe(()=>notifications++);
  const handle=createApplicationActionHandler({notes:{} as never,deviceId:async()=> 'watch-device',
    notesChanged:()=>{},accountStore:store,accountUriParse:parseJava});
  for(const bad of [
    {...request,account:{...request.account,backendBaseUrl:'http://192.168.1.8:8787'}},
    {...request,account:{...request.account,backendBaseUrl:'https://user:password@api.example.com'}},
    {...request,account:{...request.account,userId:'   '}},
    {...request,account:{...request.account,watchAccessToken:' ',watchDeviceToken:' '}},
    {...request,account:null},
  ]) {
    const reply=await handle(bad);
    expect(reply.success).toBe(false);
    expect(JSON.stringify(reply)).not.toMatch(/new-token|refresh-token|password/);
  }
  expect((await store.read())?.userId).toBe('old-user');
  expect(writes).toBe(1);
  expect(notifications).toBe(0);
});

test('write failure returns failure, keeps old account and does not notify observers', async () => {
  const values=new Map<string,string>();let fail=false,notifications=0;
  const store=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{if(fail)throw Error('secure storage unavailable');values.set(key,value);},remove:key=>{values.delete(key);}});
  await store.save({...request.account,userId:'user-1',phoneMasked:'',installId:'',watchDeviceToken:'old',
    tokenExpiresAtMillis:1,watchRefreshToken:'',refreshTokenExpiresAtMillis:0,backendBaseUrl:'https://api.example.com',
    posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},
    telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1});
  store.subscribe(()=>notifications++);fail=true;
  const handle=createApplicationActionHandler({notes:{} as never,deviceId:async()=> 'watch-device',
    notesChanged:()=>{},accountStore:store,accountUriParse:parseJava});
  expect(await handle(request)).toEqual({success:false,message:'secure storage unavailable'});
  expect((await store.read())?.userId).toBe('user-1');
  expect(notifications).toBe(0);
});
