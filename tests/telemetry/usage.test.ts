import {expect,test} from 'bun:test';
import {WatchUsageTelemetry,TelemetryScreenSession} from '../../src/telemetry/usage.ts';
import {SyncAccountTelemetry} from '../../src/sync/account-telemetry.ts';
import {WatchTokenManager} from '../../src/account/token.ts';
import {WatchAccountStore} from '../../src/account/store.ts';
import {utf8Decode,utf8Encode,type HttpTransport} from '../../src/cloud/types.ts';
import type {WatchAccountState} from '../../src/account/types.ts';
import {telemetryScreen,telemetryScreenOwner} from '../../src/telemetry/screens.ts';
const account:WatchAccountState={userId:'fixture-user',phoneMasked:'private-phone',installId:'phone-install-not-watch',watchDeviceToken:'fixture-access',tokenExpiresAtMillis:9e15,watchRefreshToken:'fixture-refresh',refreshTokenExpiresAtMillis:9e15,backendBaseUrl:'https://telemetry.invalid///',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:false,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:true,sampleRate:0},updatedAtMillis:0};
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const storage=()=>{const data=new Map<string,string>();return {data,get:(key:string)=>data.get(key),set:(key:string,value:string)=>{data.set(key,value);}};};
function fixture(disk=storage()){
 const timers:Array<()=>void>=[],requests:Parameters<HttpTransport['request']>[0][]=[];
 let now=Date.parse('2026-10-01T15:59:59Z'),bound=true,status=200;
 let intercept:(()=>Promise<void>)|undefined;
 const transport:HttpTransport={async request(request){expect(request.url.startsWith('https://telemetry.invalid/')).toBe(true);requests.push(request);await intercept?.();return {status,headers:{},body:new Uint8Array()};}};
 const telemetry=new WatchUsageTelemetry(disk,{freshAccount:async()=>{if(!bound)throw new Error('unbound');return account;},identity:async()=>({installId:'watch-install',deviceId:'watch-device'}),transport,delay:ms=>{expect(ms).toBe(750);return new Promise(resolve=>timers.push(()=>resolve(undefined)));},versionName:'fixture',versionCode:42,appVersion:'watch-fixture+42'},()=>now);
 return {disk,timers,requests,telemetry,setNow:(value:string)=>{now=Date.parse(value);},setBound:(v:boolean)=>{bound=v;},setStatus:(v:number)=>{status=v;},intercept:(fn?:()=>Promise<void>)=>{intercept=fn;},flush:async()=>{timers.shift()?.();await tick();}};
}
test('M2 rows upgrade in place; Shanghai days and seven-day pruning preserve cumulative uploaded days',()=>{
 const f=fixture();f.disk.set('watchrss.sync.account-telemetry.v1',JSON.stringify([{day:'2026-10-01',eventCounts:{sync_account:2},syncSuccessCount:2}]));
 f.telemetry.recordAppLaunch();f.telemetry.recordSyncAccount();
 expect(f.telemetry.snapshots()[0]).toEqual({day:'2026-10-01',eventCounts:{sync_account:3,app_opened:1},syncSuccessCount:3,screenOpenCounts:{},screenDurationMs:{},appForegroundMs:0,syncFailureCount:0});
 f.setNow('2026-10-01T16:00:00Z');f.telemetry.recordAppLaunch();expect(f.telemetry.backlogCount()).toBe(2);
 f.setNow('2026-10-07T15:59:59Z');f.telemetry.recordAppLaunch();expect(f.telemetry.snapshots().map(s=>s.day)).toEqual(['2026-10-01','2026-10-02','2026-10-07']);
 f.setNow('2026-10-07T16:00:00Z');f.telemetry.recordAppLaunch();expect(f.telemetry.snapshots().map(s=>s.day)).toEqual(['2026-10-02','2026-10-07','2026-10-08']);
});
test('all native events aggregate; sensitive parameters do not enter the API or exact HTTP payload',async()=>{
 const f=fixture(),t=f.telemetry;
 t.recordAppLaunch();t.recordReleaseOobeOpened(false);t.recordScreenOpen('DetailActivity');t.recordScreenDuration('DetailActivity',1000);t.recordScreenDuration('DetailActivity',0);t.recordScreenDuration('DetailActivity',-10);
 t.recordSyncReceived();t.recordFeedRefreshed();t.recordArticleReadStarted();t.recordArticleReadFinished();t.recordVideoPlayed();t.recordSyncAccount();
 expect(f.timers).toHaveLength(1);expect(f.requests).toHaveLength(0);await f.flush();expect(f.requests).toHaveLength(1);
 const request=f.requests[0];expect(request.url).toBe('https://telemetry.invalid/functions/v1/telemetry-rollup');expect(request.method).toBe('POST');
 expect(request.headers).toEqual({Authorization:'Bearer fixture-access','X-WatchRSS-App-Version':'watch-fixture+42','content-type':'application/json; charset=utf-8'});
 expect(JSON.parse(utf8Decode(request.body!))).toEqual({day:'2026-10-01',eventCounts:{app_opened:1,release_oobe_opened:1,screen_opened:1,screen_duration:1,sync_received:1,feed_refreshed:1,article_read_started:1,article_read_finished:1,video_played:1,sync_account:1},screenOpenCounts:{DetailActivity:1},screenDurationMs:{DetailActivity:1000},appForegroundMs:1000,syncSuccessCount:2,syncFailureCount:0,installId:'watch-install',deviceId:'watch-device',platform:'watch',appVersionName:'fixture',appVersionCode:42,diagnosticsOptedIn:false});
 expect(utf8Decode(request.body!)).not.toMatch(/private-phone|fixture-user|phone-install|fixture-refresh/);
 expect(t.backlogCount()).toBe(1);expect(f.timers).toHaveLength(0);
});
test('OOBE excludes debug builds, persists once per installation, and is not gated by account or consent',async()=>{
 const f=fixture();f.setBound(false);f.telemetry.recordReleaseOobeOpened(true);expect(f.telemetry.backlogCount()).toBe(0);
 f.telemetry.recordReleaseOobeOpened(false);f.telemetry.recordReleaseOobeOpened(false);await f.flush();expect(f.requests).toHaveLength(0);expect(f.telemetry.snapshots()[0].eventCounts.release_oobe_opened).toBe(1);
 expect(new SyncAccountTelemetry(f.disk).backlogCount()).toBe(1);
 const restarted=fixture(f.disk);restarted.telemetry.recordReleaseOobeOpened(false);expect(restarted.timers).toHaveLength(0);expect(restarted.telemetry.snapshots()[0].eventCounts.release_oobe_opened).toBe(1);
});
test('unbound/failed attempts wait for new captures; non-2xx stops oldest-first uploads without deletion',async()=>{
 const f=fixture();f.setBound(false);f.telemetry.recordAppLaunch();await f.flush();expect(f.requests).toHaveLength(0);expect(f.timers).toHaveLength(0);
 f.setNow('2026-10-02T16:00:00Z');f.setBound(true);f.setStatus(503);f.telemetry.recordSyncAccount();await f.flush();expect(f.requests).toHaveLength(1);expect(JSON.parse(utf8Decode(f.requests[0].body!)).day).toBe('2026-10-01');expect(f.telemetry.backlogCount()).toBe(2);expect(f.timers).toHaveLength(0);
 f.setStatus(200);f.telemetry.recordVideoPlayed();await f.flush();expect(f.requests.slice(1).map(r=>JSON.parse(utf8Decode(r.body!)).day)).toEqual(['2026-10-01','2026-10-03']);expect(f.telemetry.backlogCount()).toBe(2);
});
test('a capture during upload schedules exactly one follow-up, carrying the newer cumulative counters',async()=>{
 const f=fixture();let release!:()=>void;f.intercept(()=>new Promise(resolve=>{release=resolve;}));
 f.telemetry.recordAppLaunch();await f.flush();f.telemetry.recordVideoPlayed();f.telemetry.recordVideoPlayed();expect(f.timers).toHaveLength(0);
 release();await tick();expect(f.timers).toHaveLength(1);f.intercept();await f.flush();expect(f.requests).toHaveLength(2);expect(JSON.parse(utf8Decode(f.requests[1].body!)).eventCounts.video_played).toBe(2);expect(f.timers).toHaveLength(0);
});
test('expired access token refresh completes before rollup, and rejected refresh never sends rollup',async()=>{
 for(const refreshStatus of [200,401,503]){
  let raw:string|null=null;const disk=storage(),store=new WatchAccountStore({get:()=>raw,set:(_,v)=>{raw=v;},remove:()=>{raw=null;}});
  await store.save({...account,backendBaseUrl:'https://telemetry.invalid',tokenExpiresAtMillis:0});
  const paths:string[]=[],timers:Array<()=>void>=[];
  const transport:HttpTransport={async request(r){expect(r.url.startsWith('https://telemetry.invalid/')).toBe(true);paths.push(r.url);if(r.url.endsWith('/refresh')){expect(JSON.parse(utf8Decode(r.body!))).toEqual({refreshToken:'fixture-refresh'});return {status:refreshStatus,headers:{},body:utf8Encode(JSON.stringify({watchAccessToken:'rotated',accessTokenExpiresAt:9e15,watchRefreshToken:'rotated-refresh',refreshTokenExpiresAt:9e15,entitlement:{}}))};}expect(r.headers?.Authorization).toBe('Bearer rotated');return {status:200,headers:{},body:new Uint8Array()};}};
  const tokens=new WatchTokenManager(store,{backendBaseUrl:account.backendBaseUrl.replace(/\/+$/,''),transport,appVersion:'watch-fixture+42'});
  const telemetry=new WatchUsageTelemetry(disk,{freshAccount:()=>tokens.freshAccount(),identity:async()=>({installId:'i',deviceId:'d'}),transport,delay:()=>new Promise(resolve=>timers.push(()=>resolve(undefined))),versionName:'fixture',versionCode:42,appVersion:'watch-fixture+42'});
  telemetry.recordAppLaunch();timers.shift()!();await tick();expect(paths).toEqual(refreshStatus===200?['https://telemetry.invalid/functions/v1/account/watch-token/refresh','https://telemetry.invalid/functions/v1/telemetry-rollup']:['https://telemetry.invalid/functions/v1/account/watch-token/refresh']);expect(telemetry.backlogCount()).toBe(1);expect(timers).toHaveLength(0);
 }
});
test('screen lifecycle pauses during background and counts native extra watch_account on every resume',()=>{
 const f=fixture();let elapsed=0;const session=new TelemetryScreenSession(f.telemetry,()=>elapsed),key={};
 session.update(key,'AccountStatusActivity',true);elapsed=100;session.update(key,'AccountStatusActivity',true);elapsed=250;session.update(key,'AccountStatusActivity',false);elapsed=10000;session.update(key,'AccountStatusActivity',true);elapsed=10100;session.pause();session.pause();
 expect(f.telemetry.snapshots()[0]).toMatchObject({screenOpenCounts:{AccountStatusActivity:2,watch_account:2},screenDurationMs:{AccountStatusActivity:350},appForegroundMs:350});
 expect(telemetryScreen({page:'reader'})).toBe('DetailActivity');expect(telemetryScreen({page:'settings-speech'})).toBe('TtsSettingsActivity');expect(telemetryScreen({page:'video',playback:{title:'private title',platform:'bili'}})).toBe('BiliPlayerActivity');
});

test('internal Bili search and Douyin immersive navigation retain their native screen owner',()=>{
 const search={page:'bili',biliRoute:{name:'search'}} as const;
 expect(telemetryScreenOwner([search,{page:'bili',biliRoute:{name:'results',query:'private query'}}])).toBe(search);
 const entry={page:'douyin',douyinRoute:{name:'entry'}} as const;
 expect(telemetryScreenOwner([entry,{page:'douyin',douyinRoute:{name:'feed'}},{page:'video',playback:{platform:'douyin',title:'private',immersive:true}}])).toBe(entry);
 expect(telemetryScreen({page:'settings-auto-scroll'})).toBe('AutoScrollControlActivity');
});

test('new measurements send only bounded metric fields; invalid inputs and unbound/offline fail quietly',async()=>{
 const f=fixture();f.telemetry.recordDouyinQrLoadTime(1234);f.telemetry.recordVideoBatteryDrain('bilibili',60000,90,89);await tick();
 expect(f.requests.map(r=>r.url)).toEqual(['https://telemetry.invalid/functions/v1/douyin-qr-load-time','https://telemetry.invalid/functions/v1/video-battery-drain']);
 expect(f.requests.map(r=>JSON.parse(utf8Decode(r.body!)))).toEqual([{durationMs:1234,appVersionName:'fixture',appVersionCode:42},{source:'bilibili',durationMs:60000,batteryStart:90,batteryEnd:89,appVersionName:'fixture'}]);
 expect(f.requests.every(r=>r.headers?.Authorization==='Bearer fixture-access')).toBe(true);expect(f.telemetry.backlogCount()).toBe(0);expect(f.timers).toHaveLength(0);
 for(const n of [0,-1,NaN,Infinity])f.telemetry.recordDouyinQrLoadTime(n);
 for(const args of [['rss',60000,90,89],['douyin',59999,90,89],['douyin',60000,90,91],['douyin',60000,-1,0],['douyin',Infinity,90,89]] as const)f.telemetry.recordVideoBatteryDrain(args[0],args[1],args[2],args[3]);
 await tick();expect(f.requests).toHaveLength(2);
 f.setBound(false);f.telemetry.recordDouyinQrLoadTime(500);await tick();expect(f.requests).toHaveLength(2);
 f.setBound(true);f.intercept(async()=>{throw Error('offline');});f.telemetry.recordVideoBatteryDrain('douyin',90000,80,79);await tick();expect(f.requests).toHaveLength(3);expect(f.timers).toHaveLength(0);
});
