import {kv} from '@podjs/framework/watch';
import {hostOperation,base64ToBytes} from '@podjs/framework/services';

// This identifier belongs exclusively to device-profile telemetry. Never reuse
// an account, sync, usage-telemetry or hardware identifier, even as an input.
const KEY='watchrss.device-profile.install-id';
let pending:Promise<string>|undefined;
export async function deviceProfileInstallationId():Promise<string>{
 const existing=kv.get<string>(KEY);if(existing?.trim())return existing;
 return pending??=(async()=>{
  const bytes=base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64);
  if(bytes.length!==16)throw Error('Invalid random identity length');
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  kv.set(KEY,id);return id;
 })().finally(()=>{pending=undefined;});
}
