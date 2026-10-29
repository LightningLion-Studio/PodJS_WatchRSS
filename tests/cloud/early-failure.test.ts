import {expect,test} from 'bun:test';
import {createCloudRuntime} from '../../src/cloud/runtime';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {cloudStage,cloudSyncFailure} from '../../src/cloud/failure';
import {cloudFormatFailure} from '../../src/cloud/format-diagnostic';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
import {CloudForegroundExecution,CLOUD_SYNC_BUDGET_MILLIS} from '../../src/cloud/execution';
import {WatchCloudScheduler} from '../../src/cloud/scheduler';
import {CloudManualHandoff,MANUAL_INTENT_KEY} from '../../src/cloud/manual-handoff';
import {enabled,crypto} from './k2-crypto';
import {fixture} from './service-fixture';
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const secret='PRIVATE https://private.invalid/?token=secret';
function runtimeFixture(fail?:string){
 const calls:string[]=[],events:any[]=[];let writer=true;
 const runtime=createCloudRuntime(async<T>(method:string)=>{calls.push(method);if(method===fail)throw Error(secret);if(method==='cloud.acquire')return {acquired:writer} as T;if(method==='cloud.release')return {} as T;if(method==='file.list')return {entries:[]} as T;if(method==='discovery.networkSnapshot')return {active:true,validated:true,wifi:true,metered:false} as T;if(method==='secure.get')return {exists:false} as T;throw Error(secret);},async()=>{throw Error('repository must stay lazy');},enabled,undefined,undefined,undefined,{formatDiagnostic:v=>events.push(JSON.parse(v))});
 return {runtime,calls,events,busy:(busy:boolean)=>{writer=!busy;}};
}
test('1171: background writer contention defers before any network/account/records IO with a fixed code',async()=>{
 const f=runtimeFixture();f.busy(true);expect(await f.runtime.service.syncNow(true)).toBe(false);
 expect(f.calls).toEqual(['cloud.acquire']);expect(f.events.at(-1)).toMatchObject({outcome:'deferred',category:'busy',code:'cloud_writer_busy',stage:'lease_acquire'});
 expect(f.runtime.service.status).toMatchObject({phase:'idle',retryable:true});expect(f.runtime.service.status.retryAtMillis!).toBeGreaterThan(Date.now());
 f.busy(false);await f.runtime.service.syncNow();expect(f.calls).toContain('discovery.networkSnapshot');expect(f.calls.at(-1)).toBe('cloud.release');
});
test('production host acquire, cleanup, network and account-read failures have closed stage codes and release only acquired leases',async()=>{
 for(const [method,code,released] of [['cloud.acquire','cloud_sync_lease_acquire_failed',false],['file.list','cloud_sync_cleanup_failed',true],['discovery.networkSnapshot','cloud_sync_network_failed',true],['secure.get','cloud_sync_account_read_failed',true]] as const){
  const f=runtimeFixture(method);expect(await f.runtime.service.syncNow()).toBe(false);expect(f.events.at(-1).code).toBe(code);expect(f.events.at(-1).category).not.toBe('other');expect(f.events.at(-1).stage).toBe(code.slice('cloud_sync_'.length,-'_failed'.length));expect(f.calls.includes('cloud.release')).toBe(released);expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE|private.invalid|secret/);
 }
});
test('service preflight owner/bootstrap/content/device/keys/checkpoint failures never become unclassified',async()=>{
 for(const stage of ['session_open','owner','bootstrap','content','device','keys','checkpoint'] as const){
  const f=await fixture(),events:any[]=[];let records=0;f.session.records=async()=>{records++;throw Error('must stay closed');};
  const fail=async()=>{throw Error(secret);};
  if(stage==='owner')f.session.assertOwnership=fail;
  if(stage==='bootstrap')f.session.client.bootstrap=fail;
  if(stage==='content')f.session.state.acceptEpoch=fail;
  if(stage==='device')f.session.keys.publicKeySpki=fail;
  if(stage==='keys')f.session.keys.acceptBootstrap=fail;
  if(stage==='checkpoint')f.session.state.restoreJournal=fail;
  const service=new WatchCloudSyncService({open:stage==='session_open'?fail:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'unused',exclusive:async run=>run(),formatDiagnostic:v=>events.push(JSON.parse(v))},enabled);
  expect(await service.syncNow()).toBe(false);expect(events.at(-1)).toMatchObject({outcome:'failed',code:'cloud_sync_'+stage+'_failed',category:'runtime'});expect(records).toBe(0);expect(f.reservations.size).toBe(0);expect(JSON.stringify(events)).not.toMatch(/PRIVATE|private.invalid|secret/);
 }
});
test('nested runtime stages preserve cause, known owner/HTTP/timeout codes, and account contention classification',async()=>{
 for(const stage of ['account_current','owner','token','repository'] as const){const original=Error(secret);try{await cloudStage(stage,async()=>{throw original;});throw Error('must reject');}catch(error){expect((error as Error).cause).toBe(original);expect(JSON.parse(recordFailureDiagnostic(error)).code).toBe('cloud_sync_'+stage+'_failed');}}
 for(const code of ['library_owner_mismatch','cloud_sync_suspended','cloud_sync_deadline_exceeded','device_key_conflict'] as const){const original=Object.assign(Error(secret),{code,status:409});expect(cloudSyncFailure(original,'session_open')).toBe(original);}
 for(const [status,category] of [[401,'authorization'],[409,'conflict'],[413,'capacity'],[503,'server'],[426,'format']] as const){const error=cloudSyncFailure(Object.assign(Error(secret),{status}),'session_open');expect(cloudFormatFailure(error)).toBe(category);expect((error as any).status).toBe(status);}
 const disk=Object.assign(Error(secret),{code:'ENOSPC'});expect(cloudSyncFailure(disk,'session_open')).toBe(disk);expect(cloudFormatFailure(disk)).toBe('storage');expect(JSON.parse(recordFailureDiagnostic(disk)).code).toBe('cloud_local_storage_full');
 expect(cloudFormatFailure(cloudSyncFailure(Error('request timeout'),'session_open'))).toBe('timeout');
 expect(cloudFormatFailure(Error('Cloud lease already owned'))).toBe('busy');expect(JSON.parse(recordFailureDiagnostic(Error('Cloud lease already owned'))).code).toBe('cloud_writer_busy');
 expect(JSON.parse(recordFailureDiagnostic(Error('account_busy: '+secret))).code).toBe('cloud_account_busy');
 const f=runtimeFixture('cloud.release');await f.runtime.service.syncNow();expect(f.events.at(-1)).toMatchObject({code:'cloud_sync_lease_release_failed',category:'runtime'});
});
test('release failure cannot replace the primary failure and its diagnostic exposes only a fixed cleanup code',async()=>{
 const events:any[]=[];const runtime=createCloudRuntime(async<T>(method:string)=>{if(method==='cloud.acquire')return {acquired:true} as T;if(method==='cloud.release')throw Error(secret);if(method==='file.list')throw Error('account_busy: '+secret);throw Error('unexpected');},async()=>{throw Error('unused');},enabled,undefined,undefined,undefined,{formatDiagnostic:v=>events.push(JSON.parse(v))});
 expect(await runtime.service.syncNow()).toBe(false);expect(events.at(-1)).toMatchObject({code:'cloud_account_busy',cleanupCode:'cloud_sync_lease_release_failed',outcome:'deferred',category:'busy'});expect(JSON.stringify(events)).not.toMatch(/PRIVATE|private.invalid|secret/);
});
test('foreground suspension and exhausted budget before session open have fixed codes and never open an account',async()=>{
 for(const suspended of [true,false]){const events:any[]=[],execution=new CloudForegroundExecution(!suspended);let now=0,opened=0;
 const service=new WatchCloudSyncService({open:async()=>{execution.begin();opened++;return undefined;},network:async()=>{if(!suspended)now=CLOUD_SYNC_BUDGET_MILLIS;return {active:true,validated:true,wifi:true,metered:false};},hash:crypto.sha256,uuid:async()=> 'unused',exclusive:async run=>run(),now:()=>now,formatDiagnostic:v=>events.push(JSON.parse(v))},enabled);
 expect(await service.syncNow()).toBe(false);expect(opened).toBe(0);expect(events.at(-1)).toMatchObject({code:suspended?'cloud_sync_suspended':'cloud_sync_deadline_exceeded',category:suspended?'suspended':'timeout',outcome:suspended?'deferred':'failed'});}
});
test('writer busy preserves a manual all intent and the scheduler automatically retries after release without a user press',async()=>{
 const f=await fixture();let now=10,busy=true;const timers:{at:number;fn:()=>void;cancelled:boolean}[]=[],events:any[]=[],values=new Map<string,string>(),modes:string[]=[];let runs=0;
 const service=new WatchCloudSyncService({exclusive:async run=>{if(busy)throw Error('cloud_writer_busy');return run();},network:async()=>({active:true,validated:true,wifi:true,metered:false}),open:async()=>f.session,hash:crypto.sha256,uuid:async()=> 'local-retry',now:()=>now,formatDiagnostic:v=>events.push(JSON.parse(v))},enabled);
 let handoff:CloudManualHandoff;
 const scheduler=new WatchCloudScheduler({now:()=>now,sync:async(manual,mode)=>{runs++;modes.push(mode!);const complete=manual?handoff.captureCompletion():undefined;const success=await service.syncNow(manual,mode);await complete?.(success);if(service.status.retryAtMillis)scheduler.deferUntil(service.status.retryAtMillis,manual?mode:undefined);return success;},delay:(ms,fn)=>{const t={at:now+ms,fn,cancelled:false};timers.push(t);return()=>{t.cancelled=true;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
 handoff=new CloudManualHandoff(async<T>(method:string,args:Record<string,unknown>)=>{if(method==='crypto.random')return {bytesBase64:'opaque'} as T;if(method==='secure.set'){values.set(args.key as string,args.value as string);return {} as T;}if(method==='secure.get')return {exists:values.has(args.key as string),value:values.get(args.key as string)} as T;if(method==='secure.delete')values.delete(args.key as string);return {} as T;},async()=> 'fixture-scope',mode=>scheduler.manual(mode),()=>now);
 expect(await handoff.manual('all')).toBe(false);expect(values.has(MANUAL_INTENT_KEY)).toBe(true);expect(runs).toBe(1);
 // The app's foreground event pumps the queued retry, without another press.
 scheduler.foreground(true);await settle();expect(runs).toBe(1);const timer=timers.find(t=>!t.cancelled)!;expect(timer.at).toBe(30010);busy=false;now=timer.at;timer.fn();for(let i=0;i<100&&events.length<2;i++)await Bun.sleep(1);await settle();expect(runs).toBe(2);expect(modes).toEqual(['all','all']);expect(events.at(-1).outcome).toBe('complete');expect(values.has(MANUAL_INTENT_KEY)).toBe(false);scheduler.dispose();
});
