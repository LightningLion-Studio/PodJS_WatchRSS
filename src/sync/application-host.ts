import {cancellableSql} from '../core/sql-cancellation';
import {syncHistory} from '../debug/sync-diagnostics-host';
import {BinaryApplicationService} from './library-binary/host';
import {RELEASE_B2_ENABLED} from './library-binary/routing';
import {bookFileWork} from './library-binary/book-import';
import {BinaryStore} from './library-binary/store';
import {readAccountDomainState} from './domain-external-state';
import {hashJavaText} from './article-export';
import {localTransferActivity} from './local-transfer';
import {ResumeApplicationService} from './library-resume/host';
import {ResumeStore} from './library-resume/store';
import {VerifiedChunkStore} from '@podjs/framework/verified-chunk-store';
import {watchBookSyncAction,watchLegacyTransferIntake,watchLocalTransferIntake} from '../sync-v2/local-transfer-intake';
import {SYNC_V2_PRODUCT} from '../sync-v2/gate';
import {secureCallsite} from '../cloud/secure-callsite';
import {updateLibraryProgress,updateLibraryBytes} from './progress.ts';
import {foregroundRequestFilter,BluetoothActionPolicy} from './action-policy.ts';
import {loggedSyncSilence} from '../logs/sync-media.ts';
import {appLogger} from '../logs/app-logger.ts';
import {debugGate} from '../debug/host.ts';
import {DebugBluetoothSession} from '../debug/bluetooth.ts';
import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('application-host');
import {hostAppLogger} from '../logs/logger-host.ts';
import {clearRemoteInput,completeRemoteInput} from "../remote-input/inbox.ts";
import {readerPreviewSession,requestReaderPreviewOpen,disposeReaderPreview} from "../reader/preview-host.ts";
import {handleReaderPreview} from "./reader-preview.ts";
import {ReaderPresetStore,notifyReaderPresetsChanged} from "../reader/preset-store.ts";
import {ReaderSyncActions} from "./reader-actions.ts";
import {ReaderResources} from "./reader-resources.ts";
import {hostReaderResourceFiles} from "./reader-resources-host.ts";
import {NoteAssetReceiver} from './note-assets.ts';
import {createApplicationActionHandler} from './application-actions.ts';
import {hostArticleBodyCodec} from './article-body-host.ts';
import {usageTelemetry} from '../telemetry/host.ts';
import {SyncDiagnosticLog} from './diagnostic-log.ts';
import {summaryAccountStore} from '../llm/runtime.ts';
import {lifecycle,onLifecycleChange,hasCapability,getDisplayMetrics,kv} from '@podjs/framework/watch';
import {displayPower,silencePlayback,rfcomm,framedStreams,delay,fileChunks,webSockets,byteStreams,discovery,onNetworkChange,hostOperation,byteHostOperation,hasByteBridge,base64ToBytes} from '@podjs/framework/services';
import {db,clearWatchLibrary,getDomainVectorStore,getTokenUsageForSync,getTokenUsagePageForSync,getSavedLinksForSync,getLibrarySyncRepository,notifyLibraryChanged,memoRepository,notifyNotesChanged} from '../services.ts';
import {createRfcommLibraryListener} from './rfcomm-host.ts';
import {commitGuardedLibraryTransfer,commitDurableLibraryTransfer,noteAssetFiles} from '../services';
import {ApplicationForegroundSync,didApplyLibrary} from './application-foreground.ts';
import {IpSyncController,canOfferIpRoutes} from './ip-controller.ts';
import {acquireIpDescriptor} from './ip-discovery.ts';
import {buildWatchMediaCapabilities} from './media-capabilities.ts';
import {hostIpCrypto} from './ip-crypto-host.ts';
import {requestPairingPage,setPairingRequestForeground} from '../ui/pairing-request.ts';
export function startApplicationForegroundSync(){
 let disposed=false,ip:IpSyncController|undefined;
 setPairingRequestForeground(lifecycle()==='active');
 const loggedSilence=loggedSyncSilence(silencePlayback);
 const storage={get:(key:string)=>kv.get<string>(key),set:(key:string,value:string)=>kv.set(key,value)};
 const diagnostics=new SyncDiagnosticLog(storage,undefined,message=>hostAppLogger.d('WatchSync',message));
 const accountTelemetry=usageTelemetry;
 const intake=watchLocalTransferIntake(db,<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,secureCallsite(method,args)).result);
 const applyBooks=watchBookSyncAction(getLibrarySyncRepository,summaryAccountStore,intake);
 const deviceId=async()=>(await getLibrarySyncRepository()).deviceId();
 const legacyIntake=watchLegacyTransferIntake(summaryAccountStore,deviceId,intake);
 // With Sync v2 enabled, B2 and C-v1 require guarded peer negotiation.
 const allowLocalLibraryExtensions=()=>!disposed&&lifecycle()==='active'&&hasCapability('data.files.resumable');
 const resume=new ResumeApplicationService({assetHost:<T>(method:string,args:Record<string,unknown>)=>method==='file.read'?fileChunks.readBytes(String(args.path),Number(args.offset),Number(args.maxBytes)) as Promise<T>:hostOperation<T>(method,args).result,store:new ResumeStore(db),chunks:new VerifiedChunkStore(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result,hasByteBridge()?<T>(method:string,args:Record<string,unknown>,bytes:Uint8Array)=>byteHostOperation<T>(method,args,bytes).result:undefined),account:summaryAccountStore,repository:getLibrarySyncRepository,
  intake,localPermission:()=>!SYNC_V2_PRODUCT.syncV2&&allowLocalLibraryExtensions()&&hasCapability('runtime.timer'),
  randomId:async()=>Array.from(base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64),b=>b.toString(16).padStart(2,'0')).join(''),
  readFile:async(path,size)=>{const result=new Uint8Array(size);for(let at=0;at<size;){const part=await fileChunks.readBytes(path,at,Math.min(65536,size-at)),bytes=part.bytes;if(part.size!==size||!bytes.length||at+bytes.length>size)throw Error('LOCAL_IO');result.set(bytes,at);at+=bytes.length;}return result;},changed:notifyLibraryChanged,
 });
 const binaryFiles={...fileChunks,async orphanScratch(collect:boolean){
  let bytes=0;
  for(const path of ['books','library-binary/spool','article_content']){
   const result=await hostOperation<{bytes:number}>('file.scratch',{path,collect}).result;
   if(!Number.isSafeInteger(result.bytes)||result.bytes<0)throw Error('LOCAL_IO');
   bytes+=result.bytes;
  }
  return bytes;
 }};
 if(hasCapability('data.files.chunks'))void binaryFiles.orphanScratch(true).catch(()=>logConsole.warn('WatchRSS scratch collection: <redacted>'));
 let binaryElapsed=0;const binaryChunks=new VerifiedChunkStore(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result,<T>(method:string,args:Record<string,unknown>,bytes:Uint8Array)=>byteHostOperation<T>(method,args,bytes).result);
 const guardedRuntime=async()=>{
  try{const r=await framedStreams.runtime();return r.version===1&&r.codec==='length-prefixed-chunks-v1'&&r.chunkBytes===65536&&r.windows.includes(1)&&r.windows.includes(8)&&['open','next','register','enable','bind','applied','control','ack','data','state','retire','send','sendRejected','revoke','guardSql'].every(m=>r.methods.includes(m));}
  catch{return false;}
 };
 const binary=new BinaryApplicationService({b2BooksEnabled:RELEASE_B2_ENABLED,intake,bookRuntime:guardedRuntime,
  ...(SYNC_V2_PRODUCT.syncV2?{guardedRuntime,assetIndex:noteAssetFiles,sessionTransaction:async(context,statements)=>{
   const check=Object.assign(()=>context.checkCancelled?.(),{onCancel:context.onCancel});
   await db.execute('PRAGMA synchronous=FULL');
   return cancellableSql(db,check).transactionChanges!([...statements,{sql:"UPDATE library_binary_guard SET ok=CASE WHEN (SELECT synchronous FROM pragma_synchronous)=2 THEN 1 ELSE 0 END WHERE id=1"}]);
  }}:{}),guardedTransaction:commitGuardedLibraryTransfer,durableTransaction:commitDurableLibraryTransfer,byteBridge:hasByteBridge,store:new BinaryStore(db),chunks:binaryChunks,files:binaryFiles,bookExcluded:(kind,limit)=>logConsole.warn('B2 freeze excluded '+kind+' ('+limit+')'),bookWork:advance=>bookFileWork(fileChunks,hostOperation,advance),library:{repository:getLibrarySyncRepository,files:fileChunks},account:summaryAccountStore,deviceId:async()=>(await getLibrarySyncRepository()).deviceId(),randomId:async()=>Array.from(base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64),b=>b.toString(16).padStart(2,'0')).join(''),now:()=>binaryElapsed,sampleClock:async()=>{const r=await binaryChunks.runtime();if(!r)throw Error('LOCAL_IO');binaryElapsed=Math.max(binaryElapsed,r.elapsedMillis);},sleep:delay,localPermission:allowLocalLibraryExtensions,changed:kind=>kind==='noteAsset'?notifyNotesChanged():notifyLibraryChanged('remote')});
 const bluetoothPolicy=new BluetoothActionPolicy(()=>binary.canSwitch());
 const handleAction=createApplicationActionHandler({legacyIntake,domainVectors:{open:async(peer,profile)=>(await getDomainVectorStore()).open(peer,profile)},books:{apply:applyBooks},requestPairingPage:session=>!disposed&&lifecycle()==='active'?requestPairingPage(session):false,previewReader:request=>handleReaderPreview(request,readerPreviewSession,requestReaderPreviewOpen),readerSync:hasCapability('data.files.chunks')&&hasCapability('crypto.basic')?new ReaderSyncActions(new ReaderPresetStore(),new ReaderResources(hostReaderResourceFiles),notifyReaderPresetsChanged,()=>{readerPreviewSession.refreshResourceTransfer();}):undefined,readTokenUsage:getTokenUsageForSync,readTokenUsagePage:getTokenUsagePageForSync,readSavedLinks:getSavedLinksForSync,readDebugLog:maxChars=>hostAppLogger.pull(maxChars),clearLibrary:context=>clearWatchLibrary({check:context?.checkCancelled,onCancel:context?.onCancel}),notes:memoRepository,deviceId,notesChanged:notifyNotesChanged,accountStore:summaryAccountStore,accountStateRoot:async()=>(await getDomainVectorStore()).accountStateRoot(await readAccountDomainState(await summaryAccountStore.read(),value=>hashJavaText(value,hostArticleBodyCodec))),accountBindingHash:hostArticleBodyCodec.sha256,accountTelemetry,noteAssets:new NoteAssetReceiver({...fileChunks,write:(path,data)=>fileChunks.writeBytes(path,base64ToBytes(data)),append:(path,data,offset)=>fileChunks.appendBytes(path,base64ToBytes(data),offset)},noteAssetFiles)});
 const diagnosticBookTitle=async(id:string)=>{const row=(await db.query('SELECT state_json FROM sync_books WHERE book_id=?',[id]))[0];return row?JSON.parse(String(row.state_json)).title:null;};
 const watchCapabilities=buildWatchMediaCapabilities(getDisplayMetrics());
 diagnostics.state('bluetooth','starting');
 const stopLifecycle=onLifecycleChange(state=>{setPairingRequestForeground(!disposed&&state==='active');ip?.setActive(state==='active');});
 const stopNetwork=hasCapability('net.discovery')?onNetworkChange(()=>ip?.refresh(),()=>appLogger.w('WatchRSS_IpSync','默认网络监听注册失败')):()=>{};
 const ipReady=getLibrarySyncRepository().then(repository=>{
  if(disposed||!hasCapability('net.websocket'))return;
  ip=new IpSyncController({repository,canOffer:hasCapability('net.discovery')?async descriptor=>canOfferIpRoutes(descriptor,await discovery.networkSnapshot()):undefined,acquireDescriptor:hasCapability('net.discovery')?()=>acquireIpDescriptor(discovery,delay):undefined,discover:hasCapability('net.discovery')?port=>{
   const operation=discovery.mdns({serviceType:'_watchrss-sync._tcp.',namePrefix:'WatchRSS-',expectedPort:port,windowMs:1500});
   return {cancel:()=>operation.cancel(),result:operation.result.then(({endpoints})=>endpoints.map(endpoint=>({endpointId:'mdns-'+endpoint.address,address:endpoint.address,family:'ipv4',transportKind:'wifiLan' as const,priority:300})))};
  }:undefined,sockets:webSockets,streams:byteStreams,crypto:hostIpCrypto,delay,mediaLease:async active=>{await displayPower.keepAwake('ip-sync',active);return loggedSilence.lease('ip-sync',active);},onError:error=>{diagnostics.failure('ip');logConsole.warn('WatchRSS IP sync: <redacted>');},onRoute:route=>{diagnostics.state('ip',route?route.endpoint.transportKind:'closed');logConsole.info('WatchRSS IP route: '+(route?route.endpoint.transportKind:'closed'));}},{history:syncHistory,diagnosticBookTitle,resume,onStatus:updateLibraryProgress,onTransferProgress:updateLibraryBytes,filterRequest:foregroundRequestFilter,handleAction,watchCapabilities,acquireSession:()=>localTransferActivity.acquire(),onSessionClosed:results=>{if(results.some(didApplyLibrary))notifyLibraryChanged();},onActionCompleted:result=>{diagnostics.action(String(result.request.action??''),result.response.success===true);if(!disposed)completeRemoteInput(result);}});
  ip.setActive(lifecycle()==='active');return ip;
 });void ipReady.catch(error=>logConsole.warn('WatchRSS IP initialization: <redacted>'));
 const bluetooth=new ApplicationForegroundSync({acquireConnectionPage:()=>bluetoothPolicy.acquireConnectionPage(),repository:getLibrarySyncRepository,createListener:createRfcommLibraryListener,lifecycle,onLifecycle:onLifecycleChange,display:displayPower,radio:rfcomm,silence:loggedSilence,delay,
  onLibraryChanged:notifyLibraryChanged,onState:state=>{diagnostics.state('bluetooth',state);logConsole.info('WatchRSS foreground sync: '+state);},onError:error=>{diagnostics.failure('bluetooth');logConsole.warn('WatchRSS foreground sync: <redacted>');},
 },{history:syncHistory,diagnosticBookTitle,binary,resume,onStatus:updateLibraryProgress,onTransferProgress:updateLibraryBytes,filterRequest:bluetoothPolicy.filterRequest,handleAction,watchCapabilities,acquireSession:()=>localTransferActivity.acquire(),onSessionClosed:results=>{if(results.some(didApplyLibrary))notifyLibraryChanged();},onActionCompleted:result=>{diagnostics.action(String(result.request.action??''),result.response.success===true);if(!disposed)completeRemoteInput(result);},offerIpEndpoint:async descriptor=>(await ipReady)?.offer(descriptor)??false});
 const ready=Promise.all([bluetooth.ready,ipReady]);void ready.catch(()=>{});
 let closing:Promise<void>|undefined;
 return {ready,createDebugBluetooth:()=>{debugGate.require();return new DebugBluetoothSession(debugGate,{acquire:()=>bluetooth.acquireExclusive(),listener:()=>{let inner:ReturnType<typeof createRfcommLibraryListener>|undefined,stopped=false;return {start:async options=>{const repository=await getLibrarySyncRepository();if(stopped)throw Error('Bluetooth sync cancelled');inner=createRfcommLibraryListener(repository);return inner.start({...options,history:syncHistory,diagnosticBookTitle,binary,resume,handleAction,watchCapabilities,acquireSession:()=>localTransferActivity.acquire(),onSessionClosed:results=>{if(results.some(didApplyLibrary))notifyLibraryChanged();}});},stop:()=>{stopped=true;inner?.stop();}};},keepAwake:active=>displayPower.keepAwake('debug-bt-sync',active)});},bluetooth:{acquireConnectionPage:()=>bluetooth.acquireConnectionPage(),get state(){return bluetooth.state;},subscribe:(observer:Parameters<ApplicationForegroundSync['subscribe']>[0])=>bluetooth.subscribe(observer),refresh:()=>bluetooth.refresh()},setMediaEnabled:(enabled:boolean)=>bluetooth.setMediaEnabled(enabled),refresh:()=>{ip?.refresh();return bluetooth.refresh();},dispose:()=>closing??=(async()=>{disposed=true;setPairingRequestForeground(false);clearRemoteInput();stopNetwork();stopLifecycle();await ipReady.catch(()=>{});await Promise.all([ip?.dispose(),bluetooth.dispose(),disposeReaderPreview()]);})()};
}
