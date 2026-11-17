import {createEffect,createSignal,onCleanup,Show,type JSX} from 'solid-js';
import * as hostServices from '@podjs/framework/services';
import {observeHostInternet} from '../onboarding/network-host.ts';
import {internetAvailability,orderNetworkSnapshots,type NetworkSnapshot} from '../onboarding/network.ts';
import {NetworkRecovery} from '../network/recovery.ts';
import {NetworkUnavailableOverlay,NetworkBluetoothNotice} from './NetworkUnavailableOverlay.tsx';

export function createHostNetworkRecovery(){
 const read=orderNetworkSnapshots(()=>hostServices.hostOperation<NetworkSnapshot>('discovery.networkSnapshot',{}));
 return new NetworkRecovery({
  observe:(listener,invalidateOffline)=>observeHostInternet(listener,()=>read().result,()=>invalidateOffline(read.lastRequested())),
  delay:hostServices.delay,
  startCheck:()=>{
   const operation=read();
   return {
    ...operation,
    result:operation.result.then(snapshot=>({status:internetAvailability(snapshot),order:snapshot.order})),
   };
  },
 });
}
import {NetworkRecoveryContext as Context} from '../network/context.ts';
export function NetworkRecoveryProvider(props:{network:NetworkRecovery;active:()=>boolean;children:JSX.Element}){
 createEffect(()=>props.network.setActive(props.active()));
 onCleanup(()=>props.network.dispose());
 return <Context.Provider value={props.network}>{props.children}</Context.Provider>;
}
export function NetworkRecoveryLayer(props:{network:NetworkRecovery;width:number;height:number;round:boolean}){
 const [revision,setRevision]=createSignal(0);
 createEffect(()=>{const network=props.network;onCleanup(network.subscribe(()=>setRevision(n=>n+1)));setRevision(n=>n+1);});
 const blocking=()=>{revision();return props.network.blocking;};
 const bluetooth=()=>{revision();return props.network.bluetooth;};
 return <><Show when={blocking()}><NetworkUnavailableOverlay width={props.width} height={props.height} round={props.round} status={(revision(),props.network.overlayStatus)} onRetry={()=>void props.network.retry()}/></Show>
  <Show when={bluetooth()}><NetworkBluetoothNotice width={props.width} height={props.height} onDismiss={()=>props.network.dismissBluetooth()}/></Show></>;
}
