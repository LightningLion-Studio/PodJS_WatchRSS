import {lengthPrefixFields} from '@podjs/framework/crypto';
import {encodeUtf8} from '@podjs/framework/bytes';
import {mergeBookReading,validateBookReading,type BookHash,type BookReading} from './protocol';
export interface ReadingSummary {epoch:string;seq:number;root:string;count:number}
export interface ReadingEntry {seq:number;state:BookReading}
export const READING_DELTA_CAPABILITY='supportsBookReadingDeltaV1' as const;
const digest=(fields:readonly (string|number)[],sha:BookHash)=>sha(lengthPrefixFields(fields.map(v=>encodeUtf8(String(v),'question'))));
/** Hash semantic wire values, never JSON spelling, local IDs or sequence numbers. */
export function readingLeafHash(input:BookReading,sha:BookHash){validateBookReading(input);const v=mergeBookReading(undefined,input),fields:(string|number)[]=['watchrss/book/reading-state/v1',v.bookId,v.chapterIndex,v.isRead?1:0,Math.floor(v.readingProgress*1e6+.5),v.readingPositionBytes,v.readingPositionContentHash,v.readingPositionChangedAt,v.sourceDeviceId];
 for(const p of ['favorite','watchLater'] as const){const present=v[`${p}Saved`]!==undefined;fields.push(p,present?1:0);if(present)fields.push(v[`${p}Saved`]?1:0,v[`${p}ChangedAt`]!,v[`${p}SortOrder`]!,v[`${p}SourceDeviceId`]??v.sourceDeviceId);}
 return digest(fields,sha);
}
export function readingBookRoot(id:string,leaves:readonly {chapterIndex:number;hash:string}[],sha:BookHash){return digest(['watchrss/book/reading-book/v1',id,leaves.length,...leaves.flatMap(v=>[v.chapterIndex,v.hash])],sha);}
export function readingRoot(books:readonly {bookId:string;root:string;count:number}[],sha:BookHash){return digest(['watchrss/book/reading-root/v1',books.reduce((n,b)=>n+b.count,0),books.length,...books.flatMap(b=>[b.bookId,b.root,b.count])],sha);}
export function validateReadingSummary(v:unknown):asserts v is ReadingSummary {const s=v as ReadingSummary;if(!s||typeof s!=='object'||!/^[a-f0-9]{32}$/.test(s.epoch)||!/^[a-f0-9]{64}$/.test(s.root)||![s.seq,s.count].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('book_reading_summary_invalid');}
