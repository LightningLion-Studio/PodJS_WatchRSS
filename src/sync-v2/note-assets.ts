import type {ProjectionSql} from '@podjs/framework/sql-projection';
import {sha256Hex} from '@podjs/framework/crypto';
import {onlyChangedSql} from '@podjs/framework/sql-changes';
import type {NoteAssetStat} from '../notes/cloud-assets';
import type {MemoNote} from '../notes/types';
export const NOTE_ASSET_SCHEMA='CREATE TABLE IF NOT EXISTS memo_assets(asset_id TEXT PRIMARY KEY,mime TEXT NOT NULL,original_filename TEXT NOT NULL,updated_at INTEGER NOT NULL,source_device_id TEXT NOT NULL,deleted INTEGER NOT NULL,deleted_at INTEGER NOT NULL,local_sha256 TEXT NOT NULL DEFAULT \'\')';
export const NOTE_ASSET_WITNESS_SCHEMA='CREATE TABLE IF NOT EXISTS syncv2_note_asset_witness(asset_id TEXT PRIMARY KEY,path TEXT NOT NULL,size INTEGER NOT NULL,modified INTEGER NOT NULL,change_token TEXT NOT NULL,sha256 TEXT NOT NULL)';
const sameFile=(a:NoteAssetStat,b:NoteAssetStat)=>a.path===b.path&&a.size===b.size&&a.modified===b.modified&&a.changeToken===b.changeToken;
export const noteAssetMime=(id:string)=>/\.png$/i.test(id)?'image/png':/\.jpe?g$/i.test(id)?'image/jpeg':/\.webp$/i.test(id)?'image/webp':/\.md$/i.test(id)?'text/markdown':'application/octet-stream';
/** assetId is the literal storageKey in assets/<storageKey>, not the phone's
 * private NoteAssetEntity UUID. It is the same identity used by v2 closures. */
export async function refreshNoteAssets(db:ProjectionSql,repository:{cloudNotes():Promise<{notes:MemoNote[];assetKeys:string[]}>;cloudNoteAsset(key:string):Promise<Uint8Array>},deviceId:string,now:()=>number=Date.now,matchesCloud?: (id:string,hash:string)=>Promise<boolean>,statAsset?:(id:string)=>Promise<NoteAssetStat|undefined>){
 const snapshot=await repository.cloudNotes(),errors:string[]=[],missingKeys=new Set<string>();
 for(const id of snapshot.assetKeys){try{
  const stat=await statAsset?.(id);
  const old=(await db.query(stat&&Number.isSafeInteger(stat.modified)
   ? 'SELECT a.*,w.sha256 AS witnessed_hash,w.path,w.size,w.modified,w.change_token FROM memo_assets a LEFT JOIN syncv2_note_asset_witness w USING(asset_id) WHERE a.asset_id=?'
   : 'SELECT * FROM memo_assets WHERE asset_id=?',[id]))[0];
  if(stat&&old?.local_sha256&&old.local_sha256===old.witnessed_hash&&sameFile(stat,{
   path:String(old.path),size:Number(old.size),modified:Number(old.modified),changeToken:String(old.change_token)||undefined,
  }))continue;
  const bytes=await repository.cloudNoteAsset(id),hash=sha256Hex(bytes);
  const witness:import('@podjs/framework/sql-projection').Statement[]=[];
  if(stat&&Number.isSafeInteger(stat.modified)){
   const after=await statAsset!(id);
   if(!after||!sameFile(stat,after)||bytes.length!==stat.size)throw Error('cloud_note_asset_changed');
   witness.push({sql:'INSERT OR REPLACE INTO syncv2_note_asset_witness VALUES(?,?,?,?,?,?)',params:[id,stat.path,stat.size,stat.modified,stat.changeToken??'',hash]});
  }
  if(old?.local_sha256===hash){if(witness.length)await db.transaction(witness);continue;}
  // A newly hydrated current remote body does not constitute a new local edit.
  if(old&&await matchesCloud?.(id,hash)){
   await db.transaction([{sql:'UPDATE memo_assets SET local_sha256=? WHERE asset_id=? AND local_sha256=?',params:[hash,id,old.local_sha256]},...witness]);
   continue;
  }
  const updatedAt=Math.max(now(),old?Number(old.updated_at)+1:0);if(!Number.isSafeInteger(updatedAt))throw Error('counter_exhausted');
  const mime=noteAssetMime(id);
  await db.transaction([{sql:onlyChangedSql('INSERT INTO memo_assets(asset_id,mime,original_filename,updated_at,source_device_id,deleted,deleted_at,local_sha256) VALUES(?,?,?,?,?,0,0,?) ON CONFLICT(asset_id) DO UPDATE SET updated_at=excluded.updated_at,source_device_id=excluded.source_device_id,deleted=0,deleted_at=0,local_sha256=excluded.local_sha256'),params:[id,mime,id,updatedAt,deviceId,hash]},...witness]);
 }catch(error){
  const code=String((error as Error).message);
  if(code==='cloud_note_asset_missing')missingKeys.add(id);
  else if(!errors.includes(code))errors.push(code);
 }}
 // A missing local file can still be restored by the body channel if the
 // authenticated index contains it. A legacy reference alone is not a row.
 return {errors,missingKeys};
}
