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
async function fixture(){
 const calls:HttpRequest[]=[],store=new Map<string,string>(),blobs=new Map<string,Uint8Array>(),objects=new Map<string,Uint8Array>(),heads=new Map<string,CloudSnapshotHead>(),reservations=new Map<string,any>(),uploads=new Map<string,{hash:string;data:Uint8Array}>();
 const member:CloudMemberState={plan:'member',active:true,readable:true,writable:true,quotaBytes:1e9,usedBytes:0,reservedBytes:0,retentionDays:30,readOnlyAt:null,deleteAfter:null};
 let approve=true,current=true,seq=0,version=1,failAck=false,failComplete=false,failMerge=false,wrongTarget=false;
 const merged:string[]=[],network={active:true,validated:true,wifi:true,metered:false};
 const transport={async request(r:HttpRequest){calls.push(r);const u=new URL(r.url),p=u.pathname;const j=r.body?.length&&r.method!=='PATCH'&&r.method!=='PUT'?JSON.parse(utf8Decode(r.body)):{};let out:any={},status=200,headers:Record<string,string>={};
  if(u.host==='objects.invalid'){expect(r.headers).toEqual({});return {status:200,headers,body:objects.get(p.slice(1))??new Uint8Array()};}
  if(u.host==='uploads.invalid'){
   if(r.method==='POST'){const id='upload-'+uploads.size;uploads.set(id,{hash:r.headers['x-signature'],data:new Uint8Array()});headers.Location='/'+id;status=201;}
   else{const upload=uploads.get(p.slice(1))!;if(r.method==='PATCH'){expect(Number(r.headers['Upload-Offset'])).toBe(upload.data.length);const b=new Uint8Array(upload.data.length+r.body!.length);b.set(upload.data);b.set(r.body!,upload.data.length);upload.data=b;objects.set(upload.hash,b);}headers['Upload-Offset']=String(upload.data.length);}
   return {status,headers,body:new Uint8Array()};
  }
  expect(r.headers.authorization).toBe('Bearer fixture-token');
  if(p.endsWith('/bootstrap'))out={libraryEpoch:'9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',keyVersionFloor:0,keyCommitments:[],member,devices:[{deviceId:'watch',platform:'watch',lastSequence:heads.get('watch')?.deviceSequence??0}],keyEnvelopes:[]};
  else if(p.endsWith('/heads'))out={heads:[...heads.values()]};
  else if(p.endsWith('/reserve')){reservations.set(j.snapshotId,j);out={snapshotId:j.snapshotId,reservedBytes:1,missingObjects:[{kind:'manifest',...j.manifest},...j.chunks.map((c:any)=>({kind:'chunk',...c}))].filter((v:any)=>!objects.has(v.sha256)).map((v:any)=>({...v,sha256:wrongTarget?'f'.repeat(64):v.sha256,objectPath:v.sha256,transport:'epoch-proxy',uploadMethod:'PUT',reservationId:v.sha256,uploadUrl:'https://backend.invalid/functions/v1/cloud/uploads/'+v.sha256,signedUrl:'https://backend.invalid/functions/v1/cloud/uploads/'+v.sha256}))};}
  else if(p.includes('/cloud/uploads/')&&r.method==='PUT'){expect(r.headers['x-watchrss-library-epoch']).toBe('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff');objects.set(p.split('/').at(-1)!,r.body!.slice());}
  else if(p.endsWith('/complete')){if(failComplete)status=500;else{const v=reservations.get(j.snapshotId)!;heads.set(v.sourceDeviceId,{id:v.snapshotId,sourceDeviceId:v.sourceDeviceId,deviceSequence:v.deviceSequence,keyVersion:v.keyVersion,manifestSha256:v.manifest.sha256,manifestSizeBytes:v.manifest.sizeBytes,parentHeads:v.parentHeads,observedHeads:v.observedHeads});}}
  else if(p.endsWith('/ack')){if(failAck)status=500;}
  else if(p.includes('/snapshots/')){const h=[...heads.values()].find(h=>h.id===p.split('/').at(-1))!;const m=await codec.decryptManifest(key,h.id,objects.get(h.manifestSha256)!);out={snapshot:{manifestSignedUrl:'https://objects.invalid/'+h.manifestSha256},chunks:m.objects.flatMap(o=>o.chunks).map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:'https://objects.invalid/'+c.ciphertextSha256}))};}
  return {status,headers,body:bytes(out)};
 }};
 const codec=new WatchCloudCodec(crypto,enabled),cache=new WatchCloudCache({read:async p=>blobs.get(p),writeAtomic:async(p,b)=>{blobs.set(p,b.slice());}},crypto.sha256,enabled),state=new WatchCloudStateStore({get:async k=>store.get(k),set:async(k,v)=>{store.set(k,v);}},'user','watch',enabled);
 const client=new WatchCloudClient(transport,{baseUrl:'https://backend.invalid',accessToken:'fixture-token'},crypto,enabled);
 const session:CloudSession={userId:'user',deviceId:'watch',displayName:'Fixture',client,keys:{publicKeySpki:async()=> 'fixture-spki',currentKeyVersion:async()=>version,acceptBootstrap:async()=>approve?'ready':'waiting-approval',accountKey:async()=>key.slice()},codec,cache,state,uploader:{upload:(target,bytes)=>client.uploadObject(target,bytes)},library:{publicSources:async()=>[],mergeInventory:async()=>0,exportPayloads:async full=>({state:bytes({stable:'state'}),relay:full?bytes({stable:'relay'}):undefined}),restorePayloads:async payload=>{if(failMerge)throw Error('DB rollback');merged.push(...payload.keys());return payload.size;}},assertCurrent:async()=>{if(!current)throw Error('account switched');}};
 const service=new WatchCloudSyncService({open:async()=>session,network:async()=>network,hash:crypto.sha256,uuid:async()=>`local-${++seq}`,exclusive:async fn=>fn(),now:()=>10},enabled);
 async function phone(overrides:Partial<SnapshotInput>={}){const snap=await codec.create({accountKey:key,keyVersion:version,sourceDeviceId:'phone',sequence:(heads.get('phone')?.deviceSequence??0)+1,snapshotId:`phone-${++seq}`,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'rss-state.json',bytes:bytes({state:'remote'})},{name:'library-sync.json',bytes:bytes({relay:'remote'})}],...overrides});
 const hash=await crypto.sha256(snap.encryptedManifest);objects.set(hash,snap.encryptedManifest);for(const [h,b]of snap.newChunks)objects.set(h,b);const h={id:snap.manifest.snapshotId,sourceDeviceId:snap.manifest.sourceDeviceId,deviceSequence:snap.manifest.deviceSequence,keyVersion:snap.manifest.keyVersion,manifestSha256:hash,manifestSizeBytes:snap.encryptedManifest.length,parentHeads:snap.manifest.parentHeads,observedHeads:snap.manifest.observedHeads};heads.set(h.sourceDeviceId,h);return {snap,head:h};}
 return {service,session,cache,state,heads,objects,blobs,store,calls,member,merged,network,phone,reservations,flags:(o:{approve?:boolean;current?:boolean;version?:number;failAck?:boolean;failMerge?:boolean;failComplete?:boolean;wrongTarget?:boolean})=>{approve=o.approve??approve;current=o.current??current;version=o.version??version;failAck=o.failAck??failAck;failMerge=o.failMerge??failMerge;failComplete=o.failComplete??failComplete;wrongTarget=o.wrongTarget??wrongTarget;}};
}
test('bootstrap precedes registration and pending approval stops content IO',async()=>{
 const f=await fixture();f.flags({approve:false});expect(await f.service.syncNow()).toBe(false);expect(f.service.status.phase).toBe('waiting-approval');expect(f.calls.some(r=>r.url.endsWith('/heads'))).toBe(false);
 expect(f.calls[0].url).toContain('/bootstrap');expect(f.calls.some(r=>r.url.endsWith('/register'))).toBe(false);f.flags({approve:true});f.member.readable=false;f.member.writable=false;expect(await f.service.syncNow()).toBe(true);
});
test('full roundtrip: validated manifests/chunks, restore before ACK, epoch PUT, durable hashes and no idle reupload',async()=>{
 const f=await fixture();const remote=await f.phone();expect(await f.service.syncNow()).toBe(true);expect(f.merged).toEqual(['rss-state.json','library-sync.json']);expect(await f.state.applied('phone',true)).toBe(1);expect(f.calls.some(r=>r.url.endsWith('/'+remote.head.id+'/ack'))).toBe(true);expect(f.reservations.size).toBe(1);expect(await f.state.lastContentHash(true)).toHaveLength(64);
 expect(await f.service.syncNow()).toBe(true);expect(f.reservations.size).toBe(1);expect(f.service.status.phase).toBe('complete');
});
test('metered is state-only/no ACK; manual includes bodies; later state upload carries prior relay',async()=>{
 const f=await fixture();const p=await f.phone();f.network.metered=true;expect(await f.service.syncNow()).toBe(true);expect(f.merged).toEqual(['rss-state.json']);expect(await f.state.applied('phone',true)).toBe(0);expect(f.calls.some(r=>r.url.endsWith('/ack'))).toBe(false);
 expect(await f.service.syncNow(true)).toBe(true);expect(await f.state.applied('phone',true)).toBe(1);
 const previous=await f.cache.latest('user');const prev=await f.session.codec.decryptManifest(key,previous!.id,previous!.bytes);
 await f.phone();expect(await f.service.syncNow()).toBe(true);const next=await f.cache.latest('user');const manifest=await f.session.codec.decryptManifest(key,next!.id,next!.bytes);
 expect(manifest.objects.find(o=>o.name==='library-sync.json')).toEqual(prev.objects.find(o=>o.name==='library-sync.json'));
});
test('rotation does not carry an old-version relay and still restores older heads',async()=>{
 const f=await fixture();await f.phone();expect(await f.service.syncNow()).toBe(true);f.flags({version:2});f.network.metered=true;expect(await f.service.syncNow()).toBe(true);const cached=await f.cache.latest('user');const m=await f.session.codec.decryptManifest(key,cached!.id,cached!.bytes);expect(m.keyVersion).toBe(2);expect(m.objects.map(o=>o.name)).toEqual(['rss-state.json']);
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
