/** Isolated P3 content projection. Each step is one frame or one bounded phase.
 * Source callbacks must expose an immutable business revision, never an account lock. */
import {ContentWorker,ContentWindow,selectContentTask,completedContentTask,type ContentSignals,type Fairness} from '@podjs/framework/content-worker';
import {ContentSha256,type Sha256State} from '@podjs/framework/content-sha256';
import {checkedResumeOffset} from './resume';
import {digest,canonical,jsonBytes,hexId,uint,oid,type Scope} from './protocol';
import {sealV2,openV2,type EnvelopeCrypto} from './sealed';
import type {SigningPort} from './signing';
import {signControl} from './signing';
import {readControlRefs} from './control-refs';
import type {ApprovedKey} from './head-pins';
import {recipe,recipeBlock,contentIdFromHash,type ContentRecipe,type ContentRange} from './content-schema';
import {contentPriority,type PriorityItem} from './content-priority';
import {WatchContentStore} from './content-store';
import {WatchContentHttp} from './content-http';
export interface ContentSource {binding:string;size:number;ranges:ContentRange[];assertCurrent():Promise<void>;read(offset:number,length:number):Promise<Uint8Array>;}
export interface QueuedBody extends PriorityItem {bodyRevision:string;recipeOid?:string;opaqueContentId?:string;contentBytes?:number;sourceBinding?:string;}
interface ObjectPlan {oid:string;total:number;cache:string;receipt?:any;confirmedOffset?:number;reservation?:{id:string;expires:number};}
interface BodyPlan {direction:'upload'|'download';item:QueuedBody;phase:'blocks'|'recipe'|'refs'|'availability'|'done'|'evicted';cacheEpoch?:string;sharedCiphertext?:boolean;offset:number;hash:Sha256State;recipe:ContentRecipe|null;object:ObjectPlan|null;recipeObject:ObjectPlan|null;refs?:any;receipt?:any;}
export interface ContentMetric {stage:'source'|'seal'|'network'|'authenticate'|'checkpoint'|'file';bytes:number;objects:number;}
const unit=(bytes=0,objects=0,frames=0)=>({bytes,objects,frames,progressed:true});
export class WatchContentEngine {
 private worker=new ContentWorker();private active=false;
 private remoteStatuses=new Map<string,any>();private localStats=new Map<string,any>();private pendingObjects:ObjectPlan[]=[];
 private demands:any[]=[];private demandReadAt=-Infinity;private serverOffset=0;
 constructor(readonly store:WatchContentStore,readonly remote:WatchContentHttp,readonly crypto:EnvelopeCrypto&SigningPort,
  readonly keys:{id:Uint8Array;content:Uint8Array;version:number},readonly options:{
   source:(binding:string)=>Promise<ContentSource>;approved:(id:string)=>Promise<ApprovedKey>;alias:string;
   signals:()=>Promise<ContentSignals>;yieldControl:()=>Promise<void>;assertCurrent:()=>Promise<void>;
   refreshApproved?:(windowId:string)=>Promise<void>;now?:()=>number;monotonic?:()=>number;metric?:(m:ContentMetric)=>void;
  }){}
 private get scope(){return this.remote.http.scope;}
 private now(){return (this.options.now??Date.now)();}
 private async refreshDemands(force=false){if(!force&&this.now()-this.demandReadAt<20000)return;if(this.options.refreshApproved){const window=await this.remote.http.negotiate([],[]);await this.options.refreshApproved(window.windowId);}
  const v=await this.remote.demands(this.options.approved);this.serverOffset=v.serverNowMillis-this.now();this.demands=v.demands;this.demandReadAt=this.now();}
 private metric(stage:ContentMetric['stage'],bytes=0,objects=0){this.options.metric?.({stage,bytes,objects});}
 private key(item:QueuedBody){hexId(item.entityKey,64);hexId(item.bodyRevision,32);return digest([item.entityKey,item.bodyRevision]);}
 /** Same binding survives state edits. A changed source/auth binding gets a new store namespace. */
 async enqueue(item:QueuedBody,direction:'upload'|'download'){
  await this.options.assertCurrent();const key=this.key(item);uint(item.addedAtMillis);
  const found=await this.store.get<BodyPlan>('body:'+key);
  if(found&&found.value.direction!==direction&&found.value.phase==='done'&&(!item.recipeOid||item.recipeOid===found.value.recipeObject?.oid))return key;
  if(found?.value.phase==='evicted'&&direction==='download'){if(found.value.direction!=='download'||item.recipeOid!==found.value.recipeObject?.oid)throw Error('body_revision_changed');const reset:BodyPlan={direction,item:JSON.parse(canonical(item)),phase:'recipe',sharedCiphertext:true,cacheEpoch:digest(Array.from(await this.crypto.random(16))),offset:0,hash:new ContentSha256().snapshot(),recipe:null,object:null,recipeObject:null};const q=await this.store.get('queue:'+key);await this.store.putMany([{id:'body:'+key,value:reset,expected:found.revision},{id:'queue:'+key,value:{...item,id:key,complete:false},expected:q!.revision}]);return key;}
  if(found){if(found.value.direction!==direction||found.value.item.sourceBinding!==item.sourceBinding||found.value.item.recipeOid!==item.recipeOid)throw Error('body_revision_changed');return key;}
  if(direction==='upload'&&!item.sourceBinding||direction==='download'&&!item.recipeOid)throw Error('invalid_schema');
  const body:BodyPlan={direction,sharedCiphertext:direction==='download',item:JSON.parse(canonical(item)),phase:direction==='upload'?'blocks':'recipe',offset:0,hash:new ContentSha256().snapshot(),recipe:null,object:null,recipeObject:null};
  await this.store.putMany([{id:'body:'+key,value:body,expected:null},{id:'queue:'+key,value:{...item,id:key,complete:false},expected:null}]);return key;
 }
 async manifest(entityKey:string,bodyRevision:string){const b=await this.store.get<BodyPlan>('body:'+this.key({entityKey,bodyRevision} as QueuedBody));if(!b||b.value.phase!=='done')return null;const r=b.value.recipe!;return {bodyRevision,recipeOid:b.value.recipeObject!.oid,opaqueContentId:r.opaqueContentId,contentBytes:r.totalPlainBytes};}
 async runWindow(budget?:{millis?:number;maxBytes?:number}){
  if(this.active)return {status:'busy',bytes:0,objects:0,frames:0};this.active=true;const previousGuard=this.remote.http.requestGuard;
  try{
   this.remoteStatuses.clear();this.localStats.clear();
   const window=new ContentWindow(this.options.monotonic??Date.now,budget?.millis??300000,10000,budget?.maxBytes??8*1048576);
   this.remote.http.requestGuard=()=>{previousGuard?.();if(!window.available(0,10000))throw Error('content_window_paused');};
   let wireWindow:string|undefined;
   return await this.worker.run({window,signals:this.options.signals,yieldControl:this.options.yieldControl,step:async()=>{
    await this.options.assertCurrent();if(!wireWindow){const w=await this.remote.http.negotiate([],[]);wireWindow=w.windowId;await this.refreshDemands(true);}
    await this.refreshDemands();
    let after='',items:any[]=[];for(;;){const page=await this.store.page(after,32,'queue:');items.push(...page.map(p=>p.value));if(page.length<32)break;after=page.at(-1)!.id;await this.options.yieldControl();}
    this.pendingObjects=items.filter(i=>!i.complete&&i.pendingObject).map(i=>i.pendingObject);
    const serverNow=this.now()+this.serverOffset;
    for(const i of items){const d=this.demands.find(d=>d.entityKey===i.entityKey&&d.bodyRevision===i.bodyRevision&&d.expiresAtMillis>serverNow);i.demand=d?{demandAtMillis:d.demandAtMillis,expiresAtMillis:d.expiresAtMillis}:undefined;}
    const sorted=contentPriority(items,serverNow).map(i=>({...i,id:(i as any).id})),fair=await this.store.get<Fairness>('fairness'),state=fair?.value??{demandBlobs:0,ordinaryRank:1},task=selectContentTask(sorted,state);
    if(!task)return {...unit(),done:true};const saved=await this.store.get<BodyPlan>('body:'+task.id);if(!saved)throw Error('content_checkpoint_missing');
    const b=saved.value,progress=await this.step(task.id,b,wireWindow!);
    const changes=[{id:'body:'+task.id,value:b,expected:saved.revision}];
    if(progress.blob)changes.push({id:'fairness',value:completedContentTask(state,task.rank),expected:fair?.revision??null} as any);
    const q=await this.store.get('queue:'+task.id);changes.push({id:'queue:'+task.id,value:{...q!.value,complete:b.phase==='done',pendingObject:b.object??(b.phase==='recipe'?b.recipeObject:null)},expected:q!.revision});
    await this.store.putMany(changes);this.metric('checkpoint');return progress;
   }});
  }finally{this.remote.http.requestGuard=previousGuard;this.active=false;}
 }
 private async haveObject(id:string,windowId:string){
  if(!this.remoteStatuses.has(id)){
   const ids=[...new Set([id,...this.pendingObjects.map(o=>o.oid)])].slice(0,32).sort();
   let values;try{values=await this.remote.have(windowId,ids);}catch(error){if((error as Error).message!=='reservation_expired'||ids.length===1)throw error;values=await this.remote.have(windowId,[id]);}
   for(const v of values)this.remoteStatuses.set(v.oid,v);
  }return this.remoteStatuses.get(id);
 }
 private async fileStat(object:ObjectPlan){
  const path=this.store.path(object.cache);if(!this.localStats.has(path)){
   const paths=[...new Set([path,...this.pendingObjects.map(o=>this.store.path(o.cache))])].slice(0,32);
   for(const s of await this.store.files.stat(paths))this.localStats.set(s.path,s);
  }return this.localStats.get(path);
 }
 private async upload(object:ObjectPlan,windowId:string){
  // C8 resolves a lost final ACK here. No cache read/hash/export precedes exact have.
  let have;try{have=await this.haveObject(object.oid,windowId);}catch(error){if((error as Error).message!=='reservation_expired')throw error;
   const renewal=await this.remote.reserve(object.oid,object.total,digest([object.oid,'renew',this.now()]).slice(0,32));object.reservation={id:renewal.reservationId,expires:renewal.expiresAtMillis};
   [have]=await this.remote.have(windowId,[object.oid]);this.remoteStatuses.set(object.oid,have);
  }if(have.status!=='missing'&&have.totalBytes!==object.total)throw Error('hash_mismatch');
  const confirmed=object.confirmedOffset??0,offset=checkedResumeOffset(confirmed,have.durableOffset,object.total);
  if(have.status==='present'){object.confirmedOffset=object.total;object.receipt=have.receipt;return {objectDone:true,...unit(0,1)};}
  if(offset>confirmed){object.confirmedOffset=offset;object.receipt=have.receipt;return {objectDone:false,...unit()};}
  if(!object.reservation||object.reservation.expires<=this.now()){
   const r=await this.remote.reserve(object.oid,object.total,digest([object.oid,this.now(),offset]).slice(0,32));object.reservation={id:r.reservationId,expires:r.expiresAtMillis};
  }
  const bytes=await this.store.bytes(object.cache,object.total,offset,Math.min(65536,object.total-offset));this.metric('file',bytes.length);
  this.remote.http.requestGuard?.();await this.store.consumeReplay(object.oid,object.total,confirmed,offset,bytes.length);
  const result=await this.remote.http.putPart(object.oid,offset,object.reservation.id,digest([object.oid,object.reservation.id,offset]).slice(0,32),bytes);
  await this.remote.http.servicePin!.receipt(this.crypto,result.receipt,this.scope,object.oid,object.total,this.now());
  if(result.oid!==object.oid||result.durableOffset!==offset+bytes.length||result.receipt.body.durableOffset!==result.durableOffset)throw Error('offset_conflict');object.confirmedOffset=Math.max(confirmed,result.durableOffset);object.receipt=result.receipt;this.metric('network',bytes.length);
  this.remoteStatuses.set(object.oid,{...have,totalBytes:object.total,durableOffset:result.durableOffset,receipt:result.receipt,status:'partial'});
  if(result.durableOffset===object.total){object.receipt=await this.remote.complete(object.oid,object.total,object.reservation.id,digest([object.oid,object.reservation.id,'complete']).slice(0,32));this.remoteStatuses.set(object.oid,{oid:object.oid,totalBytes:object.total,durableOffset:object.total,status:'present',receipt:object.receipt});return {objectDone:true,...unit(bytes.length,1,1)};}
  return {objectDone:false,...unit(bytes.length,0,1)};
 }
 private async download(object:ObjectPlan,windowId:string){
  const path=this.store.path(object.cache),stat=await this.fileStat(object);let offset=stat.durableOffset;
  if(offset>object.total)throw Error('content_checkpoint_corrupt');if(offset===object.total)return {objectDone:true,...unit()};
  const bytes=await this.remote.http.object(object.oid,{start:offset,end:Math.min(offset+65536,object.total)-1,totalBytes:object.total},windowId);
  await this.store.files.frame(path,offset,bytes,canonical({oid:object.oid,totalBytes:object.total,binding:this.store.prefix}));this.localStats.set(path,{...stat,durableOffset:offset+bytes.length});this.metric('network',bytes.length);this.metric('file',bytes.length);
  return {objectDone:offset+bytes.length===object.total,...unit(bytes.length,0,1)};
 }
 private async objectFor(id:string,windowId:string,epoch=''):Promise<ObjectPlan>{const have=await this.haveObject(id,windowId);if(have.status!=='present')throw Error('object_missing');return {oid:id,total:have.totalBytes,cache:'download:'+(epoch?epoch+':':'')+id,receipt:have.receipt};}
 private async authenticate(object:ObjectPlan,validate?:(opened:Awaited<ReturnType<typeof openV2>>)=>void){
  let opened:Awaited<ReturnType<typeof openV2>>;try{opened=await openV2(this.crypto,this.keys.id,this.keys.content,this.scope,object.oid,await this.store.bytes(object.cache,object.total));}
  catch(error){if(['hash_mismatch','aead_invalid','fingerprint_mismatch','invalid_encoding','invalid_schema','scope_mismatch'].includes((error as Error).message)){
    // Only a corrupt envelope loses its durable prefix. A caller-specific
    // recipe mismatch must never discard valid shared ciphertext.
    const path=this.store.path(object.cache);try{await this.store.files.discard(path);}finally{this.localStats.delete(path);}
   }throw error;}
  validate?.(opened);return opened;
 }
 private async step(key:string,b:BodyPlan,windowId:string):Promise<ReturnType<typeof unit>&{blob?:boolean}> {
  if(b.direction==='upload')return this.send(key,b,windowId);return this.receive(key,b,windowId);
 }
 private async send(key:string,b:BodyPlan,windowId:string):Promise<any>{
  if(b.phase==='blocks'){
   if(b.object){const result=await this.upload(b.object,windowId);if(result.objectDone){b.object=null;return {...result,blob:true};}return result;}
   const source=await this.options.source(b.item.sourceBinding!);if(source.binding!==b.item.sourceBinding)throw Error('body_revision_changed');await source.assertCurrent();uint(source.size);if(source.size>2048*262144)throw Error('object_too_large');
   if(!b.recipe)b.recipe={version:2,entityKey:b.item.entityKey,bodyRevision:b.item.bodyRevision,opaqueContentId:'0'.repeat(64),totalPlainBytes:source.size,plaintextSha256:'0'.repeat(64),blocks:[],ranges:source.ranges};
   if(b.offset===source.size){const hash=new ContentSha256(b.hash).finish();b.recipe.plaintextSha256=hash;b.recipe.opaqueContentId=contentIdFromHash(this.keys.id,this.scope,'recipe',hash);recipe(b.recipe);b.phase='recipe';return unit();}
   const cache='prepared:'+key+':'+b.recipe.blocks.length,recovered=await this.store.recover(cache);
   if(recovered){const p=recovered.proof;if(p.sourceBinding!==source.binding||p.offset!==b.offset+p.block.plainBytes||p.block.index!==b.recipe.blocks.length||p.object.total!==recovered.size||p.object.cache!==cache)throw Error('content_checkpoint_corrupt');new ContentSha256(p.hash);b.recipe.blocks.push(p.block);b.offset=p.offset;b.hash=p.hash;b.object=p.object;return unit();}
   const plain=await source.read(b.offset,Math.min(262144,source.size-b.offset));await source.assertCurrent();if(plain.length!==Math.min(262144,source.size-b.offset))throw Error('body_revision_changed');this.metric('source',plain.length);
   await this.options.yieldControl();const hash=new ContentSha256(b.hash).update(plain),sealed=await sealV2(this.crypto,this.keys.id,this.keys.content,this.scope,'blob',this.keys.version,plain);this.metric('seal',plain.length,1);
   this.metric('file',sealed.bytes.length);
   const block={index:b.recipe.blocks.length,oid:sealed.oid,plainBytes:plain.length,opaqueContentId:sealed.header.opaqueContentId};
   // Validate both count and actual uncompressed J before checkpointing a new block.
   const trial={...b.recipe,totalPlainBytes:b.offset+plain.length,blocks:[...b.recipe.blocks,block],ranges:[]};recipe(trial);
   const object={oid:sealed.oid,total:sealed.bytes.length,cache};await this.store.verified(cache,sealed.bytes,{sourceBinding:source.binding,block,offset:b.offset+plain.length,hash:hash.snapshot(),object});
   b.recipe.blocks.push(block);b.offset+=plain.length;b.hash=hash.snapshot();b.object=object;return unit();
  }
  if(b.phase==='recipe'){
   if(!b.recipeObject){recipe(b.recipe);await this.options.yieldControl();const sealed=await sealV2(this.crypto,this.keys.id,this.keys.content,this.scope,'recipe',this.keys.version,jsonBytes(b.recipe));const cache='upload:'+sealed.oid;await this.store.raw(cache,sealed.bytes);b.recipeObject={oid:sealed.oid,total:sealed.bytes.length,cache};return unit();}
   const result=await this.upload(b.recipeObject,windowId);if(result.objectDone)b.phase='refs';return result;
  }
  if(b.phase==='refs'){
   if(!b.refs){b.refs=await signControl(this.crypto,this.options.alias,'wrss.sync.v2/recipe-refs-sign',{scope:this.scope,recipeOid:b.recipeObject!.oid,blobOids:b.recipe!.blocks.map(block=>block.oid)});if(jsonBytes(b.refs).length>262144)throw Error('object_too_large');return unit();}
   await this.remote.http.json('POST','/recipe-refs',b.refs);b.phase='done';return unit();
  }
  // C10: an uploaded manifest is published through P2 before any availability check.
  if(b.phase==='availability'){b.phase='done';return unit();}
return unit();
 }
 private async receive(key:string,b:BodyPlan,windowId:string):Promise<any>{
  if(b.phase==='recipe'){
   if(!b.recipeObject){b.recipeObject=await this.objectFor(b.item.recipeOid!,windowId,b.sharedCiphertext?'':b.cacheEpoch);return unit();}
   const result=await this.download(b.recipeObject,windowId);if(!result.objectDone)return result;
   const opened=await this.authenticate(b.recipeObject,o=>recipe(o.value));if(opened.header.keyVersion!==this.keys.version)throw Error('unsupported_feature');const r=recipe(opened.value);
   if(r.entityKey!==b.item.entityKey||r.bodyRevision!==b.item.bodyRevision||r.opaqueContentId!==b.item.opaqueContentId||r.totalPlainBytes!==b.item.contentBytes)throw Error('body_revision_changed');
   const refs=await readControlRefs(this.remote.http,this.crypto,this.options.approved,windowId,{type:'recipe',oid:b.recipeObject.oid,value:r});b.refs={...refs.refs,authorDeviceId:refs.mapping.authorDeviceId,keyId:refs.mapping.keyId};b.recipe=r;b.phase='availability';this.metric('authenticate',opened.plain.length,1);return result;
  }
  if(b.phase==='availability'){const a=await this.remote.availability({entityKey:b.item.entityKey,bodyRevision:b.item.bodyRevision,recipeOid:b.recipeObject!.oid,blobOids:b.recipe!.blocks.map(block=>block.oid)});if(a.status!=='cloud-ready')throw Error('closure_incomplete');b.receipt=a.receipt;b.phase='blocks';return unit();}
  if(b.phase==='blocks'){
   const r=b.recipe!,index=Math.floor(b.offset/262144);
   if(b.offset===r.totalPlainBytes){const hash=new ContentSha256(b.hash).finish();if(hash!==r.plaintextSha256||contentIdFromHash(this.keys.id,this.scope,'recipe',hash)!==r.opaqueContentId)throw Error('fingerprint_mismatch');b.phase='done';return unit();}
   const block=r.blocks[index]!;if(!b.object){b.object=await this.objectFor(block.oid,windowId,b.sharedCiphertext?'':b.cacheEpoch);return unit();}
   const cache='plain:'+(b.cacheEpoch?b.cacheEpoch+':':'')+key+':'+index,recovered=await this.store.recover(cache);if(recovered){const p=recovered.proof;if(p.oid!==block.oid||p.offset!==b.offset+block.plainBytes||recovered.size!==block.plainBytes)throw Error('content_checkpoint_corrupt');new ContentSha256(p.hash);b.offset=p.offset;b.hash=p.hash;b.object=null;return {...unit(0,1),blob:true};}
   const result=await this.download(b.object,windowId);if(!result.objectDone)return result;
   await this.options.yieldControl();const opened=await this.authenticate(b.object,o=>recipeBlock(r,index,o.plain,this.keys.id,this.scope));if(opened.header.keyVersion!==this.keys.version)throw Error('unsupported_feature');
   const hash=new ContentSha256(b.hash).update(opened.plain);await this.store.verified(cache,opened.plain,{oid:block.oid,offset:b.offset+opened.plain.length,hash:hash.snapshot()});b.offset+=opened.plain.length;b.hash=hash.snapshot();b.object=null;this.metric('authenticate',opened.plain.length,1);return {...result,objects:1,blob:true};
  }return unit();
 }
 async readRange(entityKey:string,bodyRevision:string,offset:number,length:number){uint(offset);uint(length,262144);const key=this.key({entityKey,bodyRevision} as QueuedBody),b=await this.store.get<BodyPlan>('body:'+key);if(!b||b.value.direction!=='download'||b.value.phase!=='done')throw Error('content_not_ready');if(offset>b.value.recipe!.totalPlainBytes-length)throw Error('invalid_range');
  const ranges=[];for(let at=offset;at<offset+length;){const index=Math.floor(at/262144),start=at%262144,n=Math.min(offset+length-at,262144-start);ranges.push({path:this.store.path('plain:'+(b.value.cacheEpoch?b.value.cacheEpoch+':':'')+key+':'+index),offset:start,length:n});at+=n;}
  const parts=await this.store.files.read(ranges),out=new Uint8Array(length);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;
 }
 /** Durable business identity -> immutable source revision. This is written by
  * the P3 business resolver, never inferred from a reading-state timestamp. */
 async bindBusiness(entityKey:string,kind:string,logicalId:string,bodyRevision:string,sourceBinding:string,bodyWitness:string){
  hexId(bodyWitness,64);const id='business:'+entityKey,old=await this.store.get(id),value={entityKey,kind,logicalId,bodyRevision,sourceBinding,bodyWitness};
  if(old&&canonical(old.value)===canonical(value))return;
  await this.store.put(id,value,old?.revision??null);
 }
 async businessBinding(entityKey:string){return (await this.store.get('business:'+entityKey))?.value??null;}
 /** Return authenticated, complete sealed recipe/blob sources. Cleanup uses
  * bounded stats plus the durable completed AEAD/hash witness; N07 additionally
  * authenticates every necessary object, one <=256KiB object at a time. */
 async authenticatedClosure(entityKey:string,bodyRevision:string,expectedRecipe:string|undefined,verifyBodies:boolean,readOnly=false,check?:()=>Promise<void>){
  const key=this.key({entityKey,bodyRevision} as QueuedBody),saved=await this.store.get<BodyPlan>('body:'+key);
  if(!saved||!['done','evicted'].includes(saved.value.phase))throw Error('closure_incomplete');
  const b=saved.value,r=recipe(b.recipe),ro=b.recipeObject;if(!ro||expectedRecipe&&ro.oid!==expectedRecipe||r.entityKey!==entityKey||r.bodyRevision!==bodyRevision)throw Error('body_revision_changed');
  if(new ContentSha256(b.hash).finish()!==r.plaintextSha256||b.hash.length!==r.totalPlainBytes||contentIdFromHash(this.keys.id,this.scope,'recipe',r.plaintextSha256)!==r.opaqueContentId)throw Error('hash_mismatch');
  const epoch=!b.sharedCiphertext&&b.cacheEpoch?b.cacheEpoch+':':'',objects=[{oid:ro.oid,cache:ro.cache,size:ro.total},...r.blocks.map((block,index)=>({oid:block.oid,cache:b.direction==='upload'?'prepared:'+key+':'+index:'download:'+epoch+block.oid,size:0}))];
  for(let at=0;at<objects.length;at+=32){const page=objects.slice(at,at+32),stats=await this.store.files.stat(page.map(o=>this.store.path(o.cache)));if(stats.length!==page.length)throw Error('closure_incomplete');
   for(let i=0;i<page.length;i++){const stat=stats[i]!,object=page[i]!;if(!stat.exists||stat.size<16||stat.size>266264||object.size&&object.size!==stat.size)throw Error('closure_incomplete');
    if(b.direction==='download'){if(!stat.checkpoint||stat.durableOffset!==stat.size)throw Error('closure_incomplete');const checkpoint=JSON.parse(stat.checkpoint);if(checkpoint.oid!==object.oid||checkpoint.totalBytes!==stat.size||checkpoint.binding!==this.store.prefix)throw Error('closure_incomplete');}
    object.size=stat.size;}}
  const assertCurrent=async()=>{await this.options.assertCurrent();if(b.direction==='upload'){if(!b.item.sourceBinding)throw Error('source_identity_missing');const source=await this.options.source(b.item.sourceBinding);if(source.binding!==b.item.sourceBinding||source.size!==r.totalPlainBytes)throw Error('body_revision_changed');await source.assertCurrent();}const latest=await this.store.get('body:'+key);if(!latest||latest.revision!==saved.revision)throw Error('body_revision_changed');};
  const rawRecipe=await this.store.bytes(ro.cache,ro.total),opened=await openV2(this.crypto,this.keys.id,this.keys.content,this.scope,ro.oid,rawRecipe);
  if(opened.header.keyVersion!==this.keys.version||canonical(recipe(opened.value))!==canonical(r))throw Error('body_revision_changed');
  if(b.refs){const refs=b.refs,deviceId=refs.authorDeviceId;
   if(deviceId){const approved=await this.options.approved(deviceId);if(approved.keyId!==refs.keyId)throw Error('signature_invalid');await (await import('./signing')).verifySigned(this.crypto,approved.publicKey,'wrss.sync.v2/recipe-refs-sign',refs.body,refs.signature);}
   else {const publicKey=await this.crypto.signingKey(this.options.alias,false);await (await import('./signing')).verifySigned(this.crypto,(await import('./wire')).b64(publicKey),'wrss.sync.v2/recipe-refs-sign',refs.body,refs.signature);}
   if(canonical(refs.body)!==canonical({scope:this.scope,recipeOid:ro.oid,blobOids:r.blocks.map(block=>block.oid)}))throw Error('closure_incomplete');
  }else {const http=readOnly?this.remote.http.readOnly(check):this.remote.http,window=await http.negotiate([],[]);await readControlRefs(http,this.crypto,this.options.approved,window.windowId,{type:'recipe',oid:ro.oid,value:r});}

  if(verifyBodies){const hash=new ContentSha256();for(let i=0;i<r.blocks.length;i++){const object=objects[i+1]!,block=r.blocks[i]!,raw=await this.store.bytes(object.cache,object.size),value=await openV2(this.crypto,this.keys.id,this.keys.content,this.scope,object.oid,raw);if(value.header.keyVersion!==this.keys.version)throw Error('unsupported_feature');recipeBlock(r,i,value.plain,this.keys.id,this.scope);hash.update(value.plain);await this.options.yieldControl();}if(hash.finish()!==r.plaintextSha256)throw Error('hash_mismatch');}
  await assertCurrent();
  return {item:b.item,recipe:r,recipeOid:ro.oid,objects:[...new Map(objects.map(object=>[object.oid,{oid:object.oid,size:object.size,read:async(offset:number,length:number)=>{uint(offset);uint(length,65536);if(offset>object.size-length)throw Error('invalid_range');await assertCurrent();const data=await this.store.bytes(object.cache,object.size,offset,length);await assertCurrent();return data;}}])).values()]};
 }
 async verifiedBody(entityKey:string,bodyRevision:string){const saved=await this.store.get<BodyPlan>('body:'+this.key({entityKey,bodyRevision} as QueuedBody));if(!saved||saved.value.direction!=='download'||!['done','evicted'].includes(saved.value.phase))throw Error('content_not_ready');return {item:saved.value.item,recipe:saved.value.recipe!,recipeOid:saved.value.recipeObject!.oid};}
 /** Authenticated derived-cache descriptor. Never exposes original upload files. */
 async derivedBody(entityKey:string,bodyRevision:string){
  const key=this.key({entityKey,bodyRevision} as QueuedBody),saved=await this.store.get<BodyPlan>('body:'+key);if(!saved||saved.value.direction!=='download'||saved.value.phase!=='done')throw Error('content_not_ready');const b=saved.value,r=b.recipe!,epoch=b.cacheEpoch?b.cacheEpoch+':':'';
  // Raw encrypted transfer objects are immutable and shared by OID. Only
  // plaintext uses a fresh epoch after eviction. Shared transfer files
  // must not be reclaimed from an entity-only plaintext cache journal.
  const paths=r.blocks.map((block,index)=>this.store.path('plain:'+epoch+key+':'+index));
  const resources:{id:string;path:string;bytes:number}[]=[];for(let at=0;at<paths.length;at+=32){const stats=await this.store.files.stat(paths.slice(at,at+32));for(const stat of stats){if(!stat.exists)throw Error('content_not_ready');resources.push({id:digest(stat.path),path:stat.path,bytes:stat.size});}}
  return {item:b.item,recipe:r,recipeOid:b.recipeObject!.oid,resources:[...new Map(resources.map(r=>[r.id,r])).values()]};
 }
 async prepareEviction(entityKey:string,bodyRevision:string){
  if(this.active)throw Error('content_busy');const id='body:'+this.key({entityKey,bodyRevision} as QueuedBody),saved=await this.store.get<BodyPlan>(id);if(!saved||saved.value.direction!=='download'||saved.value.phase!=='done')throw Error('content_not_ready');return this.store.prepareMany([{id,value:{...saved.value,phase:'evicted'},expected:saved.revision}]);
 }
 async demand(entityKey:string,bodyRevision:string,requesterDeviceId:string,demandId:string){
  const now=this.now(),value={entityKey,bodyRevision,requesterDeviceId,demandId,demandAtMillis:now,expiresAtMillis:now+600000};await this.options.assertCurrent();const response=await this.remote.demand(value);await this.refreshDemands(true);return response;
 }
}
