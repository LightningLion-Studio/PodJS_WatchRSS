import {initializeDebugBuild} from './debug/host.ts';
import {usageTelemetry,setTelemetryDeviceId} from './telemetry/host.ts';
import {getLibrarySyncRepository} from './services.ts';
import {startAppLogger} from './logs/logger-host.ts';
import { mount } from "@pocketjs/framework/solid";
import {onCleanup,createSignal,Show} from "solid-js";
import WatchRSS from "./ui/screen.tsx";
import { services } from "./services.ts";
import {startApplicationForegroundSync} from "./sync/application-host.ts";
import {StartupGate} from "./ui/StartupGate.tsx";
import {createAnnouncementServices} from "./announcement/host.ts";
function ContentApp(){
 const sync=startApplicationForegroundSync();
 onCleanup(()=>{void sync.dispose();});
 return <WatchRSS services={services} createDebugBluetooth={sync.createDebugBluetooth} bluetoothSync={sync.bluetooth} announcements={createAnnouncementServices()} onSyncMediaKeepAliveChange={enabled=>sync.setMediaEnabled(enabled)} />;
}
function App(){const [ready,setReady]=createSignal(false);void initializeDebugBuild().then(()=>setReady(true));return <Show when={ready()}><StartupGate content={()=> <ContentApp/>}/></Show>;}
startAppLogger();
setTelemetryDeviceId(async()=>(await getLibrarySyncRepository()).deviceId());
usageTelemetry.recordAppLaunch();
mount(App);
