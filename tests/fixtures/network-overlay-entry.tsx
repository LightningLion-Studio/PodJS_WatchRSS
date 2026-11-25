/** Offline-only visual fixture. Never mounts the product, account sync or a media client. */
import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {createSignal,onCleanup,onMount,Show} from 'solid-js';
import {observeHostInternet} from '../../src/onboarding/network-host.ts';
import type {InternetStatus} from '../../src/onboarding/state.ts';
import {NetworkUnavailableOverlay,NetworkBluetoothPage} from '../../src/ui/NetworkUnavailableOverlay.tsx';
import {discovery,application} from '@podjs/framework/services';
import {internetAvailability} from '../../src/onboarding/network.ts';
function Preview(){
 const metrics=getDisplayMetrics(),[status,setStatus]=createSignal<InternetStatus>('checking'),[notice,setNotice]=createSignal(false);
 let alive=true,stop:(()=>void)|undefined;onCleanup(()=>{alive=false;stop?.();});
 onMount(()=>{void application.buildInfo().then(info=>{if(alive&&info.debugBuild)stop=observeHostInternet(setStatus);});});
 return <View class="relative bg-black" style={{width:metrics.logicalWidth,height:metrics.logicalHeight}}>
  <Show when={!notice()||status()!=='bluetooth'} fallback={<NetworkBluetoothPage width={metrics.logicalWidth} height={metrics.logicalHeight} onDismiss={()=>setNotice(false)}/>}><NetworkUnavailableOverlay width={metrics.logicalWidth} height={metrics.logicalHeight} round status={status()} onAction={()=>{if(status()==='bluetooth'){setNotice(true);return;}void discovery.networkSnapshot().then(value=>setStatus(internetAvailability(value)));}}/></Show>
 </View>;
}
mount(Preview);
