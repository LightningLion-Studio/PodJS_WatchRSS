import {createContext,createEffect,createSignal,onCleanup,untrack,useContext,Show,type JSX} from 'solid-js';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import * as hostServices from '@podjs/framework/services';
import {observeHostInternet} from '../onboarding/network-host.ts';
import {internetAvailability,orderNetworkSnapshots,type NetworkSnapshot} from '../onboarding/network.ts';
import {NetworkRecovery} from '../network/recovery.ts';
import {NetworkUnavailableOverlay} from './NetworkUnavailableOverlay.tsx';

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

// The startup and content stacks hand off the same connection observer.
const BluetoothWarningContext=createContext<NetworkRecovery>();
export function useBluetoothWarningConnection(){
 const existing=useContext(BluetoothWarningContext);
 if(existing)return existing;
 const network=createHostNetworkRecovery();
 const update=(state:ReturnType<typeof lifecycle>)=>{
  network.setActive(state==='active');
  if(state==='active')network.requestStarted();
 };
 const stop=onLifecycleChange(update);
 update(lifecycle());
 onCleanup(()=>{stop();network.dispose();});
 return network;
}
export function BluetoothWarningConnection(props:{children:JSX.Element}){
 const network=useBluetoothWarningConnection();
 return <BluetoothWarningContext.Provider value={network}>{props.children}</BluetoothWarningContext.Provider>;
}

export function bindBluetoothWarningRoute(network:NetworkRecovery,route:{
 shown:()=>boolean;canPush:()=>boolean;push:()=>void;pop:()=>void;
}){
 const connection=observeNetworkRecovery(()=>network);
 createEffect(()=>{
  const status=connection().status;
  if(route.shown()&&(status==='available'||status==='unavailable'))untrack(route.pop);
 });
 // Check at the frame boundary, after gesture handling and editor callbacks.
 // BackMotion can settle with zero translation, without changing any signal.
 const ready=()=>!route.shown()&&connection().bluetooth&&route.canPush();
 onFrame(()=>{if(ready())route.push();},ready);
}

export function NetworkRecoveryLayer(props:{network:NetworkRecovery;width:number;height:number;round:boolean;rotation?:number}){
 const network=observeNetworkRecovery(()=>props.network);
 return <Show when={network().blocking}><NetworkUnavailableOverlay rotation={props.rotation} width={props.width} height={props.height} round={props.round} status={network().overlayStatus} onAction={()=>void props.network.retry()}/></Show>;
}
