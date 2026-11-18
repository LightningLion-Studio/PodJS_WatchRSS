import type {SQLQueryBindings} from 'bun:sqlite';
import {createReadStream,createWriteStream} from 'node:fs';
import {open} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createGunzip,gzipSync} from 'node:zlib';
import {join} from 'node:path';
import type {binaryRuntime} from './library-binary-runtime';
import {nonce} from './library-binary-runtime';
import {initializeSchema} from '../../src/core/schema';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {SqlLibrarySessionRepository,type SqlLibraryRepositoryPorts} from '../../src/sync/library-repository';
import {objectId} from '../../src/sync/library-binary/digests';
import {CHUNK_BYTES,hash,utf8,type ObjectDescriptor} from '../../src/sync/library-binary/wire';

export async function attachBinaryLibrary(f:Awaited<ReturnType<typeof binaryRuntime>>,
 cleanupRemovedContent:SqlLibraryRepositoryPorts['cleanupRemovedContent']=async()=>{},
 bookFiles?:SqlLibraryRepositoryPorts['bookFiles']){
 f.db.transactionChanges=async statements=>f.sql.transaction(()=>statements.map(s=>f.sql.query(s.sql).run(...(s.params??[]) as SQLQueryBindings[]).changes))();
 await initializeSchema(f.db,{seedBuiltinChannels:false});
 await new SyncSavedStateStore(f.db).initializeDevice('watch');
 const fail=async()=>{throw Error('unexpected whole body operation');};
 const parseUri=async(value:string)=>{const u=new URL(value);return {valid:true,host:u.hostname,scheme:u.protocol.slice(0,-1),rawPath:u.pathname,rawQuery:u.search||null};};
 const repository=new SqlLibrarySessionRepository(f.db,{uri:{parseUri,parseAndroid:parseUri},
  codec:{encode:fail,decode:fail,sha256:async bytes=>hash(bytes)},text:{parseUri,htmlText:fail},
  files:{storeText:fail,hydrate:fail},migrateReading:async()=>{},cleanupRemovedContent,bookFiles});
 const readers=new Map<string,AsyncIterator<string>>();
 const files={...f.files,
  gunzip:async(path:string,max:number,allowPlain:boolean)=>{
   const src=join(f.root,path),out=(await f.files.createTemp('decoded')).path;let size=0;
   const header=await f.files.readBytes(path,0,2);
   const source=createReadStream(src,{highWaterMark:65536});
   const input=header.bytes[0]===31&&header.bytes[1]===139?source.pipe(createGunzip({chunkSize:65536})):source;
   if(input===source&&!allowPlain)throw Error('expected gzip');
   try{
    await pipeline(input,async function*(chunks:AsyncIterable<Uint8Array>){for await(const chunk of chunks){size+=chunk.length;if(size>max)throw Error('decompressed_content_too_large');yield chunk;}},createWriteStream(join(f.root,out)));
   }catch(error){await f.files.remove(out);throw error;}
   return {path:out,size};
  },
  openText:async(path:string)=>{
   const id=nonce();
   async function* decode(){
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const input=await open(join(f.root,path),'r'),buffer=Buffer.allocUnsafe(16381);
    try{
     let offset=0;
     while(true){
      const {bytesRead}=await input.read(buffer,0,buffer.length,offset);
      if(!bytesRead)break;
      offset+=bytesRead;
      const s=decoder.decode(buffer.subarray(0,bytesRead),{stream:true});if(s)yield s;
     }
     const tail=decoder.decode();if(tail)yield tail;
    }finally{await input.close();}
   }
   readers.set(id,decode());return {id};
  },
  readTextChunk:async(id:string)=>{const next=await readers.get(id)!.next();return {text:next.done?'':next.value,eof:next.done??false,invalidUtf8:false};},
  closeText:async(id:string)=>{await readers.get(id)?.return?.();readers.delete(id);}
 };
 f.ports.library={repository:async()=>repository,files};
 return {repository,files};
}

export function sampleArticle(businessId:string,contentText:string,kind:'articleBody'|'articleMetadata'='articleBody',
 changes:Readonly<Record<string,unknown>>={},encoded?:Uint8Array){
 const payload=kind==='articleBody'?(encoded??gzipSync(JSON.stringify({contentText}))):new Uint8Array(),sha256=hash(payload);
 const chunks=(n:number)=>Array.from({length:Math.ceil(payload.length/n)},(_,i)=>hash(payload.subarray(i*n,(i+1)*n)));
 const metadataUtf8=JSON.stringify({articleId:businessId,sourceDeviceId:'phone',url:'https://fixture.invalid/'+businessId,
  title:'Title '+businessId,siteName:'Fixture',excerpt:'summary',contentHash:'sample-content-hash',
  importedAt:20,updatedAt:30,independentSaved:true,independentChangedAt:20,independentSortOrder:20,
  favoriteSaved:true,favoriteChangedAt:30,favoriteSortOrder:30,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,
  deleted:false,deletedAt:0,readingProgress:0.5,readingPositionBytes:42,readingPositionContentHash:'sample-content-hash',
  readingPositionChangedAt:30,isRead:true,...changes,
  body:{metadataOnly:kind==='articleMetadata',bodyHash:payload.length?sha256:'',bodyByteCount:payload.length,chunkSize:payload.length?131072:0,chunkHashes:chunks(131072)}});
 const object:ObjectDescriptor={objectId:'',kind,businessId,schemaVersion:1,contentVersion:'1',
  encoding:kind==='articleBody'?'article-v14':'none',size:payload.length,sha256,chunkBytes:CHUNK_BYTES,chunkHashes:chunks(CHUNK_BYTES),
  metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),dependsOn:[]};
 object.objectId=objectId(object);
 return {object,payload};
}
