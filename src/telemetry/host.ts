import {ActiveBatterySession} from '@podjs/framework/telemetry';
import {kv} from '@podjs/framework/watch';
import {application,battery,hostOperation,fileChunks,base64ToBytes,bytesToBase64,delay,type DownloadResult} from '@podjs/framework/services';
import config from '../../pod.config.json';
import {watchAppVersion} from '../core/app-version.ts';
import {summaryAccountStore} from '../llm/runtime.ts';
import {WatchTokenManager} from '../account/token.ts';
import type {HttpTransport} from '../cloud/types.ts';
import {WatchUsageTelemetry} from './usage.ts';
let sequence=0;
export const telemetryTransport:HttpTransport={async request(request){
  const path=`telemetry/response-${Date.now()}-${++sequence}.json`;
  const refreshing=request.url.endsWith('/account/watch-token/refresh');
  try{
    const response=await hostOperation<DownloadResult>('http.download',{url:request.url,path,temporary:true,
      method:request.method,headers:request.headers,bodyBase64:request.body?bytesToBase64(request.body):undefined,
      acceptHttpErrors:true,timeoutMs:refreshing?15000:8000,readTimeoutMs:refreshing?30000:12000,maxBytes:1024*1024}).result;
    const body=new Uint8Array(response.size);let offset=0;
    while(offset<body.length){const chunk=await fileChunks.read(path,offset),bytes=base64ToBytes(chunk.dataBase64);
      if(!bytes.length||offset+bytes.length>body.length||chunk.size!==body.length)throw new Error('Incomplete telemetry response');
      body.set(bytes,offset);offset+=bytes.length;
    }
    return {status:response.status,headers:response.headers,body};
  }finally{await fileChunks.remove(path).catch(()=>{});}
}};
const transport=telemetryTransport;
let deviceId:(()=>Promise<string>)|undefined;
export function setTelemetryDeviceId(provider:()=>Promise<string>){deviceId=provider;}
let identityPromise:Promise<string>|undefined;
export async function installationId(){
  const existing=kv.get<string>('watchrss.telemetry.install-id');if(existing?.trim())return existing;
  return identityPromise??=(async()=>{
    const bytes=base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    kv.set('watchrss.telemetry.install-id',id);return id;
  })().finally(()=>{identityPromise=undefined;});
}
export const usageTelemetry=new WatchUsageTelemetry({get:key=>kv.get<string>(key),set:(key,value)=>kv.set(key,value)},{
  async freshAccount(){const account=await summaryAccountStore.read();if(!account)throw new Error('No bound account');
    return new WatchTokenManager(summaryAccountStore,{backendBaseUrl:account.backendBaseUrl,transport,appVersion:watchAppVersion}).freshAccount();},
  async identity(){if(!deviceId)throw new Error('Telemetry identity not ready');return {installId:await installationId(),deviceId:await deviceId()};},
  transport,delay:ms=>delay(ms).result,versionName:config.versionName,versionCode:config.versionCode,appVersion:watchAppVersion,
});

/** Older hosts fail closed: never infer release from a version name. */
export async function recordHostReleaseOobeOpened(){
  try{const info=await application.buildInfo();if(typeof info.debugBuild==='boolean')usageTelemetry.recordReleaseOobeOpened(info.debugBuild);}catch{/* Revisit on the next OOBE after a host upgrade. */}
}

export function createVideoBatteryTelemetry(){
  return new ActiveBatterySession(()=>battery.percent(),sample=>usageTelemetry.recordVideoBatteryDrain(sample.source,sample.durationMs,sample.batteryStart,sample.batteryEnd));
}
