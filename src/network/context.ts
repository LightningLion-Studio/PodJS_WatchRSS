import {createContext,createEffect,onCleanup,untrack,useContext} from 'solid-js';
import {NetworkRecovery,directNetworkWork} from './recovery.ts';
export const NetworkRecoveryContext=createContext<NetworkRecovery>();
/** Capture the route owner synchronously; asynchronous calls retain that owner. */
export const useNetworkRecovery=()=>useContext(NetworkRecoveryContext)??directNetworkWork;

export function preserveNetworkContent(network:NetworkRecovery,usable:()=>boolean){
 onCleanup(network.preserveContent(usable));
 createEffect(()=>{if(usable())untrack(()=>network.refreshUsable());});
}
export function useCachedNetworkContent(usable:()=>boolean){
 const network=useContext(NetworkRecoveryContext);
 if(network)preserveNetworkContent(network,usable);
}
