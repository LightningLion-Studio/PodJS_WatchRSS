import type {InternetStatus} from './state.ts';
export interface NetworkSnapshot {active:boolean;internet:boolean;validated:boolean;wifi:boolean;cellular:boolean;bluetooth:boolean}
export function internetAvailability(snapshot:NetworkSnapshot):InternetStatus {
 if(!snapshot.active||!snapshot.internet||!snapshot.validated)return 'unavailable';
 if(snapshot.wifi||snapshot.cellular)return 'available';
 return snapshot.bluetooth?'bluetooth':'unavailable';
}
export interface InternetPorts {
 snapshot():Promise<NetworkSnapshot>;
 subscribe(change:()=>void,error:()=>void):()=>void;
}
/** Re-read the active route on changes; a local Wi-Fi callback alone does not prove internet access. */
export function observeInternet(ports:InternetPorts,listener:(status:InternetStatus)=>void):()=>void {
 let stopped=false,running=false,dirty=false,last:InternetStatus='checking';
 const emit=(status:InternetStatus)=>{if(!stopped&&status!==last){last=status;listener(status);}};
 const refresh=()=>{if(stopped)return;dirty=true;if(running)return;running=true;void (async()=>{
  try{while(dirty&&!stopped){dirty=false;try{const snapshot=await ports.snapshot();if(!dirty)emit(internetAvailability(snapshot));}catch{if(!dirty)emit('unavailable');}}}finally{running=false;}
 })();};
 listener('checking');const unsubscribe=ports.subscribe(refresh,()=>emit('unavailable'));refresh();
 return ()=>{if(stopped)return;stopped=true;unsubscribe();};
}
