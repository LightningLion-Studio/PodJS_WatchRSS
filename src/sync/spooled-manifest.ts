import {fileChunks} from '@podjs/framework/services';
import type {FrameSpool} from '@podjs/framework/frame-stream';
import {decodeBase64Async,type CodecWorkOptions} from '@podjs/framework/bytes';
import {attachProjectedManifestRows,parseArticleManifestRow,type ArticleManifest} from './manifest';
import {parseWireJson} from './wire-json';
import type {JsonObject} from './protocol';

const headers = {
 action:null,phase:null,version:null,success:null,deviceId:null,sentAt:null,
 libraryMode:null,forceFull:null,fullSnapshot:null,fallbackReason:null,changeSeqRange:null,syncCursor:null,
 manifestBatchIndex:null,manifestBatchCount:null,manifestTotalArticles:null,
 requestPersistentSession:null,supportsPersistentSession:null,supportsManifestBatches:null,supportsArticleBatches:null,
 supportsChunkedBodies:null,supportsChangeSequences:null,supportsMetadataOnlyArticles:null,supportsFullMetadataOnlyArticles:null,
 supportsTransferByteProgress:null,supportsLibraryArticleCheckpoints:null,supportsDomainFastPathV2:null,
 supportsBookSyncV1:null,supportsBookReadingDeltaV1:null,supportsRssCanonicalIds:null
} as const;
type Files=Pick<typeof fileChunks,'projectJson'|'openText'|'readTextChunk'|'closeText'|'remove'|'read'>;

async function readRows<T>(files:Files,path:string,check:()=>void,map:(row:JsonObject)=>T|undefined):Promise<T[]> {
 const {id}=await files.openText(path,{strictUtf8:true});
 const rows:T[]=[];
 let line='';
 try {
  for(;;){
   check();
   const {text,eof,invalidUtf8}=await files.readTextChunk(id,8192);
   check();
   if(invalidUtf8)throw Error('Invalid manifest row UTF-8');
   let start=0;
   while(start<text.length){
    const newline=text.indexOf('\n',start);
    const end=newline<0?text.length:newline;
    if(line.length+end-start>256*1024)throw Error('Manifest row is too large');
    line+=text.slice(start,end);
    if(newline<0)break;
    if(line.trimStart().startsWith('{')){
     const value=map(parseWireJson(line));
     if(value!==undefined)rows.push(value);
    }
    line='';
    start=end+1;
   }
   if(eof){
    if(line)throw Error('Truncated manifest row');
    return rows;
   }
  }
 } finally {await files.closeText(id).catch(()=>{});}
}

export async function decodeSpooledSyncFrame(
 spool:FrameSpool,work:CodecWorkOptions,decode:(frame:Uint8Array,work:CodecWorkOptions)=>Promise<JsonObject>,
 files:Files=fileChunks
):Promise<JsonObject> {
 const check=()=>{if(work.cancelled?.())throw Error('Sync connection closed');};
 const project=async <T>(field:'articleManifest'|'rssSources',map:(row:JsonObject)=>T|undefined):Promise<[JsonObject,T[]]>=>{
  const result=await files.projectJson(spool.path,spool.size,{...headers,[field]:[null]},[],field).result;
  if(result.kind!=='object'||!result.path)throw Error('Invalid spooled sync JSON: '+result.kind);
  try {
   check();
   const header=parseWireJson(result.json);
   const rows=header.action==='syncLibrary'&&header.phase==='manifest'&&Array.isArray(header[field])
    ? await readRows(files,result.path,check,map)
    : [];
   return [header,rows];
  } finally {await files.remove(result.path).catch(()=>{});}
 };
 try {
  check();
  const [request,articles]=await project<ArticleManifest>('articleManifest',parseArticleManifestRow);
  if(request.action==='syncLibrary'&&request.phase==='manifest'){
   const [sourceHeader,sources]=await project('rssSources',row=>row);
   if(Array.isArray(sourceHeader.rssSources))request.rssSources=sources;
   attachProjectedManifestRows(request,articles);
   return request;
  }
  // Other legacy actions still use their existing codec and numeric rules.
  const frame=new Uint8Array(spool.size+4);
  new DataView(frame.buffer).setInt32(0,spool.size);
  for(let at=0;at<spool.size;){
   check();
   const result=await files.read(spool.path,at,Math.min(16*1024,spool.size-at));
   const bytes=await decodeBase64Async(result.dataBase64,work);
   if(result.size!==spool.size||!bytes.length||bytes.length>spool.size-at)throw Error('Invalid spooled frame length');
   frame.set(bytes,at+4);
   at+=bytes.length;
  }
  return await decode(frame,work);
 } finally {await files.remove(spool.path).catch(()=>{});}
}
