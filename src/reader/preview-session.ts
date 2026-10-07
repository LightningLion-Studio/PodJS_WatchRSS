import {PreviewSession,type PreviewClock} from '@podjs/framework/preview-session';
import {decodeReaderPreset,type ReaderPreset} from './preset.ts';
import type {JsonObject} from '../sync/protocol.ts';
import {readerRequiredInt,readerRequiredLong,readerRequiredString} from '../sync/reader-manifest.ts';
import {wireFields} from '../sync/article-batches.ts';
export interface ReaderPreviewState {sessionId:string;sequence:number;preset:ReaderPreset;resourceTransferInProgress:boolean;updatedAt:number}
export type {PreviewClock} from '@podjs/framework/preview-session';
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
/** Reader preset policy and native timeout profile remain application-owned. */
export class ReaderPreviewSession extends PreviewSession<ReaderPreset,JsonObject,ReaderPreviewState>{
 constructor(clock:PreviewClock,timeoutMs=20000,publishIntervalMs=33){super(clock,{
  timeoutMs,extendedTimeoutMs:120000,publishIntervalMs,
  check(disposed,sessionId,sequence){if(disposed)throw Error('预览会话已关闭');if(!wireFields.trim(sessionId))throw Error('缺少预览会话 ID');if(!Number.isSafeInteger(sequence)||sequence<0)throw Error('预览更新序号无效');},
  normalize:decodeReaderPreset,apply:applyReaderPresetChanges,isEmpty:changes=>!Object.keys(changes).length,
  missingBaseline:()=>Error('预览差量缺少完整基线'),
  frame:(sessionId,sequence,preset,resourceTransferInProgress,updatedAt)=>({sessionId,sequence,preset,resourceTransferInProgress,updatedAt}),
  isExtended:state=>state.resourceTransferInProgress,
 });}
 refreshResourceTransfer():boolean{return this.refreshTimeout();}
}
