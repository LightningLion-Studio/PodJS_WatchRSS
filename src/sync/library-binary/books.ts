import type {ObjectLease,VerifiedChunkStore,VerifiedObject} from '@podjs/framework/verified-chunk-store';
import type {SqlBookStore} from '../../books/store';
import type {BookFileInfo} from '../../books/files';
import {ContentSha256} from '@podjs/framework/content-sha256';

import {BOOK_MAX_CHAPTERS,validateBook,validateBookReading,validateBookShape,type BookReading,type BookState} from '../../books/protocol';
import {libraryRevision} from '../revision';
import {D} from './digests';
import {bookDescription,bookObject,BOOK_SEGMENT_BYTES,validateBookPlan} from './book-plan';
import {bookPackageProof,sameBookPackage,type BookPackageProof} from './book-state';
import {BodyJsonReader} from './article-file';
import {BOOK_METADATA_BODY_BYTES,BOOK_METADATA_STRING_BYTES,BookMetadataRejected,bookSqlText,pagedBookBoundary} from './book-metadata';
import {importBookPackage,type BinaryBookFiles} from './book-import';
import type {BinaryStore,Job,ReceiptBoundary} from './store';
import type {BoundLocalTransferIntake} from '../../sync-v2/local-transfer-intake';
import type {SourceRecord} from '../../sync-v2/store';
import {CHUNK_BYTES,HARD_LIMITS,fail,hash,utf8,type Kind,type Limits,type ObjectDescriptor} from './wire';

export interface FrozenBookFile {path:string;offset:number}
const sourcePath=(scope:string,id:string,bookId:string,purpose:string)=>'library-binary/spool/'+D('wrss.library-binary.v2/book-source',[scope,id,bookId,purpose])+'.bin';
const empty={size:0,sha256:hash(new Uint8Array()),chunkHashes:[]};
const jobKey=(job:Job)=>[job.scope,job.jobId];
const stagingKey=(job:Job,id:string)=>D('wrss.library-binary.v2/book-shadow',[job.scope,job.jobId,id]);
const finalPath=(bookId:string,sha256:string)=>'books/'+bookId+'-'+sha256+'.jsonl';

export class BinaryBooks {
 constructor(private readonly store:BinaryStore,private readonly books:()=>Promise<SqlBookStore|undefined>,
  private readonly files:BinaryBookFiles,private readonly chunks:VerifiedChunkStore,private readonly work:()=>void,
  private readonly excluded:(kind:'bookState'|'bookReading',limit:BookMetadataRejected['limit'])=>void=()=>{},
  private readonly intake?:BoundLocalTransferIntake,
  private readonly witness?:(state:BookState)=>Promise<{size:number;sha256:string}|undefined>){}

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
  reserve:(bytes:number)=>Promise<void>,peerPackages?:ReadonlyMap<string,BookPackageProof>){
  if(!send.has('bookState'))return;
  const books=await this.repo();
  if(!await books.binaryReady())fail('SOURCE_CHANGED');
  await books.capture();await books.captureReading();
  const revision=await libraryRevision(this.store.db);
  const created=new Set<string>();
  const remember=async(path:string,size:number)=>{
   await this.store.budget(1024,limits.maxJournalBytes);
   await this.store.db.execute('INSERT INTO library_binary_source_files VALUES(?,?,?)',[path,size+4096,this.store.now()+86400000]);
   created.add(path);
  };
  const target=(bookId:string,purpose:string)=>sourcePath(scope,id,bookId,purpose);
  const saveJson=async(path:string,size:number,pieces:AsyncIterable<string>)=>{
   if(size<1||size>limits.maxObjectBytes)fail('LIMIT_EXCEEDED');
   await reserve(size+4096);await remember(path,size);
   const temp=(await this.files.createTemp('library-binary/spool')).path;
   try{
    const digest=new ContentSha256(),chunkHashes:string[]=[],block=new Uint8Array(CHUNK_BYTES);
    let offset=0,length=0;
    const append=async()=>{
     this.work();
     const chunk=block.subarray(0,length);digest.update(chunk);chunkHashes.push(hash(chunk));
     const result=await this.files.appendBytes(temp,chunk,offset);
     offset+=length;length=0;
     if(result.size!==offset)fail('LOCAL_IO');
    };
    for await(const piece of pieces){
     const data=utf8(piece);
     if(offset+length+data.length>size)fail('SOURCE_CHANGED');
     for(let at=0;at<data.length;){
      const take=Math.min(CHUNK_BYTES-length,data.length-at);
      block.set(data.subarray(at,at+take),length);length+=take;at+=take;
      if(length===CHUNK_BYTES)await append();
     }
    }
    if(length)await append();
    if(offset!==size)fail('SOURCE_CHANGED');
    const sha256=digest.finish();
    await this.files.durableCommit(temp,path,size,sha256);
    return {size,sha256,chunkHashes};
   }finally{await this.files.remove(temp).catch(()=>{});}
  };
  const checkLocal=async(kind:'bookState'|'bookReading',bytes:number,pieces:()=>AsyncIterable<string>)=>{
   if(bytes>BOOK_METADATA_BODY_BYTES){this.excluded(kind,'body');return false;}
   const reader=pieces()[Symbol.asyncIterator]();
   try{
    await this.metadataDocument(async()=>{
     const next=await reader.next();this.work();
     return {text:next.done?'':next.value,eof:!!next.done,invalidUtf8:false};
    });
    return true;
   }catch(error){
    if(!(error instanceof BookMetadataRejected))throw error;
    this.excluded(kind,error.limit);return false;
   }finally{await reader.return?.();}
  };
  try{
   let after='';
   for(;;){
    const [state]=await this.store.db.query(`SELECT book_id,chapter_count,fingerprint,json_extract(state_json,'$.lifecycle') AS lifecycle,json_extract(state_json,'$.deleted') AS deleted,
     length(state_json) AS chars,length(CAST(state_json AS BLOB)) AS bytes FROM sync_books WHERE book_id>? ORDER BY book_id LIMIT 1`,[after]);
    if(!state)break;
    const bookId=after=String(state.book_id),path=target(bookId,'state'),meta={bookId};
    const pieces=()=>bookSqlText(this.store.db,'SELECT state_json AS value FROM sync_books WHERE book_id=?',[bookId],Number(state.chars));
    if(!await checkLocal('bookState',Number(state.bytes),pieces))continue;
    const stateObject=bookObject('bookState',bookId,meta,[],await saveJson(path,Number(state.bytes),pieces()),limits);
    add(stateObject,{path,offset:0});
    if(!state.deleted&&send.has('bookPackageSegment')&&send.has('bookPackageCommit')){
     const pkg=await books.package(bookId);
     const local=pkg&&bookPackageProof({bookId,fingerprint:String(state.fingerprint),chapterCount:Number(state.chapter_count),
      lifecycle:state.lifecycle==null?undefined:JSON.parse(String(state.lifecycle))},pkg);
     if(pkg&&local&&!sameBookPackage(local,peerPackages?.get(bookId))){
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
      const rows=await this.store.db.query(`SELECT chapter_index,length(state_json) AS chars,length(CAST(state_json AS BLOB)) AS bytes
       FROM sync_book_reading WHERE book_id=? AND chapter_index>? AND chapter_index<=? ORDER BY chapter_index LIMIT 100`,[bookId,last,state.chapter_count]);
      if(!rows.length)break;
      const read:typeof rows=[];
      const readingLimit=Math.min(BOOK_METADATA_BODY_BYTES,limits.maxObjectBytes),db=this.store.db;
      const rowPieces=(row:typeof rows[number])=>bookSqlText(db,'SELECT state_json AS value FROM sync_book_reading WHERE book_id=? AND chapter_index=?',
       [bookId,row.chapter_index],Number(row.chars));
      let size=2;
      for(const row of rows){
       const bytes=Number(row.bytes),separator=read.length?1:0;
       if(bytes+2>readingLimit){last=Number(row.chapter_index);this.excluded('bookReading','body');continue;}
       if(size+bytes+separator>readingLimit)break;
       last=Number(row.chapter_index);
       if(!await checkLocal('bookReading',bytes,()=>rowPieces(row)))continue;
       size+=bytes+separator;read.push(row);
      }
      if(!read.length)continue;
      const path=target(bookId,'reading:'+pageIndex);
      const pieces=async function*(){
       yield '[';
       for(const [index,row] of read.entries()){
        if(index)yield ',';
        yield*rowPieces(row);
       }
       yield ']';
      };
      add(bookObject('bookReading',bookId+':'+pageIndex,{bookId,pageIndex},[stateObject.objectId],await saveJson(path,size,pieces()),limits),{path,offset:0});
      pageIndex++;
     }
    }
    this.work();
   }
   if(!await books.binaryReady())fail('SOURCE_CHANGED');
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
   if(d.size>limits.maxObjectBytes)fail('LIMIT_EXCEEDED');
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

 async verifyReceipt(job:Job,d:ObjectDescriptor,outcome:string,objects:readonly {descriptor:ObjectDescriptor;receipt:unknown}[]){
  if(d.kind==='bookPackageCommit'&&outcome!=='retainedLocal'){
   const book=bookDescription(d,job.description.selection.limits);
   if(book.kind!=='bookPackageCommit')fail('JOURNAL_CORRUPT');
   const repo=await this.repo(),state=await repo.transferState(book.metadata.bookId);
   const installed=state&&await repo.package(state.bookId);
   if(!state||state.deleted||state.fingerprint!==book.metadata.fingerprint||!installed||
    installed.sha256!==book.metadata.packageSha256||installed.size!==book.metadata.packageBytes)fail('RECEIPT_CONFLICT');
   const proof=await (this.witness?this.witness(state):this.files.hash(installed.path)).catch(()=>undefined);
   if(!proof||proof.size!==installed.size||proof.sha256!==installed.sha256)fail('RECEIPT_CONFLICT');
  }
  if(d.kind==='bookPackageSegment'){
   const assembly=objects.find(o=>o.descriptor.kind==='bookPackageCommit'&&o.descriptor.dependsOn.includes(d.objectId));
   if(assembly?.receipt)return;
   const rows=await this.store.db.query('SELECT path,size,ready FROM library_binary_book_files WHERE scope=? AND job_id=? AND object_id IN (?,?)',
    [...jobKey(job),d.objectId,assembly?.descriptor.objectId??d.objectId]);
   for(const row of rows)if(Number(row.ready)===1){
    const actual=await this.files.stat(String(row.path));
    if(actual.file&&actual.size===Number(row.size))return;
   }
   fail('RECEIPT_CONFLICT');
  }
 }
 async publish(job:Job,lease:ObjectLease,object:VerifiedObject,d:ObjectDescriptor){
  const path='library-binary/spool/'+stagingKey(job,d.objectId)+'.bin';
  await this.store.db.execute('INSERT OR IGNORE INTO library_binary_book_files VALUES(?,?,?,?,?,?,0)',[...jobKey(job),d.objectId,path,d.size,d.sha256]);
  return this.chunks.finalize(lease,object,path);
 }

 async apply(job:Job,d:ObjectDescriptor,path:string,boundary:ReceiptBoundary){
  const limits=job.description.selection.limits,book=bookDescription(d,limits),key=jobKey(job);
  const id=book.metadata.bookId;
  if(d.size>limits.maxObjectBytes)fail('LIMIT_EXCEEDED');
  if(book.kind==='bookPackageSegment'){
   const expected='library-binary/spool/'+stagingKey(job,d.objectId)+'.bin';
   if(path!==expected)fail('OBJECT_CONFLICT');
   boundary.check?.();
   await (boundary.transaction??(statements=>this.store.db.transaction(statements)))([...boundary.before,
    {sql:'UPDATE library_binary_book_files SET ready=1 WHERE scope=? AND job_id=? AND object_id=? AND path=?',params:[...key,d.objectId,path]},
    ...boundary.after('merged')]);
   return;
  }
  const repo=await this.repo();
  if(book.kind==='bookState'){
   const state=await this.payload(d,path);
   validateBookShape(state);
   if(state.bookId!==id)fail('BUSINESS_REJECTED');
   const incoming=this.intake?await validateBook(state,repo.ports.sha256):state;
   await this.write(job,d,boundary,[{kind:'book',logicalId:id,value:incoming}],async()=>{
    await repo.capture();
    const {bookId,fingerprint,chapterCount,instanceId,deleted,lifecycle}=state;
    await repo.mergeBinaryState(state,pagedBookBoundary(this.store.db,[...key,d.objectId],boundary),{
     sql:'INSERT INTO library_binary_book_states VALUES(?,?,?,?)',params:[...key,id,JSON.stringify({bookId,fingerprint,chapterCount,instanceId,deleted,lifecycle})],
    });
   });
   return;
  }
  if(book.kind==='bookReading'){
   const value=await this.payload(d,path);
   if(!Array.isArray(value)||!value.length||value.length>100)fail('BUSINESS_REJECTED');
   const reading:BookReading[]=[];
   for(const item of value){
    validateBookReading(item);
    if(item.bookId!==id||reading.length&&reading.at(-1)!.chapterIndex>=item.chapterIndex)fail('BUSINESS_REJECTED');
    reading.push(item);
   }
   await this.write(job,d,boundary,reading.map(value=>({kind:'book-reading',logicalId:id+':'+value.chapterIndex,value})),async()=>{
    await repo.captureReading();
    const first=reading[0]!.chapterIndex,last=reading.at(-1)!.chapterIndex,page=book.metadata.pageIndex;
    // Interval ordering detects duplicates in either apply order. The unique
    // chapter index is authoritative if two pages are retried concurrently.
    const conflict=(await this.store.db.query(`SELECT 1 FROM library_binary_book_pages WHERE scope=? AND job_id=? AND book_id=?
     AND ((page<? AND last_chapter>=?) OR (page>? AND first_chapter<=?)) LIMIT 1`,[...key,id,page,first,page,last])).length;
    if(conflict)fail('BUSINESS_REJECTED');
    await repo.mergeReadingBatch(reading,{capture:false,boundary:pagedBookBoundary(this.store.db,[...key,d.objectId],boundary),guards:[
     {sql:'INSERT INTO library_binary_book_pages VALUES(?,?,?,?,?,?)',params:[...key,id,page,first,last]},
     ...reading.map(r=>({sql:'INSERT INTO library_binary_book_chapters VALUES(?,?,?,?)',params:[...key,id,r.chapterIndex]})),
    ]});
   });
   return;
  }
  const m=book.metadata;
  const [staged]=await this.store.db.query(`SELECT json_extract(state_json,'$.bookId') AS bookId,
   json_extract(state_json,'$.fingerprint') AS fingerprint,json_extract(state_json,'$.chapterCount') AS chapterCount,
   json_extract(state_json,'$.instanceId') AS instanceId,json_extract(state_json,'$.deleted') AS deleted,
   json_extract(state_json,'$.lifecycle') AS lifecycle FROM library_binary_book_states WHERE scope=? AND job_id=? AND book_id=?`,[...key,id]);
  if(!staged)fail('JOURNAL_CORRUPT');
  const state:Pick<BookState,'bookId'|'fingerprint'|'chapterCount'|'deleted'|'instanceId'|'lifecycle'>={
   bookId:String(staged.bookId),fingerprint:String(staged.fingerprint),chapterCount:Number(staged.chapterCount),deleted:!!staged.deleted,
   instanceId:staged.instanceId===null?undefined:String(staged.instanceId),lifecycle:staged.lifecycle===null?undefined:JSON.parse(String(staged.lifecycle)),
  };
  if(state.fingerprint!==m.fingerprint||state.deleted)fail('BUSINESS_REJECTED');
  const stagedKey=stagingKey(job,d.objectId),combined='books/part-b2-'+stagedKey+'.bin',published=finalPath(id,m.packageSha256);
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
    await (boundary.transaction??(statements=>this.store.db.transaction(statements)))([...boundary.before,
     {sql:'UPDATE library_binary_book_files SET ready=1 WHERE scope=? AND job_id=? AND object_id=?',params:[...key,d.objectId]}]);
   }finally{await this.files.remove(temp).catch(()=>{});}
  }
  // The durable, whole-object-verified assembly is now the recovery source.
  for(const oid of m.segmentObjectIds)await this.removeArtifact(job,oid);
  try{
   const install=()=>repo.installBinaryPackage(info,state,stagedKey,visit=>importBookPackage(this.files,info,state,visit,this.work),
    async()=>{
     boundary.check?.();
     await (boundary.transaction??(statements=>this.store.db.transaction(statements)))([...boundary.before,
      {sql:'INSERT OR IGNORE INTO library_binary_book_publications VALUES(?,?,?,?,?)',params:[...key,d.objectId,published,info.size]}]);
     boundary.check?.();
     if(info.path!==published)await this.files.durableCommit(info.path,published,info.size,info.sha256);
     return {...info,path:published};
    },pagedBookBoundary(this.store.db,[...key,d.objectId],boundary));
   if(this.intake){
    const full=await repo.transferState(id);
    if(!full)fail('BUSINESS_REJECTED');
    await this.write(job,d,boundary,[{kind:'book',logicalId:id,value:full}],install,info);
   }else await install();
  }finally{
   // The row and file are kept for retry after a failed apply.
   if((await this.store.object(job,d.objectId)).receipt)await this.removeArtifact(job,d.objectId,published).catch(()=>{});
  }
 }
 private write(job:Job,d:ObjectDescriptor,boundary:ReceiptBoundary,records:SourceRecord[],apply:()=>Promise<void>,file?:BookFileInfo){
  if(!this.intake)return apply();
  return this.intake(async check=>{
   const body=file?{size:file.size,sha256:file.sha256,read:async(offset:number,length:number)=>{this.work();return (await this.files.readBytes(file.path,offset,length)).bytes;}}:undefined;
   await check({records,body,version:2,peer:job.description.phoneDeviceId,cursor:job.jobId+':'+d.objectId,check:boundary.check});
   boundary.check?.();
   return apply();
  });
 }
 private async payload(d:ObjectDescriptor,path:string):Promise<unknown>{
  // Finalize has already verified the raw size and SHA-256 against the manifest.
  if(d.size>BOOK_METADATA_BODY_BYTES)throw new BookMetadataRejected('body');
  const reader=(await this.files.openText(path,{strictUtf8:true})).id;
  try{
   return await this.metadataDocument(async()=>{this.work();return this.files.readTextChunk(reader,16384);});
  }finally{await this.files.closeText(reader).catch(()=>{});}
 }
 private metadataDocument(read:ConstructorParameters<typeof BodyJsonReader>[0]){
  return new BodyJsonReader(read,false,true).document(bytes=>{
   if(bytes>BOOK_METADATA_STRING_BYTES)throw new BookMetadataRejected('string');
  });
 }
 private async verify(file:BookFileInfo){
  const actual=await this.files.hash(file.path);this.work();
  if(actual.size!==file.size||actual.sha256!==file.sha256)fail('HASH_MISMATCH');
 }
 private async removeArtifact(job:Job,oid:string,published?:string){
  const key=jobKey(job),row=(await this.store.db.query('SELECT path,ready FROM library_binary_book_files WHERE scope=? AND job_id=? AND object_id=?',[...key,oid]))[0];
  if(!row)return;
  const name=stagingKey(job,oid);
  if(row.path!=='library-binary/spool/'+name+'.bin'&&row.path!=='books/part-b2-'+name+'.bin')fail('JOURNAL_CORRUPT');
  if(published){
   const final=(await this.store.db.query('SELECT path FROM library_binary_book_publications WHERE scope=? AND job_id=? AND object_id=?',[...key,oid]))[0];
   if(final&&final.path!==published)fail('JOURNAL_CORRUPT');
   // Before the publication journal existed, an absent ready assembly was
   // recovered at its deterministic final path.
   if(final||Number(row.ready)===1&&!(await this.files.stat(String(row.path))).file){
    const references=await this.store.db.query(`SELECT 1 FROM sync_books WHERE package_path=?
     UNION ALL SELECT 1 FROM library_binary_book_publications WHERE path=? AND NOT(scope=? AND job_id=? AND object_id=?) LIMIT 1`,
     [published,published,...key,oid]);
    if(!references.length)await this.files.durableRemove(published);
   }
  }
  await this.files.durableRemove(String(row.path));
  await this.store.db.transaction(['library_binary_book_files','library_binary_book_publications'].map(table=>({
   sql:'DELETE FROM '+table+' WHERE scope=? AND job_id=? AND object_id=?',params:[...key,oid],
  })));
 }
 async collect(job:Job,purge=true){
  const key=jobKey(job);
  const rows=await this.store.db.query('SELECT object_id FROM library_binary_book_files WHERE scope=? AND job_id=?',[...key]);
  for(const row of rows){
   const id=String(row.object_id),object=await this.store.object(job,id);
   if(!purge&&!object.receipt)continue;
   if(object.descriptor.kind==='bookPackageCommit'){
    const m=bookDescription(object.descriptor,job.description.selection.limits);
    if(m.kind!=='bookPackageCommit')fail('JOURNAL_CORRUPT');
    await this.store.db.execute('DELETE FROM sync_book_stage WHERE book_id=? AND package_sha256=?',[m.metadata.bookId,stagingKey(job,id)]);
    await this.removeArtifact(job,id,finalPath(m.metadata.bookId,m.metadata.packageSha256));
   }else await this.removeArtifact(job,id);
  }
  if(purge)await this.store.db.transaction(['library_binary_book_states','library_binary_book_pages','library_binary_book_chapters','library_binary_book_text'].map(table=>({
   sql:'DELETE FROM '+table+' WHERE scope=? AND job_id=?',params:key,
  })));
 }
}
