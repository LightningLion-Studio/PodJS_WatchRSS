import {SyncEventLog} from '../logs/sync-events.ts';
import {logIpRoute} from '../logs/fields.ts';
import {appLogger} from '../logs/app-logger.ts';
import type {HostOperation} from '@podjs/framework/services';
import {IpConnectionProbe,type IpConnectionPorts,type OpenIpRoute} from './ip-connection.ts';
import {parseIpDescriptor,verifyIpDescriptor,type IpDescriptor,type IpEndpoint} from './ip-protocol.ts';
import {LibrarySyncSession,type LibrarySessionOptions,type LibrarySessionRepository} from './session.ts';
import type {JsonObject} from './protocol.ts';
import type {ForegroundTimer} from './foreground.ts';
export interface IpSyncControllerPorts extends IpConnectionPorts {
 repository:LibrarySessionRepository;
 discover?(port:number):HostOperation<IpEndpoint[]>;
 acquireDescriptor?():HostOperation<JsonObject|null>;
 onRoute?(route:OpenIpRoute|null):void;
 onError?(error:unknown):void;
 mediaLease?(active:boolean):Promise<unknown>;
 canOffer?(descriptor:IpDescriptor):Promise<boolean>;
 now?():number;
}
export function canOfferIpRoutes(descriptor:IpDescriptor,network:{localWifi?:boolean;active:boolean;bluetooth:boolean}):boolean {
 // Old hosts cannot distinguish a non-default local Wi-Fi from no Wi-Fi.
 if(network.localWifi===undefined)return true;
 return descriptor.endpoints.some(e=>e.transportKind==='wifiLan'||e.transportKind==='phoneHotspot'?network.localWifi:e.transportKind==='bluetoothBridge'?network.active&&network.bluetooth:network.active);
}
export function ipFailureStage(error:unknown):string {
 const message=error instanceof Error?error.message:String(error);
 return /hmac|认证|HELLO|nonce|challenge/i.test(message)?'authentication':/timed|timeout|超时/i.test(message)?'timeout':/permission|权限/i.test(message)?'permission':/unsupported|capability/i.test(message)?'capability':'connection';
}
/** RFCOMM-bootstrap IP route owner. Discovery providers can offer the same
 * authenticated descriptor; they must not insert unverified endpoints. */
export class IpSyncController {
 private discovery:HostOperation<IpEndpoint[]>|undefined;
 private acquisition:HostOperation<JsonObject|null>|undefined;
 private descriptor:IpDescriptor|undefined;private route:OpenIpRoute|undefined;private probe:IpConnectionProbe|undefined;
 private refreshJob:Promise<void>|undefined;private refreshQueued=false;private queuedBootstrap=false;private routeGeneration=0;private serving:Promise<void>|undefined;private session:LibrarySyncSession|undefined;
 private active=true;private disposed=false;private transferring=false;private lastAckSeq=0;private cooldown=new Map<string,number>();
 private recoveryAttempts=0;private descriptorSource='bootstrap';
 private recoveryTimer:ForegroundTimer|undefined;
 private stopTimer:ForegroundTimer|undefined;private mediaTimer:ForegroundTimer|undefined;private mediaOwned=false;private resources:Promise<void>=Promise.resolve();
 private readonly now:()=>number;
 constructor(private readonly ports:IpSyncControllerPorts,private readonly options:LibrarySessionOptions={}){this.now=ports.now??Date.now;}
 private error(error:unknown){try{this.ports.onError?.(error);}catch{}}
 private routeChanged(route:OpenIpRoute|null){try{this.ports.onRoute?.(route);}catch{}}
 private media(active:boolean){if(this.mediaOwned===active)return;this.mediaOwned=active;this.resources=this.resources.then(()=>this.ports.mediaLease?.(active)).then(()=>{},e=>this.error(e));}
 private releaseLater(){if(this.disposed||!this.mediaOwned)return;this.mediaTimer?.cancel();const timer=this.ports.delay(30000);this.mediaTimer=timer;void timer.result.then(()=>{if(this.mediaTimer!==timer)return;this.mediaTimer=undefined;this.media(false);},()=>{});}
 setActive(active:boolean){if(this.disposed)return;this.active=active;if(active){this.stopTimer?.cancel();this.stopTimer=undefined;this.refresh();}else{this.recoveryTimer?.cancel();this.recoveryTimer=undefined;this.scheduleStop(2500);}}
 private scheduleStop(ms:number){this.stopTimer?.cancel();const timer=this.ports.delay(ms);this.stopTimer=timer;void timer.result.then(()=>{if(this.stopTimer!==timer)return;this.stopTimer=undefined;if(!this.active&&!this.transferring)this.stopRoute();},()=>{});}
 async offer(raw:JsonObject):Promise<boolean>{
  if(this.disposed)return false;let descriptor:IpDescriptor;try{descriptor=parseIpDescriptor(raw);}catch{return false;}
  if(!await verifyIpDescriptor(descriptor,this.ports.crypto,this.now())||this.disposed)return false;if(this.ports.canOffer&&!await this.ports.canOffer(descriptor)){if(!this.disposed){this.descriptor=descriptor;this.descriptorSource='bootstrap';}appLogger.i('WatchRSS_IpSync','IP bootstrap deferred: no compatible local route');return false;}if(this.disposed)return false;this.descriptor=descriptor;this.descriptorSource='bootstrap';this.recoveryAttempts=0;appLogger.i('WatchRSS_IpSync',`IP endpoint accepted from RFCOMM bootstrap endpoints=${descriptor.endpoints.length}`);this.recoveryTimer?.cancel();this.recoveryTimer=undefined;this.acquisition?.cancel();this.discovery?.cancel();this.probe?.cancel();this.refresh(true);return true;
 }
 refresh(bootstrap=false,recovery=false){if(!recovery)this.recoveryAttempts=0;if(this.disposed||(!this.active&&!bootstrap))return;if(this.transferring){appLogger.i("WatchRSS_IpSync",`IP route refresh deferred during active sync reason=${bootstrap?"rfcomm_bootstrap":"refresh"}`);return;}if(this.refreshJob){if(bootstrap){this.refreshQueued=true;this.queuedBootstrap=true;}return;}const job=this.select(bootstrap);this.refreshJob=job;void job.catch(e=>this.error(e)).finally(()=>{if(this.refreshJob!==job)return;this.refreshJob=undefined;if(this.refreshQueued){const queued=this.queuedBootstrap;this.refreshQueued=false;this.queuedBootstrap=false;this.refresh(queued);}});}
 private async select(bootstrap=false){
  const generation=this.routeGeneration;
  if(!bootstrap&&this.ports.acquireDescriptor){
   const previousDescriptor=this.descriptor,acquisition=this.ports.acquireDescriptor();this.acquisition=acquisition;
   try{
    const raw=await acquisition.result;
    if(this.disposed||generation!==this.routeGeneration||this.descriptor!==previousDescriptor||this.transferring)return;
    if(raw){const discovered=parseIpDescriptor(raw),verified=await verifyIpDescriptor(discovered,this.ports.crypto,this.now());if(this.disposed||generation!==this.routeGeneration||this.descriptor!==previousDescriptor||this.transferring)return;if(verified){this.descriptor=discovered;this.descriptorSource='ble';appLogger.i('WatchRSS_IpSync','BLE endpoint verified source=ble');}else appLogger.w('WatchRSS_IpSync',`BLE descriptor rejected stage=${discovered.expiresAt<this.now()?'expired':'authentication'} source=ble`);}
   }catch(error){if(this.disposed||generation!==this.routeGeneration||this.descriptor!==previousDescriptor)return;appLogger.w("WatchRSS_IpSync","BLE 端点发现失败，保留已有通道");this.error(error);}
   finally{if(this.acquisition===acquisition)this.acquisition=undefined;}
  }
  const descriptor=this.descriptor;if(!descriptor||!await verifyIpDescriptor(descriptor,this.ports.crypto,this.now())||this.disposed)return;
  const previous=this.route,minimum=previous?.descriptorEpoch===descriptor.epoch?previous.endpoint.priority:-1;
  // Discovery is speculative: signed bootstrap addresses can be connected while
  // mDNS is scanning. A healthy signed route must not wait for the scan window.
  const discovery=this.ports.discover?.(descriptor.port);this.discovery=discovery;
  const discovered=discovery?.result.then(endpoints=>({endpoints}),error=>({error}));
  const attempted=new Set<string>();let attempts=0;
  try{for(let wave=0;wave<2;wave++){
   let endpoints=descriptor.endpoints;
   if(wave===1){
    if(!discovered||attempts>=3)break;
    const result=await discovered;
    if('error' in result){if(!this.disposed&&generation===this.routeGeneration&&this.descriptor===descriptor)this.error(result.error);break;}
    endpoints=result.endpoints;
    if(endpoints.length)appLogger.i('WatchRSS_IpSync',`IP candidates discovered source=mdns count=${endpoints.length}`);
   }
   if(this.disposed||generation!==this.routeGeneration||this.descriptor!==descriptor||this.transferring||!await verifyIpDescriptor(descriptor,this.ports.crypto,this.now()))return;
   const candidates=endpoints.filter(e=>e.family==='ipv4'&&e.priority>minimum&&!attempted.has(e.address)&&(this.cooldown.get(e.endpointId)??0)<=this.now()).sort((a,b)=>b.priority-a.priority);
  for(const endpoint of candidates){
   if(attempts>=3)break;if(attempted.has(endpoint.address))continue;
   attempted.add(endpoint.address);attempts++;
   if(this.disposed||generation!==this.routeGeneration||this.transferring||this.descriptor!==descriptor)return;
   const probe=new IpConnectionProbe(this.ports);this.probe=probe;let selected:OpenIpRoute;
   try{selected=await probe.connect(descriptor,endpoint,await this.ports.repository.deviceId(),previous?.ack.sessionId??null,this.lastAckSeq);}
   catch(error){if(this.disposed||generation!==this.routeGeneration||this.descriptor!==descriptor)return;this.cooldown.set(endpoint.endpointId,this.now()+10000);appLogger.w("WatchRSS_IpSync",`IP candidate failed kind=${logIpRoute(endpoint.transportKind)} stage=${ipFailureStage(error)} endpoint=<redacted>`);this.error(error);continue;}
   finally{if(this.probe===probe)this.probe=undefined;}
   if(this.disposed||generation!==this.routeGeneration||this.transferring||this.descriptor!==descriptor||(previous&&previous.endpoint.priority>selected.endpoint.priority)){if(this.transferring)appLogger.i("WatchRSS_IpSync","IP route switch deferred after probe because sync started");await selected.connection.close();return;}
   appLogger.i("WatchRSS_IpSync",`IP route ready reason=${bootstrap?"rfcomm_bootstrap":"refresh"} route=${logIpRoute(selected.endpoint.transportKind)} source=${selected.endpoint.endpointId.startsWith('mdns-')?'mdns':this.descriptorSource} endpoint=<redacted> resume=${previous!=null}`);this.route=selected;if(previous)await previous.connection.close();this.routeChanged(selected);if(!this.active)this.scheduleStop(2500);
   const job=this.serve(selected);this.serving=job;void job.catch(e=>this.error(e)).finally(()=>{if(this.serving===job)this.serving=undefined;});return;
  }
  }}finally{if(this.discovery===discovery)this.discovery=undefined;discovery?.cancel();}
  if(!this.route&&this.recoveryAttempts>0)this.recover();
 }
 private recover(){
  if(this.disposed||!this.active)return;
  if(this.recoveryAttempts>=3){appLogger.w('WatchRSS_IpSync','IP reconnect exhausted attempts=3; waiting for network change or phone bootstrap');return;}
  const pause=[500,1500,4000][this.recoveryAttempts++]!;
  appLogger.i('WatchRSS_IpSync',`IP reconnect scheduled attempt=${this.recoveryAttempts} delayMs=${pause}`);
  this.recoveryTimer?.cancel();const timer=this.ports.delay(pause);this.recoveryTimer=timer;
  void timer.result.then(()=>{if(this.recoveryTimer!==timer)return;this.recoveryTimer=undefined;if(this.disposed||!this.active)return;if(this.refreshJob)this.refreshQueued=true;else this.refresh(false,true);},()=>{});
 }
 private async serve(route:OpenIpRoute){
  let completed=false;const diagnosticLog=new SyncEventLog("watchIpSync"),actionSession={};
  try{while(!this.disposed&&this.route===route){
   // Each nonpersistent action completes a session but retains this WebSocket.
   // This owner always closes the underlying transport on cancellation/failure.
   const connection={setFrameTiming:route.connection.setFrameTiming.bind(route.connection),setTransferProgress:route.connection.setTransferProgress.bind(route.connection),readFrame:async(timeout:number)=>{const frame=await route.connection.readFrame(timeout);if(!this.transferring){this.transferring=true;this.stopTimer?.cancel();this.stopTimer=undefined;this.mediaTimer?.cancel();this.mediaTimer=undefined;this.media(true);}return frame;},writeFrame:(frame:JsonObject)=>route.connection.writeFrame(frame),close:async()=>{}};
   const session=new LibrarySyncSession(connection,this.ports.repository,{...this.options,actionSession,diagnosticLog,initialRequestTimeoutMs:600000,responseAckTimeoutMs:600000});this.session=session;
   const results=await session.run();if(this.session===session)this.session=undefined;this.transferring=false;this.releaseLater();if(!this.active)this.scheduleStop(30000);this.lastAckSeq++;this.recoveryAttempts=0;
   if(results.some(r=>r.response.fatalSession===true))throw new Error('IP library exchange failed');
   if(results.at(-1)?.request.action==='syncSession'){appLogger.i("WatchRSS_IpSync","IP sync session closed phase=<redacted>");completed=true;break;}
   this.refresh();
  }}catch(error){if(this.route===route&&!this.disposed){diagnosticLog.event("server.ip.failed",{message:"<redacted>"},"E");appLogger.w("WatchRSS_IpSync","IP 同步数据通道失败");this.error(error);}}
  finally{try{await route.connection.close();}finally{if(this.route===route){this.route=undefined;this.session=undefined;this.transferring=false;this.routeChanged(null);this.releaseLater();if(!completed)this.recover();}}}
 }
 private stopRoute(){this.recoveryTimer?.cancel();this.recoveryTimer=undefined;this.routeGeneration++;this.refreshQueued=false;this.queuedBootstrap=false;this.acquisition?.cancel();this.discovery?.cancel();this.probe?.cancel();this.session?.cancel();const route=this.route;this.route=undefined;this.transferring=false;if(route){void route.connection.close().catch(e=>this.error(e));this.routeChanged(null);}this.releaseLater();}
 async dispose(){if(this.disposed){await this.refreshJob;await this.serving;await this.resources;return;}this.disposed=true;this.stopTimer?.cancel();this.stopTimer=undefined;this.mediaTimer?.cancel();this.mediaTimer=undefined;this.stopRoute();this.media(false);await this.refreshJob?.catch(()=>{});await this.serving?.catch(()=>{});await this.resources;}
}
