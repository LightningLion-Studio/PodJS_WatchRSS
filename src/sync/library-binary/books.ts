import type {ObjectLease,VerifiedChunkStore,VerifiedObject} from '@podjs/framework/verified-chunk-store';
import type {SqlBookStore} from '../../books/store';
import type {BookFileInfo} from '../../books/files';
import {BOOK_MAX_CHAPTERS,validateBookReading,validateBookShape,type BookReading,type BookState} from '../../books/protocol';
import {libraryRevision} from '../revision';
import {D} from './digests';
import {bookDescription,bookObject,BOOK_SEGMENT_BYTES,validateBookPlan} from './book-plan';
import {importBookPackage,type BinaryBookFiles} from './book-import';
import type {BinaryStore,Job,ReceiptBoundary} from './store';
import {CHUNK_BYTES,HARD_LIMITS,fail,hash,strictJson,utf8,type Kind,type Limits,type ObjectDescriptor} from './wire';

export interface FrozenBookFile {path:string;offset:number}
const sourcePath=(scope:string,id:string,bookId:string,purpose:string)=>'library-binary/spool/'+D('wrss.library-binary.v2/book-source',[scope,id,bookId,purpose])+'.bin';
const empty={size:0,sha256:hash(new Uint8Array()),chunkHashes:[]};
const metadataBytes=1024*1024;
const jobKey=(job:Job)=>[job.scope,job.jobId];
const stagingKey=(job:Job,id:string)=>D('wrss.library-binary.v2/book-shadow',[job.scope,job.jobId,id]);

export class BinaryBooks {
 constructor(private readonly store:BinaryStore,private readonly books:()=>Promise<SqlBookStore|undefined>,
  private readonly files:BinaryBookFiles,private readonly chunks:VerifiedChunkStore,private readonly work:()=>void){}

 validate(d:ObjectDescriptor,limits:Limits=HARD_LIMITS){return bookDescription(d,limits);}

 source(scope:string,snapshot:string,d:ObjectDescriptor,limits:Limits):FrozenBookFile|undefined{
  const b=bookDescription(d,limits),m=b.metadata;
  switch(b.kind){
   case 'bookPackageCommit':return undefined;
   case 'bookPackageSegment':return {path:sourcePath(scope,snapshot,m.bookId,'package'),offset:b.metadata.segmentOffset};
   case 'bookState':return {path:sourcePath(scope,snapshot,m.bookId,'state'),offset:0};
   case 'bookReading':return {path:sourcePath(scope,snapshot,m.bookId,'reading:'+b.metadata.pageIndex),offset:0};
  }
 }

 private async repo(){
  const repo=await this.books();
  if(!repo)fail('UNSUPPORTED_KIND');
  return repo;
 }

 async freeze(scope:string,id:string,limits:Limits,send:ReadonlySet<Kind>,add:(d:ObjectDescriptor,file?:FrozenBookFile)=>void,
  reserve:(bytes:number)=>Promise<void>){
  if(!send.has('bookState'))return;
  const books=await this.repo();
  await books.capture();await books.captureReading();
  const revision=await libraryRevision(this.store.db);
  const created=new Set<string>();
  const remember=async(path:string,size:number)=>{
   await this.store.budget(1024,limits.maxJournalBytes);
   await this.store.db.execute('INSERT INTO library_binary_source_files VALUES(?,?,?)',[path,size+4096,this.store.now()+86400000]);
   created.add(path);
  };
  const target=(bookId:string,purpose:string)=>sourcePath(scope,id,bookId,purpose);
  const saveJson=async(path:string,json:string)=>{
   const data=utf8(json);
   if(data.length>limits.maxObjectBytes||data.length>metadataBytes)fail('LIMIT_EXCEEDED');
   await reserve(data.length+4096);await remember(path,data.length);
   const temp=(await this.files.createTemp('library-binary/spool')).path;
   try{
    const sha256=hash(data),chunkHashes:string[]=[];
    for(let at=0;at<data.length;at+=CHUNK_BYTES){
     this.work();
     const chunk=data.subarray(at,at+CHUNK_BYTES);chunkHashes.push(hash(chunk));
     const result=await this.files.appendBytes(temp,chunk,at);
     if(result.size!==at+chunk.length)fail('LOCAL_IO');
    }
    await this.files.durableCommit(temp,path,data.length,sha256);
    return {size:data.length,sha256,chunkHashes};
   }finally{await this.files.remove(temp).catch(()=>{});}
  };
  try{
   let after='';
   for(;;){
    const rows=await this.store.db.query('SELECT book_id,state_json FROM sync_books WHERE book_id>? ORDER BY book_id LIMIT 1',[after]);
    const r=rows[0];if(!r)break;
    const bookId=after=String(r.book_id);
    const json=String(r.state_json),state=strictJson(json,false,200000);
    validateBookShape(state);
    if(state.bookId!==bookId)fail('LOCAL_IO');
    const path=target(bookId,'state'),meta={bookId};
    const stateObject=bookObject('bookState',bookId,meta,[],await saveJson(path,json),limits);
    add(stateObject,{path,offset:0});
    if(!state.deleted&&send.has('bookPackageSegment')&&send.has('bookPackageCommit')){
     const pkg=await books.package(bookId);
     if(pkg){
      if(pkg.size<1||pkg.size>limits.maxPackageBytes||limits.maxObjectBytes<Math.min(BOOK_SEGMENT_BYTES,pkg.size))fail('LIMIT_EXCEEDED');
      const output=target(bookId,'package');
      await reserve(pkg.size+4096);await remember(output,pkg.size);
      const temp=(await this.files.createTemp('library-binary/spool')).path;
      try{
       const result=await this.files.copyRanges({ranges:[{path:pkg.path,offset:0,size:pkg.size}],size:pkg.size,sha256:pkg.sha256,target:temp,index:true,segmentBytes:BOOK_SEGMENT_BYTES});
       this.work();
       const count=Math.ceil(pkg.size/BOOK_SEGMENT_BYTES);
       if(result.size!==pkg.size||result.sha256!==pkg.sha256||result.segments.length!==count)fail('SOURCE_CHANGED');
       await this.files.durableCommit(temp,output,pkg.size,pkg.sha256);this.work();
       const key={bookId,fingerprint:state.fingerprint,packageSha256:pkg.sha256,packageBytes:pkg.size};
       const segmentObjectIds:string[]=[];
       result.segments.forEach((digest,segmentIndex)=>{
        const segmentOffset=segmentIndex*BOOK_SEGMENT_BYTES;
        const obj=bookObject('bookPackageSegment',[bookId,pkg.sha256,segmentIndex].join(':'),{...key,segmentIndex,segmentCount:count,segmentOffset},[stateObject.objectId],digest,limits);
        segmentObjectIds.push(obj.objectId);add(obj,{path:output,offset:segmentOffset});
       });
       add(bookObject('bookPackageCommit',bookId,{...key,segmentObjectIds},[stateObject.objectId,...segmentObjectIds],empty,limits));
      }finally{await this.files.remove(temp).catch(()=>{});}
     }
    }
    if(send.has('bookReading')){
     let last=0,pageIndex=0;
     for(;;){
      const read=await this.store.db.query('SELECT chapter_index,state_json FROM sync_book_reading WHERE book_id=? AND chapter_index>? AND chapter_index<=? ORDER BY chapter_index LIMIT 100',[bookId,last,state.chapterCount]);
      if(!read.length)break;
      last=Number(read.at(-1)!.chapter_index);
      const path=target(bookId,'reading:'+pageIndex);
      const json='['+read.map(r=>String(r.state_json)).join(',')+']';
      add(bookObject('bookReading',bookId+':'+pageIndex,{bookId,pageIndex},[stateObject.objectId],await saveJson(path,json),limits),{path,offset:0});
      pageIndex++;
     }
    }
    this.work();
   }
   if(await libraryRevision(this.store.db)!==revision)fail('SOURCE_CHANGED');
  }catch(e){
   for(const path of created){
    try{await this.files.remove(path);await this.store.db.execute('DELETE FROM library_binary_source_files WHERE path=?',[path]);}catch{/* The ledger retains uncollected files. */}
   }
   throw e;
  }
 }

 /** Segment retention and assembly overlap. A verified assembly replaces all
  * segments before import. The unused reserve covers in-flight native copies,
  * text fields, SQLite shadow and publication growth. */
 peak(objects:readonly ObjectDescriptor[],limits:Limits):number {
  validateBookPlan(objects,limits);
  let total=0,maxSegment=0;
  for(const d of objects){
   if(d.kind==='bookPackageSegment')maxSegment=Math.max(maxSegment,d.size);
   if(d.kind==='bookPackageCommit'){
    const m=bookDescription(d,limits);
    if(m.kind!=='bookPackageCommit')fail('PLAN_CONFLICT');
    const size=m.metadata.packageBytes;
    const rows=Math.min(BOOK_MAX_CHAPTERS,Math.ceil(size/64));
    total+=size*2+rows*4096+65536;
   }
  }
  return total+maxSegment*3;
 }

 async publish(job:Job,lease:ObjectLease,object:VerifiedObject,d:ObjectDescriptor){
  const path='library-binary/spool/'+stagingKey(job,d.objectId)+'.bin';
  await this.store.db.execute('INSERT OR IGNORE INTO library_binary_book_files VALUES(?,?,?,?,?,?,0)',[...jobKey(job),d.objectId,path,d.size,d.sha256]);
  return this.chunks.finalize(lease,object,path);
 }

 async apply(job:Job,d:ObjectDescriptor,path:string,boundary:ReceiptBoundary){
  const limits=job.description.selection.limits,book=bookDescription(d,limits),key=jobKey(job);
  const id=book.metadata.bookId;
  if(book.kind==='bookPackageSegment'){
   const expected='library-binary/spool/'+stagingKey(job,d.objectId)+'.bin';
   if(path!==expected)fail('OBJECT_CONFLICT');
   boundary.check?.();
   await this.store.db.transaction([...boundary.before,
    {sql:'UPDATE library_binary_book_files SET ready=1 WHERE scope=? AND job_id=? AND object_id=? AND path=?',params:[...key,d.objectId,path]},
    ...boundary.after('merged')]);
   return;
  }
  const repo=await this.repo();
  if(book.kind==='bookState'){
   const state=strictJson(await this.payload(d,path),false,200000);
   validateBookShape(state);
   if(state.bookId!==id)fail('BUSINESS_REJECTED');
   await repo.mergeBinaryState(state,boundary,{
    sql:'INSERT INTO library_binary_book_states VALUES(?,?,?,?)',params:[...key,id,JSON.stringify(state)],
   });
   return;
  }
  if(book.kind==='bookReading'){
   const value=strictJson('{"items":'+await this.payload(d,path)+'}',false,200000).items;
   if(!Array.isArray(value)||!value.length||value.length>100)fail('BUSINESS_REJECTED');
   const reading:BookReading[]=[];
   for(const item of value){
    validateBookReading(item);
    if(item.bookId!==id||reading.length&&reading.at(-1)!.chapterIndex>=item.chapterIndex)fail('BUSINESS_REJECTED');
    reading.push(item);
   }
   const first=reading[0]!.chapterIndex,last=reading.at(-1)!.chapterIndex,page=book.metadata.pageIndex;
   // Interval ordering detects duplicates in either apply order. The unique
   // chapter index is authoritative if two pages are retried concurrently.
   const conflict=(await this.store.db.query(`SELECT 1 FROM library_binary_book_pages WHERE scope=? AND job_id=? AND book_id=?
    AND ((page<? AND last_chapter>=?) OR (page>? AND first_chapter<=?)) LIMIT 1`,[...key,id,page,first,page,last])).length;
   if(conflict)fail('BUSINESS_REJECTED');
   await repo.mergeReadingBatch(reading,{capture:false,boundary,guards:[
    {sql:'INSERT INTO library_binary_book_pages VALUES(?,?,?,?,?,?)',params:[...key,id,page,first,last]},
    ...reading.map(r=>({sql:'INSERT INTO library_binary_book_chapters VALUES(?,?,?,?)',params:[...key,id,r.chapterIndex]})),
   ]});
   return;
  }
  const m=book.metadata;
  const staged=(await this.store.db.query('SELECT state_json FROM library_binary_book_states WHERE scope=? AND job_id=? AND book_id=?',[...key,id]))[0];
  if(!staged)fail('JOURNAL_CORRUPT');
  const state=JSON.parse(String(staged.state_json)) as BookState;
  if(state.fingerprint!==m.fingerprint||state.deleted)fail('BUSINESS_REJECTED');
  const stagedKey=stagingKey(job,d.objectId),combined='books/part-b2-'+stagedKey+'.bin',published='books/'+id+'-'+m.packageSha256+'.jsonl';
  const info={path:combined,size:m.packageBytes,sha256:m.packageSha256};
  const old=(await this.store.db.query('SELECT ready FROM library_binary_book_files WHERE scope=? AND job_id=? AND object_id=?',[...key,d.objectId]))[0];
  if(Number(old?.ready)===1){
   if(!(await this.files.stat(combined)).file)info.path=published;
   await this.verify(info);
  }else{
   const ranges=[];
   for(const oid of m.segmentObjectIds){
    const part=(await this.store.db.query('SELECT path,size FROM library_binary_book_files WHERE scope=? AND job_id=? AND object_id=? AND ready=1',[...key,oid]))[0];
    if(!part||part.path!=='library-binary/spool/'+stagingKey(job,oid)+'.bin')fail('JOURNAL_CORRUPT');
    ranges.push({path:String(part.path),size:Number(part.size),offset:0});
   }
   await this.store.db.execute('INSERT OR IGNORE INTO library_binary_book_files VALUES(?,?,?,?,?,?,0)',[...key,d.objectId,combined,info.size,info.sha256]);
   const temp=(await this.files.createTemp('books')).path;
   try{
    const assembled=await this.files.copyRanges({ranges,target:temp,size:info.size,sha256:info.sha256});
    if(assembled.size!==info.size||assembled.sha256!==info.sha256)fail('HASH_MISMATCH');
    await this.files.durableCommit(temp,combined,info.size,info.sha256);
    boundary.check?.();
    await this.store.db.transaction([...boundary.before,
     {sql:'UPDATE library_binary_book_files SET ready=1 WHERE scope=? AND job_id=? AND object_id=?',params:[...key,d.objectId]}]);
   }finally{await this.files.remove(temp).catch(()=>{});}
  }
  // The durable, whole-object-verified assembly is now the recovery source.
  for(const oid of m.segmentObjectIds)await this.removeArtifact(job,oid);
  try{
   await repo.installBinaryPackage(info,state,stagedKey,visit=>importBookPackage(this.files,info,state,visit,this.work),
    async()=>{
     if(info.path!==published)await this.files.durableCommit(info.path,published,info.size,info.sha256);
     return {...info,path:published};
    },boundary);
  }finally{
   // The row and file are kept for retry after a failed apply.
   if((await this.store.object(job,d.objectId)).receipt)await this.removeArtifact(job,d.objectId).catch(()=>{});
  }
 }
 private async payload(d:ObjectDescriptor,path:string):Promise<string>{
  if(d.size>metadataBytes)fail('LIMIT_EXCEEDED');
  const reader=(await this.files.openText(path,{strictUtf8:true})).id;
  let text='';
  try{
   for(;;){
    const chunk=await this.files.readTextChunk(reader,16384);this.work();
    if(chunk.invalidUtf8||text.length+chunk.text.length>metadataBytes||!chunk.text&&!chunk.eof)fail('BUSINESS_REJECTED');
    text+=chunk.text;
    if(chunk.eof)return text;
   }
  }finally{await this.files.closeText(reader).catch(()=>{});}
 }
 private async verify(file:BookFileInfo){
  const actual=await this.files.hash(file.path);this.work();
  if(actual.size!==file.size||actual.sha256!==file.sha256)fail('HASH_MISMATCH');
 }
 private async removeArtifact(job:Job,oid:string){
  const key=jobKey(job),row=(await this.store.db.query('SELECT path FROM library_binary_book_files WHERE scope=? AND job_id=? AND object_id=?',[...key,oid]))[0];
  if(!row)return;
  const name=stagingKey(job,oid);
  if(row.path!=='library-binary/spool/'+name+'.bin'&&row.path!=='books/part-b2-'+name+'.bin')fail('JOURNAL_CORRUPT');
  await this.files.remove(String(row.path));
  await this.store.db.execute('DELETE FROM library_binary_book_files WHERE scope=? AND job_id=? AND object_id=?',[...key,oid]);
 }
 async collect(job:Job,purge=true){
  const key=jobKey(job);
  const rows=await this.store.db.query('SELECT object_id FROM library_binary_book_files WHERE scope=? AND job_id=?',[...key]);
  for(const row of rows){
   const id=String(row.object_id),object=await this.store.object(job,id);
   if(!purge&&!object.receipt)continue;
   await this.removeArtifact(job,id);
   if(object.descriptor.kind==='bookPackageCommit'){
    const m=bookDescription(object.descriptor,job.description.selection.limits);
    await this.store.db.execute('DELETE FROM sync_book_stage WHERE book_id=? AND package_sha256=?',[m.metadata.bookId,stagingKey(job,id)]);
   }
  }
  if(purge)await this.store.db.transaction(['library_binary_book_states','library_binary_book_pages','library_binary_book_chapters'].map(table=>({
   sql:'DELETE FROM '+table+' WHERE scope=? AND job_id=?',params:key,
  })));
 }
}
