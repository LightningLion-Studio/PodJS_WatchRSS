import { mount } from "@pocketjs/framework/solid";
import {onCleanup} from "solid-js";
import WatchRSS from "./ui/screen.tsx";
import { services } from "./services.ts";
import {startApplicationForegroundSync} from "./sync/application-host.ts";
import {StartupGate} from "./ui/StartupGate.tsx";
function ContentApp(){
 const sync=startApplicationForegroundSync();
 onCleanup(()=>{void sync.dispose();});
 return <WatchRSS services={services} onSyncMediaKeepAliveChange={enabled=>sync.setMediaEnabled(enabled)} />;
}
function App(){return <StartupGate content={()=> <ContentApp/>}/>;}
mount(App);
