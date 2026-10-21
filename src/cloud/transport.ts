import {bytesToBase64,base64ToBytes} from '@podjs/framework/bytes';
import type {HttpTransport} from './types';
import type {CloudHostRequest} from './host-ports';
import {cloudDisabled,type CloudGuard} from './guard';
/** Both directions are private files, bounded independently of guest event size.
 * Disable redirects so account tokens and signed upload credentials cannot cross origins. */
export function createCloudTransport(host:CloudHostRequest,guard:CloudGuard=cloudDisabled,options:{callTimeoutMs?:number}={}):HttpTransport {
 return {async request(request){
  guard.require();if(!/^https:\/\/[^/@?#\\\s]+(?:\/|$)/i.test(request.url))throw Error('无效云地址');
  if((request.body?.length??0)>8*1024*1024)throw Error('云请求过大');
  const output=await host<{path:string}>('file.createTemp',{directory:'cloud-http'});let input:string|undefined;
  try{
   if(request.body?.length){input=(await host<{path:string}>('file.createTemp',{directory:'cloud-http'})).path;
    for(let offset=0;offset<request.body.length;offset+=32768){guard.require();const bytes=request.body.subarray(offset,offset+32768);const value=await host<{size:number}>('file.write',{path:input,append:true,expectedOffset:offset,dataBase64:bytesToBase64(bytes)});if(value.size!==offset+bytes.length)throw Error('云上传文件不完整');}
   }
   // createTemp reserves a unique name; download temporary=true requires a new target.
   await host('file.delete',{path:output.path});guard.require();
   const result=await host<{status:number;headers:Record<string,string>;size:number;path:string}>('http.download',{url:request.url,path:output.path,temporary:true,method:request.method,headers:request.headers,bodyPath:input,acceptHttpErrors:true,followRedirects:false,callTimeoutMs:options.callTimeoutMs??120000,timeoutMs:Math.min(options.callTimeoutMs??15000,15000),readTimeoutMs:Math.min(options.callTimeoutMs??30000,30000),maxBytes:8*1024*1024});
   if(result.path!==output.path||!Number.isSafeInteger(result.size)||result.size<0||result.size>8*1024*1024)throw Error('无效云响应');
   const body=new Uint8Array(result.size);for(let offset=0;offset<body.length;){guard.require();const part=await host<{offset:number;size:number;dataBase64:string}>('file.read',{path:output.path,offset,maxBytes:32768});const bytes=base64ToBytes(part.dataBase64);if(part.offset!==offset||part.size!==body.length||!bytes.length||bytes.length>body.length-offset)throw Error('云响应不完整');body.set(bytes,offset);offset+=bytes.length;}
   return {status:result.status,headers:result.headers,body};
  }finally{if(input)await host('file.delete',{path:input}).catch(()=>{});await host('file.delete',{path:output.path}).catch(()=>{});}
 }};
}
