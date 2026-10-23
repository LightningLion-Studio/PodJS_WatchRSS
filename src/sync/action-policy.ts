import {createRequestAllowlist} from '@podjs/framework/request-policy';
import {ACTION_OPEN_PAIRING,type JsonObject} from './protocol.ts';
/** Native automatic Bluetooth and IP listeners share this list. Active connection
 * pages/debug listeners omit the policy and retain their existing permissions. */
export const FOREGROUND_SYNC_ACTIONS = Object.freeze(['syncLibrary','syncBooks','clearLibrary','syncNotes','syncNoteAsset','syncReader','previewReader','syncAccount','syncLlmTokenUsage',ACTION_OPEN_PAIRING]);
export const foregroundRequestFilter = createRequestAllowlist<JsonObject, JsonObject>(
 request=>String(request.action??''), FOREGROUND_SYNC_ACTIONS,
 ()=>({success:false,message:'当前前台自动同步不支持此操作，请在手表上打开对应连接页面'}),
);

/** Active connection pages use the shared listener with the native unrestricted
 * page policy. Leases only change dispatch permission, never own a transport. */
export class BluetoothActionPolicy {
 private connectionPages=0;
 readonly filterRequest=(request:JsonObject)=>this.connectionPages>0?undefined:foregroundRequestFilter(request);
 acquireConnectionPage():()=>void {
  this.connectionPages++;let released=false;
  return ()=>{if(released)return;released=true;this.connectionPages--;};
 }
}
