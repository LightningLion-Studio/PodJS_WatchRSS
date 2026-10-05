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

export const mediaTransport=createMediaTransport({
 download:args=>hostOperation<DownloadResult>('http.download',args).result,
 read:async(path,offset)=>base64ToBytes((await fileChunks.read(path,offset)).dataBase64),
 remove:path=>fileChunks.remove(path),
 base64:bytesToBase64,
});
const secure={get:async(key:string)=>(await secureStorage.get(key))??null,set:secureStorage.set,delete:secureStorage.delete};
export const biliClient=createBiliClient({onLogout:()=>clearBiliLogoutData(kv,managedCache),transport:mediaTransport,secureStore:secure,onSaved:async(item,type,saved)=>{await (await getExternalSavedStore()).sync(biliExternalItem(item),type,saved);},rsaOaepSha256:{encrypt:async(pem,plaintext)=>base64ToBytes((await rsaOaepSha256(pem,bytesToBase64(plaintext)).result).ciphertextBase64)},sleep:ms=>delay(ms).result});
export const douyinClient=new DouyinClient({
 onLogout:()=>clearDouyinLogoutData(managedCache, { ...browser, hasCapability }),
 transport:mediaTransport,
 savedStore:{list:async kind=>(await getDouyinSavedStore()).list(kind),state:async id=>(await getDouyinSavedStore()).state(id),set:async(item,kind,saved)=>(await getDouyinSavedStore()).set(item,kind,saved),toggle:async(item,kind)=>(await getDouyinSavedStore()).toggle(item,kind)},
 secureStorage:{get:secure.get,set:secure.set,remove:secure.delete},
 historyStorage:{get:async key=>kv.get<string>(key)??null,set:async(key,value)=>{kv.set(key,value);},remove:async key=>{kv.delete(key);}}
});

export async function loadLocalBiliDetail(target: import('./bili/detail.ts').DetailTarget) {
 return readLocalBiliDetail((await getExternalSavedStore()).db, target);
}
