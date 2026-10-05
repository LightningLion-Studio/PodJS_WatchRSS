import type { SqlDatabase, SqlParams } from "../core/types.ts";
import type { SyncBodyCodec } from "./article-body.ts";
import { stableArticleId, nativeTrim, type SyncTextPort } from "./local-manifest.ts";
import { changeLogStatement } from "./sequence-store.ts";
import { isSyncedSourceUrl } from "./source-store.ts";

type ChannelRow = Record<string, unknown>;

const number = (value: unknown): number => Number(value ?? 0);
const string = (value: unknown): string => value == null ? "" : String(value);

/** Local home actions and their phone-visible sync journal writes commit together. */
export class SqlLocalRssActions {
  constructor(
    private readonly db: SqlDatabase,
    private readonly text: Pick<SyncTextPort, "parseUri">,
    private readonly codec: Pick<SyncBodyCodec, "sha256">,
    private readonly now = Date.now,
  ) {}

  private async identity(): Promise<string> {
    const row = (await this.db.query("SELECT device_id FROM sync_local_identity WHERE id=1"))[0];
    if (!row || !nativeTrim(string(row.device_id))) throw new Error("同步身份未初始化");
    return string(row.device_id);
  }

  private async channel(id: number): Promise<ChannelRow | undefined> {
    return (await this.db.query(`SELECT c.*,s.sort_order AS sync_sort_order
      FROM channels c LEFT JOIN sync_source_states s ON s.url=c.url AND s.deleted=0
      WHERE c.id=?`, [id]))[0];
  }

  private logicalOrder(row: ChannelRow): number {
    if (row.sync_sort_order != null) return number(row.sync_sort_order);
    const stored = number(row.sort_order);
    return stored < 0 ? -stored : stored;
  }

  private async setPlacement(id: number, pinned: boolean, order: number, changedAt: number): Promise<void> {
    if (![id, order, changedAt].every(Number.isSafeInteger)) throw new Error("Invalid RSS source clock");
    const row = await this.channel(id);
    if (!row) return;
    const url = string(row.url), synced = isSyncedSourceUrl(url);
    const statements: {sql: string; params?: SqlParams}[] = [{
      sql: "UPDATE channels SET sort_order=?,is_pinned=? WHERE id=?",
      params: [synced ? -order : order, pinned ? 1 : 0, id],
    }];
    if (synced) {
      const deviceId = await this.identity();
      statements.push({
        sql: `INSERT OR REPLACE INTO sync_source_states(url,source_device_id,title,description,site_url,image_url,created_at,updated_at,sort_order,is_pinned,deleted,deleted_at)
          SELECT url,?,title,COALESCE(description,''),NULL,image_url,created_at,max(COALESCE(last_fetched_at,0),?,created_at),?,?,0,0
          FROM channels WHERE id=?`,
        params: [deviceId, order, order, pinned ? 1 : 0, id],
      });
      statements.push(changeLogStatement("rssSource", url, changedAt, deviceId, "sourceState", this.now()));
    }
    await this.db.transaction(statements);
  }

  async moveChannelToTop(id: number): Promise<void> {
    const row = await this.channel(id);
    if (!row) return;
    const at = this.now();
    await this.setPlacement(id, !!number(row.is_pinned), at, at);
  }

  async setChannelPinned(id: number, pinned: boolean): Promise<void> {
    const row = await this.channel(id);
    if (!row) return;
    const at = this.now();
    const order = pinned ? at : this.logicalOrder(row);
    await this.setPlacement(id, pinned, order, order);
  }

  async markChannelRead(id: number): Promise<void> {
    const rows = await this.db.query("SELECT id,link,dedup_key FROM articles WHERE channel_id=? AND is_read=0 ORDER BY id", [id]);
    if (!rows.length) return;
    const deviceId = await this.identity(), at = this.now();
    if (!Number.isSafeInteger(at)) throw new Error("Invalid article read clock");
    const statements: {sql: string; params?: SqlParams}[] = [];
    for (const row of rows) {
      const itemId = number(row.id), link = row.link == null ? "" : string(row.link), dedupKey = string(row.dedup_key);
      const articleId = await stableArticleId(nativeTrim(link) ? link : dedupKey, this.text.parseUri, this.codec);
      statements.push({
        sql: `INSERT INTO sync_article_aliases(item_id,article_id)
          SELECT id,? FROM articles WHERE id=? AND channel_id=?
          ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,
        params: [articleId, itemId, id],
      });
      statements.push({sql: "UPDATE articles SET is_read=1 WHERE id=? AND channel_id=?", params: [itemId, id]});
      statements.push(changeLogStatement("article", articleId, at, deviceId, "read", at));
    }
    await this.db.transaction(statements);
  }
}
