import {cpuWorkAsync,cpuJsonParse} from '@podjs/framework/cpu-work';
import {canonical} from '../cloud/records';
import {isCliSingleTextUrl} from '../core/imported-content';
import {chapterHash,bookFingerprint,bookId,normalizeBookText,BOOK_MAX_CHAPTERS,type BookChapter,type BookHash} from './protocol';
export interface BookPackageHeader {format:'watchrss-book';version:1;title:string;chapterCount:number;sourceUrl:string;kind:'txt'|'epub';instanceId?:string}
// CLI single-file imports already publish this local URI in their immutable
// R44 package. It is a display hint; retain the original bytes and fingerprint.
export const isBookUrl=(url:string)=>/^https:\/\/watchrss\.local\/(?:import-txt-novel(?:\/|$)|import-epub(?:\/|$)|import-content\/txt\/)/i.test(url)||isCliSingleTextUrl(url)||/^watchrss:\/\/import\/instance-v1\/[a-f0-9]{32}(?:\/|$)/.test(url);
const invalid=()=>{throw Error('book_package_invalid');};
export function parseBookHeader(line:string):BookPackageHeader {let h:BookPackageHeader;try{h=cpuJsonParse(line);}catch{return invalid();}if(!h||h.format!=='watchrss-book'||h.version!==1||typeof h.title!=='string'||!Number.isInteger(h.chapterCount)||h.chapterCount<1||h.chapterCount>BOOK_MAX_CHAPTERS||typeof h.sourceUrl!=='string'||!isBookUrl(h.sourceUrl)||!['txt','epub'].includes(h.kind))invalid();if(h.instanceId!==undefined&&(typeof h.instanceId!=='string'||!(/^[a-f0-9]{32}$/).test(h.instanceId)))invalid();return h;}
export function parseBookChapter(line:string,index:number):BookChapter {let c:BookChapter;try{c=cpuJsonParse(line);}catch{return invalid();}if(!c||c.chapterIndex!==index||typeof c.title!=='string'||typeof c.contentText!=='string'||c.contentHtml!==null&&typeof c.contentHtml!=='string'||typeof c.url!=='string'||!isBookUrl(c.url))invalid();return c;}
/** Validate the entire immutable stream first. Callers must not publish or
 * materialize a line before the final fingerprint and package SHA both pass. */
export async function validateBookPackage(lines:AsyncIterable<string>,sha:BookHash,expected?:{bookId:string;fingerprint:string;chapterCount?:number;instanceId?:string}){return cpuWorkAsync('book-validate','items',expected?.chapterCount??Infinity,async ()=>{
 let header:BookPackageHeader|undefined,index=0;const hashes:string[]=[];
 for await(const line of lines){if(!header){header=parseBookHeader(line);continue;}const c=parseBookChapter(line,++index);if(index>header.chapterCount)invalid();hashes.push(await chapterHash(index,c.title,c.contentText,sha));}
 if(!header||index!==header.chapterCount)invalid();const fingerprint=await bookFingerprint(hashes,sha),id=await bookId(fingerprint,sha,header!.instanceId);if(expected&&(expected.instanceId!==header!.instanceId||expected.bookId!==id||expected.fingerprint!==fingerprint||expected.chapterCount!==undefined&&expected.chapterCount!==index))invalid();return {header:header!,fingerprint,bookId:id,chapterHashes:hashes};
});}
export async function* bookPackageLines(header:BookPackageHeader,chapters:AsyncIterable<BookChapter>|Iterable<BookChapter>):AsyncGenerator<string>{
 parseBookHeader(canonical(header));yield canonical(header)+'\n';let index=0;
 for await(const chapter of chapters){parseBookChapter(canonical(chapter),++index);if(index>header.chapterCount)invalid();yield canonical({...chapter,title:normalizeBookText(chapter.title),contentText:normalizeBookText(chapter.contentText),contentHtml:chapter.contentHtml===null?null:normalizeBookText(chapter.contentHtml)})+'\n';}
 if(index!==header.chapterCount)invalid();
}
/** Host readers split UTF-8 first; keep only one JSONL line in guest memory. */
export async function* splitBookLines(chunks:AsyncIterable<string>):AsyncGenerator<string>{let pending='',first=true;for await(const chunk of chunks){if(first){first=false;if(chunk.charCodeAt(0)===0xfeff)invalid();}pending+=chunk;let at:number;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);if(line.endsWith('\r'))invalid();yield line;pending=pending.slice(at+1);}}if(pending.length)invalid();}
