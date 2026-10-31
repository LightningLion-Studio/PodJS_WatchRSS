import {test,expect} from 'bun:test';
import {fixture} from './service-fixture';
import {crypto,enabled} from './k2-crypto';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {cloudBackgroundOutcome} from '../../src/cloud/background';
import {utf8Encode} from '../../src/cloud/types';

test('only new durable units certify a fast window continuation; begin/phase/replayed counters do not',async()=>{
 const f=await fixture(),open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch','generation');
 let cp=await open();await cp.begin();await cp.phaseDone('inventory');expect(cp.advanced).toBe(true);expect(cp.committed).toBe(false);await cp.commit('real-body:1');expect(cp.committed).toBe(true);cp.close();
 cp=await open();await cp.begin();await cp.commit('real-body:1');expect(cp.committed).toBe(false);cp.close();
 cp=await open();const save=f.state.storeRestoreJournal.bind(f.state);f.state.storeRestoreJournal=async(...a)=>{if(a[1]===undefined)throw Error('header write interrupted');return save(...a);};await expect(cp.commit('real-body:2')).rejects.toThrow('header write');expect(cp.committed).toBe(true);cp.close();f.state.storeRestoreJournal=save;
 cp=await open();expect(cp.has('real-body:2')).toBe(true);expect(cp.committed).toBe(false);cp.close();
});

test('real coordinator marks a checkpointed soft deadline for a fresh request; a new session resumes and finishes',async()=>{
 const f=await fixture();await f.phone({objects:Array.from({length:8},(_,n)=>({name:'reader/'+n+'.txt',bytes:utf8Encode('body-'+n),compress:false}))});let now=0;
 const original=f.session.library.restorePayloads;f.session.library.restorePayloads=async(...a)=>{const result=await original(...a);now+=70000;return result;};f.session.library.exportPayloads=async()=>({objects:[],fingerprint:'empty'});
 const make=()=>new WatchCloudSyncService({...((f.service as any).ports),now:()=>now},enabled);
 let service=make();expect(await service.syncNow(true,'recent128')).toBe(false);expect(service.status.continuationReady).toBe(true);expect(cloudBackgroundOutcome(false,true,service.status)).toEqual({status:'retry',progress:true});
 let complete=false;for(let round=0;round<4&&!complete;round++){now=0;service=make();complete=await service.syncNow(true,'recent128');if(!complete)expect(cloudBackgroundOutcome(false,true,service.status),JSON.stringify({round,now,status:service.status,merged:f.merged})).toEqual({status:'retry',progress:true});}
 expect(complete).toBe(true);expect(service.status.continuationReady).toBe(false);expect(new Set(f.merged).size).toBe(8);expect(f.merged).toHaveLength(8);expect(f.calls.some(c=>c.url.endsWith('/ack'))).toBe(true);
});

test('network, suspension, zero-unit deadlines and stalled runs never receive a progress reset',async()=>{
 for(const error of ['network failure','cloud_sync_suspended','cloud_sync_deadline_exceeded']){
  const f=await fixture();let now=0;const e=error==='cloud_sync_deadline_exceeded'?'cloud_sync_deadline_exceeded':error;
  f.session.records=async()=>({pull:async()=>{throw Error(e);}}) as any;
  const service=new WatchCloudSyncService({...((f.service as any).ports),now:()=>now},enabled);expect(await service.syncNow(true,'recent128')).toBe(false);expect(service.status.continuationReady).toBe(false);expect(cloudBackgroundOutcome(false,true,service.status)).toBe('retry');
 }
 const f=await fixture();await f.phone();await f.state.acceptEpoch('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff');await f.state.rememberContentGeneration(f.content().contentGeneration);let now=0;const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>now).open('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',f.content().contentGeneration);await cp.begin();cp.close();
 f.session.client.snapshotHeads=async()=>{now+=300000;return [...f.heads.values()];};let service=new WatchCloudSyncService({...((f.service as any).ports),now:()=>now},enabled);expect(await service.syncNow(true,'recent128')).toBe(false);expect(service.status.errorCode).toBeUndefined();service=new WatchCloudSyncService({...((f.service as any).ports),now:()=>now},enabled);expect(await service.syncNow(true,'recent128')).toBe(false);expect(service.status).toMatchObject({errorCode:'cloud_snapshot_progress_stalled',retryable:true,continuationReady:false});expect(cloudBackgroundOutcome(false,true,service.status)).toBe('retry');
 expect(cloudBackgroundOutcome(false,false,{continuationReady:true})).toBe('retry');expect(cloudBackgroundOutcome(false,true,{continuationReady:true,errorCode:'cloud_host_capability_unavailable'})).toBe('failure');
});

test('an active writer yields benignly without turning account/network failures into a skip',async()=>{
 const f=await fixture(),service=new WatchCloudSyncService({...((f.service as any).ports),exclusive:async()=>{throw Error('cloud_writer_busy');}},enabled);
 expect(await service.syncNow(true,'recent128')).toBe(false);expect(service.status.yieldedToWriter).toBe(true);expect(cloudBackgroundOutcome(false,true,service.status)).toBe('busy');expect(cloudBackgroundOutcome(false,true,{retryable:true})).toBe('retry');
});
