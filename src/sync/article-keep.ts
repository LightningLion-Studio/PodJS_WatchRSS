import type {SqlDatabase,SqlParams} from '../core/types';
import {querySyncPages} from './sql-pages';
import {deviceOrder} from './saved-state';
type Statement={sql:string;params?:SqlParams};
export const ARTICLE_KEEP_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS sync_article_keeps(article_id TEXT PRIMARY KEY,url TEXT NOT NULL,changed_at INTEGER NOT NULL,source_device_id TEXT NOT NULL,source_order TEXT NOT NULL,item_id INTEGER REFERENCES articles(id) ON DELETE SET NULL)`,
 `CREATE INDEX IF NOT EXISTS sync_article_keeps_url ON sync_article_keeps(url)`,
 `CREATE TABLE IF NOT EXISTS sync_article_keep_aliases(alias_id TEXT NOT NULL,canonical_id TEXT NOT NULL REFERENCES sync_article_keeps(article_id) ON DELETE CASCADE,url TEXT NOT NULL,PRIMARY KEY(alias_id,canonical_id))`,
 `CREATE INDEX IF NOT EXISTS sync_article_keep_aliases_url ON sync_article_keep_aliases(url)`,
 `CREATE INDEX IF NOT EXISTS sync_article_keep_aliases_identity ON sync_article_keep_aliases(alias_id,url)`,
 `CREATE TABLE IF NOT EXISTS sync_article_keep_migration(id INTEGER PRIMARY KEY CHECK(id=1))`,
];
/** Accepted live state is business evidence. It must outlive body-cache eviction,
 * source refresh, projection/schema upgrades and transport ACK credential TTLs. */
export class ArticleKeepStore {
 private ready?:Promise<void>;
 constructor(private readonly db:Pick<SqlDatabase,'query'|'transaction'>){}
 initialize(){return this.ready??=this.migrate().catch(e=>{this.ready=undefined;throw e;});}
 private async migrate(){
  await this.db.transaction(ARTICLE_KEEP_SCHEMA.map(sql=>({sql})));
  if((await this.db.query('SELECT id FROM sync_article_keep_migration WHERE id=1')).length)return;
  // Only a verified accepted encoding receipt can seed older installations.
  // Missing provenance is not reconstructed from feed fetch/saved clocks.
  const old=await querySyncPages(this.db,`SELECT m.article_id,m.url,m.item_id,e.updated_at,e.source_device_id,e.metadata_state FROM sync_article_ids m JOIN article_sync_encoding_cache e ON e.item_id=m.item_id JOIN article_sync_content c ON c.item_id=e.item_id AND c.body_hash=e.body_hash WHERE e.updated_at>0 AND e.source_device_id IS NOT NULL AND e.metadata_state IS NOT NULL ORDER BY m.article_id`,[],100);
  for(let at=0;at<old.length;at+=100){const ss:Statement[]=[];for(const r of old.slice(at,at+100)){
   let state:unknown;try{state=JSON.parse(String(r.metadata_state));}catch{continue;}
   if(!Array.isArray(state))continue;const clock=Math.max(Number(r.updated_at),Number(state[7])||0,Number(state[10])||0);if(!Number.isSafeInteger(clock)||clock<=0)continue;
   const source=String(r.source_device_id);ss.push({sql:'INSERT OR IGNORE INTO sync_article_keeps VALUES(?,?,?,?,?,?)',params:[r.article_id,r.url,clock,source,deviceOrder(source),r.item_id]},
    {sql:'INSERT OR IGNORE INTO sync_article_keep_aliases SELECT article_id,article_id,url FROM sync_article_keeps WHERE article_id=?',params:[r.article_id]});
  }if(ss.length)await this.db.transaction(ss);}
  await this.db.transaction([{sql:'INSERT OR IGNORE INTO sync_article_keep_migration VALUES(1)'}]);
 }
 async lookup(id:string,url:string){await this.initialize();const rows=await this.db.query(`SELECT k.* FROM sync_article_keeps k JOIN sync_article_keep_aliases a ON a.canonical_id=k.article_id AND a.url=k.url WHERE a.alias_id=? AND a.url=?`,[id,url]);return rows.length===1?rows[0]:undefined;}
 /** Append to the same revision-guarded transaction as the received state. */
 record(id:string,url:string,clock:number,source:string,itemSql:string,itemParams:SqlParams,aliases:readonly string[]):Statement[]{
  if(!Number.isSafeInteger(clock)||clock<=0)return [];
  const order=deviceOrder(source),current='EXISTS(SELECT 1 FROM sync_article_keeps WHERE article_id=? AND url=? AND changed_at=? AND source_order=?)',proof=[id,url,clock,order];
  return [{sql:`INSERT INTO sync_article_keeps(article_id,url,changed_at,source_device_id,source_order,item_id) VALUES(?,?,?,?,?,${itemSql}) ON CONFLICT(article_id) DO UPDATE SET url=excluded.url,changed_at=excluded.changed_at,source_device_id=excluded.source_device_id,source_order=excluded.source_order,item_id=excluded.item_id WHERE excluded.changed_at>sync_article_keeps.changed_at OR (excluded.changed_at=sync_article_keeps.changed_at AND excluded.source_order>=sync_article_keeps.source_order)`,params:[id,url,clock,source,order,...itemParams]},
   ...[...new Set([id,...aliases])].map(alias=>({sql:`INSERT INTO sync_article_keep_aliases(alias_id,canonical_id,url) SELECT ?,?,? WHERE ${current} ON CONFLICT(alias_id,canonical_id) DO UPDATE SET url=excluded.url WHERE sync_article_keep_aliases.url IS NOT excluded.url`,params:[alias,id,url,...proof]})),
   {sql:`DELETE FROM sync_article_deletions WHERE url=? AND article_id IN (SELECT a.alias_id FROM sync_article_keep_aliases a WHERE a.canonical_id=? AND a.url=? AND 1=(SELECT count(*) FROM sync_article_keep_aliases b WHERE b.alias_id=a.alias_id AND b.url=a.url)) AND (changed_at<? OR (changed_at=? AND source_order<=?)) AND ${current}`,params:[url,id,url,clock,clock,order,...proof]},
   {sql:`DELETE FROM sync_saved_states WHERE article_id<>? AND url=? AND article_id IN (SELECT a.alias_id FROM sync_article_keep_aliases a WHERE a.canonical_id=? AND a.url=? AND 1=(SELECT count(*) FROM sync_article_keep_aliases b WHERE b.alias_id=a.alias_id AND b.url=a.url)) AND EXISTS(SELECT 1 FROM sync_saved_states kept WHERE kept.article_id=? AND kept.save_type=sync_saved_states.save_type AND (kept.changed_at>sync_saved_states.changed_at OR (kept.changed_at=sync_saved_states.changed_at AND kept.source_order>=sync_saved_states.source_order))) AND ${current}`,params:[id,url,id,url,id,...proof]}];
 }
}
