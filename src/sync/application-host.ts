import {clearRemoteInput,completeRemoteInput} from "../remote-input/inbox.ts";
import {readerPreviewSession,requestReaderPreviewOpen,disposeReaderPreview} from "../reader/preview-host.ts";
import {handleReaderPreview} from "./reader-preview.ts";
import {ReaderPresetStore,notifyReaderPresetsChanged} from "../reader/preset-store.ts";
import {ReaderSyncActions} from "./reader-actions.ts";
import {ReaderResources} from "./reader-resources.ts";
import {hostReaderResourceFiles} from "./reader-resources-host.ts";
import {NoteAssetReceiver} from './note-assets.ts';
import {createApplicationActionHandler} from './application-actions.ts';
import {SyncDiagnosticLog} from './diagnostic-log.ts';
import {summaryAccountStore} from '../llm/runtime.ts';
import {lifecycle,onLifecycleChange,hasCapability,kv} from '@podjs/framework/watch';
import {displayPower,silencePlayback,rfcomm,delay,fileChunks,webSockets,byteStreams,discovery,onNetworkChange} from '@podjs/framework/services';
import {getTokenUsageForSync,getSavedLinksForSync,getLibrarySyncRepository,notifyLibraryChanged,memoRepository,notifyNotesChanged} from '../services.ts';
import {createRfcommLibraryListener} from './rfcomm-host.ts';
import {ApplicationForegroundSync} from './application-foreground.ts';
import {IpSyncController} from './ip-controller.ts';
import {acquireIpDescriptor} from './ip-discovery.ts';
import {hostIpCrypto} from './ip-crypto-host.ts';
export function startApplicationForegroundSync(){
 const diagnostics=new SyncDiagnosticLog({get:key=>kv.get<string>(key),set:(key,value)=>kv.set(key,value)});
 const handleAction=createApplicationActionHandler({previewReader:request=>handleReaderPreview(request,readerPreviewSession,requestReaderPreviewOpen),readerSync:new ReaderSyncActions(new ReaderPresetStore(),new ReaderResources(hostReaderResourceFiles),notifyReaderPresetsChanged,()=>{readerPreviewSession.refreshResourceTransfer();}),readTokenUsage:getTokenUsageForSync,readSavedLinks:getSavedLinksForSync,readDebugLog:maxChars=>diagnostics.pull(maxChars),clearLibrary:async()=>{await (await getLibrarySyncRepository()).clearLibrary();notifyLibraryChanged();},notes:memoRepository,deviceId:async()=>(await getLibrarySyncRepository()).deviceId(),notesChanged:notifyNotesChanged,accountStore:summaryAccountStore,noteAssets:new NoteAssetReceiver(fileChunks)});
 diagnostics.state('bluetooth','starting');
 let disposed=false,ip:IpSyncController|undefined;
 const stopLifecycle=onLifecycleChange(state=>ip?.setActive(state==='active'));
 const stopNetwork=hasCapability('net.discovery')?onNetworkChange(()=>ip?.refresh(),error=>console.warn('WatchRSS network observer: '+String(error))):()=>{};
 const ipReady=getLibrarySyncRepository().then(repository=>{
  if(disposed||!hasCapability('net.websocket'))return;
  ip=new IpSyncController({repository,acquireDescriptor:hasCapability('net.discovery')?()=>acquireIpDescriptor(discovery,delay):undefined,discover:hasCapability('net.discovery')?port=>{
   const operation=discovery.mdns({serviceType:'_watchrss-sync._tcp.',namePrefix:'WatchRSS-',expectedPort:port,windowMs:1500});
   return {cancel:()=>operation.cancel(),result:operation.result.then(({endpoints})=>endpoints.map(endpoint=>({endpointId:'mdns-'+endpoint.address,address:endpoint.address,family:'ipv4',transportKind:'wifiLan' as const,priority:300})))};
  }:undefined,sockets:webSockets,streams:byteStreams,crypto:hostIpCrypto,delay,mediaLease:active=>silencePlayback.lease('ip-sync',active),onError:error=>{diagnostics.failure('ip');console.warn('WatchRSS IP sync: '+String(error));},onRoute:route=>{diagnostics.state('ip',route?route.endpoint.transportKind:'closed');console.info('WatchRSS IP route: '+(route?route.endpoint.transportKind:'closed'));}},{handleAction,onActionCompleted:result=>{diagnostics.action(String(result.request.action??''),result.response.success===true);if(!disposed)completeRemoteInput(result);if(result.request.action==='syncLibrary')notifyLibraryChanged();}});
  ip.setActive(lifecycle()==='active');return ip;
 });void ipReady.catch(error=>console.warn('WatchRSS IP initialization: '+String(error)));
 const bluetooth=new ApplicationForegroundSync({repository:getLibrarySyncRepository,createListener:createRfcommLibraryListener,lifecycle,onLifecycle:onLifecycleChange,display:displayPower,radio:rfcomm,silence:silencePlayback,delay,
  onLibraryChanged:notifyLibraryChanged,onState:state=>{diagnostics.state('bluetooth',state);console.info('WatchRSS foreground sync: '+state);},onError:error=>{diagnostics.failure('bluetooth');console.warn('WatchRSS foreground sync: '+String(error));},
 },{handleAction,onActionCompleted:result=>{diagnostics.action(String(result.request.action??''),result.response.success===true);if(!disposed)completeRemoteInput(result);},offerIpEndpoint:async descriptor=>(await ipReady)?.offer(descriptor)??false});
 const ready=Promise.all([bluetooth.ready,ipReady]);void ready.catch(()=>{});
 let closing:Promise<void>|undefined;
 return {ready,setMediaEnabled:(enabled:boolean)=>bluetooth.setMediaEnabled(enabled),refresh:()=>{ip?.refresh();return bluetooth.refresh();},dispose:()=>closing??=(async()=>{disposed=true;clearRemoteInput();stopNetwork();stopLifecycle();await ipReady.catch(()=>{});await Promise.all([ip?.dispose(),bluetooth.dispose(),disposeReaderPreview()]);})()};
}
