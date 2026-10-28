import {classifyLibraryClear,libraryClearMessage} from '../core/library-clear';
import type {DomainVectorProvider} from './domain-fast-path';
import type {AfterReadingAck} from '../books/reading-delta';
import type {SyncEventLog} from '../logs/sync-events.ts';
import {remoteInputUrl} from "../remote-input/inbox.ts";
import {tokenUsageOptInt} from './token-usage.ts';
import {ACTION_OPEN_PAIRING,type JsonObject} from './protocol.ts';
import type {SyncActionContext} from './session.ts';
import {syncNotes,type NoteSyncRepository} from './note-actions.ts';
import {syncAccount,type AccountUriParse} from './account-actions.ts';
import {pullSavedItems,type SavedLinkType} from './saved-links.ts';
import type {AccountSyncTelemetry} from './account-telemetry.ts';
import type {WatchAccountStore} from '../account/store.ts';
import {debugLogMaxChars,type DebugLogReply} from './diagnostic-log.ts';
import {watchAccountBinding} from './account-binding.ts';
export function createApplicationActionHandler(ports:{domainVectors?:DomainVectorProvider;books?:{apply(request:JsonObject,session?:object,afterAck?:AfterReadingAck):Promise<JsonObject>};notes:NoteSyncRepository;deviceId():Promise<string>;notesChanged():void;requestPairingPage?:(session:object)=>boolean|Promise<boolean>;clearLibrary?:(context?:SyncActionContext)=>Promise<void>;accountStore?:Pick<WatchAccountStore,'save'>&Partial<Pick<WatchAccountStore,'read'>>;accountBindingHash?:(bytes:Uint8Array)=>string|Promise<string>;accountUriParse?:AccountUriParse;accountChanged?:()=>void;accountStateRoot?:()=>Promise<string>;accountTelemetry?:AccountSyncTelemetry;readSavedLinks?:(type:SavedLinkType)=>Promise<string[]>;readDebugLog?:(maxChars:unknown)=>DebugLogReply|Promise<DebugLogReply>;noteAssets?:{apply(request:JsonObject):Promise<JsonObject>;inventory?(rows:unknown):Promise<unknown[]>};readTokenUsage?(limit:number):Promise<JsonObject[]>;readTokenUsagePage?(options:{limit:number;afterId:number;usageEpoch?:string}):Promise<import('./token-usage').TokenUsagePage>;readerSync?:{apply(request:JsonObject):Promise<JsonObject>};previewReader?(request:JsonObject):JsonObject}){
 const fallbackSession={};
 const accountBinding=ports.accountStore?.read&&ports.accountBindingHash
  ?()=>watchAccountBinding({read:()=>ports.accountStore!.read!()},ports.accountBindingHash!)
  :undefined;
 const handler=async(request:JsonObject,diagnostic?:SyncEventLog,context?:SyncActionContext):Promise<JsonObject>=>{
  if(request.action===ACTION_OPEN_PAIRING){
   let opened=false;
   try{opened=await ports.requestPairingPage?.(context?.session??fallbackSession)===true;}catch{}
   return {success:true,action:ACTION_OPEN_PAIRING,opened};
  }
  try{
   if(request.action==='syncBooks'&&ports.books)return await ports.books.apply(request,context?.session??fallbackSession,context?.afterAppliedAck);
   if(request.action==='ping')return {success:true,action:'pong',nonce:typeof request.nonce==='string'?request.nonce:''};
   if(request.action==='remoteInput'){if(!remoteInputUrl(request.url))throw new Error('缺少 RSS URL');return {success:true,action:'remoteInput'};}
   if(request.action==='pullSavedItems'&&ports.readSavedLinks)return await pullSavedItems(request,ports.readSavedLinks);
   if(request.action==='clearLibrary'&&ports.clearLibrary){await ports.clearLibrary(context);return {success:true,action:'clearLibrary'};}
   if(request.action==='syncAccount'&&ports.accountStore)return await syncAccount(request,ports.accountStore,ports.deviceId,ports.accountUriParse,ports.accountChanged,ports.accountTelemetry,ports.accountStateRoot);
   if(request.action==='previewReader'&&ports.previewReader)return ports.previewReader(request);
   if(request.action==='syncReader'&&ports.readerSync)return await ports.readerSync.apply(request);
   if(request.action==='syncLlmTokenUsage'&&request.afterId!==undefined){if(!ports.readTokenUsagePage)throw Error('Usage cursors unavailable');return {success:true,action:'syncLlmTokenUsage',...await ports.readTokenUsagePage({limit:request.limit===undefined?200:request.limit as number,afterId:request.afterId as number,usageEpoch:request.usageEpoch as string|undefined})};}
   if(request.action==='syncLlmTokenUsage'&&ports.readTokenUsage){const records=await ports.readTokenUsage(tokenUsageOptInt(request,'limit',200));return {success:true,action:'syncLlmTokenUsage',count:records.length,records};}
   if(request.action==='pullDebugLog'&&ports.readDebugLog)return await ports.readDebugLog(debugLogMaxChars(request));
   if(request.action==='syncNoteAsset'&&ports.noteAssets){const response=await ports.noteAssets.apply(request);if(response.complete&&!response.alreadyPresent)ports.notesChanged();return response;}
   if(request.action==='syncNotes'){const assets=request.assetManifest===undefined?undefined:await ports.noteAssets?.inventory?.(request.assetManifest);const response=await syncNotes(request,ports.notes,ports.deviceId);if(Number(response.applied)>0)ports.notesChanged();return assets?{...response,assetManifest:assets}:response;}
   return {success:false,message:'未知蓝牙同步动作：'+String(request.action??''),errorCode:'unsupported_action'};
  }catch(error){if(request.action==='clearLibrary'){const failure=classifyLibraryClear(error,'database');diagnostic?.event('clearLibrary.failed',{errorCode:failure.code},'E');return {success:false,action:'clearLibrary',errorCode:failure.code,retryable:true,message:libraryClearMessage(failure.code)};}diagnostic?.event("request.handle.failed",{message:"<redacted>"},"E");return {success:false,message:error instanceof Error?error.message:String(error)};}
 };
 return Object.assign(handler,{accountBinding,domainVectors:ports.domainVectors,capabilities:{...(ports.domainVectors?{supportsDomainFastPathV2:true}:{}),...(ports.books?{supportsBookSyncV1:true,supportsBookReadingDeltaV1:true}:{}),supportsNoteManifestV2:true,supportsNoteAssetInventory:!!ports.noteAssets?.inventory,supportsTokenUsageCursor:!!ports.readTokenUsagePage,supportsRssCanonicalIds:true,supportsFullMetadataOnlyArticles:true,supportsReaderPresets:!!ports.readerSync,supportsReaderAssets:!!ports.readerSync,supportsResourceChunkAck:!!ports.readerSync,supportsReaderPresetPreview:!!ports.previewReader}});
}
