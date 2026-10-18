import {appLogger,type LogLevel} from './app-logger.ts';
const events=new Set(["library.batch.applied","library.batch.confirmed","frame.read.complete","frame.write.complete","library.cursor.prepared","library.window.prepared","library.sources.applied","library.bodies.materialized","server.exchange.abort.close.failed","server.exchange.aborted","server.ip.failed","frame.read.failed","frame.write.failed","ack.read.failed", "ack.read.missing", "ack.read.start", "ack.read.success", "ack.received.waitApplied", "library.articles.merged", "library.articles.parsed", "library.cursor.exchanged", "library.errorResponse.write.failed", "library.local.exported", "library.manifest.handle.complete", "library.manifest.handle.failed", "library.manifest.handle.start", "library.manifest.parsed", "library.peerState.mark.failed", "library.peerState.mark.skipped", "library.peerState.mark.success", "library.response.articles.exported", "library.response.frames.built", "library.sources.merged", "request.handle.complete", "request.handle.failed", "request.handle.start", "request.pullSavedItems.built", "request.syncAccount.saved", "request.syncLibrary.probe", "request.syncLlmTokenUsage.built", "server.accept.start", "server.accept.success", "server.acceptOnce.failed", "server.acceptOnce.start", "server.client.accepted", "server.exchange.complete", "server.listen.success", "server.session.accepted", "server.session.complete"]);
const numericFields=new Set(['confirmedArticles','batchIndex','frameBytes','readMs','decodeMs','encodeMs','writeMs','timeoutMs','elapsedMs','completedActions','responseSuccess','ackApplicationSucceeded','ackSuccess','ackApplied','localSeqMax','remoteSeqPendingAck','remoteSeqApplied','remoteProtocolVersion','fullSnapshot','peerStatePendingAck','persistentSession','remoteManifest','incomingSources','remoteSeqToInclusive','remoteFullSnapshot','sourcesApplied','outgoingArticles','fullArticles','outgoingSources','chunked','peerAckedSeq','incomingArticles','articlesApplied','outgoingDiff','bodyRequests','libraryResponseFrames','ipUpgradeAccepted','items','records','success']);
const redactedFields=new Set(['remoteName','remoteAddress','remoteDeviceId','message','phase','userId','plan']);
let sequence=0;
/** Native WatchBluetoothDebugLog framing with privacy-safe scalar fields.
 * Native remote identifiers, peer names, payload text and exceptions are never
 * forwarded. This is for session/transaction boundaries, not transfer chunks. */
export class SyncEventLog {
 private readonly session:string;
 constructor(prefix:"watchSync"|"watchIpSync"="watchSync"){this.session=`${prefix==="watchIpSync"?"watchIpSync":"watchSync"}-${Date.now().toString(36)}-${++sequence}`;}
 private readonly started=globalThis.performance?.now?.()??Date.now();
 elapsed(){return Math.max(0,Math.round((globalThis.performance?.now?.()??Date.now())-this.started));}
 event(event:string,fields:Record<string,unknown>={},level:LogLevel='I'){
  const values=Object.entries(fields).filter(([key])=>numericFields.has(key)||redactedFields.has(key)).map(([key,value])=>` ${key.replace(/[^a-zA-Z0-9_-]/g,'')}=${numericFields.has(key)&&(typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')?String(value):value===null?'null':'"<redacted>"'}`).join('');
  // Event names are compile-time labels at every caller; still reject arbitrary payloads.
  const label=events.has(event)?event:'unknown';
  const message=`event="${label}" session="${this.session}"${values}`;
  if(level==='E')appLogger.e('BtSyncDebug',message);else if(level==='W')appLogger.w('BtSyncDebug',message);else appLogger.i('BtSyncDebug',message);
 }
}
