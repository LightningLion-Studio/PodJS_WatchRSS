import {wireFields} from "../sync/article-batches.ts";
import { stringToUtf8, utf8ToString } from '@podjs/framework/bytes';
import type { SyncByteStream } from '../sync/stream.ts';
import { remoteInputLanding } from './landing.ts';
export const REMOTE_INPUT_ABILITY = {code:'dc40517c-a09c-419c-8c4d-d3883258992e',name:'RSS订阅输入',version:'0.0.1'};
export const MAX_REMOTE_INPUT_BODY = 65536;
export interface RemoteHttpRequest { method?:string; target:string; headers:Record<string,string>; body:string }
export interface RemoteHttpResponse { status:number; type:string; body:string; url?:string }
class InvalidRequest extends Error {}
/** One request per connection, with a whole-request deadline and bounded buffers. */
export async function readRemoteHttpRequest(stream:SyncByteStream,now=Date.now):Promise<RemoteHttpRequest> {
 const deadline=now()+15000;let buffer:Uint8Array=new Uint8Array(0);let offset=0,headerBytes=0;
 const read=async(length:number):Promise<Uint8Array>=>{
  const out=new Uint8Array(length);let used=0;
  while(used<length){if(offset===buffer.length){const remaining=deadline-now();if(remaining<=0)throw new InvalidRequest('Request timed out');const bytes=await stream.read(4096,remaining);if(!bytes?.length||bytes.length>4096||now()>deadline)throw new InvalidRequest('Truncated request');buffer=bytes;offset=0;}
   const count=Math.min(length-used,buffer.length-offset);out.set(buffer.subarray(offset,offset+count),used);used+=count;offset+=count;
  }return out;
 };
 const line=async():Promise<string>=>{const bytes:number[]=[];while(true){if(++headerBytes>16384)throw new InvalidRequest('Headers too large');const b=(await read(1))[0];if(b===10){if(bytes.pop()!==13)throw new InvalidRequest('Invalid line ending');return utf8ToString(new Uint8Array(bytes));}bytes.push(b);}};
 const start=await line(),match=/^[A-Z]+ ([^\s]+) HTTP\/1\.[01]$/.exec(start);if(!match||!match[1].startsWith('/'))throw new InvalidRequest('Invalid request line');
 const headers:Record<string,string>=Object.create(null);
 while(true){const value=await line();if(!value)break;const colon=value.indexOf(':');if(colon<1)throw new InvalidRequest('Invalid header');const key=value.slice(0,colon).toLowerCase();if(!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key))throw new InvalidRequest('Invalid header');if(headers[key]!==undefined&&(key==='content-length'||key==='transfer-encoding'))throw new InvalidRequest('Duplicate framing');headers[key]=value.slice(colon+1).trim();}
 let bytes:Uint8Array;
 if(headers['transfer-encoding']){
  if(headers['content-length']!==undefined||headers['transfer-encoding'].toLowerCase()!=='chunked')throw new InvalidRequest('Invalid transfer encoding');
  const parts:Uint8Array[]=[];let size=0;
  while(true){const encoded=(await line()).split(';',1)[0];if(!/^[0-9a-f]+$/i.test(encoded))throw new InvalidRequest('Invalid chunk');const count=parseInt(encoded,16);if(!Number.isSafeInteger(count)||count>MAX_REMOTE_INPUT_BODY-size)throw new InvalidRequest('Body too large');
   if(count===0){while(await line()){}break;}parts.push(await read(count));size+=count;if(await line()!=='')throw new InvalidRequest('Invalid chunk ending');
  }bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
 }else{
  const length=headers['content-length']??'0';if(!/^\d+$/.test(length)||Number(length)>MAX_REMOTE_INPUT_BODY)throw new InvalidRequest('Body too large');bytes=await read(Number(length));
 }
 return {method:start.slice(0,start.indexOf(' ')),target:match[1],headers,body:utf8ToString(bytes)};
}
const json=(status:number,value:unknown,url?:string):RemoteHttpResponse=>{const body=JSON.stringify(value);return {status,type:/[^\x00-\x7f]/.test(body)?'application/json; charset=UTF-8':'application/json',body,url};};
function parameter(query:string,key:string):string {for(const pair of query.split('&')){const at=pair.indexOf('=');const decode=(s:string)=>decodeURIComponent(s.replace(/\+/g,' '));if(decode(at<0?pair:pair.slice(0,at))===key)return decode(at<0?'':pair.slice(at+1));}return '';}
export function routeRemoteHttp(request:RemoteHttpRequest):RemoteHttpResponse {
 const split=request.target.indexOf('?'),path=split<0?request.target:request.target.slice(0,split),query=split<0?'':request.target.slice(split+1);
 if(path==='/')return {status:200,type:'text/html; charset=utf-8',body:remoteInputLanding};
 if(path==='/health')return json(200,{status:'ok'});
 if(path==='/getCurrentActivationAbility')return json(200,REMOTE_INPUT_ABILITY);
 if(path==='/getAbilities')return json(200,{status:'ok',abilities:[REMOTE_INPUT_ABILITY]});
 if(path==='/getLLMSummaryConfig'||path==='/setLLMSummaryConfig')return json(410,{success:false,message:'LLM BYOK configuration is no longer supported'});
 if(path!=='/remoteEnterRSSURL')return {status:404,type:'text/plain',body:'Not Found'};
 let url='';
 if(request.headers['content-type']?.split(';',1)[0].trim().toLowerCase()==='application/x-www-form-urlencoded')url=parameter(request.body,'url')||parameter(query,'url');
 else if(wireFields.trim(request.body)){
  try{const object=JSON.parse(request.body);if(!object||Array.isArray(object)||typeof object!=='object')throw new Error('Not an object');url=wireFields.string(object.url);}
  catch{url=request.body;}
 }else url=parameter(query,'url');
 return wireFields.trim(url)?json(200,{success:true,message:'操作成功'},url):json(400,{success:false,message:'URL is required'});
}
export async function serveRemoteHttp(stream:SyncByteStream,isActive:()=>boolean,onUrl:(url:string)=>void):Promise<void> {
 let response:RemoteHttpResponse;
 try{response=routeRemoteHttp(await readRemoteHttpRequest(stream));}
 catch{response=json(400,{success:false,message:'请求正文无效或过大'});}
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
