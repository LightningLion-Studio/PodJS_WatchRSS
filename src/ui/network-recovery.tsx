import {createEffect,createSignal,onCleanup,Show,type JSX} from 'solid-js';
import * as hostServices from '@podjs/framework/services';
import {observeHostInternet} from '../onboarding/network-host.ts';
import {internetAvailability,orderNetworkSnapshots,type NetworkSnapshot} from '../onboarding/network.ts';
import {NetworkRecovery} from '../network/recovery.ts';
import {NetworkUnavailableOverlay,NetworkBluetoothPage} from './NetworkUnavailableOverlay.tsx';

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
// NetworkRecovery is shared with non-UI callers. Bridge its subscription to
// Solid without caching a stale scope when navigation changes the current route.
export function observeNetworkRecovery(network:()=>NetworkRecovery){
 const [revision,setRevision]=createSignal(0);
 createEffect(()=>{onCleanup(network().subscribe(()=>setRevision(n=>n+1)));setRevision(n=>n+1);});
 return ()=>{revision();return network();};
}

export function NetworkRecoveryLayer(props:{network:NetworkRecovery;width:number;height:number;round:boolean;rotation?:number}){
 const network=observeNetworkRecovery(()=>props.network);
 return <><Show when={network().blocking}><NetworkUnavailableOverlay rotation={props.rotation} width={props.width} height={props.height} round={props.round} status={network().overlayStatus} onAction={()=>void props.network.retry()}/></Show>
  <Show when={network().bluetooth&&!network().blocking&&network()} keyed>{scope=><NetworkBluetoothPage rotation={props.rotation} width={props.width} height={props.height} onDismiss={()=>scope.dismissBluetooth()}/>}</Show></>;
}
