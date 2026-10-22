import {LIBRARY_CHECKPOINT_FEATURE,libraryBatchAck,requireLibraryBatchAck,wantsLibraryCheckpoint} from './checkpoints.ts';
import type {FrameTiming} from '@podjs/framework/frame-stream';
import type {RequestFilter} from '@podjs/framework/request-policy';
import {SyncEventLog} from '../logs/sync-events.ts';
import {ACTION_SYNC_LIBRARY,PROTOCOL_VERSION,MIN_SUPPORTED_PHONE_PROTOCOL_VERSION,buildProbeResponse,type JsonObject,type ProbeCapabilities} from './protocol.ts';
import {ArticleBatchReceiver,wireFields,type ReceivedArticle,type RequestedArticleBody} from './article-batches.ts';
import {parseArticleManifest,selectArticleBodyRequests,type ArticleManifest} from './manifest.ts';
import {buildCursorResponse,buildManifestResponse,buildManifestFrames,buildChunkedResponseFrames,combineManifestFrames,manifestBatchCount,parseCursor,parseChangeSequence,parseResponseAck,parseSources,type SyncCursor,type ChangeSequence,type ResponseAck,type SyncedSource} from './library-wire.ts';
import type {PreparedArticle} from './article-export.ts';
const {string,trim,bool,optLong}=wireFields;
/** Byte deltas, including the four-byte prefix; never article/resource counts. */
export interface TransferByteProgress {direction:'read'|'write';bytes:number}
export interface SyncFrameConnection {
 setFrameTiming?(listener:((sample:FrameTiming)=>void)|undefined):void;
 setTransferProgress?(listener:((progress:TransferByteProgress)=>void)|undefined):void;
 readFrame(timeoutMs:number):Promise<JsonObject>;
 writeFrame(frame:JsonObject):Promise<void>;
 close():Promise<void>;
}
export interface LibraryWindow extends ChangeSequence {articleManifest:readonly ArticleManifest[];fullArticleManifest:readonly ArticleManifest[];rssSources:readonly SyncedSource[];peerAckedSeq:number}
export interface PendingSyncSuccess {remoteDeviceId:string;localSeqToInclusive:number;remoteSeqToInclusive:number;remoteProtocolVersion:number;fullSnapshot:boolean}
/** All mutation methods must resolve only after durable application. Applied
 * counts are native state-operation counts, not the number of article rows. */
export interface LibrarySessionRepository {
 deviceId():Promise<string>;
 cursor(peer:string):Promise<SyncCursor>;
 mergeSources(sources:readonly SyncedSource[],remote:string,authoritative:boolean):Promise<number>;
 prepareWindow(peer:string,peerAppliedLocalSeq:number):Promise<LibraryWindow>;
 exportSources():Promise<readonly SyncedSource[]>;
 receiveArticle(article:ReceivedArticle,remote:string,authoritative:boolean):Promise<number>;
 exportRequested(requests:readonly RequestedArticleBody[]):Promise<readonly PreparedArticle[]>;
 finalizeSnapshot(articleIds:readonly string[],sourceUrls:readonly string[]):Promise<void>;
 resetPeerState():Promise<void>;
 markSuccess(pending:PendingSyncSuccess):Promise<void>;
}
export interface SyncSessionStatus {phase:'request'|'cursor'|'manifest'|'receiving'|'sending'|'ack'|'complete'|'error';applied?:boolean;message?:string;receivedArticles?:number;sentArticles?:number;totalArticles?:number}
export interface SessionActionResult {request:JsonObject;response:JsonObject;ack:ResponseAck|null;libraryApplied:boolean}
export interface LibrarySessionOptions {
 filterRequest?:RequestFilter<JsonObject,JsonObject>;
 diagnosticLog?:SyncEventLog;
 now?:()=>number;
 monotonic?:()=>number;
 onTransferProgress?:(progress:TransferByteProgress)=>void;
 onStatus?:(status:SyncSessionStatus)=>void;
 onActionCompleted?:(result:SessionActionResult)=>void;
 capabilities?:ProbeCapabilities;
 watchCapabilities?:JsonObject;
 handleAction?:((request:JsonObject,diagnostic?:SyncEventLog)=>Promise<JsonObject>) & {capabilities?:ProbeCapabilities;accountBinding?:()=>Promise<JsonObject>};
 offerIpEndpoint?:(descriptor:JsonObject)=>Promise<boolean>;
 initialRequestTimeoutMs?:number;
 responseAckTimeoutMs?:number;
}
const persistentFields={supportsPersistentSession:true,persistentSessionAccepted:true};
/** Watch-side phase coordinator shared by Bluetooth and IP byte transports.
 * One instance owns and closes one connection. There are no automatic retries. */
export class LibrarySyncSession {
 private readonly log:SyncEventLog;
 private checkpointRequested=false;private checkpointed=false;
 private used=false;
 private cancelled:Error|null=null;
 private closed=false;
 private aborting=false;
 private readonly now:()=>number;
 private readonly monotonic:()=>number;
 constructor(private readonly connection:SyncFrameConnection,private readonly repository:LibrarySessionRepository,private readonly options:LibrarySessionOptions={}){this.log=options.diagnosticLog??new SyncEventLog();this.now=options.now??Date.now;this.monotonic=options.monotonic??(()=>globalThis.performance?.now?.()??Date.now());this.connection.setTransferProgress?.(options.onTransferProgress);this.connection.setFrameTiming?.(sample=>{this.log.event(sample.direction==='read'?'frame.read.complete':'frame.write.complete',{frameBytes:sample.bytes,readMs:sample.readMs,decodeMs:sample.decodeMs,encodeMs:sample.encodeMs,writeMs:sample.writeMs});});}
 cancel():void {this.cancelled??=new Error('Sync session cancelled');void this.close().catch(()=>{});}
 private async timed<T>(event:string,action:()=>Promise<T>):Promise<T>{const start=this.monotonic();try{return await action();}finally{this.log.event(event,{elapsedMs:Math.max(0,Math.round(this.monotonic()-start))});}}
 private check():void {if(this.cancelled)throw this.cancelled;}
 private status(status:SyncSessionStatus):void {this.options.onStatus?.(status);}
 private async close():Promise<void>{if(this.closed)return;this.closed=true;try{await this.connection.close();}catch(error){if(this.aborting)this.log.event("server.exchange.abort.close.failed",{},"W");throw error;}}
 private async read(timeout:number):Promise<JsonObject>{this.check();try{const f=await this.connection.readFrame(timeout);this.check();return f;}catch(error){this.log.event("frame.read.failed",{message:"<redacted>"},"E");throw error;}}
 private async write(frame:JsonObject):Promise<void>{this.check();try{await this.connection.writeFrame(frame);this.check();}catch(error){this.log.event("frame.write.failed",{message:"<redacted>"},"E");throw error;}}
 private async ack():Promise<ResponseAck|null>{
  this.status({phase:'ack'});this.log.event('ack.read.start',{timeoutMs:this.options.responseAckTimeoutMs??10000});
  const readAck=async(timeout:number)=>{try{return parseResponseAck(await this.read(timeout));}catch(error){this.check();this.log.event("ack.read.failed",{message:"<redacted>"},"W");return null;}};
  let ack=await readAck(this.options.responseAckTimeoutMs??10000);
  if(ack?.success&&!ack.applied&&ack.phase==='received'){this.log.event('ack.received.waitApplied',{timeoutMs:120000});ack=(await readAck(120000))??ack;}
  this.log.event(ack?'ack.read.success':'ack.read.missing',ack?{ackApplicationSucceeded:ack.success&&ack.applied}:{},ack?'I':'W');
  return ack;
 }
 async run():Promise<SessionActionResult[]> {
  if(this.used)throw new Error('Sync session already started');this.used=true;
  const results:SessionActionResult[]=[];let persistent=false,timeout=this.options.initialRequestTimeoutMs??120000;
  try{
   const localId=await this.repository.deviceId();this.check();
   while(true){
    this.status({phase:'request'});let request=await this.read(timeout);
    const accepted=!persistent&&bool(request.requestPersistentSession)&&bool(request.supportsPersistentSession);
    if(accepted){persistent=true;timeout=15*60*1000;this.log.event("server.session.accepted");}
    if(string(request.action)==='syncSession'){
     const phase=string(request.phase);if(!persistent||!['complete','abort'].includes(phase))throw new Error('Invalid persistent session control');
     const response={version:PROTOCOL_VERSION,action:'syncSession',phase,success:true,...persistentFields};await this.write(response);const ack=await this.ack();results.push({request,response,ack,libraryApplied:false});this.log.event("server.session.complete",{phase,completedActions:results.length,elapsedMs:this.log.elapsed()});return results;
    }
    let rejection=this.options.filterRequest?.(request);
    if(!rejection&&string(request.action)==='previewReader'&&bool(request.stream)){
     const result=await this.previewStream(request);results.push(result);this.options.onActionCompleted?.(result);this.status({phase:'complete',applied:false});return results;
    }
    const unsupported=()=>string(request.action)===ACTION_SYNC_LIBRARY&&optLong(request.version)<MIN_SUPPORTED_PHONE_PROTOCOL_VERSION;
    if(!rejection&&!unsupported()&&string(request.action)===ACTION_SYNC_LIBRARY&&string(request.phase)==='cursor'){
     this.checkpointRequested=request[LIBRARY_CHECKPOINT_FEATURE]===true;this.status({phase:'cursor'});const peer=trim(string(request.deviceId))||'phone';const response=buildCursorResponse(localId,await this.timed('library.cursor.prepared',()=>this.repository.cursor(peer)),this.now);
     this.log.event("library.cursor.exchanged",{remoteDeviceId:peer});await this.write({...response,...(this.checkpointRequested?{[LIBRARY_CHECKPOINT_FEATURE]:true}:{}),...(accepted?persistentFields:{})});request=await this.read(timeout);rejection=this.options.filterRequest?.(request);
    }
    let response:JsonObject,pending:PendingSyncSuccess|null=null;
    if(rejection){response=accepted?{...rejection,...persistentFields}:rejection;await this.write(response);}
    else if(!unsupported()&&string(request.action)===ACTION_SYNC_LIBRARY&&string(request.phase)==='manifest'){
     try{
      this.log.event('library.manifest.handle.start');this.status({phase:'manifest'});const count=manifestBatchCount(request);if(count>512)throw new Error('Manifest batch limit exceeded');const frames=[request];for(let i=1;i<count;i++)frames.push(await this.read(180000));request=combineManifestFrames(frames);
      const exchange=await this.exchange(request,localId,accepted);response=exchange.response;pending=exchange.pending;
     }catch(error){
      this.check();this.log.event('library.manifest.handle.failed',{message:'<redacted>'},'E');response={success:false,action:ACTION_SYNC_LIBRARY,version:PROTOCOL_VERSION,message:error instanceof Error?error.message:String(error),errorCode:'library_exchange_failed',fatalSession:true};
      try{await this.write(response);}catch{this.log.event('library.errorResponse.write.failed',{},'W');}this.aborting=true;this.log.event("server.exchange.aborted",{persistentSession:persistent,completedActions:results.length,elapsedMs:this.log.elapsed()});this.status({phase:'error',message:String(response.message)});results.push({request,response,ack:null,libraryApplied:false});return results;
     }
    }else{
     this.log.event("request.handle.start");
     if(unsupported())response={success:false,version:PROTOCOL_VERSION,minimumPhoneProtocolVersion:MIN_SUPPORTED_PHONE_PROTOCOL_VERSION,action:ACTION_SYNC_LIBRARY,message:`手机版版本过低，请升级到最新版后再同步（最低蓝牙协议 v${MIN_SUPPORTED_PHONE_PROTOCOL_VERSION}，当前 v${optLong(request.version)}）`};
     else if(string(request.action)===ACTION_SYNC_LIBRARY&&string(request.phase)==='probe'){
      let ipUpgradeAccepted=false;const descriptor=wireFields.object(request.ipEndpointDescriptor);
      if(descriptor&&this.options.offerIpEndpoint)try{ipUpgradeAccepted=await this.options.offerIpEndpoint(descriptor);}catch{}
      this.log.event("request.syncLibrary.probe",{remoteDeviceId:request.deviceId,ipUpgradeAccepted});
      const account=await this.options.handleAction?.accountBinding?.();this.check();
      response={...buildProbeResponse(localId,{...this.options.handleAction?.capabilities,...this.options.capabilities,supportsManifestBatches:true,supportsPersistentSession:true,supportsTransferByteProgress:true},this.options.watchCapabilities),...(account?{account}:{}),sentAt:this.now(),ipUpgradeAccepted};
     }
     else if(this.options.handleAction){
      try{response=await this.options.handleAction(request,this.log);}catch(error){this.log.event("request.handle.failed",{message:"<redacted>"},"E");throw error;}
      if(response.success===true){
       if(request.action==="pullSavedItems")this.log.event("request.pullSavedItems.built",{items:Array.isArray(response.items)?response.items.length:0});
       else if(request.action==="syncAccount")this.log.event("request.syncAccount.saved",{userId:"<redacted>",plan:"<redacted>"});
       else if(request.action==="syncLlmTokenUsage")this.log.event("request.syncLlmTokenUsage.built",{records:Array.isArray(response.records)?response.records.length:0});
      }
     }
     else response={success:false,version:PROTOCOL_VERSION,action:string(request.action),message:'当前同步操作尚未接入',errorCode:'unsupported_action'};
     this.log.event("request.handle.complete",{responseSuccess:response.success===true});if(accepted)response={...response,...persistentFields};await this.write(response);
    }
    const ack=await this.ack();let libraryApplied=false;
    if(pending&&ack?.success&&ack.applied){this.check();try{await this.repository.markSuccess(pending);this.check();libraryApplied=true;this.log.event("library.peerState.mark.success",{remoteDeviceId:pending.remoteDeviceId,localSeqMax:pending.localSeqToInclusive,remoteSeqApplied:pending.remoteSeqToInclusive,remoteProtocolVersion:pending.remoteProtocolVersion,fullSnapshot:pending.fullSnapshot});}catch(error){this.log.event("library.peerState.mark.failed",{message:"<redacted>"},"E");throw error;}}
    else if(pending)this.log.event("library.peerState.mark.skipped",{ackSuccess:ack?.success??null,ackApplied:ack?.applied??null,localSeqMax:pending.localSeqToInclusive,remoteSeqPendingAck:pending.remoteSeqToInclusive},"W");
    this.log.event("server.exchange.complete",{persistentSession:persistent,completedActions:results.length+1,elapsedMs:this.log.elapsed()});
    const result={request,response,ack,libraryApplied};results.push(result);this.options.onActionCompleted?.(result);this.status({phase:'complete',applied:libraryApplied});
    if(!persistent)return results;
   }
  }catch(error){this.status({phase:'error',message:error instanceof Error?error.message:String(error)});throw error;}
  finally{await this.close();}
 }
 /** Preview peers send frames continuously, never response ACKs. Retain only
  * the final result, so an arbitrarily long stream has bounded bookkeeping. */
 private async previewStream(initial:JsonObject):Promise<SessionActionResult>{
  let request=initial,lastAcknowledgedAt:number|undefined;
  while(true){
   const response=this.options.filterRequest?.(request)??(this.options.handleAction?await this.options.handleAction(request):{success:false,applied:false,message:'当前同步操作尚未接入'});
   this.check();const phase=string(request.phase),terminal=phase==='stop'||phase==='resourceHandoff',handledAt=this.monotonic();
   if(lastAcknowledgedAt===undefined||terminal||!bool(response.applied,true)||response.success===false||handledAt-lastAcknowledgedAt>=50){await this.write(response);lastAcknowledgedAt=this.monotonic();}
   if(terminal)return {request:initial,response,ack:null,libraryApplied:false};
   request=await this.read(30000);
   if(string(request.action)!=='previewReader')throw new Error('实时预览连接收到了其他蓝牙动作');
  }
 }
 private async exchange(request:JsonObject,localId:string,accepted:boolean):Promise<{response:JsonObject;pending:PendingSyncSuccess}>{
  const peer=trim(string(request.deviceId))?string(request.deviceId):'phone',mode=string(request.libraryMode)||'merge';
  if(!['merge','phoneToWatchReplace','watchToPhoneReplace'].includes(mode))throw new Error('Invalid library mode');
  const target=mode==='phoneToWatchReplace',source=mode==='watchToPhoneReplace';this.checkpointed=this.checkpointRequested&&mode==='merge'&&request[LIBRARY_CHECKPOINT_FEATURE]===true;
  if(!bool(request.supportsChunkedBodies)||optLong(request.version)<=4)throw new Error('Chunked article protocol required by this receiver');
  const remoteCursor=parseCursor(request),remoteRange=parseChangeSequence(request),remoteManifest=parseArticleManifest(request),sources=parseSources(request);
  this.log.event("library.manifest.parsed",{remoteManifest:remoteManifest.length,incomingSources:sources.length,remoteSeqToInclusive:remoteRange.toSeqInclusive,remoteFullSnapshot:remoteRange.fullSnapshot});
  let sourcesApplied=mode==='merge'?await this.timed('library.sources.applied',()=>this.repository.mergeSources(sources,peer,false)):0;this.check();
  if(mode==="merge")this.log.event("library.sources.merged",{incomingSources:sources.length,sourcesApplied});
  const prepared=await this.timed('library.window.prepared',()=>this.repository.prepareWindow(peer,remoteCursor.lastRemoteSeqApplied));this.check();
  const force=bool(request.forceFull),full=force||mode!=='merge'||!bool(request.supportsChangeSequences)||optLong(request.version)<8;
  const window:LibraryWindow=full?{...prepared,articleManifest:prepared.fullArticleManifest,rssSources:await this.repository.exportSources(),fullSnapshot:true,fromSeqExclusive:0,fallbackReason:force?'forcedFull':'peerProtocol'}:prepared;
  this.log.event("library.local.exported",{outgoingArticles:window.articleManifest.length,fullArticles:window.fullArticleManifest.length,outgoingSources:window.rssSources.length,chunked:true,localSeqMax:window.toSeqInclusive,peerAckedSeq:window.peerAckedSeq,fullSnapshot:window.fullSnapshot});
  const selected=source?[]:selectArticleBodyRequests(window.fullArticleManifest,remoteManifest,{supportsMetadataOnly:bool(request.supportsMetadataOnlyArticles)&&optLong(request.version)>=8});
  let manifest=buildManifestResponse(localId,window.articleManifest,selected,window.rssSources,sourcesApplied,window,this.now);if(accepted)manifest={...manifest,...persistentFields};if(this.checkpointed)manifest={...manifest,[LIBRARY_CHECKPOINT_FEATURE]:true};
  for(const frame of bool(request.supportsManifestBatches)?buildManifestFrames(manifest):[manifest])await this.write(frame);
  this.status({phase:'receiving'});let applied=0;
  const receiver=new ArticleBatchReceiver(selected,async entry=>{this.check();if(!source)applied+=await this.repository.receiveArticle(entry,peer,target);this.check();},{ignoreIncoming:source,flushCompleteArticles:this.checkpointed});
  let receipt,mergeMs=0;do{const incoming=await this.read(180000),mergeStart=this.monotonic();receipt=await receiver.consume(incoming);this.status({phase:'receiving',receivedArticles:receiver.committedArticles});mergeMs+=this.monotonic()-mergeStart;if(this.checkpointed&&incoming.libraryCheckpoint===true){if(!receiver.checkpointReady)throw new Error('Library checkpoint splits an incomplete article');await this.write(libraryBatchAck('phoneToWatch',Number(incoming.batchIndex??0),receiver.committedArticles));this.log.event('library.batch.applied',{confirmedArticles:receiver.committedArticles,batchIndex:Number(incoming.batchIndex??0)});}}while(!receipt);receiver.finish();this.log.event("library.articles.parsed",{incomingArticles:receipt.receivedArticles});this.log.event("library.articles.merged",{incomingArticles:receipt.receivedArticles,articlesApplied:applied,chunked:true,elapsedMs:Math.max(0,Math.round(mergeMs))});
  if(target){sourcesApplied=await this.repository.mergeSources(sources,peer,true);this.check();this.log.event("library.sources.merged",{incomingSources:sources.length,sourcesApplied});await this.repository.finalizeSnapshot(remoteManifest.map(a=>a.articleId),[...sources.map(s=>s.url),'watchrss://phone-imports']);this.check();}
  this.status({phase:'sending',receivedArticles:receipt.receivedArticles});
  const outgoing=await this.timed('library.bodies.materialized',()=>this.repository.exportRequested(receipt.bodyRequests));this.check();
  this.log.event("library.response.articles.exported",{bodyRequests:receipt.bodyRequests.length,outgoingArticles:outgoing.length});
  const frameBuildStarted=this.monotonic();const responses=buildChunkedResponseFrames(localId,outgoing,receipt.bodyRequests,applied,sourcesApplied,bool(request.supportsArticleBatches),this.now);
  this.log.event("library.response.frames.built",{libraryResponseFrames:responses.length,elapsedMs:Math.max(0,Math.round(this.monotonic()-frameBuildStarted))});
  const sentIds=new Set<string>();
  for(let index=0;index<responses.length;index++){
   const frame=responses[index]!,checkpoint=this.checkpointed&&wantsLibraryCheckpoint(responses,index);
   await this.write(this.checkpointed?{...frame,libraryCheckpoint:checkpoint}:frame);
   if(Array.isArray(frame.articles))for(const article of frame.articles)sentIds.add(String((article as JsonObject).articleId));
   this.status({phase:'sending',receivedArticles:receipt.receivedArticles,sentArticles:sentIds.size,totalArticles:outgoing.length});
   if(checkpoint){requireLibraryBatchAck(await this.read(120000),'watchToPhone',index);this.log.event('library.batch.confirmed',{batchIndex:index});}
  }
  if(source){await this.repository.resetPeerState();this.check();}
  // Keep the same response summary as native without retaining body byte arrays.
  const first=responses[0]!,response:JsonObject={success:responses.every(f=>bool(f.success,true)),version:optLong(first.version,14),action:ACTION_SYNC_LIBRARY,phase:string(first.phase)||'complete',deviceId:string(first.deviceId),sentAt:optLong(first.sentAt),batchCount:responses.length,totalArticles:responses.reduce((n,f)=>n+(Array.isArray(f.articles)?f.articles.length:0),0)};if(first.stats)response.stats=first.stats;
  this.log.event("library.manifest.handle.complete",{incomingArticles:receipt.receivedArticles,outgoingSources:window.rssSources.length,localSeqMax:window.toSeqInclusive,peerAckedSeq:window.peerAckedSeq,remoteSeqPendingAck:remoteRange.toSeqInclusive,fullSnapshot:window.fullSnapshot,peerStatePendingAck:true});
  return {response,pending:{remoteDeviceId:peer,localSeqToInclusive:target?0:window.toSeqInclusive,remoteSeqToInclusive:source?0:remoteRange.toSeqInclusive,remoteProtocolVersion:optLong(request.version),fullSnapshot:window.fullSnapshot}};
 }
}
