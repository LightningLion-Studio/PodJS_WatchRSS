import {encodeBase64 as bytesToBase64,base64ToBytes} from '@podjs/framework/bytes';
import type {SyncProgress} from './sync-progress';
import type {HttpTransport} from './types';
import type {CloudHostRequest} from './host-ports';
import {cloudDisabled,type CloudGuard} from './guard';
/** The pinned host preserves Android/OkHttp DNS, connect and TLS diagnostics in
 * the foreground and in the worker bridge. Generic timeouts are ambiguous. */
export function httpFailedBeforeSend(error:unknown):boolean {
 const {code,message}=(error??{}) as {code?:unknown;message?:unknown};
 if(typeof code==='string'&&/^(connect_timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)$/.test(code))return true;
 const diagnostic=code==='host_error'?message:code??message;
 return typeof diagnostic==='string'&&(
  /^(UnknownHostException|ConnectException|NoRouteToHostException)$/.test(diagnostic)||
  /^(unable to resolve host |failed to connect to |connect (?:timeout|timed out)\b)/i.test(diagnostic)||
  /^(?:javax\.net\.ssl\.)?SSL(?:Handshake|PeerUnverified)Exception(?::|$)/.test(diagnostic)||
  /^(?:java\.security\.cert\.)?(?:CertPathValidator|Certificate(?:Expired|NotYetValid)?)Exception(?::|$)/.test(diagnostic)||
  /^(?:Trust anchor for certification path not found\b|Chain validation failed\b|Hostname \S+ not verified\b)/i.test(diagnostic)
 );
}

// Keep six of the eight PodDeviceServices temp handles available to HTTP.
// Responses produced by http.download are tracked by PodHttpServices.
const HTTP_TEMP_HANDLES=6;
let reservedHandles=0;
const httpWaiters:{handles:number;resolve:()=>void}[]=[];
const drainHttpWaiters=()=>{
 while(httpWaiters.length&&reservedHandles+httpWaiters[0]!.handles<=HTTP_TEMP_HANDLES){
  const waiter=httpWaiters.shift()!;
  reservedHandles+=waiter.handles;
  waiter.resolve();
 }
};
const acquireHttpSlot=(handles:number)=>new Promise<void>(resolve=>{
 httpWaiters.push({handles,resolve});
 drainHttpWaiters();
});
const releaseHttpSlot=(handles:number)=>{
 reservedHandles-=handles;
 drainHttpWaiters();
};

/** Both directions are private files, bounded independently of guest event size.
 * Disable redirects so account tokens and signed upload credentials cannot cross origins. */
export function createCloudTransport(host:CloudHostRequest,guard:CloudGuard=cloudDisabled,options:{callTimeoutMs?:number;maxResponseBytes?:number;reuseInputName?:boolean;progress?:()=>SyncProgress|undefined}={}):HttpTransport {
 const maxResponseBytes=options.maxResponseBytes??8*1024*1024;
 return {async request(request){
  guard.require();if(!/^https:\/\/[^/@?#\\\s]+(?:\/|$)/i.test(request.url))throw Error('无效云地址');
  if((request.body?.length??0)>8*1024*1024)throw Error('云请求过大');
  const handles=options.reuseInputName?1:2;
  await acquireHttpSlot(handles);
  let output:string|undefined,input:string|undefined;
  try{
   guard.require();
   const createTemp=async()=>(await host<{path:string}>('file.createTemp',{directory:'cloud-http'})).path;
   const derivedResponse=options.reuseInputName&&!!request.body?.length;
   if(!derivedResponse)output=await createTemp();
   if(request.body?.length){input=await createTemp();
    // The reserved input name is unique. http.download creates its sibling
    // atomically and refuses an existing temporary target.
    output??=input+'.response';
    for(let offset=0;offset<request.body.length;offset+=32768){guard.require();const bytes=request.body.subarray(offset,offset+32768);const value=await host<{size:number}>('file.write',{path:input,append:true,expectedOffset:offset,dataBase64:bytesToBase64(bytes)});if(value.size!==offset+bytes.length)throw Error('云上传文件不完整');}
   }
   // createTemp reserves a unique name; download temporary=true requires a new target.
   if(!derivedResponse)await host('file.delete',{path:output});guard.require();
   request.beforeDispatch?.();
   const callTimeoutMs=request.callTimeoutMs??options.callTimeoutMs;
   const connectTimeoutMs=request.callTimeoutMs===undefined?15000:request.timeoutMs??15000;
   const finish=options.progress?.()?.request(request.method,request.url);
   const result=await host<{status:number;headers:Record<string,string>;size:number;path:string}>('http.download',{url:request.url,path:output,temporary:true,method:request.method,headers:request.headers,bodyPath:input,acceptHttpErrors:true,followRedirects:false,callTimeoutMs:callTimeoutMs??120000,timeoutMs:Math.min(connectTimeoutMs,callTimeoutMs??15000),readTimeoutMs:Math.min(callTimeoutMs??30000,30000),maxBytes:maxResponseBytes}).then(result=>{finish?.(request.body?.length??0,result.size);return result;},error=>{finish?.(0,0);throw error;});
   guard.require();if(result.path!==output||!Number.isSafeInteger(result.size)||result.size<0||result.size>maxResponseBytes)throw Error('无效云响应');
   const body=new Uint8Array(result.size);for(let offset=0;offset<body.length;){guard.require();const part=await host<{offset:number;size:number;dataBase64:string}>('file.read',{path:output,offset,maxBytes:32768});guard.require();const bytes=base64ToBytes(part.dataBase64);if(part.offset!==offset||part.size!==body.length||!bytes.length||bytes.length>body.length-offset)throw Error('云响应不完整');body.set(bytes,offset);offset+=bytes.length;}
   return {status:result.status,headers:result.headers,body};
  }finally{if(input)await host('file.delete',{path:input}).catch(()=>{});if(output)await host('file.delete',{path:output}).catch(()=>{});releaseHttpSlot(handles);}
 }};
}
