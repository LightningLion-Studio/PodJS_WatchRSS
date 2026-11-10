import type {RequestLifetime} from '../cloud/types';
/** QuickJS-compatible cancellation. SQL is drained, never raced against logout. */
export class SyncV2Lifetime implements RequestLifetime {
 private current=true;
 private listeners=new Set<()=>void>();
 isCurrent(){return this.current;}
 require(){if(!this.current)throw Error('feature_disabled');}
 onCancel(listener:()=>void){if(!this.current){listener();return ()=>{};}this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
 cancel(){if(!this.current)return;this.current=false;const listeners=[...this.listeners];this.listeners.clear();for(const listener of listeners)listener();}
 async read<T>(work:()=>Promise<T>):Promise<T>{
  this.require();let off=()=>{};
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{off=this.onCancel(()=>reject(Error('feature_disabled')));})]);}finally{off();}
 }
}
