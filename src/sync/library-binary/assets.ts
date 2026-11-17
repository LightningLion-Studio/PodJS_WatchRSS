import type {VerifiedChunkStore,ObjectLease,VerifiedObject} from '@podjs/framework/verified-chunk-store';
import type {BinaryStore,ReceiptBoundary} from './store';
import type {BinaryLibraryKinds} from './kinds';
import {descriptor,objectId,D} from './digests';
import {CHUNK_BYTES,fail,hash,utf8,strictJson,exact,type ObjectDescriptor,type Kind,type Row,type Snapshot,type Selection,type Limits} from './wire';
export interface BinaryAssetFiles {
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
export interface BinarySourcePlan {objects:readonly ObjectDescriptor[];read(object:ObjectDescriptor,index:number):Promise<Uint8Array>}
/** Data never becomes a JSON/base64 string. Copies and reads retain one 64KiB
 * block. Frozen spools are immutable, persisted before their witness is offered. */
export class BinaryAssets {
 private outcomes=new Map<string,'merged'|'alreadyPresent'|'retainedLocal'>();
 constructor(private readonly files:BinaryAssetFiles,private readonly store:BinaryStore,private readonly chunks:VerifiedChunkStore,private readonly check:()=>void=()=>{},private readonly unit:()=>void=()=>{},private readonly kinds?:BinaryLibraryKinds){}
 private metadata(d:ObjectDescriptor){const m=exact(strictJson(d.metadataUtf8,false),['storageKey','sha256','size']);if(d.kind!=='noteAsset'||d.encoding!=='raw'||!/^([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/.test(String(m.storageKey))||m.storageKey!==d.businessId||m.sha256!==d.sha256||m.size!==d.size||d.size>5*1024*1024||d.dependsOn.length)fail('BUSINESS_REJECTED');return m;}
 private conflict(d:ObjectDescriptor){return 'notes/asset-conflicts/'+hash(utf8(d.businessId))+'-'+d.sha256+'.bin';}
 private async verified(path:string,d:Pick<ObjectDescriptor,'size'|'sha256'>,code='SOURCE_CHANGED'){const h=await this.files.hash(path);this.check();if(h.size!==d.size||h.sha256!==d.sha256)fail(code);this.unit();}
 async freeze(scope:string,id:string,limits:Limits,send?:ReadonlySet<Kind>):Promise<{witness:Snapshot;inventory:Row}>{
  const objects:ObjectDescriptor[]=[],paths:Record<string,string>={};let manifestBytes=2;
  const entries=send&&!send.has('noteAsset')?[]:await this.noteEntries();
  for(const e of entries){this.check();if(!e.file||!e.path.startsWith('notes/assets/'))continue;const key=e.path.slice(13);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key)||/\.(?:part|pending|async-\d+|kv-migration)$/.test(key))continue;
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
  objects.sort((a,b)=>a.objectId<b.objectId?-1:1);return {witness:{snapshotId:id,manifestDigest:hash(utf8(JSON.stringify(objects))),fromExclusive:0,toInclusive:0},inventory:{objects,paths}};
 }
 private async noteEntries(){
  const exists=await this.files.stat('notes/assets');if(exists.file)fail('LOCAL_IO');
  return (await this.files.list('notes/assets')).entries;
 }
 private validate(d:ObjectDescriptor){
  if(d.kind==='noteAsset')return this.metadata(d);
  if(!this.kinds)fail('UNSUPPORTED_KIND');
  return this.kinds.validate(d);
 }
 async source(scope:string,witness:Snapshot,selection:Selection):Promise<BinarySourcePlan>{
  const frozen=await this.store.snapshot(scope,witness.snapshotId);if(!frozen||(['snapshotId','manifestDigest','fromExclusive','toInclusive'] as const).some(k=>frozen.witness[k]!==witness[k]))fail('SOURCE_CHANGED');
  const inv=frozen.inventory as {objects:ObjectDescriptor[];paths:Record<string,string>};if(!Array.isArray(inv.objects)||hash(utf8(JSON.stringify(inv.objects)))!==witness.manifestDigest||inv.objects.length>selection.limits.maxPlanObjects)fail('SOURCE_CHANGED');
  const objects=inv.objects.filter(o=>selection.kinds.some(k=>k.kind===o.kind)).map(o=>descriptor(o,selection.limits));for(const d of objects){this.validate(d);if(d.kind!=='noteAsset')continue;const expected='library-binary/spool/'+D('wrss.library-binary.v2/spool',[scope,d.objectId])+'.bin';if(inv.paths[d.objectId]!==expected)fail('JOURNAL_CORRUPT');}
  return {objects,read:async(d,index)=>{this.check();if(d.kind!=='noteAsset')fail('SOURCE_CHANGED');const r=await this.files.readBytes(inv.paths[d.objectId]!,index*CHUNK_BYTES,CHUNK_BYTES);this.check();if(r.size!==d.size||r.bytes.length!==Math.min(CHUNK_BYTES,d.size-index*CHUNK_BYTES)||hash(r.bytes)!==d.chunkHashes[index])fail('SOURCE_CHANGED');this.unit();return r.bytes;}};
 }
 async peak(limits:Limits,incoming:number,bodyJob=false){const stat=await this.files.stat('notes/assets');this.check();const other=await this.store.db.query("SELECT (SELECT COALESCE(SUM(bytes),0) FROM library_binary_peaks)+(SELECT COALESCE(SUM(bytes),0) FROM library_binary_source_files) AS n");const reserved=Number(other[0]?.n??0);if(!Number.isSafeInteger(stat.usableBytes)||incoming+reserved+limits.maxJournalBytes+1048576>stat.usableBytes!||incoming+reserved+(bodyJob?0:limits.maxJournalBytes)>limits.maxStagingBytes)fail('STORAGE_PRESSURE');}
 async reserve(scope:string,job:string,limits:Limits,objects:readonly ObjectDescriptor[]){if(!objects.length)return;let incoming=this.kinds?.shadowBytes(objects)??0;for(const d of objects){this.validate(d);incoming+=d.size*4+utf8(JSON.stringify(d)).length+1024;}
  const old=(await this.store.db.query('SELECT bytes FROM library_binary_peaks WHERE scope=? AND job_id=?',[scope,job]))[0];await this.peak(limits,incoming-Number(old?.bytes??0),objects.some(d=>d.kind==='articleBody'));this.check();await this.store.db.execute('INSERT OR REPLACE INTO library_binary_peaks VALUES(?,?,?)',[scope,job,incoming]);this.unit();}
 async collect(){
  const rows=await this.store.db.query("SELECT path FROM library_binary_source_files f WHERE expires_at<? AND NOT EXISTS(SELECT 1 FROM library_binary_snapshot_files sf JOIN library_binary_snapshots s ON s.scope=sf.scope AND s.snapshot_id=sf.snapshot_id WHERE sf.path=f.path) LIMIT 64",[this.store.now()]);
  for(const row of rows){this.check();const path=String(row.path);if(!/^library-binary\/spool\/[A-Za-z0-9._-]{1,160}$/.test(path))fail('JOURNAL_CORRUPT');await this.files.remove(path);await this.store.db.execute('DELETE FROM library_binary_source_files WHERE path=?',[path]);this.unit();}
 }
 async publish(lease:ObjectLease,object:VerifiedObject,d:ObjectDescriptor){if(d.kind!=='noteAsset')return this.chunks.finalize(lease,object);this.metadata(d);this.check();const target='notes/assets/'+d.businessId;let present=false;if((await this.files.stat(target)).file){const h=await this.files.hash(target);present=h.sha256===d.sha256&&h.size===d.size;}this.outcomes.set(d.objectId,present?'alreadyPresent':'merged');try{return await this.chunks.finalize(lease,object,target);}catch(e){if(!(e instanceof Error)||e.message!=='PUBLICATION_CONFLICT')throw e;this.outcomes.set(d.objectId,'retainedLocal');return this.chunks.finalize(lease,object,this.conflict(d));}}
 async apply(d:ObjectDescriptor,path:string,boundary:ReceiptBoundary,peer?:string){if(d.kind!=='noteAsset'){if(!this.kinds||!peer)fail('UNSUPPORTED_KIND');return this.kinds.apply(d,path,peer,boundary);}this.metadata(d);const conflict=path===this.conflict(d);if(path!=='notes/assets/'+d.businessId&&!conflict)fail('OBJECT_CONFLICT');await this.verified(path,d,'HASH_MISMATCH');boundary.check?.();const outcome=conflict?'retainedLocal':this.outcomes.get(d.objectId)??'alreadyPresent';await this.store.db.transaction([...boundary.before,{sql:'INSERT INTO library_binary_assets VALUES(?,?,?,?,?) ON CONFLICT(storage_key,sha256) DO UPDATE SET path=excluded.path,outcome=excluded.outcome',params:[d.businessId,d.sha256,d.size,path,outcome]},...boundary.after(outcome)]);this.unit();}
}
