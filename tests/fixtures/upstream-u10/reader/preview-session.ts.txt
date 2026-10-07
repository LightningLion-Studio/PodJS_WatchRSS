import {decodeReaderPreset,type ReaderPreset} from './preset.ts';
import type {JsonObject} from '../sync/protocol.ts';
import {readerRequiredInt,readerRequiredLong,readerRequiredString} from '../sync/reader-manifest.ts';
import {wireFields} from '../sync/article-batches.ts';
export interface ReaderPreviewState {sessionId:string;sequence:number;preset:ReaderPreset;resourceTransferInProgress:boolean;updatedAt:number}
export interface PreviewClock {now():number;monotonic():number;after(ms:number,callback:()=>void):()=>void}
export function applyReaderPresetChanges(base:ReaderPreset,changes:JsonObject):ReaderPreset {
 const merged:JsonObject={...base};
 for(const key of Object.keys(changes)){
  if(key==='schemaVersion'){if(readerRequiredInt(changes,key)>2)throw Error('不支持的阅读器预设版本');}
  else if(['id','name','modifiedBy'].includes(key))merged[key]=readerRequiredString(changes,key);
  else if(['codeBackgroundColorArgb','accentColorArgb','updatedAt'].includes(key))merged[key]=readerRequiredLong(changes,key);
  else if(['categoryTypographyEnabled','deleted'].includes(key)){const value=changes[key];if(typeof value!=='boolean'&&!(typeof value==='string'&&/^(true|false)$/i.test(value)))throw Error('无效布尔值 '+key);merged[key]=wireFields.bool(value);}
  else if(['body','title','subtitle','quote','code','link','background'].includes(key)){const value=wireFields.object(changes[key]);if(!value)throw Error('无效预设对象 '+key);merged[key]=value;}
 }
 return decodeReaderPreset(merged);
}
/** Ephemeral native preview ownership. Accepted deltas and the published frame
 * are distinct; empty updates/heartbeats can advance the accepted sequence. */
export class ReaderPreviewSession {
 private published:ReaderPreviewState|null=null;
 private pending:ReaderPreviewState|null=null;
 private sessionId:string|null=null;
 private sequence=-1;
 private preset:ReaderPreset|null=null;
 private lastPublished=0;
 private cancelTimeout?:()=>void;
 private cancelPublish?:()=>void;
 private disposed=false;
 private listeners=new Set<(state:ReaderPreviewState|null)=>void>();
 constructor(private readonly clock:PreviewClock,private readonly timeoutMs=20000,private readonly publishIntervalMs=33){}
 state(){return this.published;}
 subscribe(listener:(state:ReaderPreviewState|null)=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private emit(state:ReaderPreviewState|null){this.published=state;for(const listener of this.listeners)listener(state);}
 private check(sessionId:string,sequence:number){if(this.disposed)throw Error('预览会话已关闭');if(!wireFields.trim(sessionId))throw Error('缺少预览会话 ID');if(!Number.isSafeInteger(sequence)||sequence<0)throw Error('预览更新序号无效');}
 update(sessionId:string,sequence:number,preset:ReaderPreset,resourceTransferInProgress=false):boolean{
  this.check(sessionId,sequence);if(this.sessionId===sessionId&&sequence<=this.sequence)return false;
  const normalized=decodeReaderPreset(preset);this.sessionId=sessionId;this.sequence=sequence;this.preset=normalized;
  this.publish({sessionId,sequence,preset:normalized,resourceTransferInProgress,updatedAt:this.clock.now()});this.timeout(sessionId,resourceTransferInProgress?120000:this.timeoutMs);return true;
 }
 updateDelta(sessionId:string,sequence:number,changes:JsonObject,resourceTransferInProgress=false):boolean{
  this.check(sessionId,sequence);if(this.sessionId!==sessionId||!this.preset)throw Error('预览差量缺少完整基线');if(sequence<=this.sequence)return false;
  this.sequence=sequence;
  if(!Object.keys(changes).length){this.timeout(sessionId,this.timeoutMs);return true;}
  // Native consumes this sequence even if decoding the delta fails.
  const preset=applyReaderPresetChanges(this.preset,changes);this.preset=preset;
  const next={sessionId,sequence,preset,resourceTransferInProgress,updatedAt:this.clock.now()},remaining=this.publishIntervalMs-(this.clock.monotonic()-this.lastPublished);
  if(this.publishIntervalMs<=0||!this.published||remaining<=0)this.publish(next);
  else{this.pending=next;if(!this.cancelPublish)this.cancelPublish=this.clock.after(remaining,()=>{this.cancelPublish=undefined;const pending=this.pending;this.pending=null;if(pending&&pending.sessionId===this.sessionId)this.publish(pending);});}
  this.timeout(sessionId,resourceTransferInProgress?120000:this.timeoutMs);return true;
 }
 heartbeat(sessionId:string,sequence:number):number|null{if(this.sessionId!==sessionId)return null;if(sequence>this.sequence)this.sequence=sequence;this.timeout(sessionId,this.timeoutMs);return this.sequence;}
 refreshResourceTransfer():boolean{const current=this.published;if(!current?.resourceTransferInProgress)return false;this.timeout(current.sessionId,120000);return true;}
 stop(sessionId:string):boolean{if(this.sessionId!==sessionId)return false;this.cancelTimeout?.();this.cancelTimeout=undefined;this.cancelPublish?.();this.cancelPublish=undefined;this.pending=null;this.sessionId=null;this.sequence=-1;this.preset=null;this.emit(null);return true;}
 dispose(){if(this.sessionId!==null)this.stop(this.sessionId);this.disposed=true;this.listeners.clear();}
 private publish(state:ReaderPreviewState){this.cancelPublish?.();this.cancelPublish=undefined;this.pending=null;this.emit(state);this.lastPublished=this.clock.monotonic();}
 private timeout(sessionId:string,ms:number){this.cancelTimeout?.();this.cancelTimeout=this.clock.after(ms,()=>{this.cancelTimeout=undefined;this.stop(sessionId);});}
}
