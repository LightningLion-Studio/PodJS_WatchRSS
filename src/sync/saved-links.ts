import {nativeTrim} from './local-manifest.ts';
import type {JsonObject} from './protocol.ts';
import type {SqlDatabase} from '../core/types.ts';

export type SavedLinkType = 'favorite' | 'watchLater';

export async function readSavedLinks(db:Pick<SqlDatabase,'query'>,type:SavedLinkType):Promise<string[]> {
  const rows=await db.query(`SELECT a.link FROM article_saved_states s JOIN articles a ON a.id=s.article_id
    LEFT JOIN article_saved_entry_times t ON t.article_id=s.article_id AND t.save_type=s.save_type
    WHERE s.save_type=? AND s.saved=1
    ORDER BY s.sort_order ASC,COALESCE(t.created_at,s.changed_at) DESC,a.id DESC`,[type]);
  return rows.map(row=>String(row.link??''));
}

export function parseSavedLinkType(value: unknown): SavedLinkType {
  const type = nativeTrim(typeof value === 'string' ? value : '').toUpperCase();
  if (type === 'FAVORITE' || type === 'SYNC_FAVORITES') return 'favorite';
  if (type === 'WATCH_LATER' || type === 'WATCHLATER' || type === 'SYNC_WATCH_LATER') return 'watchLater';
  throw Error(`未知保存类型：${typeof value === 'string' ? value : ''}`);
}

/** The legacy phone action transfers only nonblank links, in saved-list order. */
export async function pullSavedItems(request: JsonObject, readLinks: (type: SavedLinkType) => Promise<string[]>): Promise<JsonObject> {
  const type = parseSavedLinkType(request.type);
  const links = await readLinks(type);
  const items = links.map(link => nativeTrim(link)).filter(Boolean).map(link => ({link}));
  return {success:true,action:'pullSavedItems',type:type === 'favorite' ? 'FAVORITE' : 'WATCH_LATER',
    count:items.length,items};
}
