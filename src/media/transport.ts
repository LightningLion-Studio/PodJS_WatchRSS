import {readDownloadedBytes,withOwnedPrivateFile} from '@podjs/framework/private-response';
import {appLogger} from '../logs/app-logger.ts';
import {mediaRequestFailure} from '../douyin/errors.ts';
import type {HttpRequest,HttpResponse,HttpTransport} from '../cloud/types.ts';
import type {DownloadResult} from '@podjs/framework/services';
import {videoOptEnabled} from './video-opt.ts';
import {videoResponseBudget} from './traffic-policy.ts';

export interface MediaTransportPorts {
  download(args:Record<string,unknown>,background?:import('../cloud/types.ts').RequestLifetime):Promise<DownloadResult>;
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
    return withOwnedPrivateFile(path,path=>ports.remove(path),async path=>{
      if(request.background&&!request.background.isCurrent())throw Error("cancelled");
      const response=await ports.download({url:request.url,path,method:request.method,bodyBase64:request.body?ports.base64(request.body):undefined,headers:request.headers,maxBytes:videoResponseBudget(request.url,videoOptEnabled('traffic')),
        timeoutMs:request.timeoutMs??30000,...(request.readTimeoutMs===undefined?{}:{readTimeoutMs:request.readTimeoutMs}),...(request.acceptHttpErrors===undefined?{}:{acceptHttpErrors:request.acceptHttpErrors})},request.background);
      const bytes=await readDownloadedBytes(path,response.size,(path,offset)=>ports.read(path,offset),()=>Error('服务器响应下载不完整'));
      appLogger.i('Network',`media response status=${response.status} bytes=${response.size}`);
      return {status:response.status,headers:response.headers,body:bytes};
    },error=>{
      const failure=mediaRequestFailure(error);
      appLogger.e('Network',`media request failed category=${failure.category}${failure.status===undefined?'':` status=${failure.status}`}`);
    });
  }};
}
