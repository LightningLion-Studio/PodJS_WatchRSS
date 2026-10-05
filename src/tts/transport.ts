import {appLogger} from '../logs/app-logger.ts';
import {hostOperation,fileChunks,bytesToBase64,base64ToBytes,type DownloadResult} from '@podjs/framework/services';
import type {HttpTransport} from '../cloud/types.ts';

const MAX_BYTES=8*1024*1024;
const CHUNK_BYTES=64*1024;
export interface TtsTransportPorts {
 createTemp(directory:string):Promise<{path:string}>;
 download(args:Record<string,unknown>):Promise<DownloadResult>;
 read(path:string,offset:number,maxBytes:number):ReturnType<typeof fileChunks.read>;
 remove(path:string):Promise<unknown>;
}
const hostPorts:TtsTransportPorts={
 createTemp:fileChunks.createTemp,
 download:args=>hostOperation<DownloadResult>('http.download',args).result,
 read:fileChunks.read,
 remove:fileChunks.remove,
};
/** Read JSON/hex, base64 JSON, or raw MP3 through an owned private download file. */
export function createTtsTransport(ports:TtsTransportPorts=hostPorts):HttpTransport{return {async request(request){
 appLogger.d('Network',`${request.method} ${request.url}`);
 let path:string|undefined;
 try{
  const temporary=await ports.createTemp('tts');
  if(typeof temporary.path!=='string'||!/^tts\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(temporary.path))throw Error('语音临时路径无效');
  path=temporary.path;
  await ports.remove(path);
  const response=await ports.download({url:request.url,path,temporary:true,method:request.method,headers:request.headers,bodyBase64:request.body?bytesToBase64(request.body):undefined,acceptHttpErrors:true,timeoutMs:15000,readTimeoutMs:60000,maxBytes:MAX_BYTES});
  if(response.path!==path||!Number.isSafeInteger(response.size)||response.size<0||response.size>MAX_BYTES)throw Error('语音服务响应大小或路径无效');
  const body=new Uint8Array(response.size);
  for(let offset=0;offset<body.length;){
   const maximum=Math.min(CHUNK_BYTES,body.length-offset);
   const chunk=await ports.read(path,offset,maximum);
   if(chunk.offset!==offset||chunk.size!==body.length||typeof chunk.dataBase64!=='string'||chunk.dataBase64.length>4*Math.ceil(maximum/3))throw Error('语音服务响应下载不完整');
   const part=base64ToBytes(chunk.dataBase64);
   if(!part.length||part.length>maximum||bytesToBase64(part)!==chunk.dataBase64||chunk.eof!==(offset+part.length===body.length))throw Error('语音服务响应下载不完整');
   body.set(part,offset);offset+=part.length;
  }
  appLogger.i('Network',`response status=${response.status} bytes=${body.length}`);
  return {status:response.status,headers:response.headers,body};
 }catch(error){appLogger.e('Network','Request failed',error);throw error;}finally{if(path!==undefined)await ports.remove(path).catch(()=>{});}
}};}
export const ttsTransport=createTtsTransport();
