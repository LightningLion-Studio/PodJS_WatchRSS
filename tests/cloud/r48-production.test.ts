import {test,expect} from 'bun:test';
import {WatchCloudClient} from '../../src/cloud/client';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {cloudFormatFailure} from '../../src/cloud/format-diagnostic';
import {utf8Encode} from '../../src/cloud/types';
import {crypto,enabled} from './k2-crypto';
import {fixture} from './service-fixture';

test('format telemetry counts each HTTP attempt including 401 retry, with no request or response contents',async()=>{
 const events:any[]=[];let attempts=0,now=100;
 const client=new WatchCloudClient({request:async()=>{now+=3;return {status:++attempts===1?401:200,headers:{authorization:'secret'},body:utf8Encode(attempts===1?'PRIVATE REJECTED BODY':'{}')};}},
 {baseUrl:'https://private.example',accessToken:'SECRET TOKEN',refreshToken:async()=> 'ANOTHER SECRET',formatDiagnostic:v=>events.push(JSON.parse(v)),now:()=>now},crypto,enabled);
 await client.formatCapabilities();
 expect(events.map(e=>[e.operation,e.status,e.category,e.durationMillis])).toEqual([['capabilities',401,'authorization',3],['capabilities',200,'none',3]]);
 expect(events.map(e=>e.submittedBytes)).toEqual([0,0]);expect(events.map(e=>e.responseBytes)).toEqual([21,2]);
 expect(JSON.stringify(events)).not.toMatch(/SECRET|PRIVATE|private\.example|authorization.*secret/);
});

test('format telemetry reports submitted encrypted bytes, server failure and lost transport without claiming delivery',async()=>{
 const events:any[]=[];let fail=false;
 const client=new WatchCloudClient({request:async()=>{if(fail)throw Error('SECRET /private/body');return {status:503,headers:{},body:utf8Encode('{}')};}},
 {baseUrl:'https://fixture.test',accessToken:'secret',formatDiagnostic:v=>events.push(JSON.parse(v))},crypto,enabled);
 client.setEpoch('epoch');client.setContentGeneration('55555555-5555-4555-8555-555555555555');
 const body=utf8Encode('synthetic encrypted bytes'),hash=await crypto.sha256(body);
 const target={kind:'chunk',transport:'epoch-proxy',uploadMethod:'PUT',reservationId:'synthetic',uploadUrl:'https://fixture.test/functions/v1/cloud/uploads/synthetic',sizeBytes:body.length,sha256:hash} as any;
 await expect(client.uploadObject(target,body)).rejects.toThrow('503');fail=true;await expect(client.uploadObject(target,body)).rejects.toThrow('SECRET');
 expect(events.map(e=>[e.operation,e.submittedBytes,e.success,e.category,e.status])).toEqual([['upload',body.length,false,'server',503],['upload',body.length,false,'transport',0]]);
 expect(JSON.stringify(events)).not.toMatch(/SECRET|private|synthetic|encrypted bytes/);
});

test('diagnostic sink failure cannot break default production client or sync outcome',async()=>{
 const client=new WatchCloudClient({request:async()=>({status:200,headers:{},body:utf8Encode('{}')})},{baseUrl:'https://fixture.test',accessToken:'synthetic',formatDiagnostic:()=>{throw Error('logger full');}},crypto,enabled);
 await client.formatCapabilities();
 const f=await fixture(),service=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'diagnostic-head',exclusive:async fn=>fn(),formatDiagnostic:()=>{throw Error('logger full');}},enabled);
 expect(await service.syncNow()).toBe(true);
});

test('sync outcomes distinguish completion, deferred network and storage failure; disk full remains retryable',async()=>{
 const f=await fixture(),events:any[]=[];let broken=false;
 const service=new WatchCloudSyncService({open:async()=>{if(broken)throw Object.assign(Error('disk secret'),{code:'ENOSPC'});return f.session;},network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'metric-head',exclusive:async fn=>fn(),formatDiagnostic:v=>events.push(JSON.parse(v))},enabled);
 f.network.active=false;expect(await service.syncNow()).toBe(false);f.network.active=true;expect(await service.syncNow()).toBe(true);
 broken=true;expect(await service.syncNow()).toBe(false);expect(service.status.retryable).toBe(true);expect(service.status.message).toContain('存储空间不足');
 expect(events.map(e=>[e.outcome,e.category])).toEqual([['deferred','none'],['complete','none'],['failed','storage']]);expect(JSON.stringify(events)).not.toContain('secret');
});

test('closed diagnostic categories do not disclose arbitrary codes or exception payloads',()=>{
 for(const [error,category] of [[{code:'ENOSPC'},'storage'],[Error('SQLITE_FULL: secret'),'storage'],[Error('cloud_sync_suspended'),'suspended'],[Error('cloud_format_write_disabled'),'gate'],[{status:409},'conflict'],[{status:429},'capacity'],[Error('cloud_format_future'),'format'],[{code:'SECRET BODY',message:'SECRET BODY'},'other']] as const)expect(cloudFormatFailure(error)).toBe(category);
});

for(const boundary of ['chunk','manifest','pending','latest','clear-pending'] as const)test(`atomic storage fault at ${boundary} keeps prior publication and resumes after reconstructed guest`,async()=>{
 const f=await fixture();expect(await f.service.syncNow(true)).toBe(true);const old=f.heads.get('watch')!,oldLatest=(await f.cache.latest('user'))!;
 f.session.library.exportPayloads=async()=>({objects:[{name:'reader/new.txt',bytes:utf8Encode('new local content')}],fingerprint:'changed-content'});
 let failed=false;
 const files={read:async(p:string)=>f.blobs.get(p),writeAtomic:async(p:string,b:Uint8Array)=>{
  const hit=boundary==='chunk'?p.includes('/chunks/'):boundary==='manifest'?p.includes('/manifests/'):boundary==='latest'?p.endsWith('/latest'):p.endsWith('/pending')&&(boundary==='clear-pending'?b.length===0:b.length>0);
  if(hit&&!failed){failed=true;throw Object.assign(Error('synthetic disk full'),{code:'ENOSPC'});}f.blobs.set(p,b.slice());
 }};
 f.session.cache=new WatchCloudCache(files,crypto.sha256,enabled);
 expect(await f.service.syncNow(true)).toBe(false);expect(failed).toBe(true);expect(f.service.status.message).toContain('存储空间不足');
 expect(f.objects.has(old.manifestSha256)).toBe(true);expect(await f.cache.manifest('user',oldLatest.id)).toEqual(oldLatest.bytes);
 if(['chunk','manifest','pending'].includes(boundary))expect(f.heads.get('watch')!.id).toBe(old.id);
 // Reconstruct cache + coordinator from only durable maps, as on process death.
 f.session.cache=new WatchCloudCache({read:files.read,writeAtomic:async(p,b)=>{f.blobs.set(p,b.slice());}},crypto.sha256,enabled);
 const restarted=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'recovery-head',exclusive:async fn=>fn(),now:()=>100},enabled);
 expect(await restarted.syncNow(true)).toBe(true);expect(await f.cache.pending('user')).toBeUndefined();expect(f.objects.has(old.manifestSha256)).toBe(true);
 if(['latest','clear-pending'].includes(boundary)){expect(f.heads.get('watch')!.id).toBe('local-2');expect(f.reservations.size).toBe(2);}
 expect(await f.state.lastContentHash(true)).toBe(await crypto.sha256(utf8Encode(`v3:9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff:${f.content().contentGeneration}:1:changed-content`)));
});

for(const boundary of ['applied','fingerprint'] as const)test(`durable ${boundary} failure after complete recovers confirmed head without a duplicate publication`,async()=>{
 const f=await fixture();expect(await f.service.syncNow(true)).toBe(true);const old=f.heads.get('watch')!,oldHash=await f.state.lastContentHash(true);
 f.session.library.exportPayloads=async()=>({objects:[{name:'reader/changed.txt',bytes:utf8Encode('changed')}],fingerprint:'changed'});
 let failed=false;const storage={get:async(k:string)=>f.store.get(k),set:async(k:string,v:string)=>{
  const value=k.startsWith('watchrss.cloud.state.')?JSON.parse(v):{},hit=boundary==='applied'?value.applied_full?.watch>old.deviceSequence:value.content_hash_full&&value.content_hash_full!==oldHash;
  if(hit&&!failed){failed=true;throw Object.assign(Error('synthetic full state store'),{code:'ENOSPC'});}f.store.set(k,v);
 }};
 f.session.state=new WatchCloudStateStore(storage,'user','watch',enabled);
 expect(await f.service.syncNow(true)).toBe(false);expect(failed).toBe(true);const committed=f.heads.get('watch')!;expect(committed.id).not.toBe(old.id);
 f.session.state=new WatchCloudStateStore({get:storage.get,set:async(k,v)=>{f.store.set(k,v);}},'user','watch',enabled);
 const restarted=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'must-not-publish',exclusive:async fn=>fn(),now:()=>100},enabled);
 expect(await restarted.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(2);expect(f.heads.get('watch')!.id).toBe(committed.id);expect(await f.state.applied('watch',true)).toBe(committed.deviceSequence);expect(await f.state.lastContentHash(true)).not.toBe(oldHash);expect(f.objects.has(old.manifestSha256)).toBe(true);
});

test('a capability response taking the whole TTL never authorizes a new write',async()=>{
 let now=100;
 const client=new WatchCloudClient({request:async()=>{now+=30000;return {status:200,headers:{},body:utf8Encode(JSON.stringify({protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:true}}))};}},
 {baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true,now:()=>now},crypto,enabled);
 expect(await client.refreshR48WriteGate()).toBe(false);expect(client.r48WriteEnabled).toBe(false);
});

test('instant backend policy rejection is retryable and does not claim an upgrade or a completed sync',async()=>{
 const f=await fixture();f.fault(r=>r.url.endsWith('/reserve')?{status:503,error:'r48_write_feature_disabled'}:undefined);
 expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.retryable).toBe(true);expect(f.service.status.message).toContain('写入暂未开放');expect(f.service.status.phase).toBe('idle');expect(await f.state.lastContentHash(true)).toBeUndefined();expect(await f.cache.pending('user')).toBeDefined();
 });

test('a records-lane error returned without throwing is still a failed sync metric, never a completion',async()=>{
 const f=await fixture(),events:any[]=[];f.session.records=async()=>{throw Error('private body is never logged');};
 const service=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'records-failed',exclusive:async fn=>fn(),formatDiagnostic:v=>events.push(JSON.parse(v))},enabled);
 expect(await service.syncNow()).toBe(false);expect(events.at(-1)).toMatchObject({event:'format-sync',outcome:'failed',category:'other'});expect(JSON.stringify(events)).not.toContain('private body');
 });
