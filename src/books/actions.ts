import {BookReadingDelta,type AfterReadingAck} from './reading-delta';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
import {querySyncPages} from '../sync/sql-pages';
import type {SqlDatabase} from '../core/types';
import type {JsonObject} from '../sync/protocol';
import {SqlBookStore} from './store';
import {validateBook,validateBookReading,BOOK_CHUNK_SIZE,BOOK_MAX_PACKAGE_BYTES,type BookReading,type BookState} from './protocol';
const hex=/^[a-f0-9]{64}$/;
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const requireThat=(ok:unknown)=>{if(!ok)throw Error('book_request_invalid');};
export class BookSyncActions {
 private readonly fallback={};private pages=new WeakMap<object,BookReading[]>();
 private delta:BookReadingDelta;
 constructor(private db:SqlDatabase,private store:SqlBookStore){this.delta=new BookReadingDelta(db,store);}
 async apply(request:JsonObject,session:object=this.fallback,afterAck?:AfterReadingAck):Promise<JsonObject>{
  requireThat(request.version===1&&typeof request.deviceId==='string'&&request.deviceId.length>0&&request.deviceId.length<=512);
  const base={success:true,action:'syncBooks',version:1,phase:request.phase};
  if(['readingSummary','readingDelta','readingCommit'].includes(String(request.phase)))return this.delta.apply(request,session,afterAck);
  if(request.phase==='manifest'){
   requireThat(Array.isArray(request.books)&&request.books.length<=100000);const incoming:BookState[]=[];const ids=new Set<string>();for(const raw of request.books as unknown[]){const value=await validateBook(raw,this.store.ports.sha256);requireThat(!ids.has(value.bookId)&&typeof (raw as JsonObject).contentAvailable==='boolean');ids.add(value.bookId);incoming.push(value);}
   this.pages.delete(session);await this.store.registerLocal(incoming);let applied=0;for(const s of incoming)applied+=await this.store.merge(s);const books=await this.store.manifests(),missingBookIds:string[]=[];for(let i=0;i<incoming.length;i++){const s=incoming[i]!;if(!s.deleted&&(request.books as JsonObject[])[i]!.contentAvailable===true&&!await this.store.package(s.bookId))missingBookIds.push(s.bookId);}
   return {...base,deviceId:await this.store.ports.deviceId(),books,missingBookIds,applied};
  }
  if(request.phase==='reading'){
   requireThat(Array.isArray(request.states)&&request.states.length<=100&&integer(request.after));for(const state of request.states as unknown[])validateBookReading(state);let snapshot=this.pages.get(session);if(!snapshot)await this.store.captureReading();const applied=await this.store.mergeReadingBatch(request.states as BookReading[]);if(!snapshot){snapshot=await this.store.readingStates(false);this.pages.set(session,snapshot);}const after=request.after as number;requireThat(after<=snapshot.length);const states=snapshot.slice(after,after+100),nextAfter=after+states.length;return {...base,states,nextAfter,hasMore:nextAfter<snapshot.length,applied};
  }
  const id=request.bookId;requireThat(typeof id==='string'&&hex.test(id));
  if(request.phase==='pull'){
   const info=await this.store.package(id as string);requireThat(info&&integer(request.chunkIndex,0,Math.ceil(info!.size/BOOK_CHUNK_SIZE)-1));const index=request.chunkIndex as number;const state=(await this.db.query('SELECT fingerprint,state_json FROM sync_books WHERE book_id=?',[id as string]))[0];requireThat(state&&!JSON.parse(String(state.state_json)).deleted);
   if(index===0){const actual=await this.store.ports.files.hash(info!.path);requireThat(actual.size===info!.size&&actual.sha256===info!.sha256);}const part=await this.store.ports.files.read(info!.path,index*BOOK_CHUNK_SIZE,Math.min(BOOK_CHUNK_SIZE,info!.size-index*BOOK_CHUNK_SIZE));requireThat(part.size===info!.size&&part.bytes.length===Math.min(BOOK_CHUNK_SIZE,info!.size-index*BOOK_CHUNK_SIZE));return {...base,phase:'body',bookId:id,fingerprint:state!.fingerprint,packageSha256:info!.sha256,byteCount:info!.size,chunkIndex:index,chunkCount:Math.ceil(info!.size/BOOK_CHUNK_SIZE),dataBase64:bytesToBase64(part.bytes)};
  }
  requireThat(request.phase==='body'&&typeof request.packageSha256==='string'&&hex.test(request.packageSha256)&&typeof request.fingerprint==='string'&&hex.test(request.fingerprint)&&integer(request.byteCount,1,BOOK_MAX_PACKAGE_BYTES)&&integer(request.chunkCount,1)&&request.chunkCount===Math.ceil(Number(request.byteCount)/BOOK_CHUNK_SIZE)&&integer(request.chunkIndex,0,Number(request.chunkCount)-1)&&typeof request.dataBase64==='string'&&request.dataBase64.length<=87384);
  const row=(await this.db.query('SELECT fingerprint FROM sync_books WHERE book_id=?',[id as string]))[0];requireThat(row?.fingerprint===request.fingerprint);const data=base64ToBytes(request.dataBase64 as string),expected=Math.min(BOOK_CHUNK_SIZE,Number(request.byteCount)-Number(request.chunkIndex)*BOOK_CHUNK_SIZE);requireThat(data.length===expected&&bytesToBase64(data)===request.dataBase64);
  const committed=await this.store.package(id as string);if(committed&&committed.sha256===request.packageSha256&&committed.size===request.byteCount){const old=await this.store.ports.files.read(committed.path,Number(request.chunkIndex)*BOOK_CHUNK_SIZE,expected);requireThat(old.bytes.length===data.length&&old.bytes.every((v,i)=>v===data[i]));return {...base,received:true,complete:true,applied:0};}
  const rows=await querySyncPages(this.db,'SELECT * FROM sync_book_parts WHERE book_id=? AND package_sha256=? ORDER BY chunk_index',[id as string,request.packageSha256 as string]);for(const r of rows)requireThat(r.fingerprint===request.fingerprint&&Number(r.byte_count)===request.byteCount&&Number(r.chunk_count)===request.chunkCount);
  const duplicate=rows.find(r=>Number(r.chunk_index)===request.chunkIndex);if(duplicate){const old=await this.store.ports.files.read(String(duplicate.path),0,BOOK_CHUNK_SIZE);requireThat(old.bytes.length===data.length&&old.bytes.every((v,i)=>v===data[i]));}else{const part=await this.store.ports.files.writeBytes(data);try{await this.db.transaction([{sql:'INSERT INTO sync_book_parts(book_id,package_sha256,fingerprint,byte_count,chunk_count,chunk_index,path) VALUES(?,?,?,?,?,?,?)',params:[id as string,request.packageSha256 as string,request.fingerprint as string,request.byteCount as number,request.chunkCount as number,request.chunkIndex as number,part.path]}]);}catch(error){await this.store.ports.files.remove(part.path);throw error;}}
  const parts=await querySyncPages(this.db,'SELECT * FROM sync_book_parts WHERE book_id=? AND package_sha256=? ORDER BY chunk_index',[id as string,request.packageSha256 as string]);if(parts.length!==request.chunkCount)return {...base,received:true,complete:false,applied:0};requireThat(parts.every((r,i)=>Number(r.chunk_index)===i));const info=await this.store.ports.files.combine(parts.map(r=>String(r.path)),BOOK_MAX_PACKAGE_BYTES);
  try{requireThat(info.size===request.byteCount&&info.sha256===request.packageSha256);const applied=await this.store.installPackage(info,id as string);await this.discard(id as string,request.packageSha256 as string,parts);return {...base,received:true,complete:true,applied};}catch(error){if(/book_request_invalid|book_package_|book_sync_invalid/.test(String(error)))await this.discard(id as string,request.packageSha256 as string,parts);throw error;}finally{await this.store.ports.files.remove(info.path);}
 }
 private async discard(id:string,hash:string,rows:Record<string,unknown>[]){await this.db.transaction([{sql:'DELETE FROM sync_book_parts WHERE book_id=? AND package_sha256=?',params:[id,hash]}]);for(const r of rows)await this.store.ports.files.remove(String(r.path));}
}
