import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {lengthPrefix} from '@podjs/framework/crypto';
import {bookId,bookFingerprint,chapterHash,BOOK_MAX_PACKAGE_BYTES,type BookState} from '../../src/books/protocol';
import type {BookFiles} from '../../src/books/files';
import type {BinaryBookFiles} from '../../src/sync/library-binary/book-import';
import {BOOK_SEGMENT_BYTES,bookObject} from '../../src/sync/library-binary/book-plan';
import {CHUNK_BYTES,HARD_LIMITS,hash,utf8,type ObjectDescriptor} from '../../src/sync/library-binary/wire';
import {attachBinaryLibrary} from './library-binary-kinds';
import type {binaryRuntime} from './library-binary-runtime';

export async function attachBinaryBooks(f:Awaited<ReturnType<typeof binaryRuntime>>){
 const unexpected=async():Promise<never>=>{throw Error('unexpected legacy package operation');};
 const legacy:BookFiles={
  read:(path,offset,max)=>f.files.readBytes(path,offset,max),stat:async path=>{const r=await f.files.stat(path);return {exists:r.file,size:r.size};},
  hash:f.files.hash,remove:f.files.remove,publish:unexpected,write:unexpected,writeBytes:unexpected,lines(){throw Error('unexpected legacy package operation');},combine:unexpected,
 };
 const {repository,files:article}=await attachBinaryLibrary(f,undefined,legacy);
 const files:BinaryBookFiles={...article,durableCommit:f.files.commit,durableRemove:f.files.remove,copyRanges:async options=>{
  const total=createHash('sha256'),partHashes=[];if(options.prefix)total.update(Uint8Array.from(options.prefix));
  let size=0,partSize=0,parts=createHash('sha256'),chunkHashes:string[]=[];
  const output=options.target?await open(join(f.root,options.target),'w'):undefined;
  const buffer=Buffer.allocUnsafe(CHUNK_BYTES);
  try{
   for(const range of options.ranges){
    const source=await open(join(f.root,range.path),'r');
    try{
     for(let offset=0;offset<range.size;){
      const length=Math.min(range.size-offset,buffer.length),result=await source.read(buffer,0,length,range.offset+offset);
      if(result.bytesRead!==length)throw Error('SOURCE_CHANGED');
      const bytes=buffer.subarray(0,length);total.update(bytes);await output?.write(bytes);
      offset+=length;size+=length;
      if(options.index){
       chunkHashes.push(hash(bytes));parts.update(bytes);partSize+=length;
       if(partSize===options.segmentBytes||size===options.size){
        partHashes.push({size:partSize,sha256:parts.digest('hex'),chunkHashes});
        chunkHashes=[];parts=createHash('sha256');partSize=0;
       }
      }
     }
    }finally{await source.close();}
   }
   const sha256=total.digest('hex');
   if(size!==options.size||options.sha256&&options.sha256!==sha256)throw Error('HASH_MISMATCH');
   await output?.sync();
   return {size,sha256,segments:partHashes};
  }finally{await output?.close();}
 }};
 f.ports.books=files;
 return {repository,files};
}

export async function sampleBook(f:Awaited<ReturnType<typeof binaryRuntime>>,files:BinaryBookFiles,bytes:number,title='Chapter one',exactPackageChapters?:number){
 const sourceUrl='https://watchrss.local/import-txt-novel/b2-fixture',chapterCount=exactPackageChapters??1;
 const sha=async(value:Uint8Array)=>hash(value);
 const header=JSON.stringify({format:'watchrss-book',version:1,title:'Sample book',chapterCount,sourceUrl,kind:'txt'})+'\n';
 const chapter=(i:number,contentText:string)=>({chapterIndex:i,url:sourceUrl+'/chapter/'+i,title:chapterCount===1?title:'Chapter '+i,contentHtml:null,contentText});
 let fingerprint:string;
 let write:(path:string)=>Promise<void>;
 if(exactPackageChapters){
  const chapters=Array.from({length:chapterCount},(_,i)=>chapter(i+1,''));
  const budget=bytes-utf8(header+chapters.map(value=>JSON.stringify(value)+'\n').join('')).length;
  for(const [i,value] of chapters.entries())value.contentText='x'.repeat(Math.floor(budget/chapterCount)+(i<budget%chapterCount?1:0));
  fingerprint=await bookFingerprint(await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,sha))),sha);
  write=async path=>{await f.files.writeBytes(path,utf8(header+chapters.map(value=>JSON.stringify(value)+'\n').join('')));};
 }else{
  const block=Buffer.alloc(CHUNK_BYTES,120),textHash=createHash('sha256').update(lengthPrefix('watchrss/book/chapter/v1',1,title));
  const length=Buffer.alloc(4);length.writeUInt32BE(bytes);textHash.update(length);
  for(let at=0;at<bytes;at+=CHUNK_BYTES)textHash.update(block.subarray(0,Math.min(bytes-at,block.length)));
  fingerprint=hash(lengthPrefix('watchrss/book/fingerprint/v1',1,textHash.digest('hex')));
  write=async path=>{
   const head=utf8(header+JSON.stringify(chapter(1,'')).slice(0,-2));
   await f.files.writeBytes(path,head);
   const file=await open(join(f.root,path),'a');
   try{
    for(let at=0;at<bytes;at+=CHUNK_BYTES)await file.write(block.subarray(0,Math.min(bytes-at,block.length)));
    await file.write('"}\n');await file.sync();
   }finally{await file.close();}
  };
 }
 const id=await bookId(fingerprint,sha);
 const state:BookState={bookId:id,fingerprint,title:'Sample book',chapterCount,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:20,sourceDeviceId:'phone',sourceUrl,kind:'txt'};
 const path='books/'+id+'-source.jsonl';
 await write(path);
 const info=await f.files.hash(path);
 if(info.size>BOOK_MAX_PACKAGE_BYTES)throw Error('fixture size');
 const index=await files.copyRanges({ranges:[{path,offset:0,size:info.size}],size:info.size,index:true,segmentBytes:BOOK_SEGMENT_BYTES});
 const payloads=new Map<string,Uint8Array>();
 const makeJson=(kind:'bookState'|'bookReading',businessId:string,metadata:object,deps:string[],value:unknown)=>{
  const payload=utf8(JSON.stringify(value)),d=bookObject(kind,businessId,metadata,deps,{size:payload.length,sha256:hash(payload),chunkHashes:[hash(payload)]},HARD_LIMITS);
  payloads.set(d.objectId,payload);return d;
 };
 const stateObject=makeJson('bookState',id,{bookId:id},[],state);
 const key={bookId:id,fingerprint,packageSha256:info.sha256,packageBytes:info.size};
 const segments=index.segments.map((digest,segmentIndex)=>bookObject('bookPackageSegment',[id,info.sha256,segmentIndex].join(':'),
  {...key,segmentIndex,segmentCount:index.segments.length,segmentOffset:segmentIndex*BOOK_SEGMENT_BYTES},[stateObject.objectId],digest,HARD_LIMITS));
 const segmentObjectIds=segments.map(d=>d.objectId);
 const commit=bookObject('bookPackageCommit',id,{...key,segmentObjectIds},[stateObject.objectId,...segmentObjectIds],{size:0,sha256:hash(new Uint8Array()),chunkHashes:[]},HARD_LIMITS);
 const reading=makeJson('bookReading',id+':0',{bookId:id,pageIndex:0},[stateObject.objectId],[{
  bookId:id,chapterIndex:1,isRead:false,readingProgress:0.5,readingPositionBytes:10,readingPositionContentHash:'',readingPositionChangedAt:21,sourceDeviceId:'phone',favoriteSaved:true,favoriteChangedAt:22,favoriteSortOrder:23,
 }]);
 return {state,stateObject,reading,segments,commit,path,info,objects:[stateObject,reading,...segments,commit].sort((a,b)=>a.objectId.localeCompare(b.objectId)),
  read:async(d:ObjectDescriptor,i:number)=>{
   const p=payloads.get(d.objectId);if(p)return p;
   const section=segments.findIndex(v=>v.objectId===d.objectId),offset=i*CHUNK_BYTES;
   return (await f.files.readBytes(path,section*BOOK_SEGMENT_BYTES+offset,Math.min(CHUNK_BYTES,d.size-offset))).bytes;
  }};
}
