/** Payload budget for process-local playback caches. UTF-16 strings count two
 * bytes per unit; object bookkeeping has a separate entry ceiling. Eviction
 * never removes durable playback records or invalidates native capabilities. */
export class PlaybackCache<K,V> {
 private readonly entries=new Map<K,{value:V;bytes:number}>();
 bytes=0;
 constructor(readonly maxBytes:number,private readonly maxEntries:number,private readonly weigh:(value:V,key:K)=>number){}
 get size(){return this.entries.size;}
 has(key:K){return this.entries.has(key);}
 get(key:K):V|undefined {const entry=this.entries.get(key);if(!entry)return;this.entries.delete(key);this.entries.set(key,entry);return entry.value;}
 set(key:K,value:V){
  const bytes=Math.max(0,Math.ceil(this.weigh(value,key)));this.delete(key);
  if(!Number.isFinite(bytes)||bytes>this.maxBytes)return this;
  while(this.entries.size&&(this.entries.size>=this.maxEntries||this.bytes+bytes>this.maxBytes))this.delete(this.entries.keys().next().value!);
  this.entries.set(key,{value,bytes});this.bytes+=bytes;return this;
 }
 delete(key:K){const prior=this.entries.get(key);if(!prior)return false;this.bytes-=prior.bytes;return this.entries.delete(key);}
 clear(){this.entries.clear();this.bytes=0;}
 *keys(){yield* this.entries.keys();}
 *values(){for(const entry of this.entries.values())yield entry.value;}
 *[Symbol.iterator]():IterableIterator<[K,V]>{for(const [key,entry]of this.entries)yield [key,entry.value];}
}
/** Conservative payload accounting for immutable playback DTOs; shared objects
 * within one DTO are counted once. This is not a JavaScript heap measurement. */
export function playbackPayloadBytes(value:unknown):number {
 const seen=new Set<object>();
 const walk=(entry:unknown):number=>{
  if(typeof entry==='string')return entry.length*2;
  if(entry===null||typeof entry!=='object')return 8;
  if(seen.has(entry))return 0;seen.add(entry);
  if(Array.isArray(entry))return 24+entry.reduce((sum,item)=>sum+walk(item),0);
  return 32+Object.entries(entry).reduce((sum,[key,item])=>sum+key.length*2+walk(item),0);
 };
 return walk(value);
}
