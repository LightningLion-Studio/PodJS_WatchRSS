import type {SqlDatabase,SqlParams} from '../core/types.ts';
import type {SyncBodyCodec} from './article-body.ts';
import {SyncSavedStateStore} from './saved-state.ts';
import {stableArticleId,nativeTrim,type SyncTextPort} from './local-manifest.ts';
/** Preserve the installed identity; concurrent first callers converge in SQLite. */
export async function ensureSyncDevice(db:SqlDatabase,randomBytes:()=>Promise<Uint8Array>):Promise<string>{
 const existing=(await db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0];
 if(existing){const id=String(existing.device_id);if(!nativeTrim(id))throw new Error('Stored sync identity is invalid');return id;}
 const bytes=(await randomBytes()).slice();if(bytes.length!==16)throw new Error('Invalid random UUID bytes');bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return new SyncSavedStateStore(db).initializeDevice(`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`);
}
/** These statements must commit with the UI save and its sync journal update. */
export async function prepareLocalSaveAlias(db:SqlDatabase,itemId:number,text:Pick<SyncTextPort,'parseUri'>,codec:Pick<SyncBodyCodec,'sha256'>):Promise<{sql:string;params:SqlParams}[]>{
 const item=(await db.query('SELECT id,link,dedup_key FROM articles WHERE id=?',[itemId]))[0];if(!item)return [];
 const url=item.link==null?'':String(item.link),id=await stableArticleId(nativeTrim(url)?url:String(item.dedup_key),text.parseUri,codec);
 return [{sql:`INSERT INTO sync_article_aliases(item_id,article_id)
  SELECT id,CASE WHEN link IS ? AND dedup_key=? THEN ? ELSE NULL END FROM articles WHERE id=?
  ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,params:[item.link,item.dedup_key,id,itemId]}];
}
