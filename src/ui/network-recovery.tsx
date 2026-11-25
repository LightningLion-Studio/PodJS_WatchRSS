import {batch,createEffect,createSignal,onCleanup,Show,type JSX} from 'solid-js';
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

// Layer mount order follows paint order. Keep that order when a lower route
// reports Bluetooth later, so a network update never steals the top page.
type RecoveryLayer={network:()=>NetworkRecovery;wantsBluetooth:()=>boolean};
const [bluetoothLayers,setBluetoothLayers]=createSignal<readonly RecoveryLayer[]>([]);

function dismissBluetoothPages(){
 // Publish every dismissal before rendering again so a waiting page cannot flash.
 batch(()=>{
  const networks=new Set(bluetoothLayers().map(layer=>layer.network()));
  for(const network of networks){
   if(network.status==='bluetooth')network.dismissBluetooth();
  }
 });
}

export function NetworkRecoveryLayer(props:{network:NetworkRecovery;width:number;height:number;round:boolean;rotation?:number}){
 const network=observeNetworkRecovery(()=>props.network);
 const layer={network,wantsBluetooth:()=>network().bluetooth&&!network().blocking};
 setBluetoothLayers(layers=>[layer,...layers]);
 onCleanup(()=>setBluetoothLayers(layers=>layers.filter(candidate=>candidate!==layer)));
 const ownsBluetoothPage=()=>bluetoothLayers().find(candidate=>candidate.wantsBluetooth())===layer;
 return <><Show when={network().blocking}><NetworkUnavailableOverlay rotation={props.rotation} width={props.width} height={props.height} round={props.round} status={network().overlayStatus} onAction={()=>void props.network.retry()}/></Show>
  <Show when={ownsBluetoothPage()&&network()} keyed>{_scope=><NetworkBluetoothPage rotation={props.rotation} width={props.width} height={props.height} onDismiss={dismissBluetoothPages}/>}</Show></>;
}
