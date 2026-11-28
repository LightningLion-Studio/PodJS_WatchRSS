import {objectOid} from './sealed';
import {base64ToBytes,encodeBase64} from '@podjs/framework/bytes';
import type {ProjectionSql,Statement} from '@podjs/framework/sql-projection';

export const INDEX_OBJECT_SCHEMA='CREATE TABLE IF NOT EXISTS syncv2_index_objects(scope TEXT NOT NULL,oid TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,oid))';
const diskBytes=16*1024*1024;
const diskEntries=4096;
const maxObjectBytes=64*1024;
const allowed=(id:string)=>/^(tree|meta|state|state-refs):sha256:[a-f0-9]{64}$/.test(id);
const matches=(id:string,raw:Uint8Array)=>objectOid(id.split(':',1)[0]!,raw)===id;

/** Wire bytes are disposable. Their content address is verified on both sides
 * of the disk cache; window and signer checks remain the reader's job. */
export class DiskIndexObjects {
 constructor(private readonly db:ProjectionSql,private readonly scope:string){}
 async read(ids:string[]){
  const out=new Map<string,Uint8Array>();
  for(let at=0;at<ids.length;at+=8){
   const keys=ids.slice(at,at+8);
   const rows=await this.db.query(`SELECT oid,body FROM syncv2_index_objects WHERE scope=? AND oid IN (${keys.map(()=>'?').join(',')}) AND length(body)<=?`,
    [this.scope,...keys,Math.ceil(maxObjectBytes/3)*4]);
   for(const r of rows){
    const id=String(r.oid);
    try{const raw=base64ToBytes(String(r.body));if(matches(id,raw))out.set(id,raw);}catch{/* A corrupt cache entry is a miss. */}
   }
  }
  return out;
 }
 async write(entries:Map<string,Uint8Array>){
  let page:Statement[]=[],size=0;
  const flush=async()=>{if(page.length)await this.db.transaction(page);page=[];size=0;};
  for(const [id,raw] of entries){
   if(!allowed(id)||raw.length>maxObjectBytes)continue;
   const body=encodeBase64(raw);
   if(size+body.length>128*1024)await flush();
   page.push({sql:'INSERT OR REPLACE INTO syncv2_index_objects VALUES(?,?,?)',params:[this.scope,id,body]});
   size+=body.length;
  }
  if(!page.length)return;
  page.push({sql:`DELETE FROM syncv2_index_objects WHERE rowid IN (
   SELECT rowid FROM (SELECT rowid,ROW_NUMBER() OVER(ORDER BY rowid DESC) AS n,
    SUM(length(body)) OVER(ORDER BY rowid DESC) AS bytes FROM syncv2_index_objects WHERE scope=?)
   WHERE n>? OR bytes>?)`,params:[this.scope,diskEntries,diskBytes]});
  await flush();
 }
}

const cacheBytes=1024*1024;
const maxEntries=512;

/** A runtime-scoped cache of hash-verified index bytes. Callers still validate
 * the window, row binding, decryption keys and current signers on each use. */
export class IndexObjectCache {
 private readonly objects=new Map<string,Uint8Array>();
 private bytes=0;
 constructor(private readonly disk?:DiskIndexObjects){}
 private get(id:string){
  const value=this.objects.get(id);
  if(value){this.objects.delete(id);this.objects.set(id,value);}
  return value;
 }
 private keep(id:string,raw:Uint8Array){
  if(!allowed(id)||raw.length>maxObjectBytes)return;
  if(this.objects.has(id))return;
  while(this.objects.size>=maxEntries||this.bytes+raw.length>cacheBytes){
   const oldest=this.objects.keys().next().value!;
   this.bytes-=this.objects.get(oldest)!.length;
   this.objects.delete(oldest);
  }
  this.objects.set(id,raw);this.bytes+=raw.length;
 }
 put(id:string,raw:Uint8Array){
  if(!allowed(id))return;
  if(!matches(id,raw))throw Error('hash_mismatch');
  this.keep(id,raw);
 }
 async read(id:string,load:(id:string)=>Promise<Uint8Array>){
  return (await this.batch([id],async(ids,save)=>save(new Map([[id,await load(ids[0]!)]])))).get(id)!;
 }
 async batch(ids:string[],load:(ids:string[],save:(entries:Map<string,Uint8Array>)=>Promise<void>)=>Promise<unknown>){
  const results=new Map<string,Uint8Array>(),missing:string[]=[];
  for(const id of ids){const cached=this.get(id);if(cached)results.set(id,cached);else missing.push(id);}
  if(!missing.length)return results;
  const saved=await this.disk?.read(missing);
  for(const [id,raw] of saved??[]){this.keep(id,raw);results.set(id,raw);}
  const wanted=missing.filter(id=>!results.has(id));
  if(wanted.length)await load(wanted,async entries=>{
   for(const [id,raw] of entries){
    if(!matches(id,raw))throw Error('hash_mismatch');
    this.keep(id,raw);results.set(id,raw);
   }
   await this.disk?.write(entries);
  });
  return results;
 }
 clear(){this.objects.clear();this.bytes=0;}
}
