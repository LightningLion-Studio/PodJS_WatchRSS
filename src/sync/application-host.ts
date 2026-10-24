import {localTransferActivity} from './local-transfer';
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
import {displayPower,silencePlayback,rfcomm,delay,fileChunks,webSockets,byteStreams,discovery,onNetworkChange} from '@podjs/framework/services';
import {getDomainVectorStore,getTokenUsageForSync,getTokenUsagePageForSync,getSavedLinksForSync,getLibrarySyncRepository,notifyLibraryChanged,memoRepository,notifyNotesChanged} from '../services.ts';
import {createRfcommLibraryListener} from './rfcomm-host.ts';
import {ApplicationForegroundSync,didApplyLibrary} from './application-foreground.ts';
import {IpSyncController,canOfferIpRoutes} from './ip-controller.ts';
import {acquireIpDescriptor} from './ip-discovery.ts';
import {buildWatchMediaCapabilities} from './media-capabilities.ts';
import {hostIpCrypto} from './ip-crypto-host.ts';
import {requestPairingPage,setPairingRequestForeground} from '../ui/pairing-request.ts';
export function startApplicationForegroundSync(){
 let disposed=false,ip:IpSyncController|undefined;
 setPairingRequestForeground(lifecycle()==='active');
 const bluetoothPolicy=new BluetoothActionPolicy();
 const loggedSilence=loggedSyncSilence(silencePlayback);
 const storage={get:(key:string)=>kv.get<string>(key),set:(key:string,value:string)=>kv.set(key,value)};
 const diagnostics=new SyncDiagnosticLog(storage,undefined,message=>hostAppLogger.d('WatchSync',message));
 const accountTelemetry=usageTelemetry;
 const handleAction=createApplicationActionHandler({domainVectors:{open:async(peer,profile)=>(await getDomainVectorStore()).open(peer,profile)},books:{apply:async(request,session,afterAck)=>(await getLibrarySyncRepository()).syncBooks(request,session,afterAck)},requestPairingPage:session=>!disposed&&lifecycle()==='active'?requestPairingPage(session):false,previewReader:request=>handleReaderPreview(request,readerPreviewSession,requestReaderPreviewOpen),readerSync:hasCapability('data.files.chunks')&&hasCapability('crypto.basic')?new ReaderSyncActions(new ReaderPresetStore(),new ReaderResources(hostReaderResourceFiles),notifyReaderPresetsChanged,()=>{readerPreviewSession.refreshResourceTransfer();}):undefined,readTokenUsage:getTokenUsageForSync,readTokenUsagePage:getTokenUsagePageForSync,readSavedLinks:getSavedLinksForSync,readDebugLog:maxChars=>hostAppLogger.pull(maxChars),clearLibrary:async()=>{await (await getLibrarySyncRepository()).clearLibrary();notifyLibraryChanged();},notes:memoRepository,deviceId:async()=>(await getLibrarySyncRepository()).deviceId(),notesChanged:notifyNotesChanged,accountStore:summaryAccountStore,accountBindingHash:hostArticleBodyCodec.sha256,accountTelemetry,noteAssets:new NoteAssetReceiver(fileChunks)});
 const watchCapabilities=buildWatchMediaCapabilities(getDisplayMetrics());
 diagnostics.state('bluetooth','starting');
 const stopLifecycle=onLifecycleChange(state=>{setPairingRequestForeground(!disposed&&state==='active');ip?.setActive(state==='active');});
 const stopNetwork=hasCapability('net.discovery')?onNetworkChange(()=>ip?.refresh(),()=>appLogger.w('WatchRSS_IpSync','默认网络监听注册失败')):()=>{};
 const ipReady=getLibrarySyncRepository().then(repository=>{
  if(disposed||!hasCapability('net.websocket'))return;
  ip=new IpSyncController({repository,canOffer:hasCapability('net.discovery')?async descriptor=>canOfferIpRoutes(descriptor,await discovery.networkSnapshot()):undefined,acquireDescriptor:hasCapability('net.discovery')?()=>acquireIpDescriptor(discovery,delay):undefined,discover:hasCapability('net.discovery')?port=>{
   const operation=discovery.mdns({serviceType:'_watchrss-sync._tcp.',namePrefix:'WatchRSS-',expectedPort:port,windowMs:1500});
   return {cancel:()=>operation.cancel(),result:operation.result.then(({endpoints})=>endpoints.map(endpoint=>({endpointId:'mdns-'+endpoint.address,address:endpoint.address,family:'ipv4',transportKind:'wifiLan' as const,priority:300})))};
  }:undefined,sockets:webSockets,streams:byteStreams,crypto:hostIpCrypto,delay,mediaLease:async active=>{await displayPower.keepAwake('ip-sync',active);return loggedSilence.lease('ip-sync',active);},onError:error=>{diagnostics.failure('ip');logConsole.warn('WatchRSS IP sync: <redacted>');},onRoute:route=>{diagnostics.state('ip',route?route.endpoint.transportKind:'closed');logConsole.info('WatchRSS IP route: '+(route?route.endpoint.transportKind:'closed'));}},{onStatus:updateLibraryProgress,onTransferProgress:updateLibraryBytes,filterRequest:foregroundRequestFilter,handleAction,watchCapabilities,acquireSession:()=>localTransferActivity.acquire(),onSessionClosed:results=>{if(results.some(didApplyLibrary))notifyLibraryChanged();},onActionCompleted:result=>{diagnostics.action(String(result.request.action??''),result.response.success===true);if(!disposed)completeRemoteInput(result);}});
  ip.setActive(lifecycle()==='active');return ip;
 });void ipReady.catch(error=>logConsole.warn('WatchRSS IP initialization: <redacted>'));
 const bluetooth=new ApplicationForegroundSync({acquireConnectionPage:()=>bluetoothPolicy.acquireConnectionPage(),repository:getLibrarySyncRepository,createListener:createRfcommLibraryListener,lifecycle,onLifecycle:onLifecycleChange,display:displayPower,radio:rfcomm,silence:loggedSilence,delay,
  onLibraryChanged:notifyLibraryChanged,onState:state=>{diagnostics.state('bluetooth',state);logConsole.info('WatchRSS foreground sync: '+state);},onError:error=>{diagnostics.failure('bluetooth');logConsole.warn('WatchRSS foreground sync: <redacted>');},
 },{onStatus:updateLibraryProgress,onTransferProgress:updateLibraryBytes,filterRequest:bluetoothPolicy.filterRequest,handleAction,watchCapabilities,acquireSession:()=>localTransferActivity.acquire(),onSessionClosed:results=>{if(results.some(didApplyLibrary))notifyLibraryChanged();},onActionCompleted:result=>{diagnostics.action(String(result.request.action??''),result.response.success===true);if(!disposed)completeRemoteInput(result);},offerIpEndpoint:async descriptor=>(await ipReady)?.offer(descriptor)??false});
 const ready=Promise.all([bluetooth.ready,ipReady]);void ready.catch(()=>{});
 let closing:Promise<void>|undefined;
 return {ready,createDebugBluetooth:()=>{debugGate.require();return new DebugBluetoothSession(debugGate,{acquire:()=>bluetooth.acquireExclusive(),listener:()=>{let inner:ReturnType<typeof createRfcommLibraryListener>|undefined,stopped=false;return {start:async options=>{const repository=await getLibrarySyncRepository();if(stopped)throw Error('Bluetooth sync cancelled');inner=createRfcommLibraryListener(repository);return inner.start({...options,handleAction,watchCapabilities,acquireSession:()=>localTransferActivity.acquire(),onSessionClosed:results=>{if(results.some(didApplyLibrary))notifyLibraryChanged();}});},stop:()=>{stopped=true;inner?.stop();}};},keepAwake:active=>displayPower.keepAwake('debug-bt-sync',active)});},bluetooth:{acquireConnectionPage:()=>bluetooth.acquireConnectionPage(),get state(){return bluetooth.state;},subscribe:(observer:Parameters<ApplicationForegroundSync['subscribe']>[0])=>bluetooth.subscribe(observer),refresh:()=>bluetooth.refresh()},setMediaEnabled:(enabled:boolean)=>bluetooth.setMediaEnabled(enabled),refresh:()=>{ip?.refresh();return bluetooth.refresh();},dispose:()=>closing??=(async()=>{disposed=true;setPairingRequestForeground(false);clearRemoteInput();stopNetwork();stopLifecycle();await ipReady.catch(()=>{});await Promise.all([ip?.dispose(),bluetooth.dispose(),disposeReaderPreview()]);})()};
}
