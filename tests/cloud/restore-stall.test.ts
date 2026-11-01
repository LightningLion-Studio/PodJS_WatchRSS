import {test,expect} from 'bun:test';
import {SnapshotYieldBudget,SNAPSHOT_DEFER_CODES} from '../../src/cloud/snapshot-deferral';
import {WatchCloudClient} from '../../src/cloud/client';
import {cloudBackgroundOutcome} from '../../src/cloud/background';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
import {crypto,enabled} from './k2-crypto';
import {fixture as serviceFixture} from './service-fixture';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {utf8Encode} from '../../src/cloud/types';

test('first attempts retain their full CPU window and a durable receipt disables the guard',()=>{
 let now=0;const budget=new SnapshotYieldBudget(()=>now);
 for(let i=0;i<2000;i++){now+=1000;expect(()=>budget.before('runtime.delay')).not.toThrow();}
 budget.stalled(true);budget.before('runtime.delay');now+=30000;expect(()=>budget.before('runtime.delay')).toThrow('cloud_snapshot_work_timeout');
 budget.stalled(false);expect(()=>budget.before('runtime.delay')).not.toThrow();
});

test('yield-only work stops after 30s despite log traffic and releases; real IO starts a fresh burst',()=>{
 let now=0;const budget=new SnapshotYieldBudget(()=>now);budget.stalled(true);
 for(let i=0;i<30;i++){budget.before('runtime.delay');now+=1000;budget.completed('runtime.delay');budget.completed('log.append');budget.completed('secure.release');}
 expect(()=>budget.before('runtime.delay')).toThrow('cloud_snapshot_work_timeout');
 budget.completed('file.read');expect(()=>budget.before('runtime.delay')).not.toThrow();
 for(let i=0;i<1023;i++)budget.before('runtime.delay');
 expect(()=>budget.before('runtime.delay')).toThrow('cloud_snapshot_work_timeout');
});

for(const [status,reason] of [[404,'missing'],[410,'missing'],[401,'unauthorized'],[403,'unauthorized'],[408,'timeout'],[504,'timeout'],[429,'rate_limited'],[307,'redirect'],[503,undefined]] as const)
 test('signed object HTTP '+status+' retains a closed reason and never receives credentials',async()=>{
  const client=new WatchCloudClient({request:async req=>{expect(req.headers).toEqual({});return {status,headers:{},body:utf8Encode('private signed URL and error body')};}}, {baseUrl:'https://backend.invalid',accessToken:'secret'},crypto,enabled);
  let error:unknown;try{await client.download('https://objects.invalid/private?token=secret',1,'0'.repeat(64));}catch(e){error=e;}
  const diagnostic=JSON.parse(recordFailureDiagnostic(error));expect(diagnostic.code).toBe(reason?'cloud_snapshot_object_'+reason:'cloud_snapshot_download_failed');expect(diagnostic.status).toBe(status);expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private|objects.invalid/);
 });

test('native download timeout is distinct from the outer window deadline and invalid bytes',async()=>{
 for(const [error,code] of [[Error('SocketTimeoutException secret'),'cloud_snapshot_object_timeout'],[Object.assign(Error('cloud_sync_deadline_exceeded'),{code:'cloud_sync_deadline_exceeded'}),'cloud_sync_deadline_exceeded']] as const){
  const client=new WatchCloudClient({request:async()=>{throw error;}},{baseUrl:'https://backend.invalid',accessToken:'secret'},crypto,enabled);
  await expect(client.download('https://objects.invalid/a',1,'0'.repeat(64))).rejects.toMatchObject({code});
 }
 const client=new WatchCloudClient({request:async()=>({status:200,headers:{},body:new Uint8Array(1)})},{baseUrl:'https://backend.invalid',accessToken:'secret'},crypto,enabled);
 await expect(client.download('https://objects.invalid/a',1,'0'.repeat(64))).rejects.toMatchObject({code:'cloud_snapshot_object_integrity'});
});

for(const code of SNAPSHOT_DEFER_CODES)test(code+' escapes the object catch, keeps the checkpoint and returns ordinary queue backoff',async()=>{
 const f=await serviceFixture();const remote=await f.phone({objects:[{name:'reader/a.txt',bytes:utf8Encode('a'),compress:false},{name:'reader/b.txt',bytes:utf8Encode('b'),compress:false}]});
 const target=remote.snap.manifest.objects[0].chunks[0].ciphertextSha256;
 const download=f.session.client.download.bind(f.session.client);let failed=false;
 f.session.client.download=async(url,...args)=>{if(url.endsWith(target)&&!failed){failed=true;throw Object.assign(Error(code),{code});}return download(url,...args);};
 const diagnostics:string[]=[];const service=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'unused',exclusive:fn=>fn(),formatDiagnostic:s=>diagnostics.push(s)},enabled);
 expect(await service.syncNow()).toBe(false);expect(service.status).toMatchObject({errorCode:code,retryable:true,continuationReady:false});
 expect(service.status.retryAtMillis).toBeGreaterThan(Date.now());expect(cloudBackgroundOutcome(false,true,service.status)).toBe('retry');
 expect(diagnostics.join('')).toContain('"code":"'+code+'"');expect(f.calls.filter(r=>r.url.includes('/ack'))).toHaveLength(0);expect(f.merged).toHaveLength(0);
 expect(await service.syncNow()).toBe(true);expect(f.merged).toEqual(['reader/a.txt','reader/b.txt']);
});

test('public diagnostics retain only the enumerated deferral codes',async()=>{
 const lines:string[]=[];const d=backgroundDiagnostics(async(_method,args)=>{lines.push(String(args.text));return {} as any;});
 for(const code of [...SNAPSHOT_DEFER_CODES,'cloud_snapshot_object_missing secret'])d.report(JSON.stringify({event:'format-sync',outcome:'deferred',code,url:'https://private.invalid/?token=secret'}));
 await d.flush();for(const code of SNAPSHOT_DEFER_CODES)expect(lines.join('')).toContain('"code":"'+code+'"');expect(lines.join('')).not.toMatch(/secret|private.invalid/);
});

test('stall history is scoped to the current journal work and successful receipts disable the short budget',async()=>{
 const f=await serviceFixture(),seen:boolean[]=[];
 f.session.restoreCheckpoint={state:f.state,cache:f.cache,codec:f.session.codec,stalled:value=>seen.push(value)};
 const {SnapshotRestoreCheckpoint}=await import('../../src/cloud/snapshot-checkpoint');
 const open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('current-epoch','current-generation');
 let cp=await open();await cp.begin();await cp.commit('current-prefix');cp.close();
 cp=await open();await cp.noProgress(Error('cloud_sync_deadline_exceeded'));cp.close();
 cp=await open();expect(seen.at(-1)).toBe(false);await cp.noProgress(Error('cloud_sync_deadline_exceeded'));cp.close();
 cp=await open();expect(seen.at(-1)).toBe(true);await cp.commit('next-receipt');expect(seen.at(-1)).toBe(false);cp.close();
 cp=await open();expect(seen.at(-1)).toBe(false);expect(cp.has('current-prefix')).toBe(true);expect(cp.has('next-receipt')).toBe(true);cp.close();
});

test('stalled temporary IO cannot reset its own budget; only durable receipts do',()=>{
 let now=0;const budget=new SnapshotYieldBudget(()=>now);budget.stalled(true);
 for(let i=0;i<30;i++){budget.before('file.write');budget.completed('file.write');budget.completed('secure.get');now+=1000;}
 expect(()=>budget.before('file.write')).toThrow('cloud_snapshot_work_timeout');
 budget.stalled(false);for(let i=0;i<300;i++){budget.before('file.write');now+=1000;budget.completed('file.write');}
 budget.stalled(true);for(let i=0;i<256;i++){budget.before('file.read');budget.completed('file.read');}
 expect(()=>budget.before('crypto.largeAesGcmDecrypt')).toThrow('cloud_snapshot_work_timeout');
 // Cleanup remains available even after exhaustion; it cannot certify work.
 expect(()=>budget.before('file.delete')).not.toThrow();expect(()=>budget.before('crypto.closeSealedGzip')).not.toThrow();
});

test('a paused foreground still closes its bounded sealed stream',async()=>{
 const {cloudRunHost}=await import('../../src/cloud/execution');const calls:string[]=[];
 const request=cloudRunHost(async<T>(method:string)=>{calls.push(method);return {} as T;},()=>{throw Error('paused');});
 await request('crypto.closeSealedGzip',{outputPrefix:'public-fixture/p'});await expect(request('crypto.gunzipSealedParts',{})).rejects.toThrow('paused');expect(calls).toEqual(['crypto.closeSealedGzip']);
});
