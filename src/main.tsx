import { mount } from "@pocketjs/framework/solid";
import {onCleanup} from "solid-js";
import WatchRSS from "./ui/screen.tsx";
import { services } from "./services.ts";
import {startApplicationForegroundSync} from "./sync/application-host.ts";
import {StartupGate} from "./ui/StartupGate.tsx";
import {createAnnouncementServices} from "./announcement/host.ts";
function ContentApp(){
 const sync=startApplicationForegroundSync();
 onCleanup(()=>{void sync.dispose();});
 return <WatchRSS services={services} bluetoothSync={sync.bluetooth} announcements={createAnnouncementServices()} onSyncMediaKeepAliveChange={enabled=>sync.setMediaEnabled(enabled)} />;
}
function App(){return <StartupGate content={()=> <ContentApp/>}/>;}
mount(App);
