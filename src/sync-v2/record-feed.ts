/** R4: replayable inputs of an account apply. A feed is read again for each
 * pass, one bounded page at a time, so no pass holds all records or all
 * business statements (note text) at once. Small per-record facts, collected
 * while the feed is built, spare the passes that only need identities. */
import type {Statement} from '@podjs/framework/sql-projection';
import {sha256Hex} from '@podjs/framework/crypto';
import {canonical,bytes} from './protocol';
import {toWire} from './business';
import type {SourceRecord} from './store';
/** What the business pre-pass needs from one record; never note text. `wire`
 * is the digest of the record's canonical wire form (unchanged detection). */
export interface RecordFact {kind:SourceRecord['kind'];logicalId:string;wire:string;source?:SourceRecord;rssSourceUrl?:unknown;bookId?:unknown;chapterIndex?:unknown}
/** Records in a fixed entity order. `read` returns at least one record when
 * `from` is in range and never more than `limit`; it may stop early to bound
 * bytes. `facts` align with `keys`; `inputHash`, when present, is the store's
 * input digest of the same records (computed while the feed was built). */
export interface RecordFeed {readonly keys:readonly string[];readonly facts:readonly RecordFact[];readonly inputHash?:string;read(from:number,limit:number):Promise<SourceRecord[]>}
/** Business statements; every run yields the same sequence. */
export interface StatementFeed {run():AsyncIterable<Statement[]>}
export const wireDigest=(kind:SourceRecord['kind'],payload:{meta:unknown;state:unknown})=>sha256Hex(bytes(canonical(payload)));
export function recordFact(r:SourceRecord):RecordFact{
 const fact:RecordFact={kind:r.kind,logicalId:r.logicalId,wire:wireDigest(r.kind,toWire(r.kind,r.value))};
 if(r.kind==='source')fact.source=r;else if(r.kind==='article')fact.rssSourceUrl=r.value.rssSourceUrl;else if(r.kind==='book-reading'){fact.bookId=r.value.bookId;fact.chapterIndex=r.value.chapterIndex;}
 return fact;
}
export function arrayRecordFeed(records:readonly SourceRecord[],key:(r:SourceRecord)=>string):RecordFeed{
 return {keys:records.map(key),facts:records.map(recordFact),read:async(from,limit)=>records.slice(from,from+limit)};
}
export const arrayStatementFeed=(statements:readonly Statement[]):StatementFeed=>({async *run(){for(let at=0;at<statements.length;at+=64)yield statements.slice(at,at+64);}});
export async function* feedPages(feed:RecordFeed,limit=32):AsyncGenerator<SourceRecord[]>{
 for(let at=0;at<feed.keys.length;){const page=await feed.read(at,limit);if(!page.length)throw Error('closure_incomplete');at+=page.length;yield page;}
}
