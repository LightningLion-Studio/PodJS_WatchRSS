import {encodeUtf8} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';
import type {SqlDatabase,SqlParams} from '../core/types';

export const NOTE_ASSET_FILES_SCHEMA="CREATE TABLE IF NOT EXISTS note_asset_files(storage_key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,size INTEGER NOT NULL)";
export const NOTE_ASSET_VERSIONS='notes/asset-versions';
export type NoteAssetVersion={sha256:string;size:number};
type Statement={sql:string;params?:SqlParams};

export function noteAssetVersionPath(key:string,sha256:string):string{
 if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('note_asset_invalid_reference');
 return NOTE_ASSET_VERSIONS+'/'+sha256Hex(encodeUtf8(key,'strict'))+'-'+sha256+'.bin';
}

/** Physical files in asset-versions are private candidates. Only the committed
 * SQL row makes one visible. Older installations still read their old path. */
export class NoteAssetFileIndex {
 constructor(private readonly db:Pick<SqlDatabase,'query'|'transaction'>){}
 private async rows(key?:string){
  try{return await this.db.query('SELECT storage_key,sha256,size FROM note_asset_files'+(key===undefined?'':' WHERE storage_key=?'),key===undefined?[]:[key]);}
  catch(error){if(/no such table: note_asset_files/.test(String(error)))return [];throw error;}
 }
 async version(key:string):Promise<NoteAssetVersion|undefined>{
  const [row]=await this.rows(key);if(!row)return;
  return {sha256:String(row.sha256),size:Number(row.size)};
 }
 async path(key:string):Promise<string>{
  const version=await this.version(key);
  return version?noteAssetVersionPath(key,version.sha256):'notes/assets/'+key;
 }
 async entries(){
  return (await this.rows()).map(row=>{
   const key=String(row.storage_key);
   return {key,path:noteAssetVersionPath(key,String(row.sha256)),size:Number(row.size)};
  });
 }
 statements(key:string,before:NoteAssetVersion|undefined,after:NoteAssetVersion):Statement[]{
  const exists='EXISTS(SELECT 1 FROM note_asset_files WHERE storage_key=?';
  return [
   {sql:NOTE_ASSET_FILES_SCHEMA},
   {sql:'CREATE TABLE IF NOT EXISTS podjs_sql_cas_guard(id INTEGER NOT NULL CHECK(id=1))'},
   {sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN '+(before?exists+' AND sha256=? AND size=?)':'NOT '+exists+')')+' THEN 1 ELSE 0 END',params:before?[key,before.sha256,before.size]:[key]},
   {sql:'DELETE FROM podjs_sql_cas_guard'},
   {sql:'INSERT INTO note_asset_files VALUES(?,?,?) ON CONFLICT(storage_key) DO UPDATE SET sha256=excluded.sha256,size=excluded.size',params:[key,after.sha256,after.size]},
  ];
 }
 async commit(key:string,before:NoteAssetVersion|undefined,after:NoteAssetVersion){
  await this.db.transaction(this.statements(key,before,after));
 }
}
