import type {ProjectionSql} from '@podjs/framework/sql-projection';
import {sha256Hex} from '@podjs/framework/crypto';
import {onlyChangedSql} from '@podjs/framework/sql-changes';
import type {MemoNote} from '../notes/types';
export const NOTE_ASSET_SCHEMA='CREATE TABLE IF NOT EXISTS memo_assets(asset_id TEXT PRIMARY KEY,mime TEXT NOT NULL,original_filename TEXT NOT NULL,updated_at INTEGER NOT NULL,source_device_id TEXT NOT NULL,deleted INTEGER NOT NULL,deleted_at INTEGER NOT NULL,local_sha256 TEXT NOT NULL DEFAULT \'\')';
export const noteAssetMime=(id:string)=>/\.png$/i.test(id)?'image/png':/\.jpe?g$/i.test(id)?'image/jpeg':/\.webp$/i.test(id)?'image/webp':/\.md$/i.test(id)?'text/markdown':'application/octet-stream';
/** assetId is the literal storageKey in assets/<storageKey>, not the phone's
 * private NoteAssetEntity UUID. It is the same identity used by v2 closures. */
export async function refreshNoteAssets(db:ProjectionSql,repository:{cloudNotes():Promise<{notes:MemoNote[];assetKeys:string[]}>;cloudNoteAsset(key:string):Promise<Uint8Array>},deviceId:string,now:()=>number=Date.now,matchesCloud?: (id:string,hash:string)=>Promise<boolean>){
 const snapshot=await repository.cloudNotes(),errors:string[]=[];
 for(const id of snapshot.assetKeys){try{
  const bytes=await repository.cloudNoteAsset(id),hash=sha256Hex(bytes),old=(await db.query('SELECT * FROM memo_assets WHERE asset_id=?',[id]))[0];
  if(old&&old.local_sha256===hash)continue;
  // A newly hydrated current remote body does not constitute a new local edit.
  if(old&&await matchesCloud?.(id,hash)){
   await db.transaction([{sql:'UPDATE memo_assets SET local_sha256=? WHERE asset_id=? AND local_sha256=?',params:[hash,id,old.local_sha256]}]);
   continue;
  }
  const updatedAt=Math.max(now(),old?Number(old.updated_at)+1:0);if(!Number.isSafeInteger(updatedAt))throw Error('counter_exhausted');
  const mime=noteAssetMime(id);
  await db.transaction([{sql:onlyChangedSql('INSERT INTO memo_assets(asset_id,mime,original_filename,updated_at,source_device_id,deleted,deleted_at,local_sha256) VALUES(?,?,?,?,?,0,0,?) ON CONFLICT(asset_id) DO UPDATE SET updated_at=excluded.updated_at,source_device_id=excluded.source_device_id,deleted=0,deleted_at=0,local_sha256=excluded.local_sha256'),params:[id,mime,id,updatedAt,deviceId,hash]}]);
 }catch(error){const code=String((error as Error).message);if(!errors.includes(code))errors.push(code);}}
 // Absence is not a tombstone: cloud history/conflicts may still reference it.
 return errors;
}
