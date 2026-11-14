import type {CloudHostRequest} from './host-ports';
export const CLOUD_SYNC_SUSPENDED='cloud_sync_suspended';
export const CLOUD_HOST_CAPABILITY_UNAVAILABLE='cloud_host_capability_unavailable';
/** Fence every chunk request, while allowing resource cleanup after a pause. */
export function cloudRunHost(host:CloudHostRequest,current:()=>void):CloudHostRequest {
 return (async<R>(method:string,args:Record<string,unknown>)=>{
  if(method!=='file.delete'&&method!=='file.closeText'&&method!=='crypto.closeSealedGzip'&&method!=='secure.release'&&method!=='cloud.release')current();
  return host<R>(method,args);
 });
}
/** An Android foreground run cannot become an unbounded background guest.
 * A pause permanently fences the old run, even after a quick resume. OS workers
 * have their own bounded guest and do not use this foreground-only gate. */
export class CloudForegroundExecution {
 private generation=0;
 constructor(private active:boolean){}
 foreground(active:boolean){if(this.active&&!active)this.generation++;this.active=active;}
 begin(){const generation=this.generation;const current=()=>{if(!this.active||generation!==this.generation)throw Error(CLOUD_SYNC_SUSPENDED);};current();return current;}
}

/** Cooperative work deadline, checked at IO and commit boundaries. Never race a
 * write against a timer: the lease remains held until the old task unwinds. */
export const CLOUD_SYNC_BUDGET_MILLIS=5*60*1000;
export class CloudSyncDeadlineError extends Error {
 readonly code='cloud_sync_deadline_exceeded';
 constructor(){super('cloud_sync_deadline_exceeded');}
}
export class CloudSyncBudget {
 private readonly started:number;private expired=false;
 constructor(private readonly now=()=>globalThis.performance?.now?.()??Date.now()){this.started=now();}
 remainingMillis(){return this.expired?0:Math.max(0,CLOUD_SYNC_BUDGET_MILLIS-(this.now()-this.started));}
 check=()=>{if(this.expired||this.now()-this.started>=CLOUD_SYNC_BUDGET_MILLIS){this.expired=true;throw new CloudSyncDeadlineError();}};
}
