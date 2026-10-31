import {openWrssRange,type WrssRangeReader} from './wrss';
import {cloudFormatFailure} from './format-diagnostic';
import type {CloudSession} from './service';
import type {CloudManifest,CloudObject,RestoreCodecCheckpoint} from './codec';
import type {CloudSnapshotHead} from './types';
import {PRIVATE_OVERLAY_NAME,hasPrivateOverlay} from './private-overlay';
import {cloudCompatibility,emptyCompatibilityStatus} from './compatibility';
import {SnapshotRestoreCheckpoint} from './snapshot-checkpoint';
export interface RestoringSnapshot {h:CloudSnapshotHead;remote:Awaited<ReturnType<CloudSession['client']['snapshot']>>;manifest:CloudManifest;overlayPayload:Map<string,Uint8Array>;}
export async function restoreSnapshots(p:{session:CloudSession;heads:CloudSnapshotHead[];full:boolean;journal:SnapshotRestoreCheckpoint;current:()=>Promise<void>;manifest:(h:CloudSnapshotHead,bytes:Uint8Array)=>Promise<CloudManifest>;hash:(b:Uint8Array)=>Promise<string>;supported:(o:CloudObject)=>boolean;now:()=>number;status:(percent:number,phase?:'apply')=>void;changed:()=>void}){
 const fatal=(error:unknown)=>cloudFormatFailure(error)==='storage'||/cloud_sync_deadline_exceeded|cloud_sync_suspended|cloud_operation_superseded|cloud_host_capability_unavailable/.test(String(error))||String(error).includes('cloud_snapshot_unit_capacity')||String(error).includes('cloud_snapshot_checkpoint_invalid');
 const {session:s,journal:cp}=p,snapshots:RestoringSnapshot[]=[],compatibility=emptyCompatibilityStatus();let pendingItems=0,abandonedItems=0,formatBlocked=!!s.client.requiredFeatures?.length,changed=false,overlayPending=0;
 const indices=new Map<CloudObject,number>(),partTokens=new Map<CloudObject,Map<string,string>>(),objectTokens=new Map<CloudObject,string>(),keys=new Map<number,Uint8Array>(),memo=new Map<CloudObject,Uint8Array>();let memoBytes=0;
 const token=async(h:CloudSnapshotHead,o:CloudObject)=>{let v=objectTokens.get(o);if(!v){const index=indices.get(o);if(index===undefined)throw Error('cloud_snapshot_checkpoint_invalid');v=h.manifestSha256+'-o'+index;objectTokens.set(o,v);}return v;};
 const partToken=async(h:CloudSnapshotHead,o:CloudObject,part:string)=>{let map=partTokens.get(o);if(!map){map=new Map();partTokens.set(o,map);}let t=map.get(part);if(!t){t=await token(h,o)+'-'+part.replace(':','-');map.set(part,t);}return t;};
 const applyFractions=new Map<CloudObject,number>();let total=0,done=0;const counts=new Map<CloudObject,number>(),weights=new Map<CloudObject,number>();const report=()=>p.status(total?Math.min(99,Math.floor(done*100/total)):0);
 const update=async(h:CloudSnapshotHead,o:CloudObject)=>{const t=await token(h,o),weight=weights.get(o);if(weight===undefined)return;let n=0;if(cp.has('applied:'+t)){n=weight;applyFractions.set(o,1);}else for(let i=0;i<(o.chunks?.length??0);i++)if(cp.has('decoded:'+await partToken(h,o,'chunk:'+i)))n++;done+=n-(counts.get(o)??0);counts.set(o,n);report();};
 const publish=async()=>{for(const {h,manifest}of snapshots.filter(v=>!cloudCompatibility(v.manifest).opaque))for(const o of manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&p.supported(o)&&(p.full||o.name==='rss-state.json'))){const weight=1+(o.chunks?.length??0);if(!weights.has(o)){weights.set(o,weight);total+=weight;}await update(h,o);}report();};
 const directories=new Map<CloudObject,Awaited<ReturnType<typeof openWrssRange>>>();
 const rangeReader=async(v:RestoringSnapshot,o:CloudObject):Promise<WrssRangeReader>=>{const t=await partToken(v.h,o,'object'),index=await cp.index(t);if(!index)throw Error('cloud_snapshot_projection_missing');return {length:o.originalBytes,read:async(offset,length)=>{try{return await cp.range(t,offset,length,index);}catch(error){await cp.invalidate('decoded:'+t);throw error;}}};};
 const ranged=(v:RestoringSnapshot,o:CloudObject)=>o.originalBytes>8*1024*1024&&!o.entryRef&&(o.name==='private-library.wrss'||!o.name.startsWith('private/articles/')&&!o.privateBook&&v.manifest.objects.some(x=>x.entryRef?.object===o.name));
 const load=async(v:RestoringSnapshot,o:CloudObject):Promise<Uint8Array>=>{ 
  await p.current();const objectToken=await partToken(v.h,o,'object');if(ranged(v,o)&&cp.has('decoded:'+objectToken)&&await cp.index(objectToken))return new Uint8Array();const cached=memo.get(o);if(cached)return cached;
  const key=keys.get(v.h.keyVersion)??await s.keys.accountKey(s.userId,v.h.keyVersion);if(!key)throw Error('missing_key_version');keys.set(v.h.keyVersion,key);
  const descriptors=new Map(v.remote.chunks.map(c=>[c.sha256,c]));
  const reload=async(hash:string)=>{await p.current();const target=descriptors.get(hash);if(!target)throw Error('cloud_snapshot_chunk_missing');const b=await cp.timed('download',target.sizeBytes,()=>s.client.download(target.signedUrl,target.sizeBytes,hash));await (s.restoreCheckpoint?.cache??s.cache).storeChunk(s.userId,hash,b);await cp.commit('download:'+hash,b.length);return b;};
  const work:RestoreCodecCheckpoint={materializeOnly:ranged(v,o),link:async(object,parts,length)=>cp.link(await partToken(v.h,object,'object'),await Promise.all(parts.map(part=>partToken(v.h,object,part))),length),entry:async(target,path)=>{const t=await partToken(v.h,target,'object');if(!cp.has('decoded:'+t))await load(v,target);let dir=directories.get(target);if(!dir){dir=await openWrssRange(await rangeReader(v,target),(b,max)=>(s.restoreCheckpoint?.codec??s.codec).inflateRestoreEntry(b,max),{yield:async()=>{await p.current();await (s.restoreCheckpoint?.codec??s.codec).yieldRestoreTurn();}});if(directories.size>=4)directories.delete(directories.keys().next().value!);directories.set(target,dir);}return dir.get(path);},reload:chunk=>reload(chunk.ciphertextSha256),length:async(object,part)=>cp.length(await partToken(v.h,object,part)),manifestValidated:true,check:p.current,now:p.now,read:async(object,part)=>part==='object'&&ranged(v,object)?undefined:cp.read(await partToken(v.h,object,part)),write:async(object,part,bytes)=>{await cp.write(await partToken(v.h,object,part),bytes);await update(v.h,object);},resolve:object=>load(v,object),metric:(stage,bytes,at,hit,chunkIndex)=>cp.metric(stage,bytes,at,hit,{objectIndex:indices.get(o),...(chunkIndex===undefined?{}:{chunkIndex})})};
  const bytes=(await cp.timed('object',o.originalBytes,()=>(s.restoreCheckpoint?.codec??s.codec).restore(key,v.manifest,async hash=>{
   return await s.cache.rawChunk(s.userId,hash)??reload(hash);
  },[o],work),false,{objectIndex:indices.get(o)})).get(o.name);if(!bytes)throw Error('cloud_snapshot_object_missing');
  if(bytes.length<=32*1024*1024){while(memo.size&&memoBytes+bytes.length>32*1024*1024){const first=memo.keys().next().value!;memoBytes-=memo.get(first)!.length;memo.delete(first);}memo.set(o,bytes);memoBytes+=bytes.length;}return bytes;
 };
 try{
  for(const h of [...p.heads].sort((a,b)=>a.deviceSequence-b.deviceSequence)){
   await p.current();report();const remote=await s.client.snapshot(h.id);let bytes=await s.cache.manifest(s.userId,h.id);
   if(bytes&&(bytes.length!==h.manifestSizeBytes||await p.hash(bytes)!==h.manifestSha256))bytes=undefined;
   if(!bytes){bytes=await cp.timed('download',h.manifestSizeBytes,()=>s.client.download(remote.manifestUrl,h.manifestSizeBytes,h.manifestSha256));await (s.restoreCheckpoint?.cache??s.cache).storeManifest(s.userId,h.id,bytes);await cp.commit('manifest:'+h.manifestSha256,bytes.length);}
   const manifest=await cp.timed('manifest',bytes.length,()=>p.manifest(h,bytes!));if(!cloudCompatibility(manifest).opaque)for(let i=0;i<manifest.objects.length;i++)indices.set(manifest.objects[i],i);snapshots.push({h,remote,manifest,overlayPayload:new Map()});
  }
  const objects=snapshots.filter(v=>!cloudCompatibility(v.manifest).opaque).flatMap(v=>v.manifest.objects),chunks=objects.flatMap(o=>o.chunks??[]);cp.metric('plan',objects.reduce((n,o)=>n+o.originalBytes,0),p.now(),false,{objects:objects.length,chunks:chunks.length,maxChunkBytes:chunks.reduce((n,c)=>Math.max(n,c.ciphertextBytes),0)});
  await publish();
  // Every current head participates before any body is applied. Per-entry
  // authenticated receipts resume validation without weakening overlay LWW.
  for(const v of snapshots){const {h,manifest,overlayPayload}=v;await p.current();if(!cloudCompatibility(manifest).opaque&&hasPrivateOverlay(manifest)){
   if(!p.full||!s.library.observePrivateOverlay){overlayPending++;formatBlocked=true;continue;}
   const index=manifest.objects.find(o=>o.name===PRIVATE_OVERLAY_NAME)!;if(cloudCompatibility(index).opaque)throw Error('cloud_format_overlay_invalid');overlayPayload.set(index.name,await load(v,index));
   const trusted=h.deviceSequence<=await s.state.applied(h.sourceDeviceId,true),prefix='overlay:'+await token(h,index);
   const result=await cp.timed('overlay',index.originalBytes,()=>s.library.observePrivateOverlay!(overlayPayload,h.sourceDeviceId,manifest.objects,trusted,{checkpoint:cp.apply(prefix),resolve:async name=>{const o=manifest.objects.find(o=>o.name===name);if(!o||cloudCompatibility(o).opaque)return;try{return await load(v,o);}catch(error){await p.current();if(fatal(error))throw error;return;}}}));overlayPending+=result.pending;
  }}
  pendingItems+=overlayPending;
  for(const v of snapshots){const {h,remote,manifest,overlayPayload}=v;await p.current();const rootPolicy=cloudCompatibility(manifest),already=h.deviceSequence<=await s.state.applied(h.sourceDeviceId,p.full);
   if(rootPolicy.readOnly){formatBlocked=true;if(rootPolicy.opaque)compatibility.opaque++;else compatibility.readOnly++;compatibility.upgradeRequired=true;if(rootPolicy.opaque){pendingItems++;continue;}}
   const incompatible=manifest.objects.filter(o=>cloudCompatibility(o).opaque||!p.supported(o));compatibility.opaque+=incompatible.length;compatibility.readOnly+=manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&cloudCompatibility(o).readOnly).length;
   if(already){const blocked=Number(rootPolicy.readOnly)+incompatible.length+manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&cloudCompatibility(o).readOnly).length;if(blocked)pendingItems+=blocked;else if(p.full&&!overlayPending)await s.client.acknowledge(h.id,s.deviceId);continue;}
   const selected=manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&p.supported(o)&&(p.full||o.name==='rss-state.json'));let headAbandoned=0,headPending=Number(overlayPending>0)+Number(rootPolicy.readOnly)+incompatible.length+manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&cloudCompatibility(o).readOnly).length;
   for(const object of selected){await p.current();const t=await token(h,object);if(cp.has('applied:'+t)){headAbandoned+=cp.apply('applied').result(t);continue;}
    const payload=new Map(overlayPayload);try{payload.set(object.name,await load(v,object));}catch(error){await p.current();if(fatal(error))throw error;headPending++;continue;}
    await p.current();const restored=await cp.timed('apply',object.originalBytes,async()=>s.library.restorePayloads(payload,h.sourceDeviceId,[object],{archiveReader:ranged(v,object)?await rangeReader(v,object):undefined,checkpoint:cp.apply('rows:'+t,(done,total)=>{applyFractions.set(object,total?Math.min(1,done/total):0);p.status(Math.min(99,Math.floor([...applyFractions.values()].reduce((n,v)=>n+v,0)*100/Math.max(1,weights.size))),'apply');}),skipReading:true}));const result=typeof restored==='number'?{changed:restored,pending:0,abandoned:0}:restored;
    changed=result.changed>0||changed;if(result.changed)p.changed();headPending+=result.pending;headAbandoned+=result.abandoned??0;
    if(!result.pending)await cp.commit('applied:'+t,result.abandoned??0);await update(h,object);
   }
   if(headAbandoned&&!await s.state.warned(h.sourceDeviceId,h.id)){await s.state.markWarned(h.sourceDeviceId,h.id);abandonedItems+=headAbandoned;}
   pendingItems+=headPending;await p.current();if(p.full&&!headPending){await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,true);await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,false);await s.client.acknowledge(h.id,s.deviceId);}else if(!headPending&&selected.some(o=>o.name==='rss-state.json'))await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,false);
  }
  return {snapshots,changed,pendingItems,abandonedItems,formatBlocked,compatibility};
 }finally{for(const key of keys.values())key.fill(0);if(cp.advanced)p.changed();}
}
