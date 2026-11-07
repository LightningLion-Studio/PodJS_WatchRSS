/** Encrypted, page-sized content projection. Never writes business tables. */
import type {ProjectionSql} from '@podjs/framework/sql-projection';
import {ContentFiles} from '@podjs/framework/content-files';
import {digest,canonical,jsonBytes,parseCanonicalJson} from './protocol';
import {contentRecordCipher} from '@podjs/framework/content-record';
import type {LocalCipher} from './store';
import {chargedReplayBytes} from './resume';
export class WatchContentStore {
 readonly prefix:string;readonly cipher:LocalCipher;
 constructor(readonly sql:ProjectionSql,cipher:LocalCipher,readonly files:ContentFiles,binding:unknown){this.prefix=digest(binding);this.cipher=contentRecordCipher(cipher,jsonBytes,parseCanonicalJson);}
 async init(){await this.sql.transaction([{sql:'CREATE TABLE IF NOT EXISTS sync2_content_projection (binding TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(binding,id))'}]);}
 private aad(id:string){return canonical({version:2,binding:this.prefix,id});}
 async get<T=any>(id:string):Promise<{revision:number;value:T}|null>{const rows=await this.sql.query('SELECT revision,value FROM sync2_content_projection WHERE binding=? AND id=?',[this.prefix,id]);const row=rows[0];return row?{revision:Number(row.revision),value:await this.cipher.open(this.aad(id),String(row.value))}:null;}
 async put(id:string,value:any,expected:number|null){return this.putMany([{id,value,expected}]);}
 async putMany(changes:{id:string;value:any;expected:number|null}[]){await this.sql.transaction(await this.prepareMany(changes));}
 async prepareMany(changes:{id:string;value:any;expected:number|null}[]){
  const statements:{sql:string;params?:unknown[]}[]=[];
  for(const c of changes){const sealed=await this.cipher.seal(this.aad(c.id),c.value);
   if(c.expected===null)statements.push({sql:'INSERT INTO sync2_content_projection(binding,id,revision,value) VALUES (?,?,1,?)',params:[this.prefix,c.id,sealed]});
   else statements.push({sql:'UPDATE sync2_content_projection SET revision=revision+1,value=? WHERE binding=? AND id=? AND revision=?',params:[sealed,this.prefix,c.id,c.expected]},
    {sql:'INSERT INTO sync2_content_projection(binding,id,revision,value) SELECT NULL,NULL,0,NULL WHERE changes()!=1'});
  }return statements;
 }
 async page(after='',limit=32,prefix=''){if(limit<1||limit>32)throw Error('content_batch_limit');const rows=await this.sql.query('SELECT id,revision,value FROM sync2_content_projection WHERE binding=? AND id>? AND substr(id,1,?)=? ORDER BY id LIMIT ?',[this.prefix,after,prefix.length,prefix,limit]);return Promise.all(rows.map(async r=>({id:String(r.id),revision:Number(r.revision),value:await this.cipher.open(this.aad(String(r.id)),String(r.value))})));}
 path(key:string,suffix='data'){return this.prefix+'/'+digest(key)+'.'+suffix;}
 async bytes(key:string,total:number,offset=0,length=total-offset){const out=new Uint8Array(length);for(let at=0;at<length;at+=262144){const n=Math.min(262144,length-at),[part]=await this.files.read([{path:this.path(key),offset:offset+at,length:n}]);out.set(part!,at);}return out;}
 async verified(key:string,bytes:Uint8Array,proof:any){const checkpoint=await this.cipher.seal(this.aad('verified:'+key),proof);if(checkpoint.length>8192)throw Error('object_too_large');await this.files.publish(this.path(key),bytes,checkpoint);}
 async recover(key:string){const [stat]=await this.files.stat([this.path(key)]);if(!stat?.exists||!stat.checkpoint)return null;return {size:stat.size,proof:await this.cipher.open(this.aad('verified:'+key),stat.checkpoint)};}
 async raw(key:string,bytes:Uint8Array){await this.files.publish(this.path(key),bytes);}
 async consumeReplay(oid:string,total:number,confirmed:number,offset:number,length:number){
  const id='upload-replay:'+oid,saved=await this.get(id),prior=saved?.value;
  if(prior&&prior.total!==total)throw Error('hash_mismatch');
  const high=Math.max(confirmed,prior?.confirmed??0),attempted=Math.max(prior?.attempted??0,offset+length),used=prior?.bytes??0,next=chargedReplayBytes(Math.max(high,prior?.attempted??0),offset,length,total,used);
  if(!prior||next!==used||attempted!==prior.attempted||high!==prior.confirmed)await this.put(id,{total,confirmed:high,attempted,bytes:next},saved?.revision??null);
 }
}
