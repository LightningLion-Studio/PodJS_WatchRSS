import {debugGate} from './debug/gate.ts';
import type {HttpTransport} from './cloud/types.ts';
import {backgroundResult} from './media/background-work.ts';
import {readDouyinRequestConfig} from './douyin/request-config.ts';
import {createDouyinLoginProbe} from './douyin/login-probe.ts';
import {readDouyin403Enabled} from './douyin/auth403.ts';
import {DouyinSqlStateStorage} from './douyin/state-storage.ts';
import {createHostDouyinStock} from './douyin/stock-host.ts';
import {createHostDouyinPreload} from './douyin/preload-host.ts';
import {createHostBiliPreview} from './bili/preview-host.ts';
import {appLogger} from './logs/app-logger.ts';
import {createMediaTransport} from './media/transport.ts';
import { clearBiliLogoutData, clearDouyinLogoutData } from "./media/logout.ts";
import { managedCache } from "./cache/host.ts";
import { readLocalBiliDetail } from "./bili/local-detail.ts";
import {getExternalSavedStore,getDouyinSavedStore} from "./services.ts";
import {biliExternalItem} from "./core/external-saved.ts";
import { browser, rsaOaepSha256, bytesToBase64, delay, hostOperation, fileChunks, base64ToBytes, secureStorage, type DownloadResult } from "@podjs/framework/services";
import { createBiliClient } from "./bili/index.ts";
import { DouyinClient } from "./douyin/index.ts";
import { hasCapability, kv } from "@podjs/framework/watch";
import {readWatchConfig,WATCH_COOLDOWN_KEY} from './bili/watch-api/config.ts';

export const mediaTransport=createMediaTransport({
 download:(args,background)=>{
  const op=hostOperation<DownloadResult>('http.download',{...args,...(background?{background:true}:{})});
  return backgroundResult(op,background);
 },
 read:async(path,offset)=>base64ToBytes((await fileChunks.read(path,offset)).dataBase64),
 remove:path=>fileChunks.remove(path),
 base64:bytesToBase64,
});
const secure={get:async(key:string)=>(await secureStorage.get(key))??null,set:secureStorage.set,delete:secureStorage.delete};
export const biliClient=createBiliClient({watchApi:()=>readWatchConfig(kv),watchCooldown:{get:()=>kv.get<number>(WATCH_COOLDOWN_KEY)??0,set:until=>kv.set(WATCH_COOLDOWN_KEY,until)},onLogout:()=>clearBiliLogoutData(kv,managedCache),transport:mediaTransport,secureStore:secure,onSaved:async(item,type,saved)=>{await (await getExternalSavedStore()).sync(biliExternalItem(item),type,saved);
 // Cache failures never turn a successful remote/local save into a failed save.
 if(saved)void biliPreviewCache.enqueue(item).result.catch(()=>appLogger.w('BiliPreview','preview download failed'));
 else await biliPreviewCache.remove(item).catch(()=>appLogger.w('BiliPreview','preview removal failed'));},rsaOaepSha256:{encrypt:async(pem,plaintext)=>base64ToBytes((await rsaOaepSha256(pem,bytesToBase64(plaintext)).result).ciphertextBase64)},sleep:ms=>delay(ms).result});
export const biliPreviewCache=createHostBiliPreview(biliClient);
const douyinSecure={get:secure.get,set:secure.set,remove:secure.delete};
const douyinRequestConfig=()=>readDouyinRequestConfig(kv,douyinSecure);
const createDouyinClient=(transport:HttpTransport)=>new DouyinClient({
 requestConfig:douyinRequestConfig,
 auth403:{enabled:()=>readDouyin403Enabled(kv),probe:createDouyinLoginProbe({transport,requestConfig:douyinRequestConfig})},
 onLogout:()=>clearDouyinLogoutData(managedCache, { ...browser, hasCapability }),
 transport,
 savedStore:{list:async kind=>(await getDouyinSavedStore()).list(kind),state:async id=>(await getDouyinSavedStore()).state(id),set:async(item,kind,saved)=>(await getDouyinSavedStore()).set(item,kind,saved),toggle:async(item,kind)=>(await getDouyinSavedStore()).toggle(item,kind)},
 secureStorage:{get:secure.get,set:secure.set,remove:(key,observation)=>secure.delete(key,observation)},
 historyStorage:new DouyinSqlStateStorage(async()=>(await getExternalSavedStore()).db,{get:async key=>kv.get<string>(key)??null,set:async()=>{throw Error("Legacy Douyin data is read-only");},remove:async key=>{kv.delete(key);}})
});

let douyinTransport:HttpTransport=mediaTransport;
const douyinTransportPort:HttpTransport={request:request=>douyinTransport.request(request)};
export const douyinClient=createDouyinClient(douyinTransportPort);
export const douyinStock=createHostDouyinStock(douyinClient);
export const douyinPreload=createHostDouyinPreload(douyinClient,douyinStock);

/** The fixture entry changes only transport. Existing production services keep their owners. */
export function installDouyinDebugTransport(transport:HttpTransport){
 debugGate.require();
 douyinTransport=transport;
}

export async function loadLocalBiliDetail(target: import('./bili/detail.ts').DetailTarget) {
 return readLocalBiliDetail((await getExternalSavedStore()).db, target);
}
