import {afterFirstScreen,startupMark} from './core/startup-trace.ts';
import {trackDebugMemoryOwner} from '@podjs/framework/debug-memory';
import {initializeDebugBuild} from './debug/host.ts';
import {usageTelemetry,setTelemetryDeviceId} from './telemetry/host.ts';
import {getLibrarySyncRepository} from './services.ts';
import {startAppLogger} from './logs/logger-host.ts';
import { mount } from "@pocketjs/framework/solid";
import {onCleanup,createSignal,Show} from "solid-js";
import WatchRSS from "./ui/screen.tsx";
import { services, warmServices } from "./services.ts";
import {startApplicationCloudSync,stopApplicationCloudSync,applyCloudBuildPolicy} from './cloud/application';
import {startApplicationForegroundSync} from "./sync/application-host.ts";
import {StartupGate} from "./ui/StartupGate.tsx";
import {createAnnouncementServices} from "./announcement/host.ts";
/** Starts phone sync after the first screen so its SQLite traffic does not delay launch. */
function deferredForegroundSync(){
 type Sync=ReturnType<typeof startApplicationForegroundSync>;
 let inner:Sync|undefined,disposed=false,mediaEnabled:boolean|undefined,connectionEnabled:boolean|undefined;
 const observers=new Set<Parameters<Sync['bluetooth']['subscribe']>[0]>();
 const unsubscribers=new Map<unknown,()=>void>();
 void afterFirstScreen().then(()=>{
  if(disposed)return;
  inner=startApplicationForegroundSync();startApplicationCloudSync();startupMark('sync.started');
  if(connectionEnabled!==undefined)inner.setConnectionEnabled(connectionEnabled);
  if(mediaEnabled!==undefined)inner.setMediaEnabled(mediaEnabled);
  for(const observer of observers)unsubscribers.set(observer,inner.bluetooth.subscribe(observer));
 });
 const bluetooth:Sync['bluetooth']={
  get state(){return inner?inner.bluetooth.state:'idle';},
  subscribe:observer=>{observers.add(observer);if(inner)unsubscribers.set(observer,inner.bluetooth.subscribe(observer));return ()=>{observers.delete(observer);unsubscribers.get(observer)?.();unsubscribers.delete(observer);};},
  refresh:async()=>{await inner?.bluetooth.refresh();},
 } as Sync['bluetooth'];
 return {
  bluetooth,
  createDebugBluetooth:(()=>{if(!inner)throw Error('蓝牙同步尚未启动');return inner.createDebugBluetooth();}) as Sync['createDebugBluetooth'],
  setConnectionEnabled:(enabled:boolean)=>{connectionEnabled=enabled;inner?.setConnectionEnabled(enabled);},
  setMediaEnabled:(enabled:boolean)=>{mediaEnabled=enabled;inner?.setMediaEnabled(enabled);},
  dispose:async()=>{disposed=true;stopApplicationCloudSync();await inner?.dispose();},
 };
}
function ContentApp(){
 trackDebugMemoryOwner();
 startupMark('content.mount');
 const sync=deferredForegroundSync();
 onCleanup(()=>{void sync.dispose();});
 return <WatchRSS services={services} createDebugBluetooth={sync.createDebugBluetooth} bluetoothSync={sync.bluetooth} announcements={createAnnouncementServices()} onPhoneConnectionEnabledChange={enabled=>sync.setConnectionEnabled(enabled)} onSyncMediaKeepAliveChange={enabled=>sync.setMediaEnabled(enabled)} />;
}
// The startup gate (activity state, onboarding) loads in parallel with the build info read;
// only the content waits for the debug gate so debug-only UI is decided before it mounts.
function App(){const [ready,setReady]=createSignal(false);startupMark('app.mount');void initializeDebugBuild().then(()=>{void applyCloudBuildPolicy().catch(()=>{});startupMark('debugBuild.ready');setReady(true);});return <StartupGate content={()=> <Show when={ready()}><ContentApp/></Show>}/>;}
warmServices();
startAppLogger(afterFirstScreen(5000));
setTelemetryDeviceId(async()=>{await afterFirstScreen();return (await getLibrarySyncRepository()).deviceId();});
usageTelemetry.recordAppLaunch();
mount(App);
