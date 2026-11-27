import {objectOid} from './sealed';

const cacheBytes=1024*1024;
const maxEntries=512;
const maxObjectBytes=64*1024;

/** A runtime-scoped cache of hash-verified index bytes. Callers still validate
 * the window, row binding, decryption keys and current signers on each use. */
export class IndexObjectCache {
 private readonly objects=new Map<string,Uint8Array>();
 private bytes=0;
 private get(id:string){
  const value=this.objects.get(id);
  if(value){this.objects.delete(id);this.objects.set(id,value);}
  return value;
 }
 private keep(id:string,raw:Uint8Array){
  const kind=id.split(':',1)[0]!;
  if(!['tree','meta','state','state-refs'].includes(kind)||raw.length>maxObjectBytes)return;
  if(objectOid(kind,raw)!==id)throw Error('hash_mismatch');
  if(this.objects.has(id))return;
  while(this.objects.size>=maxEntries||this.bytes+raw.length>cacheBytes){
   const oldest=this.objects.keys().next().value!;
   this.bytes-=this.objects.get(oldest)!.length;
   this.objects.delete(oldest);
  }
  this.objects.set(id,raw);this.bytes+=raw.length;
 }
 put(id:string,raw:Uint8Array){this.keep(id,raw);}
 async read(id:string,load:(id:string)=>Promise<Uint8Array>){
  const cached=this.get(id);if(cached)return cached;
  const raw=await load(id);this.keep(id,raw);return raw;
 }
 async batch(ids:string[],load:(ids:string[])=>Promise<Map<string,Uint8Array>>){
  const results=new Map<string,Uint8Array>(),wanted:string[]=[];
  for(const id of ids){const cached=this.get(id);if(cached)results.set(id,cached);else wanted.push(id);}
  if(wanted.length)for(const [id,raw] of await load(wanted)){this.keep(id,raw);results.set(id,raw);}
  return results;
 }
 clear(){this.objects.clear();this.bytes=0;}
}
