import type {SqlDatabase} from '../core/types';
import type {JsonObject} from '../sync/protocol';
import {libraryRevision,revisionGuard} from '../sync/revision';
import {querySyncPages} from '../sync/sql-pages';
import {canonical} from '../cloud/records';
import type {SqlBookStore} from './store';
import {validateBookReading} from './protocol';
import {readingLeafHash,readingBookRoot,readingRoot,validateReadingSummary,type ReadingSummary,type ReadingEntry} from './reading-hash';
export type AfterReadingAck=(commit:()=>Promise<void>)=>void;
interface Window {id:string;peer:string;local:ReadingSummary;remote:ReadingSummary;from:number;remoteFrom:number;entries:ReadingEntry[];outAfter:number;remoteLast:number;done:boolean;batch:number;equal:boolean;last?:{signature:string;response:JsonObject}}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const requireThat=(yes:unknown)=>{if(!yes)throw Error('book_reading_window_invalid');};
/** One physical-session window; only the final transport applied ACK publishes cursors. */
export class BookReadingDelta {
 private windows=new WeakMap<object,Window>();private serial=0;
 constructor(private db:SqlDatabase,private store:SqlBookStore){}
 async summary():Promise<ReadingSummary>{
  await this.store.captureReading();
  for(let attempt=0;attempt<3;attempt++){const revision=await libraryRevision(this.db);try{
   const meta=(await this.db.query('SELECT * FROM sync_book_reading_meta WHERE id=1'))[0];requireThat(meta);
   let root=meta!.root as string|null,count=Number(meta!.count);
   if(root===null){
    const dirty=await this.db.query('SELECT book_id FROM sync_book_reading_hash_dirty ORDER BY book_id');
    for(const d of dirty){const id=String(d.book_id),missing=await querySyncPages(this.db,'SELECT r.chapter_index,r.state_json FROM sync_book_reading r LEFT JOIN sync_book_reading_hashes h ON h.book_id=r.book_id AND h.chapter_index=r.chapter_index WHERE r.book_id=? AND h.hash IS NULL ORDER BY r.chapter_index',[id]);
     for(let at=0;at<missing.length;at+=100){const ss=[];for(const r of missing.slice(at,at+100))ss.push({sql:'INSERT OR REPLACE INTO sync_book_reading_hashes VALUES(?,?,?)',params:[id,r.chapter_index,await readingLeafHash(JSON.parse(String(r.state_json)),this.store.ports.sha256)]});await this.db.transaction([revisionGuard(revision),...ss]);}
     const leaves=(await querySyncPages(this.db,'SELECT chapter_index,hash FROM sync_book_reading_hashes WHERE book_id=? ORDER BY chapter_index',[id])).map(r=>({chapterIndex:Number(r.chapter_index),hash:String(r.hash)}));
     await this.db.transaction([revisionGuard(revision),leaves.length?{sql:'INSERT OR REPLACE INTO sync_book_reading_book_hashes VALUES(?,?,?)',params:[id,await readingBookRoot(id,leaves,this.store.ports.sha256),leaves.length]}:{sql:'DELETE FROM sync_book_reading_book_hashes WHERE book_id=?',params:[id]},{sql:'DELETE FROM sync_book_reading_hash_dirty WHERE book_id=?',params:[id]}]);
    }
    const books=(await querySyncPages(this.db,'SELECT * FROM sync_book_reading_book_hashes ORDER BY book_id')).map(r=>({bookId:String(r.book_id),root:String(r.root),count:Number(r.count)}));root=await readingRoot(books,this.store.ports.sha256);count=books.reduce((n,b)=>n+b.count,0);
    await this.db.transaction([revisionGuard(revision),{sql:'UPDATE sync_book_reading_meta SET root=?,count=? WHERE id=1',params:[root,count]}]);
   }
   // Read root and watermark in one SQLite snapshot. A write after hashing may
   // invalidate the root, but must never pair a stale root with its newer seq.
   const frozen=(await this.db.query('SELECT epoch,root,count,(SELECT COALESCE(MAX(seq),0) FROM sync_book_reading_journal) AS seq FROM sync_book_reading_meta WHERE id=1'))[0]!;
   if(frozen.root===null)continue;
   const summary={epoch:String(frozen.epoch),seq:Number(frozen.seq),root:String(frozen.root),count:Number(frozen.count)};validateReadingSummary(summary);return summary;
  }catch(e){if(await libraryRevision(this.db)===revision)throw e;}}
  throw Error('book_reading_changed_repeatedly');
 }
 async entries(from:number,to:number):Promise<ReadingEntry[]>{return (await querySyncPages(this.db,'SELECT h.seq,h.state_json FROM sync_book_reading_history h WHERE h.seq>? AND h.seq<=? AND NOT EXISTS(SELECT 1 FROM sync_book_reading_history newer WHERE newer.book_id=h.book_id AND newer.chapter_index=h.chapter_index AND newer.seq>h.seq AND newer.seq<=?) ORDER BY h.seq',[from,to,to])).map(r=>({seq:Number(r.seq),state:JSON.parse(String(r.state_json))}));}
 async apply(request:JsonObject,session:object,afterAck?:AfterReadingAck):Promise<JsonObject>{
  const peer=String(request.deviceId),base={success:true,action:'syncBooks',version:1,phase:request.phase};
  if(request.phase==='readingSummary'){
   validateReadingSummary(request.summary);requireThat(safe(request.ackedLocalSeq));const remote=request.summary,local=await this.summary(),known=request.knownRemote as {epoch:string;seq:number}|null;
   requireThat(known===null||!!known&&/^[a-f0-9]{32}$/.test(known.epoch)&&safe(known.seq));
   const p=(await this.db.query('SELECT * FROM sync_book_reading_peers WHERE peer=?',[peer]))[0],sameEpoch=!!p&&p.local_epoch===local.epoch&&p.remote_epoch===remote.epoch;
   let from=sameEpoch&&known?.epoch===local.epoch&&known.seq<=local.seq?Math.min(Number(p!.local_seq),known.seq):0;
   let remoteFrom=sameEpoch&&Number(p!.remote_seq)<=remote.seq?Math.min(Number(p!.remote_seq),(request.ackedLocalSeq as number)<=remote.seq?request.ackedLocalSeq as number:0):0;
   const equal=local.root===remote.root&&local.count===remote.count;
   // Root divergence with no remaining delta is a rollback/cache repair, never an empty success.
   if(!equal&&(from>=local.seq&&remoteFrom>=remote.seq)){from=0;remoteFrom=0;}
   if(!equal&&sameEpoch){if(from>=local.seq&&p!.root!==local.root)from=0;if(remoteFrom>=remote.seq&&p!.root!==remote.root)remoteFrom=0;}
   const entries=equal?[]:await this.entries(from,local.seq),id=local.epoch+'-'+(++this.serial);
   this.windows.set(session,{id,peer,local,remote,from,remoteFrom,entries,outAfter:0,remoteLast:remoteFrom,done:equal,batch:0,equal});
   return {...base,windowId:id,summary:local,fromSeq:from,remoteFromSeq:remoteFrom,equal};
  }
  const w=this.windows.get(session);requireThat(w&&w.peer===peer&&request.windowId===w.id);const window=w!;
  if(request.phase==='readingDelta'){
   requireThat(!window.equal&&safe(request.batchIndex)&&safe(request.after)&&Array.isArray(request.entries)&&request.entries.length<=100&&typeof request.done==='boolean');
   const signature=canonical(request);if(request.batchIndex===window.batch-1&&window.last?.signature===signature)return {...window.last.response,applied:0};
   requireThat(request.batchIndex===window.batch&&request.after===window.outAfter&&(!window.done||request.done===true&&(request.entries as unknown[]).length===0));
   let last=window.remoteLast;const entries=request.entries as unknown as ReadingEntry[];for(const e of entries){requireThat(e&&safe(e.seq)&&e.seq>last&&e.seq<=window.remote.seq);validateBookReading(e.state);last=e.seq;}
   const applied=await this.store.mergeReadingBatch(entries.map(e=>e.state)),after=request.after as number,states=window.entries.slice(after,after+100),nextAfter=after+states.length;
   const response={...base,windowId:window.id,entries:states,nextAfter,hasMore:nextAfter<window.entries.length,applied};window.remoteLast=last;window.done=request.done===true;window.outAfter=nextAfter;window.batch++;window.last={signature,response};return response;
  }
  requireThat(request.phase==='readingCommit'&&window.done&&window.outAfter===window.entries.length&&request.receivedSeq===window.local.seq&&request.sentSeq===window.remote.seq&&typeof request.mergedRoot==='string'&&!!afterAck);
  const merged=await this.summary();requireThat(merged.epoch===window.local.epoch);
  if(merged.root!==request.mergedRoot)return {...base,windowId:window.id,committed:false,retry:true,summary:merged,applied:0};
  afterAck!(async()=>{const now=(await this.db.query('SELECT epoch FROM sync_book_reading_meta WHERE id=1'))[0];requireThat(now?.epoch===window.local.epoch);
   await this.db.execute('INSERT INTO sync_book_reading_peers(peer,local_epoch,local_seq,remote_epoch,remote_seq,root) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sync_book_reading_meta WHERE id=1 AND epoch=?) ON CONFLICT(peer) DO UPDATE SET local_epoch=excluded.local_epoch,local_seq=excluded.local_seq,remote_epoch=excluded.remote_epoch,remote_seq=excluded.remote_seq,root=excluded.root',[peer,window.local.epoch,window.local.seq,window.remote.epoch,window.remote.seq,merged.root,window.local.epoch]);
  });return {...base,windowId:window.id,committed:true,root:merged.root,applied:0};
 }
}
