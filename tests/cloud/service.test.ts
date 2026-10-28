import {test,expect} from 'bun:test';
import {crypto,enabled,key} from './k2-crypto';
import {WatchCloudSyncService,type CloudSession} from '../../src/cloud/service';
import {WatchCloudCodec,type SnapshotInput} from '../../src/cloud/codec';
import {WatchCloudClient} from '../../src/cloud/client';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {SupabaseTusUploader} from '../../src/cloud/tus';
import {utf8Encode,utf8Decode,type HttpRequest,type CloudMemberState,type CloudSnapshotHead} from '../../src/cloud/types';
const bytes=(v:unknown)=>utf8Encode(JSON.stringify(v));
import {fixture} from './service-fixture';
test('missing host crypto stops the records lane and worker retries without clearing data, then resumes after repair',async()=>{
 const f=await fixture(),records=f.session.records;let invalidations=0;f.session.invalidate=async()=>{invalidations++;};f.session.records=async()=>{throw Error('cloud_host_capability_unavailable');};
 expect(await f.service.syncNow()).toBe(false);expect(f.service.status.retryable).toBe(false);expect(f.service.status.message).toContain('请升级');expect(f.calls.some(r=>r.url.endsWith('/heads'))).toBe(false);expect(f.reservations.size).toBe(0);expect(invalidations).toBe(0);
 f.session.records=records;expect(await f.service.syncNow()).toBe(true);expect(f.service.status.retryable).not.toBe(false);
});
test('bootstrap precedes registration and pending approval stops content IO',async()=>{
 const f=await fixture();f.flags({approve:false});expect(await f.service.syncNow()).toBe(false);expect(f.service.status.phase).toBe('waiting-approval');expect(f.calls.some(r=>r.url.endsWith('/heads'))).toBe(false);
 expect(f.calls[0].url).toContain('/bootstrap');expect(f.calls.some(r=>r.url.endsWith('/register'))).toBe(false);f.flags({approve:true});f.member.readable=false;f.member.writable=false;expect(await f.service.syncNow()).toBe(true);
});
test('full roundtrip: validated manifests/chunks, restore before ACK, epoch PUT, durable hashes and no idle reupload',async()=>{
 const f=await fixture();const remote=await f.phone();expect(await f.service.syncNow()).toBe(true);expect(f.merged).toEqual(['rss-state.json','library-sync.json']);expect(await f.state.applied('phone',true)).toBe(1);expect(f.calls.some(r=>r.url.endsWith('/'+remote.head.id+'/ack'))).toBe(true);expect(f.reservations.size).toBe(1);expect(await f.state.lastContentHash(true)).toHaveLength(64);
 expect(await f.service.syncNow()).toBe(true);expect(f.reservations.size).toBe(1);expect(f.service.status.phase).toBe('complete');
});
test('metered only pulls records/legacy state; manual restores bodies and no legacy objects are carried',async()=>{
 const f=await fixture();const p=await f.phone();f.network.metered=true;expect(await f.service.syncNow()).toBe(true);expect(f.merged).toEqual(['rss-state.json']);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
 expect(await f.service.syncNow(true)).toBe(true);expect(await f.state.applied('phone',true)).toBe(1);
 const previous=await f.cache.latest('user');const prev=await f.session.codec.decryptManifest(key,previous!.id,previous!.bytes);
 await f.phone();expect(await f.service.syncNow()).toBe(true);const next=await f.cache.latest('user');const manifest=await f.session.codec.decryptManifest(key,next!.id,next!.bytes);
 expect(manifest.objects).toEqual(prev.objects);expect(manifest.objects.some(o=>['rss-state.json','library-sync.json'].includes(o.name))).toBe(false);
});
test('metered rotation does not publish a metadata snapshot and still restores older heads',async()=>{
 const f=await fixture();await f.phone();expect(await f.service.syncNow()).toBe(true);f.flags({version:2});f.network.metered=true;expect(await f.service.syncNow()).toBe(true);const cached=await f.cache.latest('user');const m=await f.session.codec.decryptManifest(key,cached!.id,cached!.bytes);expect(m.keyVersion).toBe(1);expect(m.objects.map(o=>o.name)).toEqual(['private-library.wrss','reader/test.txt']);
});
test('cache corruption refetches; authenticated source mismatch never merges or ACKs',async()=>{
 const f=await fixture(),{head}=await f.phone();await f.cache.storeManifest('user',head.id,new Uint8Array(head.manifestSizeBytes));expect(await f.service.syncNow()).toBe(true);expect(f.calls.some(r=>r.url==='https://objects.invalid/'+head.manifestSha256)).toBe(true);
 const g=await fixture(),remote=await g.phone();g.heads.set('phone',{...remote.head,sourceDeviceId:'impostor'});expect(await g.service.syncNow()).toBe(false);expect(g.merged).toEqual([]);expect(g.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
});
test('DB failure withholds applied and ACK; ACK failure retries without restoring twice',async()=>{
 const f=await fixture();await f.phone();f.flags({failMerge:true});expect(await f.service.syncNow()).toBe(false);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
 f.flags({failMerge:false,failAck:true});expect(await f.service.syncNow()).toBe(false);expect(await f.state.applied('phone',true)).toBe(1);const merged=f.merged.length;f.flags({failAck:false});expect(await f.service.syncNow()).toBe(true);expect(f.merged.length).toBe(merged);
});
test('free quota semantics permit upload; bad reserve and failed complete cannot mark uploaded',async()=>{
 const f=await fixture();await f.phone();f.member.writable=false;expect(await f.service.syncNow()).toBe(true);expect(f.reservations.size).toBe(1);
 for(const flags of [{wrongTarget:true},{failComplete:true}]){const g=await fixture();g.flags(flags);expect(await g.service.syncNow()).toBe(false);expect(await g.state.lastContentHash(true)).toBeUndefined();expect(await g.state.applied('watch',true)).toBe(0);expect(await g.cache.latest('user')).toBeUndefined();}
});
test('account switch stops sync before mutation; default gate makes no calls',async()=>{
 const f=await fixture();f.flags({current:false});expect(await f.service.syncNow()).toBe(false);expect(f.calls).toHaveLength(0);
 const disabled=new WatchCloudSyncService({open:async()=>{throw Error('IO');}} as any);expect(()=>disabled.syncNow()).toThrow('unavailable');
});

test('epoch reset and revocation clear cloud state before heads, preserving the local library',async()=>{
 const f=await fixture();await f.phone();expect(await f.service.syncNow()).toBe(true);let cleared=0;f.session.invalidate=async()=>{cleared++;await f.state.clear();};
 const original=f.session.client.bootstrap.bind(f.session.client);f.session.client.bootstrap=async()=>({...await original(),libraryEpoch:'00000000-0000-4000-8000-000000000000'});
 const start=f.calls.length;expect(await f.service.syncNow()).toBe(false);expect(cleared).toBe(1);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.slice(start).some(r=>r.url.endsWith('/heads'))).toBe(false);expect(f.service.status.phase).toBe('waiting-approval');
 const g=await fixture();let revoked=0;g.session.invalidate=async()=>{revoked++;};const get=g.session.client.bootstrap.bind(g.session.client);g.session.client.bootstrap=async()=>{const b=await get();b.devices[0].revokedAt='now';return b;};expect(await g.service.syncNow()).toBe(false);expect(revoked).toBe(1);expect(g.calls.some(r=>r.url.endsWith('/reserve'))).toBe(false);
});
test('library-owner upload guard prevents export/reservation even after downloading another library',async()=>{
 const f=await fixture();f.session.assertUpload=async()=>{throw Error('library_owner_mismatch');};expect(await f.service.syncNow()).toBe(false);expect(f.reservations.size).toBe(0);
});

test('owner choice appears before rebuilding or fetching the previous account public RSS inventory',async()=>{
 const f=await fixture();await f.phone();let projections=0,inventories=0;
 f.session.assertUpload=async()=>{throw Error('library_owner_mismatch');};
 f.session.library.publicSources=async()=>{projections++;return [{url:'https://old-owner.invalid/rss',sourceDeviceId:'old',title:'Old fixture',description:'',siteUrl:null,imageUrl:null,createdAt:1,updatedAt:1,sortOrder:1,isPinned:false,deleted:false,deletedAt:0}];};
 f.session.client.resolveRssSource=async()=>{inventories++;throw Error('old owner RSS request must not run');};
 expect(await f.service.syncNow()).toBe(false);
 expect(f.service.status.message).toBe('本机资料属于其他账号，请先选择清空或合并');
 expect(projections).toBe(0);expect(inventories).toBe(0);expect(f.reservations.size).toBe(0);
 // Existing read-only recovery is retained; ownership still gates the expensive
 // local-source projection and all uploads until the user makes a choice.
 expect(f.merged.length).toBeGreaterThan(0);
});

test('426 upgrade is actionable and preserves the no-content-I/O boundary',async()=>{
 const f=await fixture();f.session.client.bootstrap=async()=>{throw Error('client_upgrade_required');};expect(await f.service.syncNow()).toBe(false);expect(f.service.status.message).toContain('请升级');expect(f.calls).toHaveLength(0);
});


test('R4 reader-migration heads reject objects outside reader namespace before restoring',async()=>{
 const f=await fixture();await f.phone({sourceDeviceId:'reader-migration-1'});expect(await f.service.syncNow()).toBe(false);expect(f.merged).toEqual([]);expect(f.reservations.size).toBe(0);
});
test('R8 watch never publishes legacy commitments when server commitment table is empty',async()=>{
 const f=await fixture();f.session.keys.prepareLegacyUpgrade=async()=>undefined;f.flags({approve:false});expect(await f.service.syncNow()).toBe(false);expect(f.calls.some(r=>r.url.includes('/keys/commitments'))).toBe(false);
});


test('R20: sync surfaces device key conflict as explicit re-registration and preserves trust until local agreement',async()=>{
 const f=await fixture(),bootstrap=f.session.client.bootstrap.bind(f.session.client);let cleared=0;f.session.client.bootstrap=async()=>({...await bootstrap(),devices:[]});f.session.client.registerDevice=async()=>{throw Error('Cloud HTTP 409 device_key_conflict');};f.session.invalidate=async()=>{cleared++;};expect(await f.service.syncNow()).toBe(false);expect(f.service.status).toMatchObject({phase:'waiting-approval',message:'本机云设备公钥冲突，请重新登记本机'});expect(cleared).toBe(0);expect(f.calls.some(r=>r.url.endsWith('/heads'))).toBe(false);
});

test('recheck low 8: binding after logout succeeds but real persisted ownership blocks export/reservation until explicit choice',async()=>{
 const {WatchAccountStore}=await import('../../src/account/store');const values=new Map<string,string>(),accounts=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);}});
 const state=(userId:string)=>({userId,backendBaseUrl:'https://backend.invalid',watchDeviceToken:'token',watchRefreshToken:'',tokenExpiresAtMillis:9e15,refreshTokenExpiresAtMillis:0,phoneMasked:'',installId:'i',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1});
 await accounts.save(state('old-owner'));await accounts.clear();const owner=values.get('watchrss.library.owner');await accounts.save(state('user'));expect((await accounts.read())?.userId).toBe('user');expect(values.get('watchrss.library.owner')).toBe(owner);
 const f=await fixture();await f.phone();let exports=0;const exportPayloads=f.session.library.exportPayloads;f.session.library.exportPayloads=async full=>{exports++;return exportPayloads(full);};f.session.assertUpload=()=>accounts.assertLibraryOwner(state('user'));
 expect(await f.service.syncNow()).toBe(false);expect(f.merged.length).toBeGreaterThan(0);expect(exports).toBe(0);expect(f.reservations.size).toBe(0);expect(values.get('watchrss.library.owner')).toBe(owner);
 await accounts.resolveLibraryOwner(state('user'),'merge');expect(await f.service.syncNow()).toBe(true);expect(exports).toBe(1);expect(f.reservations.size).toBe(1);
});
test('account reset suppresses a late approval or failure from the previous account',async()=>{
 for(const fail of [false,true,'ready']){
  const f=await fixture();let finish!:(v:'waiting-approval'|'ready')=>void,abort!:(e:Error)=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r);
  f.session.keys.acceptBootstrap=async()=>{entered();return new Promise<'waiting-approval'|'ready'>((resolve,reject)=>{finish=resolve;abort=reject;});};
  const run=f.service.syncNow();await ready;f.service.reset();
  if(fail===true)abort(Error('old account request failed'));else finish(fail==='ready'?'ready':'waiting-approval');
  await run;expect(f.service.status).toEqual({phase:'idle',message:'尚未同步',usedBytes:0,reservedBytes:0,quotaBytes:0,lastCompletedAt:0});expect(f.calls.some(r=>r.url.endsWith('/heads'))).toBe(false);
 }
});

test('failed upload survives guest restart and resumes only missing chunks with the same snapshot id',async()=>{
 const f=await fixture();const upload=f.session.uploader.upload.bind(f.session.uploader);let sent=0;
 f.session.uploader.upload=async(target,data)=>{if(++sent===3)throw Error('network interrupted');await upload(target,data);};
 expect(await f.service.syncNow()).toBe(false);expect(f.reservations.size).toBe(1);
 const pending=await f.cache.pending('user');expect(pending).toBeDefined();
 const uploaded=new Set(f.objects.keys());expect(uploaded.size).toBe(2);
 f.session.cache=new WatchCloudCache({read:async p=>f.blobs.get(p),writeAtomic:async(p,b)=>{f.blobs.set(p,b.slice());}},crypto.sha256,enabled);
 f.session.codec=new WatchCloudCodec(crypto,enabled);
 const retried:string[]=[];f.session.uploader.upload=async(target,data)=>{retried.push(target.sha256);await upload(target,data);};
 const restarted=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'fresh-id-not-used',exclusive:async fn=>fn(),now:()=>10},enabled);
 expect(await restarted.syncNow()).toBe(true);expect(f.reservations.size).toBe(1);
 expect(retried.length).toBe(1);expect(retried.every(hash=>!uploaded.has(hash))).toBe(true);
 expect((await f.cache.latest('user'))!.id).toBe(pending!.id);
 expect(await f.cache.pending('user')).toBeUndefined();expect(await f.cache.pending('another-user')).toBeUndefined();
});

test('lost completion response retries the existing identity without uploading blocks again',async()=>{
 const f=await fixture();f.flags({failComplete:true});expect(await f.service.syncNow()).toBe(false);
 const id=(await f.cache.pending('user'))!.id;
 const puts=f.calls.filter(c=>c.method==='PUT').length;
 f.flags({failComplete:false});expect(await f.service.syncNow()).toBe(true);
 expect(f.reservations.size).toBe(1);expect((await f.cache.latest('user'))!.id).toBe(id);
 expect(f.calls.filter(c=>c.method==='PUT').length).toBe(puts);
});
