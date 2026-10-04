import type { SqlDatabase, SqlParams } from "../core/types.ts";

export type SyncSaveType = "favorite" | "watchLater";
export interface RemoteSavedState {
  articleId: string;
  url: string;
  type: SyncSaveType;
  saved: boolean;
  changedAt: number;
  sortOrder: number;
  sourceDeviceId: string;
}
type Statement = { sql: string; params: SqlParams };

// SQLite UTF-8 binary order differs from Kotlin String.compareTo for non-BMP
// characters. Fixed-width UTF-16 hex retains the native device-id tie break.
export function deviceOrder(id: string): string {
  let result = "";
  for (let i = 0; i < id.length; i++) result += id.charCodeAt(i).toString(16).padStart(4, "0");
  return result;
}
function nonblank(value: string, field: string) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Invalid ${field}`);
}
function integer(value: number, field: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${field}: expected safe integer`);
}

/** Append to the SAME transaction as the local UI save operation. No mapping
 * means a local RSS identity has not yet been resolved; do not invent one. */
export function localSavedStateStatements(itemId: number, type: SyncSaveType): Statement[] {
  return [{ sql: `INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order)
    SELECT m.article_id,s.save_type,s.article_id,m.url,s.saved,s.changed_at,-s.sort_order,i.device_id,i.device_order
    FROM article_saved_states s JOIN (
      SELECT article_id,item_id,url FROM sync_article_ids WHERE item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sync_article_aliases al WHERE al.item_id=sync_article_ids.item_id)
      UNION ALL SELECT al.article_id,al.item_id,COALESCE(a.link,'') FROM sync_article_aliases al JOIN articles a ON a.id=al.item_id
    ) m ON m.item_id=s.article_id CROSS JOIN sync_local_identity i
    WHERE s.article_id=? AND s.save_type=? AND i.id=1
    ON CONFLICT(article_id,save_type) DO UPDATE SET item_id=excluded.item_id,url=excluded.url,
      saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order,
      source_device_id=excluded.source_device_id,source_order=excluded.source_order
    WHERE sync_saved_states.saved!=excluded.saved`, params: [itemId, type] }];
}

/** Saved-state persistence only. Article selection, body application, whole
 * article deletion, media side effects, peer cursors and ACKs belong to the
 * receive coordinator and are deliberately not implied by this API. */
export class SyncSavedStateStore {
  constructor(private readonly db: SqlDatabase) {}

  async initializeDevice(candidateId: string): Promise<string> {
    nonblank(candidateId, "device id");
    await this.db.execute(`INSERT OR IGNORE INTO sync_local_identity(id,device_id,device_order) VALUES(1,?,?)`, [candidateId, deviceOrder(candidateId)]);
    const row = (await this.db.query("SELECT device_id FROM sync_local_identity WHERE id=1"))[0];
    if (!row) throw new Error("Missing sync identity");
    return String(row.device_id);
  }

  /** Call only after the receive coordinator has resolved a native article id.
   * UNIQUE/FK constraints reject remapping an existing item to another id. */
  async bindArticle(itemId: number, articleId: string, url: string): Promise<void> {
    integer(itemId, "item id"); nonblank(articleId, "article id");
    if (!(await this.db.query("SELECT device_id FROM sync_local_identity WHERE id=1")).length) throw new Error("Initialize sync identity first");
    await this.db.transaction([
      { sql: `INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,?,?)
        ON CONFLICT(article_id) DO UPDATE SET item_id=excluded.item_id,url=excluded.url
        `, params: [articleId, itemId, url] },
      {sql:`INSERT INTO sync_article_aliases(item_id,article_id) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,params:[itemId,articleId]},
      // Seed local state before considering a first remote update. Do not
      // reinterpret existing remote state as a new local write on restart.
      { sql: `INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order)
        SELECT m.article_id,s.save_type,s.article_id,m.url,s.saved,s.changed_at,-s.sort_order,i.device_id,i.device_order
        FROM article_saved_states s JOIN sync_article_ids m ON m.item_id=s.article_id CROSS JOIN sync_local_identity i
        WHERE m.article_id=? AND m.item_id=? AND i.id=1 ON CONFLICT(article_id,save_type) DO NOTHING`, params: [articleId,itemId] },
      {sql:`UPDATE sync_saved_states SET item_id=? WHERE article_id=?`,params:[itemId,articleId]},
      ...this.projection(articleId),
    ]);
  }

  /** May be included in a larger article transaction. All conflict decisions
   * read current SQLite state during commit, never a stale preparatory read. */
  remoteStatements(state: RemoteSavedState, options: { authoritative?: boolean; tombstone?: boolean } = {}): Statement[] {
    nonblank(state.articleId, "article id"); nonblank(state.sourceDeviceId, "source device id");
    integer(state.changedAt, "changedAt"); integer(state.sortOrder, "sortOrder");
    if (state.type !== "favorite" && state.type !== "watchLater") throw new Error("Invalid save type");
    if (typeof state.saved !== "boolean") throw new Error("Invalid saved flag");
    if (options.tombstone && state.saved) return [];
    if (!options.authoritative && !state.saved && state.changedAt <= 0) return [];
    const statements: Statement[] = [{ sql: `INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order)
      SELECT ?,?,${options.tombstone ? "NULL" : "m.item_id"},?,?,?,?,?,?
      ${options.tombstone ? "WHERE 1" : "FROM sync_article_ids m WHERE m.article_id=? AND m.item_id IS NOT NULL"}
      ON CONFLICT(article_id,save_type) DO UPDATE SET item_id=excluded.item_id,url=excluded.url,
        saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order,
        source_device_id=excluded.source_device_id,source_order=excluded.source_order
      WHERE ?=1 OR excluded.changed_at>sync_saved_states.changed_at OR
        (excluded.changed_at=sync_saved_states.changed_at AND excluded.source_order>sync_saved_states.source_order)`,
      params: [state.articleId,state.type,state.url,state.saved?1:0,state.changedAt,options.tombstone?0:state.sortOrder,state.sourceDeviceId,deviceOrder(state.sourceDeviceId),...(options.tombstone ? [] : [state.articleId]),options.authoritative?1:0] }];
    // Tombstones for missing articles have no saved-entry side effects in the
    // native repository. Keep that distinct from normal state application.
    if (!options.tombstone) statements.push(...this.projection(state.articleId,state.type,true));
    return statements;
  }

  async apply(state: RemoteSavedState, options: { authoritative?: boolean; tombstone?: boolean } = {}): Promise<void> {
    const statements = this.remoteStatements(state, options);
    if (statements.length) await this.db.transaction(statements);
  }

  private projection(articleId:string,type?:SyncSaveType,onlyChanged=false):Statement[] {
    const where=`s.article_id=? AND s.item_id IS NOT NULL${type?" AND s.save_type=?":""}${onlyChanged?" AND changes()>0":""}`;
    const params=[articleId,...(type?[type]:[])];
    return [
      {sql:`INSERT INTO article_saved_entry_times(article_id,save_type,created_at)
        SELECT s.item_id,s.save_type,CASE WHEN u.saved=1 AND s.saved=1 THEN COALESCE(t.created_at,u.changed_at) ELSE s.changed_at END
        FROM sync_saved_states s LEFT JOIN article_saved_states u ON u.article_id=s.item_id AND u.save_type=s.save_type
        LEFT JOIN article_saved_entry_times t ON t.article_id=s.item_id AND t.save_type=s.save_type WHERE ${where}
        ON CONFLICT(article_id,save_type) DO UPDATE SET created_at=excluded.created_at`,params},
      {sql:`INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order)
        SELECT s.item_id,s.save_type,s.saved,s.changed_at,-s.sort_order FROM sync_saved_states s WHERE ${where}
        ON CONFLICT(article_id,save_type) DO UPDATE SET saved=excluded.saved,changed_at=excluded.changed_at,sort_order=excluded.sort_order`,params},
      {sql:`UPDATE articles SET is_saved=COALESCE((SELECT saved FROM article_saved_states WHERE article_id=articles.id AND save_type='favorite'),0)
        WHERE id IN(SELECT s.item_id FROM sync_saved_states s WHERE ${where})`,params},
    ];
  }
}
