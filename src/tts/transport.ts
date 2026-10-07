import {readDownloadedChunks,withOwnedPrivateFile} from '@podjs/framework/private-response';
import {appLogger} from '../logs/app-logger.ts';
import {hostOperation,fileChunks,bytesToBase64,type DownloadResult} from '@podjs/framework/services';
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
 appLogger.d('Network',`${request.method} TTS request`);
 return withOwnedPrivateFile(async()=>{
  const temporary=await ports.createTemp('tts');
  if(typeof temporary.path!=='string'||!/^tts\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(temporary.path))throw Error('语音临时路径无效');
  return temporary.path;
 },path=>ports.remove(path),async path=>{
  await ports.remove(path);
  const response=await ports.download({url:request.url,path,temporary:true,method:request.method,headers:request.headers,bodyBase64:request.body?bytesToBase64(request.body):undefined,acceptHttpErrors:true,timeoutMs:15000,readTimeoutMs:60000,maxBytes:MAX_BYTES});
  const body=await readDownloadedChunks(path,response,(path,offset,maxBytes)=>ports.read(path,offset,maxBytes),{maxBytes:MAX_BYTES,chunkBytes:CHUNK_BYTES,invalidResponse:()=>Error('语音服务响应大小或路径无效'),incomplete:()=>Error('语音服务响应下载不完整')});
  appLogger.i('Network',`response status=${response.status} bytes=${body.length}`);
  return {status:response.status,headers:response.headers,body};
 },()=>appLogger.e('Network','Request failed'));
}};}
export const ttsTransport=createTtsTransport();
