import {test,expect} from 'bun:test';
import {WatchDeviceProfileTelemetry,deviceProfileDay,type DeviceProfileReport} from '../../src/telemetry/device-profile';

function fixture(){
 const data=new Map<string,unknown>(),sent:DeviceProfileReport[]=[],reads:string[]=[];
 const timers:{ms:number;callback:()=>void;cancelled:boolean}[]=[];
 let now=Date.parse('2026-11-13T15:59:59Z'),agreed=true,debug=false,fail=false,unsupported=false;
 let onSend:((report:DeviceProfileReport)=>{acceptedDays:string[]})|undefined;
 const storage={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};
 const ports={consented:()=>agreed,now:()=>now,privacyPolicyVersion:2,versionName:'1.0',versionCode:1,
  buildInfo:async()=>{reads.push('build');return {debugBuild:debug};},
  info:async()=>{reads.push('info');if(unsupported)throw {code:'unsupported'};return {brand:'OnePlus',manufacturer:'OPLUS',model:'OPWWE231',device:'OPWWE231',product:'OPWWE231'};},
  identity:async()=>{reads.push('identity');return '39f713a4-d23f-4a90-96e9-4c906a046952';},
  send:async(report:DeviceProfileReport)=>{sent.push(report);if(fail)throw Error('offline');return onSend?.(report)??{acceptedDays:report.activeDays};},
  after:(ms:number,callback:()=>void)=>{const t={ms,callback,cancelled:false};timers.push(t);return ()=>{t.cancelled=true;};},
 };
 const create=()=>new WatchDeviceProfileTelemetry(storage,ports);
 return {sent,reads,timers,data,create,t:create(),onSend:(fn?:typeof onSend)=>{onSend=fn;},now:(s:string)=>{now=Date.parse(s);},agreed:(v:boolean)=>{agreed=v;},debug:(v:boolean)=>{debug=v;},fail:(v:boolean)=>{fail=v;},unsupported:()=>{unsupported=true;}};
}
test('no host reads, identity creation, persisted data or traffic before consent',async()=>{
 const f=fixture();f.agreed(false);await f.t.refresh(true);expect(f.reads).toEqual([]);expect(f.sent).toEqual([]);expect(f.data.size).toBe(0);
 f.agreed(true);await f.t.refresh();expect(f.sent).toHaveLength(1);expect(f.sent[0].privacyPolicyVersion).toBe(2);
});
test('release-only uploads are account independent and a successful day stays deduplicated across restarts',async()=>{
 const f=fixture();await f.t.refresh(true);await f.t.refresh(false);await f.t.refresh(true);
 expect(f.sent).toHaveLength(1);expect(Object.keys(f.sent[0]).sort()).toEqual(['activeDays','anonymousDeviceId','appVersionCode','appVersionName','deviceInfo','privacyPolicyVersion']);
 f.t.stop();await f.create().refresh(true);expect(f.sent).toHaveLength(1);
 const debug=fixture();debug.debug(true);await debug.t.refresh(true);expect(debug.reads).toEqual(['build']);expect(debug.data.size).toBe(0);expect(debug.sent).toEqual([]);
 const old=fixture();old.unsupported();await old.t.refresh(true);await old.t.refresh(true);expect(old.sent).toEqual([]);expect(old.reads).toEqual(['build','info']);
});
test('Shanghai midnight records the new day while active and pauses all timers in background',async()=>{
 const f=fixture();await f.t.refresh(true);expect(f.sent[0].activeDays).toEqual(['2026-11-13']);expect(f.timers.at(-1)?.ms).toBe(1000);
 f.now('2026-11-13T16:00:00Z');f.timers.at(-1)!.callback();await f.t.refresh();
 expect(f.sent[1].activeDays).toEqual(['2026-11-14']);expect(f.sent[1].anonymousDeviceId).toBe(f.sent[0].anonymousDeviceId);
 await f.t.refresh(false);expect(f.timers.at(-1)?.cancelled).toBe(true);
 expect(deviceProfileDay(Date.parse('2026-11-13T15:59:59Z'))).toBe('2026-11-13');
});
test('offline days survive restart, retries back off, reconnect flushes and old days expire',async()=>{
 const f=fixture();f.fail(true);await f.t.refresh(true);expect(f.timers.at(-1)?.ms).toBe(1000);
 await f.t.refresh();expect(f.sent).toHaveLength(1);
 f.now('2026-11-14T00:00:00Z');await f.t.refresh();expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-13','2026-11-14']);
 f.t.stop();f.fail(false);const next=f.create();await next.refresh(true);expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-13','2026-11-14']);
 f.now('2026-11-20T01:00:00Z');await next.refresh();expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-20']);
 f.now('2026-11-21T01:00:00Z');f.fail(true);await next.refresh();const requests=f.sent.length;
 f.fail(false);await next.refresh(true,true);expect(f.sent).toHaveLength(requests+1);
});
test('overlapping refreshes share one request and stopping during host reads cancels collection',async()=>{
 const f=fixture();await Promise.all([f.t.refresh(true),f.t.refresh(true),f.t.refresh(true)]);expect(f.sent).toHaveLength(1);
 const stopped=fixture();const pending=stopped.t.refresh(true);stopped.t.stop();await pending;expect(stopped.sent).toHaveLength(0);expect(stopped.data.size).toBe(0);
});

test('requests spanning midnight record the new day and partial acknowledgements retry',async()=>{
 const f=fixture();f.onSend(report=>{f.now('2026-11-13T16:00:02Z');return {acceptedDays:report.activeDays};});
 await f.t.refresh(true);expect(f.timers.at(-1)?.ms).toBe(1000);f.timers.at(-1)!.callback();await f.t.refresh();expect(f.sent[1].activeDays).toEqual(['2026-11-14']);
 const partial=fixture();partial.now('2026-11-13T01:00:00Z');partial.onSend(()=>({acceptedDays:[]}));await partial.t.refresh(true);expect(partial.timers.at(-1)?.ms).toBe(60000);
 partial.onSend();await partial.t.refresh(true,true);expect(partial.sent[1].activeDays).toEqual(['2026-11-13']);await partial.t.refresh();expect(partial.sent).toHaveLength(2);
});
