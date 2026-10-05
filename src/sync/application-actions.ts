import {remoteInputUrl} from "../remote-input/inbox.ts";
import {tokenUsageOptInt} from './token-usage.ts';
import type {JsonObject} from './protocol.ts';
import {syncNotes,type NoteSyncRepository} from './note-actions.ts';
import {syncAccount,type AccountUriParse} from './account-actions.ts';
import {pullSavedItems,type SavedLinkType} from './saved-links.ts';
import type {WatchAccountStore} from '../account/store.ts';
import type {DebugLogReply} from './diagnostic-log.ts';
export function createApplicationActionHandler(ports:{notes:NoteSyncRepository;deviceId():Promise<string>;notesChanged():void;clearLibrary?:()=>Promise<void>;accountStore?:Pick<WatchAccountStore,'save'>;accountUriParse?:AccountUriParse;accountChanged?:()=>void;readSavedLinks?:(type:SavedLinkType)=>Promise<string[]>;readDebugLog?:(maxChars:unknown)=>DebugLogReply;noteAssets?:{apply(request:JsonObject):Promise<JsonObject>};readTokenUsage?(limit:number):Promise<JsonObject[]>;readerSync?:{apply(request:JsonObject):Promise<JsonObject>};previewReader?(request:JsonObject):JsonObject}){
 const handler=async(request:JsonObject):Promise<JsonObject>=>{
  try{
   if(request.action==='ping')return {success:true,action:'pong',nonce:typeof request.nonce==='string'?request.nonce:''};
   if(request.action==='remoteInput'){if(!remoteInputUrl(request.url))throw new Error('缺少 RSS URL');return {success:true,action:'remoteInput'};}
   if(request.action==='pullSavedItems'&&ports.readSavedLinks)return await pullSavedItems(request,ports.readSavedLinks);
   if(request.action==='clearLibrary'&&ports.clearLibrary){await ports.clearLibrary();return {success:true,action:'clearLibrary'};}
   if(request.action==='syncAccount'&&ports.accountStore)return await syncAccount(request,ports.accountStore,ports.deviceId,ports.accountUriParse,ports.accountChanged);
   if(request.action==='previewReader'&&ports.previewReader)return ports.previewReader(request);
   if(request.action==='syncReader'&&ports.readerSync)return await ports.readerSync.apply(request);
   if(request.action==='syncLlmTokenUsage'&&ports.readTokenUsage){const records=await ports.readTokenUsage(tokenUsageOptInt(request,'limit',200));return {success:true,action:'syncLlmTokenUsage',count:records.length,records};}
   if(request.action==='pullDebugLog'&&ports.readDebugLog)return ports.readDebugLog(request.maxChars);
   if(request.action==='syncNoteAsset'&&ports.noteAssets){const response=await ports.noteAssets.apply(request);if(response.complete)ports.notesChanged();return response;}
   if(request.action==='syncNotes'){const response=await syncNotes(request,ports.notes,ports.deviceId);ports.notesChanged();return response;}
   return {success:false,message:'未知蓝牙同步动作：'+String(request.action??''),errorCode:'unsupported_action'};
  }catch(error){return {success:false,message:error instanceof Error?error.message:String(error)};}
 };
 return Object.assign(handler,{capabilities:{supportsReaderPresets:!!ports.readerSync,supportsReaderAssets:!!ports.readerSync,supportsResourceChunkAck:!!ports.readerSync,supportsReaderPresetPreview:!!ports.previewReader}});
}
