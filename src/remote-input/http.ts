import {readHttpRequest} from "@podjs/framework/http-request";
import {appLogger} from '../logs/app-logger.ts';
import {EXPORT_ABILITIES,historyPayload,playbackPayload,historyFailure,type HttpExportSession} from './exports.ts';
import {nativeTrim} from '../sync/local-manifest.ts';
import {wireFields} from "../sync/article-batches.ts";
import { stringToUtf8, utf8ToString } from '@podjs/framework/bytes';
import type { SyncByteStream } from '../sync/stream.ts';
import { remoteInputLanding } from './landing.ts';
export const REMOTE_INPUT_ABILITY = {code:'dc40517c-a09c-419c-8c4d-d3883258992e',name:'RSS订阅输入',version:'0.0.1'};
export const MAX_REMOTE_INPUT_BODY = 65536;
export interface RemoteHttpRequest { method?:string; target:string; headers:Record<string,string>; body:string }
export interface RemoteHttpResponse { status:number; type:string; body:string; url?:string }
/** One request per connection; routes and native limits stay application-owned. */
export function readRemoteHttpRequest(stream:SyncByteStream,now=Date.now):Promise<RemoteHttpRequest>{return readHttpRequest(stream,{now,timeoutMs:15000,readBytes:4096,maxHeaderBytes:16384,maxBodyBytes:MAX_REMOTE_INPUT_BODY});}
const json=(status:number,value:unknown,url?:string):RemoteHttpResponse=>{const body=JSON.stringify(value);return {status,type:/[^\x00-\x7f]/.test(body)?'application/json; charset=UTF-8':'application/json',body,url};};
function parameter(query:string,key:string):string {for(const pair of query.split('&')){const at=pair.indexOf('=');const decode=(s:string)=>decodeURIComponent(s.replace(/\+/g,' '));if(decode(at<0?pair:pair.slice(0,at))===key)return decode(at<0?'':pair.slice(at+1));}return '';}
export function routeRemoteHttp(request:RemoteHttpRequest,exportSession?:HttpExportSession):RemoteHttpResponse {
 const ability=exportSession?EXPORT_ABILITIES[exportSession.mode]:REMOTE_INPUT_ABILITY;
 const split=request.target.indexOf('?'),path=split<0?request.target:request.target.slice(0,split),query=split<0?'':request.target.slice(split+1);
 if(path==='/')return {status:200,type:'text/html; charset=utf-8',body:remoteInputLanding};
 if(path==='/health')return json(200,{status:'ok'});
 if(path==='/getCurrentActivationAbility')return json(200,ability);
 if(path==='/getAbilities')return json(200,{status:'ok',abilities:[ability]});
 if(path==='/getLLMSummaryConfig'||path==='/setLLMSummaryConfig')return json(410,{success:false,message:'LLM BYOK configuration is no longer supported'});
 if(exportSession||path!=='/remoteEnterRSSURL')return {status:404,type:'text/plain',body:'Not Found'};
 let url='';
 if(request.headers['content-type']?.split(';',1)[0].trim().toLowerCase()==='application/x-www-form-urlencoded')url=parameter(request.body,'url')||parameter(query,'url');
 else if(wireFields.trim(request.body)){
  try{const object=JSON.parse(request.body);if(!object||Array.isArray(object)||typeof object!=='object')throw new Error('Not an object');url=wireFields.string(object.url);}
  catch{url=request.body;}
 }else url=parameter(query,'url');
 return wireFields.trim(url)?json(200,{success:true,message:'操作成功'},url):json(400,{success:false,message:'URL is required'});
}
/** Native export servers are isolated by ability and do not use TTS pairing tokens. */
export async function routeRemoteExportHttp(request:RemoteHttpRequest,session:HttpExportSession):Promise<RemoteHttpResponse>{
 const [path,query='']=request.target.split('?',2);
 const savedType=path==='/getFavorites'&&session.mode==='favorite'?'favorite':path==='/getWatchlaterList'&&session.mode==='watchLater'?'watchLater':undefined;
 const history=path==='/getBiliWatchHistory'&&session.mode==='bili';
 const progress=path==='/getBiliPlaybackProgress'&&session.mode==='bili';
 if(!savedType&&!history&&!progress)return routeRemoteHttp(request,session);
 try{
  let data:unknown;
  if(savedType)data=(await session.source.readSavedLinks(savedType)).map(nativeTrim).filter(Boolean).map(link=>({link}));
  else if(history){
   // Kotlin toLongOrNull rejects whitespace, decimals and overflow; first query value wins.
   const long=(value:string)=>{if(!/^[+-]?[0-9]+$/.test(value))return undefined;const n=BigInt(value);return n< -9223372036854775808n||n>9223372036854775807n?undefined:Number(n);};
   const max=long(parameter(query,'max')),viewAt=long(parameter(query,'view_at'))??long(parameter(query,'viewAt')),business=nativeTrim(parameter(query,'business'))||undefined;
   const cursor=max===undefined&&viewAt===undefined&&business===undefined?undefined:{max,viewAt,business};
   let page;
   try{page=await session.source.history(cursor);}catch(error){appLogger.e("LocalHttpServer","handleGetBiliWatchHistory failed");return json(200,historyFailure(error));}
   data=historyPayload(page);
  }else data=playbackPayload(await session.source.playbackProgress());
  session.onComplete?.();
  return json(200,{success:true,data});
 }catch(error){appLogger.e('LocalHttpServer',savedType==='favorite'?'handleGetFavorites failed':savedType==='watchLater'?'handleGetWatchLater failed':history?'handleGetBiliWatchHistory failed':'handleGetBiliPlaybackProgress failed');return json(500,{success:false,message:error instanceof Error?error.message:'Unknown error',...(history||progress?{data:null}:{})});}
}
export async function serveRemoteHttp(stream:SyncByteStream,isActive:()=>boolean,onUrl:(url:string)=>void,exportSession?:HttpExportSession):Promise<void> {
 let response:RemoteHttpResponse;
 try{const request=await readRemoteHttpRequest(stream);response=exportSession?await routeRemoteExportHttp(request,exportSession):routeRemoteHttp(request);}
 catch{if(!exportSession)appLogger.e('LocalHttpServer','handleRemoteInput failed');response=json(400,{success:false,message:'请求正文无效或过大'});}
 try{
  if(!isActive())return;
  await writeRemoteHttpResponse(stream,isActive,response);
  if(isActive()&&response.url!==undefined)onUrl(response.url);
 }finally{await stream.close();}
}
export async function writeRemoteHttpResponse(stream:SyncByteStream,isActive:()=>boolean,response:RemoteHttpResponse):Promise<void>{
 const body=stringToUtf8(response.body),reason=({200:'OK',400:'Bad Request',401:'Unauthorized',404:'Not Found',410:'Gone',500:'Internal Server Error'} as Record<number,string>)[response.status]??'Error';
 const header=stringToUtf8(`HTTP/1.1 ${response.status} ${reason}\r\nContent-Type: ${response.type}\r\nContent-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`);
 if(!isActive())return;await stream.write(header);for(let at=0;at<body.length;at+=65536){if(!isActive())return;await stream.write(body.subarray(at,at+65536));}
}
export function remoteInputQrContent(address:string,port:number):string {
 return `http://${address}:${port}/#请将手机和手表连上同一个WiFi再扫码`;
}
