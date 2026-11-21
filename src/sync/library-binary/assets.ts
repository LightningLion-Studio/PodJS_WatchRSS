import type {VerifiedChunkStore,ObjectLease,VerifiedObject} from '@podjs/framework/verified-chunk-store';
import {noteAssetVersionPath, type NoteAssetFileIndex} from '../../notes/asset-files';
import type {SourceFileRange} from './codec';
import type {BinaryBooks,FrozenBookFile} from './books';
import type {BinaryStore,Job,ReceiptBoundary} from './store';
import type {BinaryLibraryKinds} from './kinds';
import {descriptor,objectId,D} from './digests';
import {CHUNK_BYTES,fail,hash,utf8,strictJson,exact,type ObjectDescriptor,type Kind,type Row,type Snapshot,type Selection,type Limits} from './wire';
// Native reserves this factor for block files, assembly and publication.
export const STAGING_COPIES=4;
export interface BinaryAssetFiles {
 orphanScratch?(collect:boolean):Promise<number>;
 list(path:string):Promise<{entries:{path:string;file:boolean;size:number}[]}>;
 stat(path:string):Promise<{file:boolean;size:number;usableBytes?:number}>;
 hash(path:string):Promise<{sha256:string;size:number}>;
 readBytes(path:string,offset:number,maxBytes:number):Promise<{bytes:Uint8Array;size:number}>;
 writeBytes(path:string,bytes:Uint8Array):Promise<{size:number}>;
 appendBytes(path:string,bytes:Uint8Array,offset:number):Promise<{size:number}>;
 createTemp(directory:string):Promise<{path:string}>;
 commit(path:string,target:string,size:number,sha256:string,expectedTargetSha256?:string|null):Promise<{path:string}>;
 remove(path:string):Promise<void>;
}
export interface BinarySourcePlan {objects:readonly ObjectDescriptor[];read(object:ObjectDescriptor,index:number):Promise<Uint8Array>;range?(object:ObjectDescriptor,index:number):SourceFileRange|undefined}
/** Data never becomes a JSON/base64 string. Copies and reads retain one 64KiB
 * block. Frozen spools are immutable, persisted before their witness is offered. */
export class BinaryAssets {
 private outcomes=new Map<string,'merged'|'alreadyPresent'|'retainedLocal'>();
 constructor(private readonly files:BinaryAssetFiles,private readonly store:BinaryStore,private readonly chunks:VerifiedChunkStore,private readonly check:()=>void=()=>{},private readonly unit:()=>void=()=>{},private readonly kinds?:BinaryLibraryKinds,private readonly books?:BinaryBooks,private readonly assetIndex?:NoteAssetFileIndex){}
 private metadata(d:ObjectDescriptor){const m=exact(strictJson(d.metadataUtf8,false),['storageKey','sha256','size']);if(d.kind!=='noteAsset'||d.encoding!=='raw'||!/^([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/.test(String(m.storageKey))||m.storageKey!==d.businessId||m.sha256!==d.sha256||m.size!==d.size||d.size>5*1024*1024||d.dependsOn.length)fail('BUSINESS_REJECTED');return m;}
 private conflict(d:ObjectDescriptor){return 'notes/asset-conflicts/'+hash(utf8(d.businessId))+'-'+d.sha256+'.bin';}
 private async verified(path:string,d:Pick<ObjectDescriptor,'size'|'sha256'>,code='SOURCE_CHANGED'){const h=await this.files.hash(path);this.check();if(h.size!==d.size||h.sha256!==d.sha256)fail(code);this.unit();}
 async freeze(scope:string,id:string,limits:Limits,send?:ReadonlySet<Kind>):Promise<{witness:Snapshot;inventory:Row}>{
  const objects:ObjectDescriptor[]=[],paths:Record<string,string>={};let manifestBytes=2;
  const entries=send&&!send.has('noteAsset')?[]:await this.noteEntries();
  for(const e of entries){this.check();const key=e.key;if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key)||/\.(?:part|pending|async-\d+|kv-migration)$/.test(key))continue;
   if(objects.length>=limits.maxPlanObjects)fail('LIMIT_EXCEEDED');
   const before=await this.files.hash(e.path);this.unit();if(before.size>limits.maxObjectBytes||before.size>5*1024*1024)fail('LIMIT_EXCEEDED');
   await this.peak(limits,before.size*2+8192);
   const temp=(await this.files.createTemp('library-binary/spool')).path;const hashes:string[]=[];
   await this.store.budget(2048,limits.maxJournalBytes);await this.store.db.execute('INSERT OR REPLACE INTO library_binary_source_files VALUES(?,?,?)',[temp,before.size+4096,this.store.now()+86400000]);
   try{await this.files.writeBytes(temp,new Uint8Array());for(let at=0;at<before.size;){this.check();const r=await this.files.readBytes(e.path,at,Math.min(CHUNK_BYTES,before.size-at));if(r.size!==before.size||r.bytes.length!==Math.min(CHUNK_BYTES,before.size-at))fail('SOURCE_CHANGED');hashes.push(hash(r.bytes));const w=await this.files.appendBytes(temp,r.bytes,at);if(w.size!==at+r.bytes.length)fail('LOCAL_IO');at+=r.bytes.length;this.unit();}
    await this.verified(e.path,before);await this.verified(temp,before);
    const metadataUtf8=JSON.stringify({storageKey:key,sha256:before.sha256,size:before.size});const d:ObjectDescriptor={objectId:'',kind:'noteAsset',schemaVersion:1,businessId:key,contentVersion:before.sha256,encoding:'raw',size:before.size,sha256:before.sha256,chunkBytes:65536,chunkHashes:hashes,metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),dependsOn:[]};d.objectId=objectId(d);descriptor(d,limits);
    manifestBytes+=utf8(JSON.stringify(d)).length+1;if(manifestBytes>limits.maxManifestBytes)fail('LIMIT_EXCEEDED');
    const target='library-binary/spool/'+D('wrss.library-binary.v2/spool',[scope,d.objectId])+'.bin';await this.store.db.execute('INSERT OR REPLACE INTO library_binary_source_files VALUES(?,?,?)',[target,d.size+4096,this.store.now()+86400000]);await this.files.commit(temp,target,d.size,d.sha256,null);this.check();objects.push(d);paths[d.objectId]=target;
   }finally{try{await this.files.remove(temp);await this.store.db.execute('DELETE FROM library_binary_source_files WHERE path=?',[temp]);}catch{/* The owned ledger retains interrupted copies for delayed collection. */}}
  }
  if(send?.has('rssSource')&&this.kinds)for(const d of await this.kinds.freezeSources()){
   descriptor(d,limits);manifestBytes+=utf8(JSON.stringify(d)).length+1;
   if(objects.length>=limits.maxPlanObjects||manifestBytes>limits.maxManifestBytes)fail('LIMIT_EXCEEDED');
   objects.push(d);
  }
  if(send&&this.books)await this.books.freeze(scope,id,limits,send,(d,file)=>{
   manifestBytes+=utf8(JSON.stringify(d)).length+1;
   if(objects.length>=limits.maxPlanObjects||manifestBytes>limits.maxManifestBytes)fail('LIMIT_EXCEEDED');
   objects.push(d);if(file)paths[d.objectId]=file.path;
  },bytes=>this.peak(limits,bytes));
  objects.sort((a,b)=>a.objectId<b.objectId?-1:1);return {witness:{snapshotId:id,manifestDigest:hash(utf8(JSON.stringify(objects))),fromExclusive:0,toInclusive:0},inventory:{objects,paths}};
 }
 private async noteEntries(){
  const exists=await this.files.stat('notes/assets');if(exists.file)fail('LOCAL_IO');
  const legacy=(await this.files.list('notes/assets')).entries.filter(e=>e.file&&e.path.startsWith('notes/assets/'))
   .map(e=>({key:e.path.slice(13),path:e.path}));
  if(!this.assetIndex)return legacy;
  const current=await this.assetIndex.entries(),keys=new Set(current.map(e=>e.key));
  return [...legacy.filter(e=>!keys.has(e.key)),...current];
 }
 private validate(d:ObjectDescriptor,limits:Limits){
  if(d.kind.startsWith('book')){
   if(!this.books)fail('UNSUPPORTED_KIND');
   return this.books.validate(d,limits);
  }
  if(d.kind==='noteAsset')return this.metadata(d);
  if(!this.kinds)fail('UNSUPPORTED_KIND');
  return this.kinds.validate(d);
 }
 async source(scope:string,witness:Snapshot,selection:Selection):Promise<BinarySourcePlan>{
  const frozen=await this.store.snapshot(scope,witness.snapshotId);if(!frozen||(['snapshotId','manifestDigest','fromExclusive','toInclusive'] as const).some(k=>frozen.witness[k]!==witness[k]))fail('SOURCE_CHANGED');
  const inv=frozen.inventory as {objects:ObjectDescriptor[];paths:Record<string,string>};if(!Array.isArray(inv.objects)||hash(utf8(JSON.stringify(inv.objects)))!==witness.manifestDigest||inv.objects.length>selection.limits.maxPlanObjects)fail('SOURCE_CHANGED');
  const objects=inv.objects.filter(o=>selection.kinds.some(k=>k.kind===o.kind)).map(o=>descriptor(o,selection.limits));
  const bookFiles=new Map<string,FrozenBookFile>();
  for(const d of objects){
   this.validate(d,selection.limits);
   if(d.kind.startsWith('book')){
    const file=this.books?.source(scope,witness.snapshotId,d,selection.limits);
    if(file){if(inv.paths[d.objectId]!==file.path)fail('JOURNAL_CORRUPT');bookFiles.set(d.objectId,file);}
   }
   if(d.kind!=='noteAsset')continue;const expected='library-binary/spool/'+D('wrss.library-binary.v2/spool',[scope,d.objectId])+'.bin';if(inv.paths[d.objectId]!==expected)fail('JOURNAL_CORRUPT');}
  return {objects,range:(d,index)=>{
   const file=bookFiles.get(d.objectId);if(!file)return;
   const offset=index*CHUNK_BYTES,sha256=d.chunkHashes[index];
   if(!sha256)fail('OBJECT_CONFLICT');
   return {path:file.path,offset:file.offset+offset,size:Math.min(CHUNK_BYTES,d.size-offset),sha256};
  },read:async(d,index)=>{this.check();if(d.kind!=='noteAsset')fail('SOURCE_CHANGED');const r=await this.files.readBytes(inv.paths[d.objectId]!,index*CHUNK_BYTES,CHUNK_BYTES);this.check();if(r.size!==d.size||r.bytes.length!==Math.min(CHUNK_BYTES,d.size-index*CHUNK_BYTES)||hash(r.bytes)!==d.chunkHashes[index])fail('SOURCE_CHANGED');this.unit();return r.bytes;}};
 }
 async peak(limits:Limits,incoming:number){
  const abandoned=await this.files.orphanScratch?.(false)??0;
  if(!Number.isSafeInteger(abandoned)||abandoned<0)fail('LOCAL_IO');
  const stat=await this.files.stat('notes/assets');this.check();
  const rows=await this.store.db.query(`SELECT (SELECT COALESCE(SUM(bytes),0) FROM library_binary_peaks)
   +(SELECT COALESCE(SUM(bytes),0) FROM library_binary_source_files)
   +(SELECT COALESCE(SUM(f.size),0) FROM library_binary_book_files f WHERE NOT EXISTS
     (SELECT 1 FROM library_binary_peaks p WHERE p.scope=f.scope AND p.job_id=f.job_id))
   +(SELECT COALESCE(SUM(f.size),0) FROM library_binary_book_publications f WHERE NOT EXISTS
     (SELECT 1 FROM library_binary_peaks p WHERE p.scope=f.scope AND p.job_id=f.job_id)) AS n`);
  const staging=Number(rows[0]?.n??0)+incoming+abandoned;
  // The store budgets manifest and receipts against maxJournalBytes. The
  // filesystem must still have room for that journal alongside staging.
  if(staging>limits.maxStagingBytes||!Number.isSafeInteger(stat.usableBytes)||staging+limits.maxJournalBytes+1048576>stat.usableBytes!)fail('STORAGE_PRESSURE');
 }
 async reserve(scope:string,job:string,limits:Limits,objects:readonly ObjectDescriptor[]){
  if(!objects.length)return;
  let incoming=(this.kinds?.shadowBytes(objects)??0)+(this.books?.peak(objects,limits)??0);
  for(const d of objects){
   this.validate(d,limits);
   if(d.kind!=='bookPackageSegment')incoming+=d.size*STAGING_COPIES;
  }
  const old=(await this.store.db.query('SELECT bytes FROM library_binary_peaks WHERE scope=? AND job_id=?',[scope,job]))[0];
  await this.peak(limits,incoming-Number(old?.bytes??0));this.check();
  await this.store.db.execute('INSERT OR REPLACE INTO library_binary_peaks VALUES(?,?,?)',[scope,job,incoming]);this.unit();
 }
 async collect(){
  this.check();await this.files.orphanScratch?.(true);this.check();
  const rows=await this.store.db.query("SELECT path FROM library_binary_source_files f WHERE expires_at<? AND NOT EXISTS(SELECT 1 FROM library_binary_snapshot_files sf JOIN library_binary_snapshots s ON s.scope=sf.scope AND s.snapshot_id=sf.snapshot_id WHERE sf.path=f.path) LIMIT 64",[this.store.now()]);
  for(const row of rows){this.check();const path=String(row.path);if(!/^library-binary\/spool\/[A-Za-z0-9._-]{1,160}$/.test(path))fail('JOURNAL_CORRUPT');await this.files.remove(path);await this.store.db.execute('DELETE FROM library_binary_source_files WHERE path=?',[path]);this.unit();}
 }
 async publish(lease:ObjectLease,object:VerifiedObject,d:ObjectDescriptor,job?:Job){
  if(d.kind==='bookPackageSegment'){
   if(!this.books||!job)fail('UNSUPPORTED_KIND');
   return this.books.publish(job,lease,object,d);
  }
  if(d.kind!=='noteAsset')return this.chunks.finalize(lease,object);
  this.metadata(d);this.check();
  if(this.assetIndex)return this.chunks.finalize(lease,object,noteAssetVersionPath(d.businessId,d.sha256));
  const target='notes/assets/'+d.businessId;let present=false;if((await this.files.stat(target)).file){const h=await this.files.hash(target);present=h.sha256===d.sha256&&h.size===d.size;}this.outcomes.set(d.objectId,present?'alreadyPresent':'merged');try{return await this.chunks.finalize(lease,object,target);}catch(e){if(!(e instanceof Error)||e.message!=='PUBLICATION_CONFLICT')throw e;this.outcomes.set(d.objectId,'retainedLocal');return this.chunks.finalize(lease,object,this.conflict(d));}}
 async apply(d:ObjectDescriptor,path:string,boundary:ReceiptBoundary,peer?:string,job?:Job){
  if(d.kind.startsWith('book')){
   if(!this.books||!job)fail('UNSUPPORTED_KIND');
   return this.books.apply(job,d,path,boundary);
  }
  if(d.kind!=='noteAsset'){if(!this.kinds||!peer)fail('UNSUPPORTED_KIND');return this.kinds.apply(d,path,peer,boundary,job?.jobId);}
  this.metadata(d);
  let outcome:'merged'|'alreadyPresent'|'retainedLocal',effects:ReceiptBoundary['before']=[];
  if(this.assetIndex){
   if(path!==noteAssetVersionPath(d.businessId,d.sha256))fail('OBJECT_CONFLICT');
   const before=await this.assetIndex.version(d.businessId),legacy='notes/assets/'+d.businessId;
   const current=before??((await this.files.stat(legacy)).file?await this.files.hash(legacy):undefined);
   outcome=!current?'merged':current.sha256===d.sha256&&current.size===d.size?'alreadyPresent':'retainedLocal';
   if(outcome!=='retainedLocal')effects=this.assetIndex.statements(d.businessId,before,d);
  }else{
   const conflict=path===this.conflict(d);if(path!=='notes/assets/'+d.businessId&&!conflict)fail('OBJECT_CONFLICT');
   outcome=conflict?'retainedLocal':this.outcomes.get(d.objectId)??'alreadyPresent';
  }
  await this.verified(path,d,'HASH_MISMATCH');boundary.check?.();
  await (boundary.transaction??(statements=>this.store.db.transaction(statements)))([...boundary.before,...effects,
   {sql:'INSERT INTO library_binary_assets VALUES(?,?,?,?,?) ON CONFLICT(storage_key,sha256) DO UPDATE SET path=excluded.path,outcome=excluded.outcome',params:[d.businessId,d.sha256,d.size,path,outcome]},
   ...boundary.after(outcome)]);
  this.unit();
 }
}
