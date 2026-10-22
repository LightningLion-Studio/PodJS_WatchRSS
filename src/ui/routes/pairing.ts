import {pairingRequests,type PairingRequestBus} from '../pairing-request.ts';

/** Bind once in the application route owner, using its CURRENT page getter,
 * not a retained stack entry's page. Does not alter any layout or start pairing. */
export function bindPairingRequestRoute(ports:{
 active():boolean;
 page():string;
 go(page:'phone-connection'):void|Promise<void>;
},bus:PairingRequestBus=pairingRequests):()=>void {
 return bus.subscribe(async()=>{
  if(!ports.active())return false;
  if(ports.page()!=='phone-connection')await ports.go('phone-connection');
  return ports.active()&&ports.page()==='phone-connection';
 });
}
