import type {CloudHostRequest} from './host-ports';
export const CLOUD_SYNC_SUSPENDED='cloud_sync_suspended';
export const CLOUD_HOST_CAPABILITY_UNAVAILABLE='cloud_host_capability_unavailable';
/** Fence every chunk request, while allowing resource cleanup after a pause. */
export function cloudRunHost(host:CloudHostRequest,current:()=>void):CloudHostRequest {
 return (async<R>(method:string,args:Record<string,unknown>)=>{
  if(method!=='file.delete'&&method!=='secure.release'&&method!=='cloud.release')current();
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
