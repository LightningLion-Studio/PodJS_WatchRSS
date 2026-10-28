import {test,expect} from 'bun:test';
import {CloudSyncBudget,CLOUD_SYNC_BUDGET_MILLIS} from '../../src/cloud/execution';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
import {cloudFormatFailure} from '../../src/cloud/format-diagnostic';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {fixture} from './service-fixture';
import {enabled,crypto} from './k2-crypto';
test('missing QuickJS timers and contention have fixed codes without leaking exception text',()=>{
 expect(JSON.parse(recordFailureDiagnostic(new ReferenceError('setTimeout is not defined'),'interactions',17))).toEqual({event:'records-failed',code:'host_timer_unavailable',name:'ReferenceError',stage:'interactions',durationMillis:17});
 expect(cloudFormatFailure(new ReferenceError('setTimeout is not defined'))).toBe('runtime');
 expect(JSON.parse(recordFailureDiagnostic(Error('Local library changed during sync snapshot'),'interactions')).code).toBe('library_busy');
 expect(cloudFormatFailure(Object.assign(Error('private message'),{code:'library_busy'}))).toBe('concurrent-library-change');
 for(const stage of ['open','pull','interactions','reapply','flush','confirm'] as const){const event=JSON.parse(recordFailureDiagnostic(Error('PRIVATE https://private.invalid/token=secret'),stage));expect(event.code).toBe('cloud_records_'+stage+'_failed');expect(JSON.stringify(event)).not.toMatch(/PRIVATE|private.invalid|secret/);}
});
test('cooperative budget expires at its boundary and remains expired after a clock reset',()=>{
 let now=0;const budget=new CloudSyncBudget(()=>now);now=CLOUD_SYNC_BUDGET_MILLIS-1;budget.check();now++;expect(budget.check).toThrow('cloud_sync_deadline_exceeded');now=0;expect(budget.check).toThrow('cloud_sync_deadline_exceeded');
});
test('records failure keeps its real lane category even when another snapshot requires an upgrade',async()=>{
 const f=await fixture(),events:any[]=[],records:any[]=[];await f.phone();Object.defineProperty(f.session.client,'requiredFeatures',{get:()=>['future.feature']});
 f.session.records=async()=>({pull:async()=>0,flushInteractions:async()=>{throw new ReferenceError('setTimeout is not defined');}}) as any;
 const service=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'must-not-publish',exclusive:async run=>run(),formatDiagnostic:v=>events.push(JSON.parse(v)),recordDiagnostic:v=>records.push(JSON.parse(v))},enabled);
 expect(await service.syncNow()).toBe(false);expect(events.at(-1)).toMatchObject({event:'format-sync',outcome:'failed',category:'runtime',code:'host_timer_unavailable',recordStage:'interactions'});expect(records.at(-1)).toMatchObject({code:'host_timer_unavailable',stage:'interactions'});expect(service.status.phase).not.toBe('complete');
});
test('deadline fences records publication, skips expensive later lanes and refresh, and releases the lease only after unwinding',async()=>{
 const f=await fixture();let now=0,check:(()=>void)|undefined;const events:any[]=[],calls:string[]=[];
 f.session.records=async()=>({pull:async()=>{calls.push('pull');now=CLOUD_SYNC_BUDGET_MILLIS;check?.();return 0;},flushInteractions:async()=>{throw Error('must not publish');}}) as any;
 const service=new WatchCloudSyncService({open:async c=>{check=c;return f.session;},network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'must-not-publish',exclusive:async run=>{calls.push('acquire');try{return await run();}finally{calls.push('release');}},now:()=>now,formatDiagnostic:v=>events.push(JSON.parse(v))},enabled);
 expect(await service.syncNow()).toBe(false);expect(calls).toEqual(['acquire','pull','release']);expect(f.calls.filter(c=>c.url.endsWith('/bootstrap'))).toHaveLength(1);expect(f.calls.some(c=>c.url.endsWith('/heads'))).toBe(false);expect(service.status.retryable).toBe(true);expect(events.at(-1)).toMatchObject({category:'timeout',code:'cloud_sync_deadline_exceeded',recordStage:'pull'});expect(check).toThrow('cloud_sync_deadline_exceeded');expect(await f.state.lastContentHash(true)).toBeUndefined();
});
