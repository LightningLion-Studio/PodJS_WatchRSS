import {test,expect} from 'bun:test';
import {WatchDeviceProfileTelemetry,type DeviceProfileReport} from '../../src/telemetry/device-profile';

const MINUTE=60000;
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(){
 const data=new Map<string,unknown>(),sent:DeviceProfileReport[]=[];
 const timers:{ms:number;callback:()=>void;cancelled:boolean}[]=[];
 let now=Date.parse('2026-11-14T01:00:00Z'),random=0,reads=0;
 let resolve!:(id:string)=>void,reject!:(error:Error)=>void;
 const identity=new Promise<string>((ok,fail)=>{resolve=ok;reject=fail;});
 const t=new WatchDeviceProfileTelemetry({get:k=>data.get(k),set:(k,v)=>{data.set(k,v);}},{
  consented:()=>true,buildInfo:async()=>({debugBuild:false}),info:async()=>({brand:'fixture',manufacturer:'',model:'fixture',device:'',product:''}),
  identity:()=>{reads++;return identity;},send:async report=>{sent.push(report);return {acceptedDays:report.activeDays};},
  random:()=>random,now:()=>now,after:(ms,callback)=>{const timer={ms,callback,cancelled:false};timers.push(timer);return ()=>{timer.cancelled=true;};},
  versionName:'fixture',versionCode:1,privacyPolicyVersion:2,
 });
 return {t,sent,timers,reads:()=>reads,tick:(ms:number)=>{now+=ms;},random:(value:number)=>{random=value;},
  resolve:()=>resolve('11111111-1111-4111-8111-111111111111'),reject:()=>reject(Error('late identity failure'))};
}
async function pendingIdentity(f:ReturnType<typeof fixture>){
 await f.t.refresh(true);f.tick(30*MINUTE);const pending=f.t.refresh();await settle();expect(f.reads()).toBe(1);return {pending};
}

test('resume_identity_probe: pending identity cannot bypass the new foreground delay',async()=>{
 const f=fixture();const {pending}=await pendingIdentity(f);
 await f.t.refresh(false);const resumed=f.t.refresh(true);f.resolve();await Promise.all([pending,resumed]);
 expect(f.sent).toHaveLength(0);expect(f.timers.at(-1)!.ms).toBe(30*MINUTE);
 f.tick(30*MINUTE-1);await f.t.refresh();expect(f.sent).toHaveLength(0);
 f.tick(1);await f.t.refresh();expect(f.sent).toHaveLength(1);f.t.stop();
});

test('old foreground generation is discarded even after the new deadline expires',async()=>{
 const f=fixture();const {pending}=await pendingIdentity(f);
 await f.t.refresh(false);f.random(1);const resumed=f.t.refresh(true);
 f.tick(180*MINUTE);f.resolve();await Promise.all([pending,resumed]);
 expect(f.sent).toHaveLength(0);expect(f.timers.at(-1)!.ms).toBe(1000);
 f.tick(1000);f.timers.at(-1)!.callback();await settle();await f.t.refresh();
 expect(f.reads()).toBe(2);expect(f.sent).toHaveLength(1);f.t.stop();
});

test('multiple foreground entries retain the latest randomized deadline',async()=>{
 const f=fixture();const {pending}=await pendingIdentity(f);
 await f.t.refresh(false);f.random(0.5);const first=f.t.refresh(true);
 await f.t.refresh(false);f.tick(5*MINUTE);f.random(1);const second=f.t.refresh(true);
 f.resolve();await Promise.all([pending,first,second]);expect(f.sent).toHaveLength(0);
 expect(f.timers.at(-1)!.ms).toBe(180*MINUTE);
 f.tick(105*MINUTE);await f.t.refresh(true,true);expect(f.sent).toHaveLength(0);
 expect(f.timers.at(-1)!.ms).toBe(75*MINUTE);f.t.stop();
});

test('stale identity failure cannot overwrite the new foreground deadline',async()=>{
 const f=fixture();const {pending}=await pendingIdentity(f);
 await f.t.refresh(false);const resumed=f.t.refresh(true);f.tick(10*MINUTE);
 f.reject();await Promise.all([pending,resumed]);expect(f.sent).toHaveLength(0);
 expect(f.timers.at(-1)!.ms).toBe(20*MINUTE);f.t.stop();
});

test('identity completion rechecks the deadline after a clock rollback in the same generation',async()=>{
 const f=fixture();const {pending}=await pendingIdentity(f);f.tick(-5*MINUTE);
 f.resolve();await pending;expect(f.sent).toHaveLength(0);expect(f.timers.at(-1)!.ms).toBe(5*MINUTE);
 f.tick(5*MINUTE);await f.t.refresh();expect(f.sent).toHaveLength(1);f.t.stop();
});
