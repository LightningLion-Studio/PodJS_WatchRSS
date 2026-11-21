import type {SqlDatabase} from '../core/types';
import type {BodyBinding,BodyKind} from './body-channel-codec';
import {carrierBodyRevision} from './body-channel-codec';

const table='syncv2_bluetooth_body_claims';
const receipts='syncv2_bluetooth_body_receipts';
const claimLifetime=60000;

export interface LocalBodyClaim {kind:BodyKind;logicalId:string;sha256:string}

/** A short preference for a verified Bluetooth manifest, shared with the worker.
 * Claims never certify that bytes exist or are authorized to become visible. */
export class LocalBodyClaims {
 constructor(private readonly db:Pick<SqlDatabase,'query'|'transaction'>,private readonly now=Date.now){}
 async replace(scope:string,owner:string,claims:readonly LocalBodyClaim[]){
  const now=this.now();
  await this.db.transaction([
   {sql:`CREATE TABLE IF NOT EXISTS ${table}(scope TEXT NOT NULL,kind TEXT NOT NULL,logical_id TEXT NOT NULL,raw_sha TEXT NOT NULL,owner TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,kind,logical_id,raw_sha,owner))`},
   {sql:`DELETE FROM ${table} WHERE owner=? OR expires_at<=? OR started_at>?`,params:[owner,now,now]},
   ...claims.map(({kind,logicalId,sha256})=>({sql:`INSERT OR IGNORE INTO ${table} VALUES(?,?,?,?,?,?,?)`,params:[scope,kind,logicalId,sha256,owner,now,now+claimLifetime]})),
  ]);
 }
 async release(owner:string){
  await this.db.transaction([{sql:`DELETE FROM ${table} WHERE owner=?`,params:[owner]}]);
 }
 static receipt(scope:string,kind:BodyKind,id:string,sha256:string){
  return [
   {sql:`CREATE TABLE IF NOT EXISTS ${receipts}(scope TEXT NOT NULL,kind TEXT NOT NULL,logical_id TEXT NOT NULL,raw_sha TEXT NOT NULL,PRIMARY KEY(scope,kind,logical_id))`},
   {sql:`INSERT INTO ${receipts} VALUES(?,?,?,?) ON CONFLICT(scope,kind,logical_id) DO UPDATE SET raw_sha=excluded.raw_sha`,params:[scope,kind,id,sha256]},
  ];
 }
 async received(scope:string,binding:BodyBinding,sha256:string){
  if(!(await this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",[receipts])).length)return false;
  const [row]=await this.db.query(`SELECT raw_sha FROM ${receipts} WHERE scope=? AND kind=? AND logical_id=?`,[scope,binding.kind,binding.logicalId]);
  return row?.raw_sha===sha256;
 }
 async has(scope:string,binding:BodyBinding){
  if(!(await this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",[table])).length)return false;
  const now=this.now(),rows=await this.db.query(`SELECT raw_sha FROM ${table} WHERE scope=? AND kind=? AND logical_id=? AND started_at<=? AND expires_at>?`,[scope,binding.kind,binding.logicalId,now,now]);
  return rows.some(row=>carrierBodyRevision(binding.kind,binding.entityKey,String(row.raw_sha))===binding.bodyRevision);
 }
}
