import {BOOK_MAX_CHAPTERS} from '../../books/protocol';
import {descriptor,objectId} from './digests';
import {CHUNK_BYTES,exact,fail,hash,hex,integer,strictJson,utf8,type Limits,type ObjectDescriptor} from './wire';

export const BOOK_SEGMENT_BYTES=16*1024*1024;
export type BookKind='bookState'|'bookPackageSegment'|'bookPackageCommit'|'bookReading';
interface BookKey {bookId:string}
interface PackageKey extends BookKey {fingerprint:string;packageSha256:string;packageBytes:number}
export type BookDescription=
 | {kind:'bookState';metadata:BookKey}
 | {kind:'bookReading';metadata:BookKey&{pageIndex:number}}
 | {kind:'bookPackageSegment';metadata:PackageKey&{segmentIndex:number;segmentCount:number;segmentOffset:number}}
 | {kind:'bookPackageCommit';metadata:PackageKey&{segmentObjectIds:string[]}};

export function bookDescription(d:ObjectDescriptor,limits:Limits):BookDescription {
 const value=strictJson(d.metadataUtf8,false);
 const bookId=hex(value.bookId);
 switch(d.kind){
  case 'bookState':
   exact(value,['bookId']);
   if(d.businessId!==bookId||!d.size||d.dependsOn.length)fail('BUSINESS_REJECTED');
   return {kind:d.kind,metadata:{bookId}};
  case 'bookReading': {
   exact(value,['bookId','pageIndex']);
   const pageIndex=integer(value.pageIndex,BOOK_MAX_CHAPTERS-1);
   if(d.businessId!==bookId+':'+pageIndex||!d.size||d.dependsOn.length!==1)fail('BUSINESS_REJECTED');
   return {kind:d.kind,metadata:{bookId,pageIndex}};
  }
  case 'bookPackageSegment':
  case 'bookPackageCommit': {
   const fingerprint=hex(value.fingerprint),packageSha256=hex(value.packageSha256);
   const packageBytes=integer(value.packageBytes,limits.maxPackageBytes);
   if(!packageBytes)fail('LIMIT_EXCEEDED');
   const count=Math.ceil(packageBytes/BOOK_SEGMENT_BYTES);
   const key={bookId,fingerprint,packageSha256,packageBytes};
   if(d.kind==='bookPackageSegment'){
    exact(value,['bookId','fingerprint','packageSha256','packageBytes','segmentIndex','segmentCount','segmentOffset']);
    const segmentIndex=integer(value.segmentIndex,count-1);
    const segmentOffset=segmentIndex*BOOK_SEGMENT_BYTES;
    if(value.segmentCount!==count||value.segmentOffset!==segmentOffset||
      d.size!==Math.min(BOOK_SEGMENT_BYTES,packageBytes-segmentOffset)||
      d.businessId!==[bookId,packageSha256,segmentIndex].join(':')||d.dependsOn.length!==1)fail('PLAN_CONFLICT');
    return {kind:d.kind,metadata:{...key,segmentIndex,segmentCount:count,segmentOffset}};
   }
   exact(value,['bookId','fingerprint','packageSha256','packageBytes','segmentObjectIds']);
   if(!Array.isArray(value.segmentObjectIds)||value.segmentObjectIds.length!==count||
     d.businessId!==bookId||d.dependsOn.length!==count+1)fail('PLAN_CONFLICT');
   const segmentObjectIds=value.segmentObjectIds.map(id=>hex(id));
   if(new Set(segmentObjectIds).size!==count)fail('PLAN_CONFLICT');
   return {kind:d.kind,metadata:{...key,segmentObjectIds}};
  }
  default:return fail('UNSUPPORTED_KIND');
 }
}

export function validateBookPlan(objects:readonly ObjectDescriptor[],limits:Limits):void {
 const states=new Map<string,ObjectDescriptor>();
 const segments=new Map<string,Extract<BookDescription,{kind:'bookPackageSegment'}>['metadata']>();
 const commits=new Map<string,{ids:string[];d:ObjectDescriptor}>();
 const pages=new Map<string,Set<number>>();
 const books=objects.filter(d=>d.kind.startsWith('book')).map(d=>({d,book:bookDescription(d,limits)}));
 for(const {d,book} of books){
  const id=book.metadata.bookId;
  if(book.kind==='bookState'){
   if(states.has(id))fail('PLAN_CONFLICT');
   states.set(id,d);
  }else if(book.kind==='bookPackageSegment')segments.set(d.objectId,book.metadata);
 }
 for(const {d,book} of books){
  const m=book.metadata;
  if(book.kind==='bookState')continue;
  const state=states.get(m.bookId);
  if(!state||!d.dependsOn.includes(state.objectId))fail('PLAN_CONFLICT');
  if(book.kind==='bookReading'){
   const seen=pages.get(m.bookId)??new Set<number>();
   if(seen.has(book.metadata.pageIndex))fail('PLAN_CONFLICT');
   seen.add(book.metadata.pageIndex);pages.set(m.bookId,seen);
  }
  if(book.kind==='bookPackageCommit'){
   if(commits.has(m.bookId))fail('PLAN_CONFLICT');
   const {segmentObjectIds,packageBytes,packageSha256,fingerprint}=book.metadata;
   for(const [index,id] of segmentObjectIds.entries()){
    const part=segments.get(id);
    if(!part||part.bookId!==m.bookId||part.packageBytes!==packageBytes||part.packageSha256!==packageSha256||
      part.fingerprint!==fingerprint||part.segmentIndex!==index||!d.dependsOn.includes(id))fail('PLAN_CONFLICT');
   }
   commits.set(m.bookId,{ids:segmentObjectIds,d});
  }
 }
 for(const [id,m] of segments)if(!commits.get(m.bookId)?.ids.includes(id))fail('PLAN_CONFLICT');
 for(const seen of pages.values())for(let i=0;i<seen.size;i++)if(!seen.has(i))fail('PLAN_CONFLICT');
}

export interface BookFileDigest {size:number;sha256:string;chunkHashes:readonly string[]}
export function bookObject(kind:BookKind,businessId:string,metadata:object,dependsOn:readonly string[],digest:BookFileDigest,limits:Limits):ObjectDescriptor{
 const metadataUtf8=JSON.stringify(metadata);
 const value:Omit<ObjectDescriptor,'objectId'>={kind,schemaVersion:1,businessId,contentVersion:digest.sha256,encoding:kind==='bookPackageCommit'?'none':'raw',size:digest.size,
  sha256:digest.sha256,chunkBytes:CHUNK_BYTES,chunkHashes:[...digest.chunkHashes],metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),dependsOn:[...dependsOn].sort()};
 return descriptor({...value,objectId:objectId(value)},limits);
}
