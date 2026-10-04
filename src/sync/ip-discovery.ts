import {base64ToBytes,type discovery,type HostOperation} from '@podjs/framework/services';
import {decodeSyncUtf8,type JsonObject} from './protocol.ts';
import {parseWireJson} from './wire-json.ts';
import type {ForegroundTimer} from './foreground.ts';
export const IP_BLE_DISCOVERY = Object.freeze({
 advertisedServiceUuid:'7e57c201-1f7d-4f0b-9f3d-2d7d3a65b201',
 manufacturerId:0xffff,manufacturerDataBase64:'V1JTMw==',
 serviceUuid:'7e57d001-1f7d-4f0b-9f3d-2d7d3a65d001',
 characteristicUuid:'7e57d001-1f7d-4f0b-9f3d-2d7d3a65d002',
 bondedOnly:true,scanTimeoutMs:8000,readTimeoutMs:12000,
});
/** Foreground/network refresh debounce; permission prompts belong to explicit UI.
 * The controller must authenticate the returned descriptor before using it. */
export function acquireIpDescriptor(radio:Pick<typeof discovery,'status'|'bleReadCharacteristic'>,delay:(ms:number)=>ForegroundTimer):HostOperation<JsonObject|null>{
 let cancelled=false,pending:{cancel():void}|undefined;
 const check=()=>{if(cancelled)throw new Error('IP discovery cancelled');};
 const result=(async()=>{
  const timer=delay(350);pending=timer;try{await timer.result;}finally{if(pending===timer)pending=undefined;}check();
  const state=await radio.status();check();if(!state.available||!state.enabled||state.permission!=='granted')return null;
  const read=radio.bleReadCharacteristic({...IP_BLE_DISCOVERY});pending=read;
  try{const value=await read.result;check();if(!value.bonded)throw new Error('IP discovery requires a bonded phone');return parseWireJson(decodeSyncUtf8(base64ToBytes(value.dataBase64)));}
  finally{if(pending===read)pending=undefined;}
 })();
 return {result,cancel:()=>{cancelled=true;pending?.cancel();}};
}
