/** Volatile UI requests only. No account, key, storage or transport dependencies. */
export const PAIRING_REQUEST_INTERVAL_MS = 10_000;
export type PairingRequestListener = () => boolean | Promise<boolean>;
type PendingRequest = {expiresAt:number;cancelled:boolean;consumed:boolean;aborted:Promise<false>;abort():void};

export class PairingRequestBus {
 private foreground=false;
 private pending:PendingRequest|undefined;
 private delivering:PendingRequest|undefined;
 private readonly listeners=new Set<PairingRequestListener>();
 private readonly attempts=new WeakMap<object,number>();
 private readonly activities=new Set<object>();
 private readonly localSession={};
 constructor(private readonly now=()=>globalThis.performance?.now?.()??Date.now()){}

 private discard(request:PendingRequest|undefined){
  if(!request)return;
  request.cancelled=true;request.abort();
  if(this.pending===request)this.pending=undefined;
  if(this.delivering===request)this.delivering=undefined;
 }

 setForeground(active:boolean){
  this.foreground=active;
  if(!active){this.discard(this.pending);this.discard(this.delivering);}
 }
 subscribe(listener:PairingRequestListener):()=>void {
  this.listeners.add(listener);
  return ()=>{this.listeners.delete(listener);if(!this.listeners.size){this.discard(this.pending);this.discard(this.delivering);}};
 }
 private fresh(request:PendingRequest){return !request.cancelled&&this.foreground&&this.now()<request.expiresAt;}
 /** Requires both a UI acknowledgement and consumption by the phone page.
  * Rejected requests never replay when the app later resumes or mounts a route. */
 async request(session:object=this.localSession):Promise<boolean> {
  const at=this.now(),last=this.attempts.get(session);
  if(last!==undefined&&at-last<PAIRING_REQUEST_INTERVAL_MS)return false;
  this.attempts.set(session,at);
  if(this.pending&&!this.fresh(this.pending))this.discard(this.pending);
  if(this.delivering&&!this.fresh(this.delivering))this.discard(this.delivering);
  if(!this.foreground||this.activities.size||this.pending||this.delivering||!this.listeners.size)return false;
  let abort!:()=>void;
  const aborted=new Promise<false>(resolve=>{abort=()=>resolve(false);});
  const request:PendingRequest={expiresAt:at+PAIRING_REQUEST_INTERVAL_MS,cancelled:false,consumed:false,aborted,abort};
  this.pending=request;this.delivering=request;
  let opened=false;
  try{
   // Notify the already-mounted phone page as well as its route owner. A newly
   // mounted phone page consumes the same pending request during initialization.
   for(const listener of [...this.listeners]){
    if(!this.fresh(request))break;
    if(!this.listeners.has(listener))continue;
    try{if(await Promise.race([listener(),request.aborted])===true)opened=true;}catch{}
   }
   opened=opened&&request.consumed&&this.fresh(request);
   return opened;
  }finally{
   if(!opened)this.discard(request);
   if(this.delivering===request)this.delivering=undefined;
  }
 }
 /** One-shot hook for PhoneConnectionScreen, on mount and future requests. */
 consumePending():boolean {
  const request=this.pending;this.pending=undefined;
  if(!request||!this.fresh(request)||this.activities.size)return false;
  request.consumed=true;return true;
 }
 /** Held by the pairing controller, including manual starts and finish grace. */
 acquireActivity():()=>void {
  const owner={};this.activities.add(owner);this.pending=undefined;
  return ()=>{this.activities.delete(owner);};
 }
}

export const pairingRequests=new PairingRequestBus();
export const requestPairingPage=(session?:object)=>pairingRequests.request(session);
export const subscribePairingRequests=(listener:PairingRequestListener)=>pairingRequests.subscribe(listener);
export const consumePendingPairingRequest=()=>pairingRequests.consumePending();
export const setPairingRequestForeground=(active:boolean)=>pairingRequests.setForeground(active);
export const acquirePairingActivity=()=>pairingRequests.acquireActivity();
