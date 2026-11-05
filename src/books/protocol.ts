import {cpuSort} from '@podjs/framework/cpu-work';
import {lengthPrefixFields} from '@podjs/framework/crypto';
import {encodeUtf8} from '@podjs/framework/bytes';
import {compareLifecycleTokens,validateLifecycleToken,type LifecycleToken} from '@podjs/framework/lifecycle-token';
export type BookHash=(bytes:Uint8Array)=>Promise<string>;
export interface BookState {bookId:string;fingerprint:string;title:string;chapterCount:number;deletedChapters:number[];deletionClock:number;deleted:boolean;deletedAt:number;updatedAt:number;sourceDeviceId:string;sourceUrl?:string;kind?:string;instanceId?:string;lifecycle?:LifecycleToken}
export interface BookReading {bookId:string;chapterIndex:number;isRead:boolean;readingProgress:number;readingPositionBytes:number;readingPositionContentHash:string;readingPositionChangedAt:number;sourceDeviceId:string;favoriteSaved?:boolean;favoriteChangedAt?:number;favoriteSortOrder?:number;favoriteSourceDeviceId?:string;watchLaterSaved?:boolean;watchLaterChangedAt?:number;watchLaterSortOrder?:number;watchLaterSourceDeviceId?:string}
export interface BookChapter {chapterIndex:number;title:string;contentText:string;contentHtml:string|null;url:string}
export const BOOK_MAX_CHAPTERS=100000,BOOK_CHUNK_SIZE=64*1024,BOOK_MAX_PACKAGE_BYTES=512*1024*1024;
const hex=/^[a-f0-9]{64}$/;
function check(yes:unknown):asserts yes {if(!yes)throw Error('book_sync_invalid');}
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
export const normalizeBookText=(text:string)=>text.replace(/\r\n?/g,'\n');
const lpFields=(fields:readonly (string|number)[])=>lengthPrefixFields(fields.map(s=>encodeUtf8(String(s),'question')));
const lp=(...fields:(string|number)[])=>lpFields(fields);
export function chapterHash(index:number,title:string,text:string,sha:BookHash){check(integer(index,1,BOOK_MAX_CHAPTERS));return sha(lp('watchrss/book/chapter/v1',index,normalizeBookText(title),normalizeBookText(text)));}
export function bookFingerprint(hashes:readonly string[],sha:BookHash){check(hashes.length>0&&hashes.length<=BOOK_MAX_CHAPTERS&&hashes.every(x=>hex.test(x)));return sha(lpFields(['watchrss/book/fingerprint/v1',hashes.length,...hashes]));}
export function bookIdInput(fingerprint:string,instanceId?:string){check(typeof fingerprint==='string'&&hex.test(fingerprint));if(instanceId===undefined)return lp('watchrss/book/id/v1',fingerprint);check(typeof instanceId==='string'&&/^[a-f0-9]{32}$/.test(instanceId));return lp('watchrss/book/instance-id/v1',fingerprint,instanceId);}
export function bookId(fingerprint:string,sha:BookHash,instanceId?:string){return sha(bookIdInput(fingerprint,instanceId));}
export function bookArticleId(id:string,index:number,sha:BookHash){check(hex.test(id)&&integer(index,1,BOOK_MAX_CHAPTERS));return sha(lp('watchrss/book/article/v1',id,index));}
export function validateBookShape(raw:unknown):asserts raw is BookState {
 check(!!raw&&typeof raw==='object'&&!Array.isArray(raw));const v=raw as BookState;
 check(typeof v.bookId==='string'&&typeof v.fingerprint==='string'&&hex.test(v.bookId)&&hex.test(v.fingerprint)&&typeof v.title==='string'&&typeof v.sourceDeviceId==='string'&&typeof v.deleted==='boolean'&&integer(v.chapterCount,1,BOOK_MAX_CHAPTERS));
 for(const n of [v.deletionClock,v.deletedAt,v.updatedAt])check(integer(n));
 for(const n of [v.sourceUrl,v.kind])check(n===undefined||typeof n==='string');
 check(v.instanceId===undefined||typeof v.instanceId==='string'&&/^[a-f0-9]{32}$/.test(v.instanceId));if(v.lifecycle!==undefined)validateLifecycleToken(v.lifecycle);
 check(Array.isArray(v.deletedChapters));let previous=0;for(const n of v.deletedChapters){check(integer(n,previous+1,v.chapterCount));previous=n;}
}
export async function validateBook(v:unknown,sha:BookHash):Promise<BookState>{validateBookShape(v);check(await bookId(v.fingerprint,sha,v.instanceId)===v.bookId);return cleanBook(v);}
function cleanBook(v:BookState):BookState {return {bookId:v.bookId,fingerprint:v.fingerprint,title:v.title,chapterCount:v.chapterCount,deletedChapters:[...v.deletedChapters],deletionClock:v.deletionClock,deleted:v.deleted,deletedAt:v.deletedAt,updatedAt:v.updatedAt,sourceDeviceId:v.sourceDeviceId,...(v.sourceUrl===undefined?{}:{sourceUrl:v.sourceUrl}),...(v.kind===undefined?{}:{kind:v.kind}),...(v.instanceId===undefined?{}:{instanceId:v.instanceId}),...(v.lifecycle===undefined?{}:{lifecycle:{...v.lifecycle}})};}
const compare=(a:readonly (string|number)[],b:readonly (string|number)[])=>{for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]!<b[i]!?-1:1;}return 0;};
/** Permanent deletion set/tombstone; display metadata alone uses stable LWW. */
export function mergeBook(local:BookState|undefined,remote:BookState):BookState {
 validateBookShape(remote);if(!local)return cleanBook(remote);validateBookShape(local);check(local.bookId===remote.bookId&&local.fingerprint===remote.fingerprint&&local.chapterCount===remote.chapterCount&&local.instanceId===remote.instanceId);
 const token=compareLifecycleTokens(local.lifecycle,remote.lifecycle);if(token)return cleanBook(token>0?local:remote);
 const order=(s:BookState)=>[s.updatedAt,s.sourceDeviceId,s.title,s.sourceUrl??'',s.kind??''];
 return {...cleanBook(compare(order(remote),order(local))>0?remote:local),deletedChapters:cpuSort([...new Set([...local.deletedChapters,...remote.deletedChapters])],(a,b)=>a-b),deletionClock:Math.max(local.deletionClock,remote.deletionClock),deletedAt:Math.max(local.deletedAt,remote.deletedAt),deleted:local.deleted||remote.deleted};
}
export function validateBookReading(raw:unknown):asserts raw is BookReading {
 check(!!raw&&typeof raw==='object'&&!Array.isArray(raw));const v=raw as BookReading;
 check(hex.test(v.bookId)&&integer(v.chapterIndex,1,BOOK_MAX_CHAPTERS)&&typeof v.isRead==='boolean'&&typeof v.sourceDeviceId==='string'&&typeof v.readingPositionContentHash==='string'&&integer(v.readingPositionBytes)&&integer(v.readingPositionChangedAt));
 check(typeof v.readingProgress==='number'&&Number.isFinite(v.readingProgress)&&v.readingProgress>=0&&v.readingProgress<=1);
 for(const p of ['favorite','watchLater'] as const){if(v[`${p}Saved`]!==undefined){check(typeof v[`${p}Saved`]==='boolean'&&integer(v[`${p}ChangedAt`])&&integer(v[`${p}SortOrder`]));check(v[`${p}SourceDeviceId`]===undefined||typeof v[`${p}SourceDeviceId`]==='string');}else check(v[`${p}ChangedAt`]===undefined&&v[`${p}SortOrder`]===undefined&&v[`${p}SourceDeviceId`]===undefined);}
}
function reading(v:BookReading):BookReading {const out:BookReading={bookId:v.bookId,chapterIndex:v.chapterIndex,isRead:v.isRead,readingProgress:Math.floor(v.readingProgress*1e6+.5)/1e6,readingPositionBytes:v.readingPositionBytes,readingPositionContentHash:v.readingPositionContentHash,readingPositionChangedAt:v.readingPositionChangedAt,sourceDeviceId:v.sourceDeviceId};for(const p of ['favorite','watchLater'] as const)if(v[`${p}Saved`]!==undefined){out[`${p}Saved`]=v[`${p}Saved`];out[`${p}ChangedAt`]=v[`${p}ChangedAt`];out[`${p}SortOrder`]=v[`${p}SortOrder`];out[`${p}SourceDeviceId`]=v[`${p}SourceDeviceId`]??v.sourceDeviceId;}return out;}
/** Reading and each save list have independent clocks and provenance. */
export function mergeBookReading(local:BookReading|undefined,remote:BookReading):BookReading {
 validateBookReading(remote);const r=reading(remote);if(!local)return r;validateBookReading(local);const l=reading(local);check(l.bookId===r.bookId&&l.chapterIndex===r.chapterIndex);
 const order=(s:BookReading)=>[s.readingPositionChangedAt,s.sourceDeviceId,s.isRead?0:1,s.readingPositionBytes,s.readingProgress,s.readingPositionContentHash];const out={...(compare(order(r),order(l))>0?r:l)};
 for(const p of ['favorite','watchLater'] as const){const order=(s:BookReading)=>[s[`${p}ChangedAt`]!,s[`${p}SourceDeviceId`]??s.sourceDeviceId,s[`${p}Saved`]?0:1,s[`${p}SortOrder`]!];const win=r[`${p}Saved`]===undefined?l:l[`${p}Saved`]===undefined?r:compare(order(r),order(l))>0?r:l;for(const suffix of ['Saved','ChangedAt','SortOrder','SourceDeviceId'] as const){const k=`${p}${suffix}` as keyof BookReading;if(win[k]!==undefined)(out as unknown as Record<string,unknown>)[k]=win[k];}}
 return out;
}
export function bookInteracted(v:Pick<BookReading,'isRead'|'readingProgress'|'readingPositionChangedAt'|'favoriteSaved'|'favoriteChangedAt'|'watchLaterSaved'|'watchLaterChangedAt'>){return !!(v.isRead||v.readingProgress||v.readingPositionChangedAt||v.favoriteSaved||v.favoriteChangedAt||v.watchLaterSaved||v.watchLaterChangedAt);}
