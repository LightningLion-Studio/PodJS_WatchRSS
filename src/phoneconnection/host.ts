import {hostOperation,base64ToBytes,bytesToBase64,stringToUtf8,utf8ToString} from '@podjs/framework/services';
import {debugGate} from '../debug/host.ts';
import {getSavedLinksForSync} from '../services.ts';
import {enqueueRemoteInput} from '../remote-input/inbox.ts';
import {AcousticConnectionSession,type AcousticState} from './session.ts';
export function createAcousticConnection(changed:(state:AcousticState)=>void,onUrl:(url:string)=>void=enqueueRemoteInput){
 const request=<T>(method:string,args:Record<string,unknown>)=>{debugGate.require();return hostOperation<T>(method,args);};
 const compression=(method:string)=>async(bytes:Uint8Array,maxBytes=65536)=>{const value=await request<{dataBase64:string}>(method,{dataBase64:bytesToBase64(bytes),maxBytes}).result;return base64ToBytes(value.dataBase64);};
 return new AcousticConnectionSession({requireDebug:()=>debugGate.require(),request,text:{encode:stringToUtf8,decode:utf8ToString},compression:{gzip:compression('acoustic.gzip'),gunzip:compression('acoustic.gunzip')},fromBase64:base64ToBytes,toBase64:bytesToBase64,savedLinks:ability=>getSavedLinksForSync(ability==='SYNC_FAVORITES'?'favorite':'watchLater'),remoteInput:onUrl},changed);
}
