import {BOOK_PART_RECEIPT_SCHEMA} from './schema';
import {BookReadingDelta,type AfterReadingAck} from './reading-delta';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {querySyncPages} from '../sync/sql-pages';
import type {SqlDatabase} from '../core/types';
import type {JsonObject} from '../sync/protocol';
import {SqlBookStore} from './store';
import {validateBook,validateBookReading,BOOK_CHUNK_SIZE,BOOK_MAX_PACKAGE_BYTES,type BookReading,type BookState} from './protocol';
import type {BookFileInfo} from './files';
import type {LocalTransferWrite} from '../sync-v2/local-transfer-intake';
import type {SourceRecord} from '../sync-v2/store';
import {canonicalLegacy,digest} from '../sync-v2/protocol';
const hex=/^[a-f0-9]{64}$/;
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const requireThat=(ok:unknown)=>{if(!ok)throw Error('book_request_invalid');};
export class BookSyncActions {
 private readonly fallback={};private pages=new WeakMap<object,BookReading[]>();
 private delta:BookReadingDelta;
 private partsReady?:Promise<void>;
 constructor(private db:SqlDatabase,private store:SqlBookStore){this.delta=new BookReadingDelta(db,store);}
 async apply(request:JsonObject,session:object=this.fallback,afterAck?:AfterReadingAck,check?:LocalTransferWrite,cancel?:()=>void,readingFence?:string):Promise<JsonObject>{
  requireThat(request.version===1&&typeof request.deviceId==='string'&&request.deviceId.length>0&&request.deviceId.length<=512);
  const base={success:true,action:'syncBooks',version:1,phase:request.phase};
  const protect=async(records:SourceRecord[],file?:BookFileInfo)=>{
   cancel?.();if(!check||!records.length)return;
   const body=file?{size:file.size,sha256:file.sha256,read:async(offset:number,length:number)=>(await this.store.ports.files.read(file.path,offset,length)).bytes}:undefined;
   await check({version:14,peer:String(request.deviceId),cursor:digest(['syncBooks',request.phase,canonicalLegacy(records),file?.sha256??null]),records,body,check:cancel});
   cancel?.();
  };
  const protectReading=(reading:readonly BookReading[])=>protect(reading.map(value=>({kind:'book-reading',logicalId:value.bookId+':'+value.chapterIndex,value})));
  if(['readingSummary','readingDelta','readingCommit'].includes(String(request.phase)))return this.delta.apply(request,session,afterAck,protectReading,cancel,readingFence);
  if(request.phase==='manifest'){
   requireThat(Array.isArray(request.books)&&request.books.length<=100000);const incoming:BookState[]=[];const ids=new Set<string>();for(const raw of request.books as unknown[]){const value=await validateBook(raw,this.store.ports.sha256);requireThat(!ids.has(value.bookId)&&typeof (raw as JsonObject).contentAvailable==='boolean');ids.add(value.bookId);incoming.push(value);}
   await protect(incoming.map(value=>({kind:'book',logicalId:value.bookId,value})));
   this.pages.delete(session);await this.store.registerLocal(incoming,cancel);let applied=0;for(const s of incoming)applied+=await this.store.merge(s,cancel);const books=await this.store.manifests(),missingBookIds:string[]=[];for(let i=0;i<incoming.length;i++){const s=incoming[i]!;if(!s.deleted&&(request.books as JsonObject[])[i]!.contentAvailable===true&&!await this.store.package(s.bookId))missingBookIds.push(s.bookId);}
   return {...base,deviceId:await this.store.ports.deviceId(),books,missingBookIds,applied};
  }
  if(request.phase==='reading'){
   requireThat(Array.isArray(request.states)&&request.states.length<=100&&integer(request.after));for(const state of request.states as unknown[])validateBookReading(state);await protectReading(request.states as BookReading[]);let snapshot=this.pages.get(session);if(!snapshot)await this.store.captureReading();const applied=await this.store.mergeReadingBatch(request.states as BookReading[],{check:cancel});if(!snapshot){snapshot=await this.store.readingStates(false);this.pages.set(session,snapshot);}const after=request.after as number;requireThat(after<=snapshot.length);const states=snapshot.slice(after,after+100),nextAfter=after+states.length;return {...base,states,nextAfter,hasMore:nextAfter<snapshot.length,applied};
  }
  const id=request.bookId;requireThat(typeof id==='string'&&hex.test(id));
  if(request.phase==='pull'){
   const info=await this.store.package(id as string);requireThat(info&&integer(request.chunkIndex,0,Math.ceil(info!.size/BOOK_CHUNK_SIZE)-1));const index=request.chunkIndex as number;const state=(await this.db.query("SELECT fingerprint,json_extract(state_json,'$.deleted') AS deleted FROM sync_books WHERE book_id=?",[id as string]))[0];requireThat(state&&!state.deleted);
   if(index===0){const actual=await this.store.ports.files.hash(info!.path);requireThat(actual.size===info!.size&&actual.sha256===info!.sha256);}const part=await this.store.ports.files.read(info!.path,index*BOOK_CHUNK_SIZE,Math.min(BOOK_CHUNK_SIZE,info!.size-index*BOOK_CHUNK_SIZE));requireThat(part.size===info!.size&&part.bytes.length===Math.min(BOOK_CHUNK_SIZE,info!.size-index*BOOK_CHUNK_SIZE));return {...base,phase:'body',bookId:id,fingerprint:state!.fingerprint,packageSha256:info!.sha256,byteCount:info!.size,chunkIndex:index,chunkCount:Math.ceil(info!.size/BOOK_CHUNK_SIZE),dataBase64:bytesToBase64(part.bytes)};
  }
  requireThat(request.phase==='body'&&typeof request.packageSha256==='string'&&hex.test(request.packageSha256)&&typeof request.fingerprint==='string'&&hex.test(request.fingerprint)&&integer(request.byteCount,1,BOOK_MAX_PACKAGE_BYTES)&&integer(request.chunkCount,1)&&request.chunkCount===Math.ceil(Number(request.byteCount)/BOOK_CHUNK_SIZE)&&integer(request.chunkIndex,0,Number(request.chunkCount)-1)&&typeof request.dataBase64==='string'&&request.dataBase64.length<=87384);
  const row=(await this.db.query('SELECT fingerprint FROM sync_books WHERE book_id=?',[id as string]))[0];requireThat(row?.fingerprint===request.fingerprint);const data=base64ToBytes(request.dataBase64 as string),expected=Math.min(BOOK_CHUNK_SIZE,Number(request.byteCount)-Number(request.chunkIndex)*BOOK_CHUNK_SIZE);requireThat(data.length===expected&&bytesToBase64(data)===request.dataBase64);
  const key=[id as string,request.packageSha256 as string] as const,index=Number(request.chunkIndex);
  const protectPackage=async(file:BookFileInfo)=>{
   if(!check)return;
   const state=await this.store.transferState(key[0]);
   requireThat(state&&!state.deleted&&state.fingerprint===request.fingerprint);
   await protect([{kind:'book',logicalId:key[0],value:state!}],file);
  };
  const committed=await this.store.package(key[0]);
  if(committed&&committed.sha256===key[1]&&committed.size===request.byteCount){
   const old=await this.store.ports.files.read(committed.path,index*BOOK_CHUNK_SIZE,expected);
   requireThat(old.bytes.length===data.length&&old.bytes.every((v,i)=>v===data[i]));
   await protectPackage(committed);
   const parts=await querySyncPages(this.db,'SELECT path FROM sync_book_parts WHERE book_id=? AND package_sha256=? ORDER BY chunk_index',key);
   await this.discard(key,parts,true);
   return {...base,received:true,complete:true,applied:0};
  }
  await this.preparePartReceipts();
  const matches=(part:Record<string,unknown>)=>part.fingerprint===request.fingerprint&&Number(part.byte_count)===request.byteCount&&Number(part.chunk_count)===request.chunkCount;
  const staged=(await this.db.query(`SELECT r.fingerprint,r.byte_count,r.chunk_count,r.received,p.path
   FROM sync_book_part_receipts r LEFT JOIN sync_book_parts p
   ON p.book_id=r.book_id AND p.package_sha256=r.package_sha256 AND p.chunk_index=?
   WHERE r.book_id=? AND r.package_sha256=?`,[index,...key]))[0];
  if(staged)requireThat(matches(staged));
  let received=Number(staged?.received??0);
  if(staged?.path!=null){
   const old=await this.store.ports.files.read(String(staged.path),0,BOOK_CHUNK_SIZE);
   requireThat(old.bytes.length===data.length&&old.bytes.every((v,i)=>v===data[i]));
  }else{
   const part=await this.store.ports.files.writeBytes(data);
   try{
    cancel?.();await this.db.transaction([{sql:'INSERT INTO sync_book_parts(book_id,package_sha256,fingerprint,byte_count,chunk_count,chunk_index,path) VALUES(?,?,?,?,?,?,?)',
     params:[...key,request.fingerprint,request.byteCount,request.chunkCount,index,part.path]}]);
   }catch(error){await this.store.ports.files.remove(part.path);throw error;}
   received=Number((await this.db.query('SELECT received FROM sync_book_part_receipts WHERE book_id=? AND package_sha256=?',key))[0]?.received);
  }
  requireThat(integer(received,1,Number(request.chunkCount)));
  if(received!==request.chunkCount)return {...base,received:true,complete:false,applied:0};
  const parts=await querySyncPages(this.db,'SELECT * FROM sync_book_parts WHERE book_id=? AND package_sha256=? ORDER BY chunk_index',key);
  requireThat(parts.length===request.chunkCount&&parts.every((r,i)=>Number(r.chunk_index)===i&&matches(r)));
  const info=await this.store.ports.files.combine(parts.map(r=>String(r.path)),BOOK_MAX_PACKAGE_BYTES);
  try{
   let applied:number;
   try{
    requireThat(info.size===request.byteCount&&info.sha256===key[1]);
    await protectPackage(info);
    applied=await this.store.installPackage(info,key[0],undefined,false,cancel);
   }
   catch(error){if(/book_request_invalid|book_package_|book_sync_invalid/.test(String(error)))await this.discard(key,parts,false);throw error;}
   await this.discard(key,parts,true);
   return {...base,received:true,complete:true,applied};
  }finally{await this.store.ports.files.remove(info.path);}
 }
 private preparePartReceipts(){
  return this.partsReady??=(async()=>{
   if((await this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_book_part_receipts'")).length)return;
   await this.db.transaction(BOOK_PART_RECEIPT_SCHEMA.map(sql=>({sql})));
  })().catch(error=>{this.partsReady=undefined;throw error;});
 }
 private async discard(key:readonly [string,string],rows:Record<string,unknown>[],published:boolean){
  if(!rows.length)return;
  const remove=async()=>{for(const row of rows)await this.store.ports.files.remove(String(row.path));};
  // A published package can replay cleanup after interruption. Keep the
  // durable paths until every staged file has been removed.
  if(published)await remove();
  await this.db.transaction([{sql:'DELETE FROM sync_book_parts WHERE book_id=? AND package_sha256=?',params:key}]);
  if(!published)await remove();
 }
}
