import {batch,createContext,createEffect,createSignal,onCleanup,untrack,useContext,Show,type JSX} from 'solid-js';
import {gestureResourceCounts} from '@pocketjs/framework/gesture';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {__onHostEvent,lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import * as hostServices from '@podjs/framework/services';
import {observeHostInternet} from '../onboarding/network-host.ts';
import {bluetoothTransport,internetAvailability,orderNetworkSnapshots,type NetworkSnapshot} from '../onboarding/network.ts';
import {NetworkRecovery} from '../network/recovery.ts';
import {NetworkUnavailableOverlay} from './NetworkUnavailableOverlay.tsx';

export function createHostNetworkRecovery(){
 const read=orderNetworkSnapshots(()=>hostServices.hostOperation<NetworkSnapshot>('discovery.networkSnapshot',{}));
 return new NetworkRecovery({
  observe:(listener,invalidateOffline)=>observeHostInternet(listener,()=>read().result,connectionChanged=>invalidateOffline(read.lastRequested(),connectionChanged)),
  delay:hostServices.delay,
  startCheck:()=>{
   const operation=read();
   return {
    ...operation,
    result:operation.result.then(snapshot=>({status:internetAvailability(snapshot),order:snapshot.order,onBluetooth:bluetoothTransport(snapshot),defaultNetworkId:snapshot.defaultNetworkId})),
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

const BLUETOOTH_WARNING_IDLE_MS=3000;

export function bindBluetoothWarningRoute(network:NetworkRecovery,route:{
 shown:()=>boolean;canShow:()=>boolean;push:()=>void;pop:()=>void;
}){
 const connection=observeNetworkRecovery(()=>network);
 createEffect(()=>{
  const current=connection();
  // An eligible Bluetooth connection while the advisory is on the stack
  // belongs to a new connection. Remove the previous connection's page first.
  if(route.shown()&&(current.bluetooth||current.status==='available'||current.status==='unavailable'))
   untrack(route.pop);
 });

 const candidate=()=>connection().bluetooth&&!route.shown()&&route.canShow();
 let lastInput=Date.now();
 let inputHeld=false;
 const recordInput=()=>{lastInput=Date.now();};
 onCleanup(__onHostEvent(event=>{
  if(event.t==='axis'||event.t==='input.scroll'||event.t==='back'||event.t==='accessibility.action'
   ||event.t==='touchCancel')recordInput();
 }));
 onFrame(buttons=>{
  const held=!!buttons||gestureResourceCounts().contacts>0;
  if(held||inputHeld||Date.now()<lastInput)recordInput();
  inputHeld=held;
  if(held||!candidate()||Date.now()-lastInput<BLUETOOTH_WARNING_IDLE_MS)return;
  batch(()=>{
   route.push();
   // Consume the advisory once it is on either stack.
   if(route.shown())network.dismissBluetooth();
  });
 },candidate);
}

export function NetworkRecoveryLayer(props:{network:NetworkRecovery;width:number;height:number;round:boolean;rotation?:number}){
 const network=observeNetworkRecovery(()=>props.network);
 return <Show when={network().blocking}><NetworkUnavailableOverlay rotation={props.rotation} width={props.width} height={props.height} round={props.round} status={network().overlayStatus} onAction={()=>void props.network.retry()}/></Show>;
}
