import {hostOperation,secureStorage,fileChunks,bytesToBase64,base64ToBytes,type DownloadResult,type HostOperation} from "@podjs/framework/services";
import {WatchAccountStore} from "../account/store.ts";
import {WatchTokenManager} from "../account/token.ts";
import type {HttpTransport} from "../cloud/types.ts";
import type {SqlDatabase} from "../core/types.ts";
import {watchAppVersion} from '../core/app-version.ts';
import {SummarySession,type SummaryState} from "./summary.ts";
import {loadSummarySource} from "./source.ts";

export const summaryAccountStore=new WatchAccountStore({get:async key=>(await secureStorage.get(key))??null,set:secureStorage.set,remove:secureStorage.delete});
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
 return new SummarySession({source:waiting=>loadSummarySource(db,id,original,waiting),account:()=>summaryAccountStore.read(),freshAccount:(account,force)=>{tokens??=new WatchTokenManager(summaryAccountStore,{backendBaseUrl:account.backendBaseUrl,transport,appVersion:watchAppVersion});return tokens.freshAccount(force);},transport,
  recordUsage:async(model,usage)=>{await db.execute("INSERT INTO llm_token_usage(provider,model,request_id,usage_json,created_at) VALUES(?,?,?,?,?)",["WatchRSS",model,`${Date.now()}_${++sequence}_server_summary`,JSON.stringify(usage??null),Date.now()]);},
  cancel:()=>{disposed=true;for(const task of requests)task.cancel();requests.clear();}
 },preset,changed);
}
