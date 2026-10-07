import {appLogger} from '../logs/app-logger.ts';
import {mediaRequestFailure} from '../douyin/errors.ts';
import type {HttpRequest,HttpResponse,HttpTransport} from '../cloud/types.ts';
import type {DownloadResult} from '@podjs/framework/services';

export interface MediaTransportPorts {
  download(args:Record<string,unknown>):Promise<DownloadResult>;
  read(path:string,offset:number):Promise<Uint8Array>;
  remove(path:string):Promise<unknown>;
  base64(bytes:Uint8Array):string;
}
/** GET/POST responses stream to private files with a bounded 8 MiB JSON read. */
export function createMediaTransport(ports:MediaTransportPorts):HttpTransport {
  let sequence=0;
  return {async request(request:HttpRequest):Promise<HttpResponse>{
    if(request.method!=='GET'&&request.method!=='POST')throw new Error('Unsupported media request method');
    // A request path is useful for diagnosis; signed query strings and headers are not.
    appLogger.d('Network',`${request.method} media request`);
    const path=`media-json/request-${Date.now()}-${++sequence}.json`;
    try{
      const response=await ports.download({url:request.url,path,method:request.method,bodyBase64:request.body?ports.base64(request.body):undefined,headers:request.headers,maxBytes:8*1024*1024,
        timeoutMs:request.timeoutMs??30000,...(request.readTimeoutMs===undefined?{}:{readTimeoutMs:request.readTimeoutMs}),...(request.acceptHttpErrors===undefined?{}:{acceptHttpErrors:request.acceptHttpErrors})});
      const bytes=new Uint8Array(response.size);let offset=0;
      while(offset<bytes.length){
        const chunk=await ports.read(path,offset);
        if(!chunk.length||offset+chunk.length>bytes.length)throw new Error('服务器响应下载不完整');
        bytes.set(chunk,offset);offset+=chunk.length;
      }
      appLogger.i('Network',`media response status=${response.status} bytes=${response.size}`);
      return {status:response.status,headers:response.headers,body:bytes};
    }catch(error){
      const failure=mediaRequestFailure(error);
      appLogger.e('Network',`media request failed category=${failure.category}${failure.status===undefined?'':` status=${failure.status}`}`);
      throw error;
    }finally{await ports.remove(path).catch(()=>{});}
  }};
}
