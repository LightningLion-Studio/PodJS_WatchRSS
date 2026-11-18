import {test,expect} from 'bun:test';
import {WatchDeviceProfileTelemetry,deviceProfileDay,type DeviceProfileReport} from '../../src/telemetry/device-profile';

function fixture(){
 const data=new Map<string,unknown>(),sent:DeviceProfileReport[]=[],reads:string[]=[];
 const timers:{ms:number;callback:()=>void;cancelled:boolean}[]=[];
 let now=Date.parse('2026-11-13T01:00:00Z'),agreed=true,debug=false,fail=false,unsupported=false;
 let onSend:((report:DeviceProfileReport)=>{acceptedDays:string[]})|undefined;
 const storage={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};
 let random=0;
 const ports={random:()=>random,consented:()=>agreed,now:()=>now,privacyPolicyVersion:2,versionName:'1.0',versionCode:1,
  buildInfo:async()=>{reads.push('build');return {debugBuild:debug};},
  info:async()=>{reads.push('info');if(unsupported)throw {code:'unsupported'};return {brand:'OnePlus',manufacturer:'OPLUS',model:'OPWWE231',device:'OPWWE231',product:'OPWWE231'};},
  identity:async()=>{reads.push('identity');return '39f713a4-d23f-4a90-96e9-4c906a046952';},
  send:async(report:DeviceProfileReport)=>{sent.push(report);if(fail)throw Error('offline');return onSend?.(report)??{acceptedDays:report.activeDays};},
  after:(ms:number,callback:()=>void)=>{const t={ms,callback,cancelled:false};timers.push(t);return ()=>{t.cancelled=true;};},
 };
 const create=()=>new WatchDeviceProfileTelemetry(storage,ports);
 return {advance:async(t:WatchDeviceProfileTelemetry)=>{now+=timers.at(-1)!.ms;await t.refresh();},random:(n:number)=>{random=n;},sent,reads,timers,data,create,t:create(),onSend:(fn?:typeof onSend)=>{onSend=fn;},now:(s:string)=>{now=Date.parse(s);},agreed:(v:boolean)=>{agreed=v;},debug:(v:boolean)=>{debug=v;},fail:(v:boolean)=>{fail=v;},unsupported:()=>{unsupported=true;}};
}
test('no host reads, identity creation, persisted data or traffic before consent',async()=>{
 const f=fixture();f.agreed(false);await f.t.refresh(true);expect(f.reads).toEqual([]);expect(f.data.size).toBe(0);
 f.agreed(true);await f.t.refresh();expect(f.sent).toHaveLength(0);await f.advance(f.t);
 expect(f.sent[0].privacyPolicyVersion).toBe(2);
});
test('release-only uploads use an independent identity and deduplicate across restart',async()=>{
 const f=fixture();await f.t.refresh(true);await f.advance(f.t);expect(f.sent).toHaveLength(1);
 expect(Object.keys(f.sent[0]).sort()).toEqual(['activeDays','anonymousDeviceId','appVersionCode','appVersionName','deviceInfo','privacyPolicyVersion']);
 f.t.stop();const next=f.create();await next.refresh(true);expect(f.sent).toHaveLength(1);
 const debug=fixture();debug.debug(true);await debug.t.refresh(true);expect(debug.reads).toEqual(['build']);expect(debug.data.size).toBe(0);
 const old=fixture();old.unsupported();await old.t.refresh(true);await old.t.refresh();expect(old.reads).toEqual(['build','info']);expect(old.sent).toEqual([]);
});
test('Shanghai midnight records the new day without immediate traffic and background cancels timers',async()=>{
 const f=fixture();f.now('2026-11-13T15:59:59Z');await f.t.refresh(true);expect(f.timers.at(-1)?.ms).toBe(1000);
 f.now('2026-11-13T16:00:00Z');await f.t.refresh();expect(f.sent).toHaveLength(0);
 await f.advance(f.t);expect(f.sent[0].activeDays).toEqual(['2026-11-13']);
 await f.t.refresh(false);expect(f.timers.at(-1)?.cancelled).toBe(true);
 expect(deviceProfileDay(Date.parse('2026-11-13T15:59:59Z'))).toBe('2026-11-13');
});
test('offline days survive restart and each delayed request sends exactly one deduplicated day',async()=>{
 const f=fixture();f.fail(true);await f.t.refresh(true);await f.advance(f.t);expect(f.sent).toHaveLength(1);
 await f.t.refresh(true,true);expect(f.sent).toHaveLength(1);
 f.now('2026-11-14T01:00:00Z');await f.t.refresh();expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-13']);
 f.t.stop();f.fail(false);const next=f.create();await next.refresh(true);const before=f.sent.length;
 expect(f.sent).toHaveLength(before);await f.advance(next);expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-13']);
 await f.advance(next);expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-14']);
 f.now('2026-11-22T01:00:00Z');await next.refresh();await f.advance(next);expect(f.sent.at(-1)?.activeDays).toEqual(['2026-11-22']);
});
test('overlapping refreshes share one delayed request; stop during host reads cancels collection',async()=>{
 const f=fixture();await Promise.all([f.t.refresh(true),f.t.refresh(true),f.t.refresh(true)]);expect(f.sent).toHaveLength(0);
 await f.advance(f.t);expect(f.sent).toHaveLength(1);
 const stopped=fixture();const pending=stopped.t.refresh(true);stopped.t.stop();await pending;expect(stopped.data.size).toBe(0);expect(stopped.sent).toHaveLength(0);
});
test('partial acknowledgement and request crossing midnight preserve pending dates with new jitter',async()=>{
 const f=fixture();f.onSend(()=>({acceptedDays:[]}));await f.t.refresh(true);await f.advance(f.t);
 expect(f.timers.at(-1)?.ms).toBe(30*60000);await f.t.refresh(true,true);expect(f.sent).toHaveLength(1);
 f.onSend(report=>{f.now('2026-11-13T16:00:02Z');return {acceptedDays:report.activeDays};});
 await f.advance(f.t);await f.t.refresh();expect(f.sent).toHaveLength(2);await f.advance(f.t);expect(f.sent[2].activeDays).toEqual(['2026-11-14']);
});
test('foreground and reconnect never bypass the random profile delay',async()=>{
 for(const [random,minutes] of [[0,30],[0.5,105],[1,180]]){
  const f=fixture();f.random(random);await f.t.refresh(true);expect(f.sent).toHaveLength(0);expect(f.reads).not.toContain('identity');
  await f.t.refresh(true,true);expect(f.sent).toHaveLength(0);expect(f.timers.at(-1)!.ms).toBe(minutes!*60000);
  await f.t.refresh(false);f.now('2026-11-14T01:00:00Z');await f.t.refresh(true,true);
  expect(f.sent).toHaveLength(0);expect(f.timers.at(-1)!.ms).toBe(minutes!*60000);
 }
});
