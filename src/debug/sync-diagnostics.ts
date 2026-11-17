import {redactTitle} from './safe-title';
import {bookIdPrefix,bookRejectionReason,rejectionTitle} from './book-rejections';
import type {DiagnosticStorage} from '../sync/diagnostic-log';
export const HISTORY_LIMIT=12, ITEM_LIMIT=256;
export const HISTORY_KEY='watchrss.sync.readonly-history.v1';
const codes=new Set(['book_batch_rejected','none','unknown','sync_failed','peer_rejected','ack_missing','book_manifest_invalid','book_package_invalid','book_request_invalid','book_sync_not_negotiated','book_reading_delta_not_negotiated','library_busy','library_exchange_failed','unsupported_action','account_required','binding_required','body_missing','package_missing','package_hash_mismatch','metadata_invalid','read_failed','staged','registration_pending']);
export const reasonCode=(v:unknown)=>typeof v==='string'&&codes.has(v)?v:'unknown';
export const opaqueId=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:null;
const itemId=(v:unknown)=>typeof v==='string'&&(/^[a-f0-9]{64}$/.test(v)||/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v))?v:null;
export const safeTitle=(v:unknown)=>typeof v==='string'?redactTitle(v).slice(0,256):'';
export const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:0;
export interface ItemResult {kind:string;id?:string|null;result?:string;reasonCode?:string;bookIdPrefix?:string;code?:string;title?:string|null;reason?:string}
export const isRejectedItem=(r:ItemResult)=>r.result==='rejected'||r.kind==='book'&&r.code!==undefined;
/** Keep only public business IDs. Batch failure applies to each submitted item. */
export function* iterateRequestItems(request:Record<string,unknown>):Generator<{kind:string;id:string|null;title?:string|null}> {
 const kind=request.action==='syncBooks'?'book':request.action==='syncNotes'?'note':request.action==='syncNoteAsset'?'asset':request.action==='syncReader'?'reader':request.action==='syncAccount'?'account':'library';
 const rows=kind==='book'&&request.phase==='manifest'?request.books:kind==='note'?(Array.isArray(request.notes)&&request.notes.length?request.notes:request.noteManifest):undefined;
 if(Array.isArray(rows)&&rows.length){for(const raw of rows){const r=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};yield kind==='book'?{kind,id:opaqueId(r.bookId),title:rejectionTitle(r.title)}:{kind,id:itemId(r.noteId)};}}
 else yield {kind,id:kind==='book'?opaqueId(request.bookId):kind==='asset'?opaqueId(request.sha256):kind==='note'?itemId(request.noteId):null};
}
export function requestItems(request:Record<string,unknown>){const items=[];for(const item of iterateRequestItems(request)){items.push(item);if(items.length>=ITEM_LIMIT+1)break;}return items;}
export function itemResult(raw:Record<string,unknown>):ItemResult {
 if(raw.kind==='book'&&raw.result!=='applied')return {kind:'book',bookIdPrefix:bookIdPrefix(raw.bookIdPrefix??raw.id),code:reasonCode(raw.code??raw.reasonCode),title:rejectionTitle(raw.title),reason:bookRejectionReason(raw.reason)};
 return {kind:['book','article','note','asset','reader','library','account','unknown'].includes(String(raw.kind))?String(raw.kind):'unknown',id:['book','asset'].includes(String(raw.kind))?opaqueId(raw.id):['article','note'].includes(String(raw.kind))?itemId(raw.id):null,result:raw.result==='applied'?'applied':'rejected',reasonCode:reasonCode(raw.reasonCode)};
}
export interface SyncRecord {startedAt:number;endedAt:number|null;channel:'RFCOMM'|'IP';result:string;totalBytes:number;bytesPerSecond:number;reconnectCount:number;items:ItemResult[];itemsTruncated:boolean;pendingCount:number|null;rejectedCount:number|null;omittedCount:number|null;omittedRejectedCount:number|null;omittedAppliedCount:number|null}
export function syncRecord(raw:Record<string,unknown>):SyncRecord {
 const known=typeof raw.rejectedCount==='number';const retained=(Array.isArray(raw.items)?raw.items:[]).slice(0,ITEM_LIMIT).filter(v=>v&&typeof v==='object').map(itemResult);const legacyUnknown=!known&&(raw.itemsTruncated===true||Array.isArray(raw.items)&&raw.items.length>ITEM_LIMIT);const rejected=known?count(raw.rejectedCount):retained.filter(isRejectedItem).length;
 return {pendingCount:legacyUnknown?null:rejected,rejectedCount:legacyUnknown?null:rejected,omittedCount:legacyUnknown?null:count(raw.omittedCount),omittedRejectedCount:legacyUnknown?null:count(raw.omittedRejectedCount),omittedAppliedCount:legacyUnknown?null:count(raw.omittedAppliedCount),startedAt:count(raw.startedAt),endedAt:raw.endedAt===null?null:count(raw.endedAt),channel:raw.channel==='IP'?'IP':'RFCOMM',result:['running','success','partial','failed'].includes(String(raw.result))?String(raw.result):'failed',totalBytes:count(raw.totalBytes),bytesPerSecond:count(raw.bytesPerSecond),reconnectCount:count(raw.reconnectCount),items:(Array.isArray(raw.items)?raw.items:[]).slice(0,ITEM_LIMIT).filter(v=>v&&typeof v==='object').map(itemResult),itemsTruncated:raw.itemsTruncated===true||Array.isArray(raw.items)&&raw.items.length>ITEM_LIMIT};
}
/** Projection on both write and read. A poisoned/stale storage value cannot add fields. */
export class SyncHistory {
 constructor(private storage:DiagnosticStorage){}
 last(n=3):SyncRecord[]{try{const raw=JSON.parse(this.storage.get(HISTORY_KEY)??'[]');return Array.isArray(raw)?raw.slice(-HISTORY_LIMIT).filter(v=>v&&typeof v==='object').map(syncRecord).reverse().slice(0,n):[];}catch{return [];}}
 begin(channel:'RFCOMM'|'IP',now=Date.now,monotonic=now,start?:{at:number;tick:number;reconnects:number}){
  const at=start?.at??now(),tick=start?.tick??monotonic();let bytes=0,finished=false;const items:ItemResult[]=[];let truncated=false,rejectedCount=0,omittedCount=0,omittedRejectedCount=0,omittedAppliedCount=0;
  const save=(result:string,endedAt:number|null)=>{const record=syncRecord({startedAt:at,endedAt,channel,result,totalBytes:bytes,bytesPerSecond:endedAt===null?0:Math.floor(bytes*1000/Math.max(1,monotonic()-tick)),reconnectCount:start?.reconnects??0,items,itemsTruncated:truncated,rejectedCount,omittedCount,omittedRejectedCount,omittedAppliedCount});const rows=this.last(HISTORY_LIMIT).reverse();const existing=rows.findIndex(r=>r.startedAt===at&&r.channel===channel&&r.endedAt===null);if(existing>=0)rows.splice(existing,1);rows.push(record);try{this.storage.set(HISTORY_KEY,JSON.stringify(rows.slice(-HISTORY_LIMIT)));}catch{/* Diagnostics never interrupt synchronization. */}};
  save('running',null);
  return {bytes:(n:number)=>{bytes+=count(n);},item:(raw:Record<string,unknown>)=>{const item=itemResult(raw),rejected=isRejectedItem(item);if(rejected)rejectedCount++;if(items.length<ITEM_LIMIT)items.push(item);else{truncated=true;omittedCount++;if(rejected)omittedRejectedCount++;else omittedAppliedCount++;}},finish:(ok:boolean)=>{if(finished)return;finished=true;save(ok?(rejectedCount>0?'partial':'success'):'failed',now());}};
 }
}
export type SyncTrace=ReturnType<SyncHistory['begin']>;
export interface BookPage {offset:number;limit:number}
export interface LibraryDiagnosticsPort {books(check?:()=>void,page?:BookPage):Promise<unknown[]>;summary(check?:()=>void):Promise<Record<string,unknown>>;last(n:number):unknown[]}
export function bookFields(r:Record<string,unknown>){return {bookId:opaqueId(r.bookId),title:safeTitle(r.title),chapterCount:count(r.chapterCount),packageBytes:count(r.packageBytes),packageSha256:opaqueId(r.packageSha256),status:['ready','staged','failed'].includes(String(r.status))?String(r.status):'failed',reasonCode:reasonCode(r.reasonCode),readable:r.readable===true};}
export function summaryFields(r:Record<string,unknown>){return {channels:count(r.channels),articles:count(r.articles),favorites:count(r.favorites),watchLater:count(r.watchLater),memos:count(r.memos),books:count(r.books)};}

/** Latest item outcome wins. A repaired local package still overrides historical failure. */
export function bookRejections(records:readonly SyncRecord[]):Map<string,string>{const seen=new Set<string>(),reasons=new Map<string,string>();for(const record of records)for(const item of [...record.items].reverse()){if(item.kind!=='book')continue;const prefix=item.bookIdPrefix??(opaqueId(item.id)?.slice(0,8));if(!prefix||prefix==='invalid'||seen.has(prefix))continue;seen.add(prefix);if(isRejectedItem(item))reasons.set(prefix,item.code??'unknown');}return reasons;}
