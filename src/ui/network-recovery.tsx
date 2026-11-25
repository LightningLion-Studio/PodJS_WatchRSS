import {createContext,createEffect,createSignal,onCleanup,untrack,useContext,Show,type JSX} from 'solid-js';
import {gestureResourceCounts} from '@pocketjs/framework/gesture';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {__onHostEvent,lifecycle,onLifecycleChange} from '@podjs/framework/watch';
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

const BLUETOOTH_WARNING_IDLE_MS=1000;

export function bindBluetoothWarningRoute(network:NetworkRecovery,route:{
 shown:()=>boolean;idleRoute:()=>object|undefined;push:()=>void;pop:()=>void;
}){
 const connection=observeNetworkRecovery(()=>network);
 createEffect(()=>{
  const status=connection().status;
  if(route.shown()&&(status==='available'||status==='unavailable'))untrack(route.pop);
 });

 const candidate=()=>connection().bluetooth&&!route.shown()?route.idleRoute():undefined;
 let observedRoute:object|undefined,idleRoute:object|undefined,idleSince:number|undefined;
 const resetIdle=()=>{idleSince=undefined;};
 // Reset on reactive changes even if the host skips frames while the route is busy.
 createEffect(()=>{
  const entry=candidate();
  if(entry!==observedRoute)resetIdle();
  observedRoute=entry;
 });
 onCleanup(__onHostEvent(event=>{
  if(event.t==='axis'||event.t==='input.scroll'||event.t==='back'||event.t==='accessibility.action'
   ||event.t==='touchCancel'||event.t==='lifecycle')resetIdle();
 }));
 onFrame(buttons=>{
  const entry=candidate();
  if(entry!==idleRoute)resetIdle();
  idleRoute=entry;
  if(!entry||buttons||gestureResourceCounts().contacts>0){resetIdle();return;}
  const now=Date.now();
  if(idleSince===undefined||now<idleSince)idleSince=now;
  if(now-idleSince<BLUETOOTH_WARNING_IDLE_MS)return;
  route.push();
  // Consume the advisory once it is on either stack.
  if(route.shown())network.dismissBluetooth();
 },()=>candidate()!==undefined&&gestureResourceCounts().contacts===0);
}

export function NetworkRecoveryLayer(props:{network:NetworkRecovery;width:number;height:number;round:boolean;rotation?:number}){
 const network=observeNetworkRecovery(()=>props.network);
 return <Show when={network().blocking}><NetworkUnavailableOverlay rotation={props.rotation} width={props.width} height={props.height} round={props.round} status={network().overlayStatus} onAction={()=>void props.network.retry()}/></Show>;
}
