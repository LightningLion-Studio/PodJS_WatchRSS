import type {MediaPrefetchResult} from '@podjs/framework/media-prefix-cache';
export interface PrefetchBinding {id:string;itemToken:string;generation:number;uri:string;url:string}
export interface PrefetchFailure {id:string;count:number;consecutive:number;reason:string;lastFailureAt:number;generation:number}
/** Tokens identify a particular registered source, not just an item. Never act
 * on a late HTTP failure from a prior URL/window, or evict the foreground item. */
export class DouyinPrefetchResults {
 private bindings=new Map<string,PrefetchBinding>();
 private refreshed=new Set<string>();
 private records=new Map<string,PrefetchFailure>();
 constructor(private readonly now=Date.now,records:readonly PrefetchFailure[]=[]){for(const record of records.slice(-200))if(record&&typeof record.id==='string'&&record.id.length>0&&record.id.length<=256&&Number.isSafeInteger(record.count)&&record.count>=0&&Number.isSafeInteger(record.consecutive)&&record.consecutive>=0&&Number.isFinite(record.lastFailureAt)&&Number.isSafeInteger(record.generation)&&typeof record.reason==='string'&&['http_403','http_4xx','http_5xx','transport'].includes(record.reason))this.records.set(record.id,{...record});}
 begin(newOwner=false){this.bindings.clear();if(newOwner)this.refreshed.clear();}
 bind(binding:PrefetchBinding){for(const [token,value] of this.bindings)if(value.id===binding.id)this.bindings.delete(token);this.bindings.set(binding.itemToken,binding);}
 current(binding:PrefetchBinding){return this.bindings.get(binding.itemToken)===binding;}
 result(event:MediaPrefetchResult,foreground:(id:string)=>boolean):{binding:PrefetchBinding;action:'refresh'|'quarantine'|'none'}|undefined {
  const binding=this.bindings.get(event.itemToken);if(!binding||binding.generation!==event.generation)return;
  if(event.result==='success'){const record=this.records.get(binding.id);if(record)record.consecutive=0;this.refreshed.delete(binding.id);return {binding,action:'none'};}
  const previous=this.records.get(binding.id);
  this.records.delete(binding.id);this.records.set(binding.id,{id:binding.id,count:(previous?.count??0)+1,consecutive:(previous?.consecutive??0)+1,reason:event.category,lastFailureAt:this.now(),generation:binding.generation});
  while(this.records.size>200)this.records.delete(this.records.keys().next().value!);
  if(event.httpStatus===403&&!this.refreshed.has(binding.id)){this.refreshed.add(binding.id);return {binding,action:'refresh'};}
  return {binding,action:(this.records.get(binding.id)!.consecutive>=2&&!foreground(binding.id))?'quarantine':'none'};
 }
 reset(id:string){this.refreshed.delete(id);const record=this.records.get(id);if(record)record.consecutive=0;}
 snapshot(){return Array.from(this.records.values(),value=>({...value}));}
}
