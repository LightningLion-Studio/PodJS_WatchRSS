import {fileChunks,hostOperation,type DownloadResult,type HostOperation} from '@podjs/framework/services';
import {base64ToBytes,bytesToBase64,utf8ToString} from '@podjs/framework/bytes';
import {watchAppVersion} from '../core/app-version.ts';

const MAX_BYTES=512*1024;
const CHUNK_BYTES=64*1024;

export interface LegalDocumentPorts {
 createTemp(directory:string):Promise<{path:string}>;
 download(args:Record<string,unknown>):HostOperation<DownloadResult>;
 read(path:string,offset:number,maxBytes:number):ReturnType<typeof fileChunks.read>;
 remove(path:string):Promise<unknown>;
}
const hostPorts:LegalDocumentPorts={
 createTemp:fileChunks.createTemp,
 download:args=>hostOperation<DownloadResult>('http.download',args),
 read:fileChunks.read,
 remove:fileChunks.remove,
};

/** Native legal documents are plain response text, including JSON/HTML-looking
 * content. The owned download file is transient and never enters app stores. */
export function fetchLegalDocument(url:string,ports:LegalDocumentPorts=hostPorts):HostOperation<string> {
 let path:string|undefined;
 let cancelled=false,settled=false,request:HostOperation<DownloadResult>|undefined;
 let rejectCancellation!:(reason:Error)=>void;
 const cancellation=new Promise<never>((_,reject)=>{rejectCancellation=reject;});
 const cancelledError=()=>new Error('协议正文请求已取消');
 const checkCancelled=()=>{if(cancelled)throw cancelledError();};
 const work=(async()=>{
  try {
   // The host reserves a new file atomically. A guessed path plus unconditional
   // cleanup could otherwise delete a pre-existing file after download refuses
   // to overwrite it. Release only our placeholder before temporary download.
   const temporary=await ports.createTemp('legal-documents');
   if(typeof temporary.path!=='string'||!/^legal-documents\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(temporary.path))throw Error('协议正文临时路径无效');
   path=temporary.path;checkCancelled();
   await ports.remove(path);checkCancelled();
   request=ports.download({url,path,temporary:true,maxBytes:MAX_BYTES,text:true,timeoutMs:8000,readTimeoutMs:12000,
    headers:{'Cache-Control':'no-cache, no-store','X-WatchRSS-App-Version':watchAppVersion}});
   const downloaded=await request.result;checkCancelled();
   if(!Number.isInteger(downloaded.status)||downloaded.status<200||downloaded.status>=300)throw Error(`协议正文请求失败：HTTP ${downloaded.status}`);
   if(downloaded.path!==path)throw Error('协议正文下载路径不匹配');
   if(!Number.isSafeInteger(downloaded.size)||downloaded.size<0||downloaded.size>MAX_BYTES)throw Error('协议正文下载大小无效');
   const bytes=new Uint8Array(downloaded.size);let offset=0;
   while(offset<bytes.length){
    checkCancelled();const maximum=Math.min(CHUNK_BYTES,bytes.length-offset);
    const chunk=await ports.read(path,offset,maximum);checkCancelled();
    if(chunk.offset!==offset||chunk.size!==bytes.length||typeof chunk.dataBase64!=='string'||chunk.dataBase64.length>4*Math.ceil(maximum/3))throw Error('协议正文读取范围不匹配');
    const part=base64ToBytes(chunk.dataBase64);
    if(!part.length||part.length>maximum||bytesToBase64(part)!==chunk.dataBase64||chunk.eof!==(offset+part.length===bytes.length))throw Error('协议正文下载不完整');
    bytes.set(part,offset);offset+=part.length;
   }
   checkCancelled();const text=utf8ToString(bytes).trim();
   if(!text)throw Error('协议正文为空');
   return text;
  }finally{
   // Never use the download result's path: it may refer to unrelated data.
   if(path!==undefined)try{await ports.remove(path);}catch{/* Host close also releases its temporary downloads. */}
  }
 })();
 const result=Promise.race([work,cancellation]).finally(()=>{settled=true;});
 return {result,cancel(){
  if(cancelled||settled)return;
  cancelled=true;rejectCancellation(cancelledError());
  try{request?.cancel();}catch{/* Delivery remains cancelled even if host dispatch fails. */}
 }};
}
