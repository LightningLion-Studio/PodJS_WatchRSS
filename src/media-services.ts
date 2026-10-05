import { clearBiliLogoutData, clearDouyinLogoutData } from "./media/logout.ts";
import { managedCache } from "./cache/host.ts";
import { readLocalBiliDetail } from "./bili/local-detail.ts";
import {getExternalSavedStore,getDouyinSavedStore} from "./services.ts";
import {biliExternalItem} from "./core/external-saved.ts";
import { rsaOaepSha256, bytesToBase64, delay, hostOperation, fileChunks, base64ToBytes, secureStorage, type DownloadResult } from "@podjs/framework/services";
import { createBiliClient } from "./bili/index.ts";
import { DouyinClient } from "./douyin/index.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "./cloud/types.ts";
import { kv } from "@podjs/framework/watch";

let sequence=0;
/** GET and POST responses stream to private files with a bounded 8 MiB JSON read. */
export const mediaTransport: HttpTransport = {
 async request(request:HttpRequest):Promise<HttpResponse> {
  if(request.method!=="GET"&&request.method!=="POST")throw new Error("Unsupported media request method");
  const path=`media-json/request-${Date.now()}-${++sequence}.json`;
  try {
   const response=await hostOperation<DownloadResult>("http.download",{url:request.url,path,method:request.method,bodyBase64:request.body?bytesToBase64(request.body):undefined,headers:request.headers,maxBytes:8*1024*1024,timeoutMs:30000}).result;
   const bytes=new Uint8Array(response.size);let offset=0;
   while(offset<bytes.length) {
    const chunk=base64ToBytes((await fileChunks.read(path,offset)).dataBase64);
    if(!chunk.length||offset+chunk.length>bytes.length)throw new Error("服务器响应下载不完整");
    bytes.set(chunk,offset);offset+=chunk.length;
   }
   return {status:response.status,headers:response.headers,body:bytes};
  } finally {await fileChunks.remove(path).catch(()=>{});}
 }
};
const secure={get:async(key:string)=>(await secureStorage.get(key))??null,set:secureStorage.set,delete:secureStorage.delete};
export const biliClient=createBiliClient({onLogout:()=>clearBiliLogoutData(kv,managedCache),transport:mediaTransport,secureStore:secure,onSaved:async(item,type,saved)=>{await (await getExternalSavedStore()).sync(biliExternalItem(item),type,saved);},rsaOaepSha256:{encrypt:async(pem,plaintext)=>base64ToBytes((await rsaOaepSha256(pem,bytesToBase64(plaintext)).result).ciphertextBase64)},sleep:ms=>delay(ms).result});
export const douyinClient=new DouyinClient({
 onLogout:()=>clearDouyinLogoutData(managedCache),
 transport:mediaTransport,
 savedStore:{list:async kind=>(await getDouyinSavedStore()).list(kind),state:async id=>(await getDouyinSavedStore()).state(id),set:async(item,kind,saved)=>(await getDouyinSavedStore()).set(item,kind,saved),toggle:async(item,kind)=>(await getDouyinSavedStore()).toggle(item,kind)},
 secureStorage:{get:secure.get,set:secure.set,remove:secure.delete},
 historyStorage:{get:async key=>kv.get<string>(key)??null,set:async(key,value)=>{kv.set(key,value);},remove:async key=>{kv.delete(key);}}
});

export async function loadLocalBiliDetail(target: import('./bili/detail.ts').DetailTarget) {
 return readLocalBiliDetail((await getExternalSavedStore()).db, target);
}
