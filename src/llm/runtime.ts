import {withAccountLease} from '../account/lease';
import {clearAccountCloud,revokeAccountCloud} from '../account/cloud-cleanup';
import {hostOperation,secureStorage,fileChunks,bytesToBase64,base64ToBytes,type DownloadResult,type HostOperation} from "@podjs/framework/services";
import {secureCallsite} from '../cloud/secure-callsite';
import {WatchAccountStore} from "../account/store.ts";
import {WatchTokenManager} from "../account/token.ts";
import type {HttpTransport} from "../cloud/types.ts";
import type {SqlDatabase} from "../core/types.ts";
import {watchAppVersion} from '../core/app-version.ts';
import {SummarySession,type SummaryState} from "./summary.ts";
import {loadSummarySource} from "./source.ts";
import {appendUsage} from "./usage.ts";

export const summaryAccountStore=new WatchAccountStore({exclusive:action=>withAccountLease(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,secureCallsite(method,args)).result,action),revokeCloudScope:state=>revokeAccountCloud(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,secureCallsite(method,args)).result,state),clearCloudScope:state=>clearAccountCloud(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,secureCallsite(method,args)).result,state),get:async key=>(await secureStorage.get(key,1))??null,set:(key,value)=>secureStorage.set(key,value,1),remove:key=>secureStorage.delete(key,undefined,1)});
let sequence=0;
export function createSummarySession(db:SqlDatabase,id:string,preset:()=>number,original:()=>Promise<unknown>,changed:(state:SummaryState)=>void):SummarySession {
 const requests=new Set<HostOperation<DownloadResult>>();let disposed=false;
 const transport:HttpTransport={async request(request){
  if(disposed)throw new Error("总结已取消");
  const path=`llm/response-${Date.now()}-${++sequence}.json`;
  const task=hostOperation<DownloadResult>("http.download",{url:request.url,path,temporary:true,method:request.method,headers:request.headers,bodyBase64:request.body?bytesToBase64(request.body):undefined,acceptHttpErrors:true,timeoutMs:15000,readTimeoutMs:600000,maxBytes:8*1024*1024});
  requests.add(task);
  try{
   const result=await task.result;if(disposed)throw new Error("总结已取消");
   const body=new Uint8Array(result.size);let offset=0;
   while(offset<body.length){if(disposed)throw new Error("总结已取消");const chunk=await fileChunks.read(path,offset),bytes=base64ToBytes(chunk.dataBase64);if(!bytes.length||offset+bytes.length>body.length||chunk.size!==body.length)throw new Error("总结响应下载不完整");body.set(bytes,offset);offset+=bytes.length;}
   return {status:result.status,headers:result.headers,body};
  }finally{requests.delete(task);await fileChunks.remove(path).catch(()=>{});}
 }};
 let tokens:WatchTokenManager|undefined;
 return new SummarySession({source:waiting=>loadSummarySource(db,id,original,waiting),account:()=>summaryAccountStore.read(),freshAccount:(account,force,rejectedAccessToken)=>{tokens??=new WatchTokenManager(summaryAccountStore,{backendBaseUrl:account.backendBaseUrl,transport,appVersion:watchAppVersion});return tokens.freshAccount(force,rejectedAccessToken);},transport,
  recordUsage:async(model,usage)=>{const createdAt=Date.now();await appendUsage(db,{provider:"WatchRSS",model,requestId:`${createdAt}_${++sequence}_server_summary`,usage,createdAt});},
  cancel:()=>{disposed=true;for(const task of requests)task.cancel();requests.clear();}
 },preset,changed);
}
