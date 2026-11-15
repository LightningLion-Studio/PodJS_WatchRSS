import {afterEach,expect,test} from 'bun:test';
import {SavedPlaybackIssueTelemetry} from '../../src/telemetry/saved-playback.ts';
import {DouyinSavedPlaybackDiagnostic} from '../../src/douyin/saved-playback-diagnostics.ts';
import {installSavedIssueSink} from '../../src/douyin/saved-issue-events.ts';
import type {WatchAccountState} from '../../src/account/types.ts';
import {utf8Decode,type HttpTransport} from '../../src/cloud/types.ts';
const DAY=86400000,NOW=1800000000000;
const account:WatchAccountState={userId:'account-a',phoneMasked:'private-phone',installId:'installation-a',watchDeviceToken:'access-a',tokenExpiresAtMillis:9e15,watchRefreshToken:'private-refresh',refreshTokenExpiresAtMillis:9e15,backendBaseUrl:'https://telemetry.invalid///',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:false,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:true,sampleRate:0},updatedAtMillis:0};
const tick=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const storage=()=>{const data=new Map<string,string>();return {get:(k:string)=>data.get(k),set:(k:string,v:string)=>{data.set(k,v);}};};
function fixture(disk=storage()){
 let owner:WatchAccountState|null=account,status=503,n=0,intercept:(()=>Promise<void>)|undefined;
 const timers:Array<()=>void>=[],requests:Parameters<HttpTransport['request']>[0][]=[];
 const telemetry=new SavedPlaybackIssueTelemetry(disk,{
  readAccount:async()=>owner,freshAccount:async()=>{if(!owner)throw Error('unbound');return owner;},
  randomId:async()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`,
  delay:ms=>{expect(ms).toBe(750);return new Promise(resolve=>timers.push(()=>resolve(undefined)));},
  version:'fixture-version',appVersion:'watch-fixture+3',
  transport:{async request(r){requests.push(r);await intercept?.();return {status,headers:{},body:new Uint8Array()};}},
 },()=>NOW);
 return {telemetry,disk,requests,timers,setOwner:(v:WatchAccountState|null)=>{owner=v;},setStatus:(v:number)=>{status=v;},intercept:(v?:()=>Promise<void>)=>{intercept=v;},flush:async()=>{timers.shift()?.();await tick();}};
}
const context={itemId:'private-video-id',savedAtMillis:NOW-15*DAY};
const occurrence={atMillis:NOW,stage:'player',code:'source_expired'} as const;
const events=(f:ReturnType<typeof fixture>,i=0)=>JSON.parse(utf8Decode(f.requests[i].body!)).events;
afterEach(()=>installSavedIssueSink(undefined));
test('one opening counts once across retries, recovery, and later failure; re-opening counts again',()=>{
 const rows:unknown[]=[];installSavedIssueSink((c,e)=>rows.push({c,e}));let time=NOW;
 const trace=new DouyinSavedPlaybackDiagnostic({kind:'favorite',url:'',...context},()=>time);
 trace.playbackFailure({code:'source_expired'});time+=1000;trace.recovery(false);trace.playbackFailure({code:'network_error'});trace.recovery(true);trace.firstFrame();trace.playbackFailure({code:'decode_error'});trace.openError();trace.end();
 expect(rows).toHaveLength(1);expect(rows[0]).toEqual({c:context,e:occurrence});
 new DouyinSavedPlaybackDiagnostic({kind:'favorite',url:'',...context},()=>time).openError();expect(rows).toHaveLength(2);
});
test('watch later, ordinary video and cancelled openings never report local-favorite issues',()=>{
 const rows:unknown[]=[];installSavedIssueSink((c,e)=>rows.push({c,e}));
 for(const kind of ['none','watchLater'])new DouyinSavedPlaybackDiagnostic({kind,url:'',...context},()=>NOW).playbackFailure({code:'source_expired'});
 const cancelled=new DouyinSavedPlaybackDiagnostic({kind:'favorite',url:'',...context},()=>NOW);
 cancelled.resolution('initial',{ok:false,code:'CANCELLED',forceRefresh:false});cancelled.openError();expect(rows).toEqual([]);
 const stale=new DouyinSavedPlaybackDiagnostic({kind:'favorite',url:'',...context},()=>NOW);stale.playbackFailure({code:'CANCELLED'});stale.end();stale.playbackFailure({code:'decode_error'});expect(rows).toEqual([]);
 const missing=new DouyinSavedPlaybackDiagnostic({kind:'both',url:'',...context},()=>NOW);
 missing.resolution('initial',{ok:false,code:'PARSE_FAILED',forceRefresh:false});missing.openError();expect(rows).toHaveLength(1);
});
test('durable retry retains event identity; wire payload excludes raw identifiers and arbitrary errors',async()=>{
 const f=fixture();await f.telemetry.capture(context,occurrence);await f.flush();expect(f.telemetry.backlogCount()).toBe(1);
 const first=events(f);expect(first[0]).toMatchObject({ageMs:15*DAY,stage:'player',code:'source_expired',appVersion:'fixture-version'});
 expect(first[0].collectionKey).toMatch(/^[0-9a-f]{64}$/);expect(f.requests[0].headers.Authorization).toBe('Bearer access-a');
 expect(utf8Decode(f.requests[0].body!)).not.toMatch(/private-video-id|private-phone|account-a|installation-a|private-refresh/);
 const restarted=fixture(f.disk);restarted.setStatus(200);restarted.telemetry.retryPending();await restarted.flush();expect(events(restarted)).toEqual(first);expect(restarted.telemetry.backlogCount()).toBe(0);
});
test('collection digest is stable across devices but changes with account, backend or re-save',async()=>{
 const keys:string[]=[];
 for(const [owner,saved] of [[account,context.savedAtMillis],[{...account,installId:'device-b',watchDeviceToken:'access-b'},context.savedAtMillis],[{...account,userId:'account-b'},context.savedAtMillis],[{...account,backendBaseUrl:'https://other.invalid'},context.savedAtMillis],[account,NOW-DAY]] as const){
  const f=fixture();f.setOwner(owner);await f.telemetry.capture({...context,savedAtMillis:saved},occurrence);await f.flush();keys.push(events(f)[0].collectionKey);
 }
 expect(keys[0]).toBe(keys[1]);expect(new Set(keys).size).toBe(4);
});
test('account switching cannot upload another account backlog; unbound capture is excluded',async()=>{
 const f=fixture();f.setOwner(null);await f.telemetry.capture(context,occurrence);expect(f.telemetry.backlogCount()).toBe(0);
 f.setOwner(account);await f.telemetry.capture(context,occurrence);f.setOwner({...account,userId:'account-b',watchDeviceToken:'access-b'});await f.flush();expect(f.requests).toHaveLength(0);expect(f.telemetry.backlogCount()).toBe(1);
 await f.telemetry.capture(context,occurrence);f.setStatus(200);await f.flush();expect(events(f)).toHaveLength(1);expect(f.requests[0].headers.Authorization).toBe('Bearer access-b');expect(f.telemetry.backlogCount()).toBe(1);
 f.setOwner(account);f.telemetry.retryPending();await f.flush();expect(f.requests[1].headers.Authorization).toBe('Bearer access-a');expect(f.telemetry.backlogCount()).toBe(0);
});
test('unknown/future ages remain null and error text maps to unknown; network failure retains events',async()=>{
 const f=fixture();f.intercept(async()=>{throw Error('offline');});
 for(const savedAtMillis of [undefined,NOW+1,NaN,NOW-15*DAY])await f.telemetry.capture({itemId:'id',savedAtMillis},{...occurrence,code:'https://private.invalid/token'});
 await f.flush();expect(events(f).map((e:{ageMs:unknown})=>e.ageMs)).toEqual([null,null,null,15*DAY]);expect(events(f).every((e:{code:string})=>e.code==='unknown')).toBe(true);expect(f.telemetry.backlogCount()).toBe(4);
});
test('capture appended during upload survives acknowledgment and uploads in the next batch',async()=>{
 const f=fixture();f.setStatus(200);let release!:()=>void;f.intercept(()=>new Promise(resolve=>{release=resolve;}));
 await f.telemetry.capture(context,occurrence);await f.flush();await f.telemetry.capture(context,{...occurrence,atMillis:NOW+1});
 f.intercept();release();await tick();expect(f.requests).toHaveLength(2);expect(events(f,0)[0].eventId).not.toBe(events(f,1)[0].eventId);expect(f.telemetry.backlogCount()).toBe(0);
});
