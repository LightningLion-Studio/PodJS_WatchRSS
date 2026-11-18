import {test,expect,mock} from 'bun:test';
const data=new Map<string,unknown>([['watchrss.telemetry.install-id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],['watchrss.onboarding.v1',{}]]);
let randomCalls=0,reads=0,sendCalls=0;
const sent:any[]=[];
let now=Date.parse('2026-11-13T01:00:00Z');const originalNow=Date.now;Date.now=()=>now;
const timers:{ms:number;fire:()=>void;cancelled:boolean}[]=[];
const advance=async()=>{const timer=timers.at(-1)!;expect(timer.ms).toBeGreaterThanOrEqual(30*60000);expect(timer.ms).toBeLessThanOrEqual(180*60000);now+=timer.ms;timer.fire();await settle();};
mock.module('@podjs/framework/watch',()=>({kv:{get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>data.set(key,value)},lifecycle:()=> 'active',onLifecycleChange:()=>()=>{}}));
mock.module('@podjs/framework/services',()=>({application:{buildInfo:async()=>({debugBuild:false})},device:{info:async()=>{reads++;return {brand:'fixture',manufacturer:'fixture',model:'fixture',device:'fixture',product:'fixture'};}},delay:(ms:number)=>{let fire!:()=>void;const result=new Promise<void>(resolve=>{fire=resolve;});const timer={ms,fire,cancelled:false};timers.push(timer);return {result,cancel(){timer.cancelled=true;}};},base64ToBytes:(s:string)=>new Uint8Array(Buffer.from(s,'base64')),hostOperation:(method:string)=>{expect(method).toBe('crypto.random');randomCalls++;return {result:Promise.resolve({bytesBase64:Buffer.alloc(16,randomCalls).toString('base64')})};}}));
let agreed=false;
mock.module('../../src/onboarding/store',()=>({OnboardingStore:class{load(){return {privacyPolicyAgreedVersion:agreed?2:0};}}}));
mock.module('../../src/onboarding/network-host',()=>({observeHostInternet:()=>()=>{}}));
// If the production binding reuses the account provider, it returns the fixture ID.
mock.module('../../src/telemetry/host',()=>({installationId:async()=>data.get('watchrss.telemetry.install-id'),telemetryTransport:{request:async(r:any)=>{sendCalls++;const report=JSON.parse(new TextDecoder().decode(r.body));sent.push(report);return {status:200,body:new TextEncoder().encode(JSON.stringify({acceptedDays:report.activeDays}))};}}}));
const {startDeviceProfileTelemetry}=await import('../../src/telemetry/device-profile-host');
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
test('production profile binding creates a private identity only after consent and preserves it across restart',async()=>{
 let stop=startDeviceProfileTelemetry();await settle();stop();expect(randomCalls).toBe(0);expect(reads).toBe(0);expect(sendCalls).toBe(0);
 agreed=true;stop=startDeviceProfileTelemetry();await settle();expect(sent).toHaveLength(0);expect(randomCalls).toBe(0);await advance();stop();expect(sent).toHaveLength(1);expect(randomCalls).toBe(1);
 expect(sent[0].anonymousDeviceId).not.toBe(data.get('watchrss.telemetry.install-id'));
 expect(data.get('watchrss.device-profile.install-id')).toBe(sent[0].anonymousDeviceId);
 const stable=sent[0].anonymousDeviceId;data.set('watchrss.telemetry.install-id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 // Clear only the recorded day to exercise a second host upload after restart.
 data.delete('watchrss.telemetry.device-profile.v1');stop=startDeviceProfileTelemetry();await settle();await advance();stop();
 expect(sent).toHaveLength(2);expect(sent[1].anonymousDeviceId).toBe(stable);expect(randomCalls).toBe(1);expect(data.get('watchrss.device-profile.install-id')).toBe(stable);Date.now=originalNow;
});
