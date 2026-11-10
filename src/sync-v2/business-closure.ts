/** Product business -> P3A authenticated object closure. No synthetic source,
 * raw proof booleans or arbitrary OID lists can supply recovery bytes here. */
import {openV2} from './sealed';
import {recipe} from './content-schema';
import {signedAvailability} from './service-key';
import {businessBodyWitness} from './body-binding';
import {noteAssetKeys} from '../notes/cloud-assets';
import {conflictTexts,validateSet} from './note-conflict-set';
import {fromWire} from './business';
import {canonical,entityKey,hexId,type Kind} from './protocol';
import type {WatchProjectionStore} from './store';
import type {WatchContentEngine} from './content-engine';
import {recoveryBusiness,type RecoveryDelta,type RecoveryValue} from './recovery';
import type {CachedBody} from './space-store';
export class WatchBusinessClosure {
 constructor(readonly projection:WatchProjectionStore,readonly content:WatchContentEngine){}
 private async record(id:string,cloudOnly=false,readOnly=false){
  hexId(id,64);const state=await(readOnly?this.projection.readStableState():this.projection.readState()),current=state.cloud?.current;
  const cloud=state.account&&current?.commitOid===state.account.oid?await this.projection.cloudRow(current.treeRoot,id):null;
  const candidate=cloudOnly?null:await this.projection.readCandidate(id),entry=candidate??cloud;
  if(!entry||!entry.meta||!entry.state||entry.meta.entityKey!==id||entry.state.entityKey!==id)throw Error('source_identity_missing');
  const kind:Kind=entry.meta.kind,logicalId=entry.meta.logicalId,value=fromWire(kind,entry.meta.payload,entry.state.payload);
  const businessId=kind==='article'?value.articleId:kind==='book'?value.bookId:kind==='book-reading'?value.bookId+':'+value.chapterIndex:kind==='rss-state'?value.sourceId+':'+value.articleIdHash:kind==='source'?value.url:kind==='note'?value.noteId:kind==='folder'?value.folderId:value.assetId;
  if(businessId!==logicalId||entityKey(this.content.keys.id,this.content.remote.http.scope.repoId,kind,logicalId)!==id)throw Error('source_identity_missing');
  return {id,kind,logicalId,value,entry,cloud,state};
 }
 private async body(record:Awaited<ReturnType<WatchBusinessClosure['record']>>,verifyBytes:boolean){
  const {id,kind,logicalId,value,cloud}=record,binding=await this.content.businessBinding(id);
  let revision:string,recipeOid:string|undefined;
  if(binding){if(binding.entityKey!==id||binding.kind!==kind||binding.logicalId!==logicalId||binding.bodyWitness!==businessBodyWitness(kind,value))throw Error('source_identity_missing');revision=binding.bodyRevision;}
  else {if(!cloud||canonical(recoveryBusiness(cloud.meta.kind,fromWire(cloud.meta.kind,cloud.meta.payload,cloud.state.payload)))!==canonical(recoveryBusiness(kind,value))||!cloud.row.recipeOid)throw Error('closure_incomplete');revision=cloud.row.bodyRevision;recipeOid=cloud.row.recipeOid;}
  const closure=await this.content.authenticatedClosure(id,revision,recipeOid,verifyBytes);
  if(binding&&closure.item.sourceBinding!==undefined&&closure.item.sourceBinding!==binding.sourceBinding)throw Error('body_revision_changed');
  return closure;
 }
 private async collect(id:string,expected:Record<string,any>|undefined,verifyBytes:boolean,seen:Set<string>,objects:Map<string,any>){
  const record=await this.record(id);
  if(expected&&canonical(recoveryBusiness(record.kind,record.value))!==canonical(recoveryBusiness(record.kind,expected)))throw Error('choice_stale');
  if(seen.has(id))return record;seen.add(id);
  if(record.kind==='note'){
   // Note Markdown is authenticated inline state. Only its necessary image
   // objects need a body pin; include base and every resolved conflict too.
   const texts=[record.value.markdown,record.value.baseMarkdown];
   if(record.value.noteConflicts){validateSet(record.logicalId,record.value.noteConflicts);texts.push(...conflictTexts(record.value.noteConflicts));}
   const assets=new Set<string>();for(const text of texts)for(const asset of noteAssetKeys(text))assets.add(asset);
   for(const asset of [...assets].sort()){
    const assetKey=entityKey(this.content.keys.id,this.content.remote.http.scope.repoId,'asset',asset),image=await this.record(assetKey);
    if(image.kind!=='asset'||image.logicalId!==asset||image.value.assetId!==asset)throw Error('closure_incomplete');
    await this.collect(assetKey,undefined,verifyBytes,seen,objects);
   }
  }else if(['article','book','asset'].includes(record.kind)){
   const closure=await this.body(record,verifyBytes);for(const object of closure.objects)objects.set(object.oid,object);
  }else if(!['folder','source','rss-state','book-reading'].includes(record.kind))throw Error('unsupported_feature');
  return record;
 }
 /** Identity, immutable timestamps and body classification come from the
  * authenticated current business row. Open/edit witnesses are caller-owned. */
 async cachedBody(id:string,access:{lastOpenedAtMillis:number|null;openedNow:boolean;dirty:boolean}):Promise<CachedBody|null>{
  const r=await this.record(id,true);if(r.kind==='note')return null;
  if(!['article','book','asset'].includes(r.kind)||!r.cloud?.row.recipeOid||r.cloud.row.deleted)throw Error('closure_incomplete');
  const row=r.cloud.row,body=await this.content.authenticatedClosure(id,row.bodyRevision,row.recipeOid,false),kind=r.kind==='asset'?'memo':r.kind==='book'||body.item.importedFile?'import':'rss';
  return {item:{entityKey:id,bodyRevision:row.bodyRevision,recipeOid:row.recipeOid,scope:this.content.remote.http.scope,kind,...(r.kind==='asset'?{parentKind:'memo'}:{}),addedAtMillis:row.addedAtMillis,addedAtSource:r.cloud.meta.addedAtSource,localBytes:row.contentBytes,...access},metadata:{businessId:r.logicalId,addedAt:row.addedAtMillis,title:r.value.title??r.value.originalFilename??''},status:'ready',plaintextSha256:body.recipe.plaintextSha256};
 }
 async recoveryValue(id:string):Promise<RecoveryValue>{const objects=new Map<string,any>(),record=await this.collect(id,undefined,false,new Set(),objects);if(!record)throw Error('source_identity_missing');return {kind:record.kind,value:recoveryBusiness(record.kind,record.value),bodyRefs:[...objects.keys()].sort()};}
 async source(refs:string[],changes:RecoveryDelta['changes']){
  const before=await this.projection.readState(),objects=new Map<string,any>(),seen=new Set<string>();
  for(const change of changes)if(change.kind==='set')await this.collect(change.id,change.value,true,seen,objects);
  const required=[...objects.keys()].sort();if(canonical(refs)!==canonical(required))throw Error('closure_incomplete');
  const after=await this.projection.readState();if(canonical(before)!==canonical(after))throw Error('choice_stale');
  return required.map(id=>objects.get(id)!);
 }
 /** Release the BODY owner after upload acknowledgement and fresh current
  * closure receipts. Later title/reading/inline state edits do not change a
  * pinned recipe's identity. Read recipes from the durable edit owner. */
 async acknowledgeRecovery(delta:RecoveryDelta,read:(ref:string)=>Promise<Uint8Array[]>,now:()=>number|null,check?:()=>Promise<void>){
  const before=await this.projection.readStableState(),scope=this.content.remote.http.scope;
  if(!before.account||before.pendingChoice||before.hasUnsentEdits||before.cloud?.current?.commitOid!==before.account.oid)throw Error('closure_incomplete');
  const guard=async()=>{await check?.();if(canonical(before)!==canonical(await this.projection.readStableState()))throw Error('choice_stale');};
  const refs=new Set<string>();let expiresAtMillis=Number.MAX_SAFE_INTEGER;
  for(const ref of delta.bodyRefs.filter(ref=>ref.startsWith('recipe:'))){
   const parts=await read(ref),size=parts.reduce((n,p)=>n+p.length,0);if(size>266264)throw Error('object_too_large');const raw=new Uint8Array(size);let at=0;for(const part of parts){raw.set(part,at);at+=part.length;}
   const opened=await openV2(this.content.crypto,this.content.keys.id,this.content.keys.readContentKey??this.content.keys.content,scope,ref,raw),body=recipe(opened.value),r=await this.record(body.entityKey,true,true),row=r.entry.row;
   if(!row||row.deleted||!['article','book','asset'].includes(r.kind)||(!this.content.keys.readContentKey&&opened.header.keyVersion!==this.content.keys.version)||row.recipeOid!==ref||body.bodyRevision!==row.bodyRevision||body.opaqueContentId!==row.opaqueContentId||body.totalPlainBytes!==row.contentBytes)throw Error('body_revision_changed');
   const blobOids=body.blocks.map(b=>b.oid),expected={entityKey:body.entityKey,bodyRevision:row.bodyRevision,recipeOid:ref,blobOids};refs.add(ref);for(const oid of blobOids)refs.add(oid);
   await guard();const response=await this.content.remote.availability(expected,true,guard),time=now();if(time===null)throw Error('clock_unknown');
   await guard();const signed=await signedAvailability(this.content.remote.http.servicePin!,this.content.crypto,response.receipt,scope,expected,time,true);
   if(signed.status!=='cloud-ready'||signed.expiresAtMillis<=time)throw Error('closure_incomplete');expiresAtMillis=Math.min(expiresAtMillis,signed.expiresAtMillis);
  }
  if(canonical([...refs].sort())!==canonical(delta.bodyRefs))throw Error('closure_incomplete');
  if(canonical(before)!==canonical(await this.projection.readStableState()))throw Error('choice_stale');return {expiresAtMillis};
 }
 /** Metadata/stat-only cleanup proof. The controller obtains and verifies a
  * fresh SignedAvailability before its atomic placeholder/retirement commits. */
 async cloudProof(body:CachedBody,check?:()=>Promise<void>){
  const r=await this.record(body.item.entityKey,true,true),row=r.entry.row,state=r.state;
  if(!state.account||state.hasUnsentEdits||state.pendingChoice||!row||row.deleted||row.recipeOid!==body.item.recipeOid||row.bodyRevision!==body.item.bodyRevision)throw Error('closure_incomplete');
  const guard=async()=>{await check?.();if(canonical(state)!==canonical(await this.projection.readStableState()))throw Error('choice_stale');};
  await guard();const descriptor=await this.content.authenticatedClosure(row.entityKey,row.bodyRevision,row.recipeOid,false,true,guard);
  const kind=r.kind==='book'?'import':r.kind==='article'?(descriptor.item.importedFile?'import':'rss'):'memo';
  if(body.item.kind!==kind||body.item.addedAtMillis!==row.addedAtMillis||body.item.addedAtSource!==r.entry.meta.addedAtSource)throw Error('closure_incomplete');
  return {accountOid:state.account.oid,scope:this.content.remote.http.scope,entityKey:row.entityKey,bodyRevision:row.bodyRevision,recipeOid:row.recipeOid,blobOids:descriptor.recipe.blocks.map(b=>b.oid),keyVersion:this.content.keys.version,authenticated:true};
 }
}
