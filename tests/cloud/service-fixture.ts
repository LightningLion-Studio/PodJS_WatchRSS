import {expect} from 'bun:test';
import {crypto,enabled,key} from './k2-crypto';
import {WatchCloudSyncService,type CloudSession} from '../../src/cloud/service';
import {WatchCloudCodec,type SnapshotInput} from '../../src/cloud/codec';
import {WatchCloudClient} from '../../src/cloud/client';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {SupabaseTusUploader} from '../../src/cloud/tus';
import {utf8Encode,utf8Decode,type HttpRequest,type CloudMemberState,type CloudSnapshotHead} from '../../src/cloud/types';
const bytes=(v:unknown)=>utf8Encode(JSON.stringify(v));
export async function fixture(){
 const calls:HttpRequest[]=[],store=new Map<string,string>(),blobs=new Map<string,Uint8Array>(),objects=new Map<string,Uint8Array>(),heads=new Map<string,CloudSnapshotHead>(),reservations=new Map<string,any>(),uploads=new Map<string,{hash:string;data:Uint8Array}>();
 const member:CloudMemberState={plan:'member',active:true,readable:true,writable:true,quotaBytes:1e9,usedBytes:0,reservedBytes:0,retentionDays:30,readOnlyAt:null,deleteAfter:null};
 const recordRows=new Map<string,any>();let recordRevision=0;let inventory:any={sourceId:'pool',url:'https://feed.example/rss',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[]};
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
  else if(p.endsWith('/records')&&r.method==='GET'){const after=Number(u.searchParams.get('after')??0),items=[...recordRows.values()].filter(v=>Number(v.revision)>after).sort((a,b)=>Number(a.revision)-Number(b.revision)).slice(0,50);out={formatVersion:1,libraryEpoch:'9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',keyVersionFloor:0,keyCommitments:[],items,cursor:items.at(-1)?.revision??String(recordRevision),headRevision:String(recordRevision),hasMore:items.length===50&&Number(items.at(-1).revision)<recordRevision};}
  else if(p.endsWith('/records')&&r.method==='POST'){if(j.items.some((v:any)=>(recordRows.get(v.recordId)?.revision??'0')!==v.expectedRevision)){status=409;out={error:'cloud_record_conflict'};}else{out={formatVersion:1,items:j.items.map((v:any)=>{const revision=String(++recordRevision);recordRows.set(v.recordId,{recordId:v.recordId,revision,envelope:v.envelope,tombstone:v.tombstone});return {recordId:v.recordId,revision};})};}}
  else if(p.endsWith('/rss/sources/resolve'))out={source:{id:inventory.sourceId}};
  else if(p.endsWith('/entries'))out={source:inventory,entries:inventory.items.map((a:any,i:number)=>({...a,id:String(i),link:a.url}))};
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
 const session:CloudSession={userId:'user',deviceId:'watch',displayName:'Fixture',client,keys:{publicKeySpki:async()=> 'fixture-spki',currentKeyVersion:async()=>version,acceptBootstrap:async()=>approve?'ready':'waiting-approval',accountKey:async()=>key.slice()},codec,cache,state,uploader:{upload:(target,bytes)=>client.uploadObject(target,bytes)},library:{publicSources:async()=>[],mergeInventory:async()=>0,exportPayloads:async full=>({objects:full?[{name:'private-library.wrss',bytes:bytes({stable:'body'})},{name:'reader/test.txt',bytes:bytes({stable:'reader'})}]:[],fingerprint:'stable-body'}),restorePayloads:async payload=>{if(failMerge)throw Error('DB rollback');merged.push(...payload.keys());return {changed:payload.size,pending:0,abandoned:0,warnings:[]};}},records:async()=>({pull:async()=>0,reapply:async()=>0,flush:async()=>0}) as any,assertCurrent:async()=>{if(!current)throw Error('account switched');}};
 let now=10;const service=new WatchCloudSyncService({open:async()=>session,network:async()=>network,hash:crypto.sha256,uuid:async()=>`local-${++seq}`,exclusive:async fn=>fn(),now:()=>now},enabled);
 async function phone(overrides:Partial<SnapshotInput>={}){const snap=await codec.create({accountKey:key,keyVersion:version,sourceDeviceId:'phone',sequence:(heads.get('phone')?.deviceSequence??0)+1,snapshotId:`phone-${++seq}`,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'rss-state.json',bytes:bytes({state:'remote'})},{name:'library-sync.json',bytes:bytes({relay:'remote'})}],...overrides});
 const hash=await crypto.sha256(snap.encryptedManifest);objects.set(hash,snap.encryptedManifest);for(const [h,b]of snap.newChunks)objects.set(h,b);const h={id:snap.manifest.snapshotId,sourceDeviceId:snap.manifest.sourceDeviceId,deviceSequence:snap.manifest.deviceSequence,keyVersion:snap.manifest.keyVersion,manifestSha256:hash,manifestSizeBytes:snap.encryptedManifest.length,parentHeads:snap.manifest.parentHeads,observedHeads:snap.manifest.observedHeads};heads.set(h.sourceDeviceId,h);return {snap,head:h};}
 return {service,session,setNow:(value:number)=>{now=value;},recordRows,seedRecords(rows:Map<string,any>){for(const [k,v]of rows)recordRows.set(k,v);recordRevision=Math.max(0,...[...recordRows.values()].map(r=>Number(r.revision)));},pool:(value:any)=>{inventory=value;},cache,state,heads,objects,blobs,store,calls,member,merged,network,phone,reservations,flags:(o:{approve?:boolean;current?:boolean;version?:number;failAck?:boolean;failMerge?:boolean;failComplete?:boolean;wrongTarget?:boolean})=>{approve=o.approve??approve;current=o.current??current;version=o.version??version;failAck=o.failAck??failAck;failMerge=o.failMerge??failMerge;failComplete=o.failComplete??failComplete;wrongTarget=o.wrongTarget??wrongTarget;}};
}
