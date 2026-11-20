import {ContentSha256} from '@podjs/framework/content-sha256';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import type {ProjectionSql,Statement} from '@podjs/framework/sql-projection';
import {canonical,hexId} from './protocol';
import type {LocalCipher} from './store';
import {BOOK_MAX_PACKAGE_BYTES} from '../books/protocol';

const BLOCK_BYTES=65536;
const BLOCKS_PER_TRANSACTION=4;
export const LEGACY_BODY_SCHEMA='CREATE TABLE IF NOT EXISTS syncv2_legacy_body(scope TEXT NOT NULL,owner TEXT NOT NULL,block INTEGER NOT NULL,body TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 0 CHECK(live IN (0,1)),PRIMARY KEY(scope,owner,block))';

export interface LegacyBodySource {
 size:number;
 sha256:string;
 read(offset:number,length:number):Promise<Uint8Array>;
}
export interface LegacyBodyRef {owner:string;size:number;sha256:string}
export interface LegacyBodyArchive {
 ref:LegacyBodyRef;
 read(visit:(part:Uint8Array,offset:number)=>Promise<void>):Promise<void>;
}

/** Ciphertext blocks are private local storage. An inbox or recovery CAS owns
 * the reference independently of the transport job and its expiry. */
export class WatchLegacyBody {
 constructor(private db:ProjectionSql,private cipher:LocalCipher,private scope:string){}
 private aad(ref:LegacyBodyRef,block:number){
  return canonical({domain:'wrss.sync.v2/local-legacy-body',scope:this.scope,...ref,block});
 }
 private count(ref:LegacyBodyRef){
  hexId(ref.owner,64);hexId(ref.sha256,64);
  if(!Number.isSafeInteger(ref.size)||ref.size<0||ref.size>BOOK_MAX_PACKAGE_BYTES)throw Error('object_too_large');
  return Math.max(1,Math.ceil(ref.size/BLOCK_BYTES));
 }
 async stage(ref:LegacyBodyRef,source:LegacyBodySource,check:()=>void){
  const count=this.count(ref),hash=new ContentSha256(),batch:Statement[]=[];
  for(let block=0;block<count;block++){
   check();
   const length=Math.min(BLOCK_BYTES,ref.size-block*BLOCK_BYTES),part=length?await source.read(block*BLOCK_BYTES,length):new Uint8Array();
   if(part.length!==length)throw Error('closure_incomplete');
   hash.update(part);
   const sealed=await this.cipher.seal(this.aad(ref,block),{bytes:encodeBase64(part)});
   batch.push({sql:'INSERT INTO syncv2_legacy_body(scope,owner,block,body) VALUES(?,?,?,?)',params:[this.scope,ref.owner,block,sealed]});
   if(batch.length===BLOCKS_PER_TRANSACTION||block===count-1){
    check();await this.db.transaction(batch.splice(0));
   }
  }
  if(hash.finish()!==ref.sha256)throw Error('hash_mismatch');
 }
 guard(ref:LegacyBodyRef):Statement[]{
  const count=this.count(ref);
  return [{sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN (SELECT COUNT(*) FROM syncv2_legacy_body WHERE scope=? AND owner=? AND block>=0 AND block<?)=? THEN 1 ELSE 0 END',params:[this.scope,ref.owner,count,count]},{sql:'DELETE FROM podjs_sql_cas_guard'}];
 }
 activation(ref:LegacyBodyRef):Statement[]{
  return [...this.guard(ref),{sql:'UPDATE syncv2_legacy_body SET live=1 WHERE scope=? AND owner=?',params:[this.scope,ref.owner]}];
 }
 discardIncomplete():Statement{
  return {sql:'DELETE FROM syncv2_legacy_body WHERE scope=? AND live=0',params:[this.scope]};
 }
 drop(ref:LegacyBodyRef):Statement{
  return {sql:'DELETE FROM syncv2_legacy_body WHERE scope=? AND owner=?',params:[this.scope,ref.owner]};
 }
 async verify(ref:LegacyBodyRef,visit?:(part:Uint8Array,offset:number)=>Promise<void>){
  const count=this.count(ref),hash=new ContentSha256();
  for(let block=0;block<count;block++){
   const offset=block*BLOCK_BYTES,[row]=await this.db.query('SELECT body FROM syncv2_legacy_body WHERE scope=? AND owner=? AND block=?',[this.scope,ref.owner,block]);
   if(!row)throw Error('closure_incomplete');
   const value=await this.cipher.open(this.aad(ref,block),String(row.body));
   const part=decodeBase64(value.bytes);
   if(part.length!==Math.min(BLOCK_BYTES,ref.size-offset))throw Error('closure_incomplete');
   hash.update(part);
   await visit?.(part,offset);
  }
  if(hash.finish()!==ref.sha256)throw Error('hash_mismatch');
 }
}
