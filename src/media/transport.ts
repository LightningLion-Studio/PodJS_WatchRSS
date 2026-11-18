import {readDownloadedBytes,withOwnedPrivateFile} from '@podjs/framework/private-response';
import {appLogger} from '../logs/app-logger.ts';
import {MediaResponseReadError,mediaRequestFailure} from '../douyin/errors.ts';
import type {HttpRequest,HttpResponse,HttpTransport} from '../cloud/types.ts';
import type {DownloadResult} from '@podjs/framework/services';
import {videoOptEnabled} from './video-opt.ts';
import {videoResponseBudget} from './traffic-policy.ts';

export interface MediaTransportPorts {
  download(args:Record<string,unknown>,background?:import('../cloud/types.ts').RequestLifetime):Promise<DownloadResult>;
  read(path:string,offset:number):Promise<Uint8Array>;
  readPortable?(path:string,offset:number):Promise<Uint8Array>;
  project?(path:string,size:number,projection:NonNullable<HttpRequest['fileProjection']>,background?:HttpRequest['background']):Promise<NonNullable<HttpResponse['fileProjection']>['value']>;
  remove(path:string):Promise<unknown>;
  base64(bytes:Uint8Array):string;
}

function byteBridgeBusy(error:unknown):boolean {
  const value=error as {code?:unknown;message?:unknown}|null;
  return value?.code==='busy'&&value.message==='Byte bridge full';
}

function projectionUnavailable(error:unknown):boolean {
  const value=error as {code?:unknown;message?:unknown}|null;
  return value?.code==='unsupported'||value?.code==='invalid_argument'&&value.message==='unsupported_method:file.projectJson';
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
      if(request.fileProjection&&ports.project){
        if(request.background&&!request.background.isCurrent())throw Error('cancelled');
        try {
          const value=await ports.project(path,response.size,request.fileProjection,request.background);
          return {status:response.status,headers:response.headers,body:new Uint8Array(0),fileProjection:{value,size:response.size}};
        }catch(error){
          if(!projectionUnavailable(error))throw error;
        }
      }
      const portable=request.background?undefined:ports.readPortable;
      let bridgePressure=false;
      let bytes:Uint8Array;
      try {
        bytes=await readDownloadedBytes(path,response.size,async(path,offset)=>{
          if(request.background&&!request.background.isCurrent())throw Error('cancelled');
          if(bridgePressure&&portable)return portable(path,offset);
          try {return await ports.read(path,offset);}
          catch(error){
            if(!byteBridgeBusy(error))throw error;
            bridgePressure=true;
            if(!portable)throw error;
            // Continue at the same file offset without a binary attachment
            // or another HTTP request.
            return portable(path,offset);
          }
        },()=>Error('服务器响应下载不完整'));
      }catch(error){
        if(!bridgePressure||mediaRequestFailure(error).category==='cancelled')throw error;
        throw new MediaResponseReadError(response.status,response.size,error);
      }
      appLogger.i('Network',`media response status=${response.status} bytes=${response.size}`);
      return {status:response.status,headers:response.headers,body:bytes};
    },error=>{
      const failure=mediaRequestFailure(error);
      appLogger.e('Network',`media request failed category=${failure.category}${failure.status===undefined?'':` status=${failure.status}`}`);
    });
  }};
}

type ProjectedTextChunk={text:string;eof:boolean;invalidUtf8:boolean};

/** The native spool contains one projected row per line. Keep only one input row. */
export async function readProjectedRows(
  read:()=>Promise<ProjectedTextChunk>,
  map:(row:unknown)=>unknown,
  background?:HttpRequest['background'],
):Promise<unknown[]> {
  const rows:unknown[]=[];
  let line='';
  for(;;){
    if(background&&!background.isCurrent())throw Error('cancelled');
    const {text,eof,invalidUtf8}=await read();
    if(background&&!background.isCurrent())throw Error('cancelled');
    if(invalidUtf8)throw Error('invalid projection UTF-8');
    let start=0;
    while(start<text.length){
      const newline=text.indexOf('\n',start);
      const end=newline<0?text.length:newline;
      if(line.length+end-start>256*1024)throw Error('projected row limit');
      line+=text.slice(start,end);
      if(newline<0)break;
      const row=map(JSON.parse(line));
      if(row!==null&&row!==undefined)rows.push(row);
      line='';
      start=end+1;
    }
    if(eof){
      if(line)throw Error('incomplete projected row');
      return rows;
    }
  }
}
