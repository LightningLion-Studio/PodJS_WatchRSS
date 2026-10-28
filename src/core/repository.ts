import {canonicalRssUrl,isLocalOnlyRssSource} from '../cloud/rss-identity';
import {querySyncPages} from '../sync/sql-pages';
import {prepareTextLayout,yieldWorkTurn} from "@podjs/framework/text-layout";
import {traceServiceWork} from "@podjs/framework/service-trace";
import { localSavedStateStatements } from "../sync/saved-state.ts";
import { articlePreview } from "./preview.ts";
import { isDeletableLocalContentChannel,isImportedContentUrl } from "./imported-content.ts";
import { parseFeedAsync } from "./parser";
import type { Article, Channel, Note, SourcePreferences, SqlDatabase, SqlParams,ParsedArticle } from "./types";
const n = (v: unknown) => Number(v ?? 0), b = (v: unknown) => Boolean(Number(v));
const ARTICLE_META = `id,channel_id,title,substr(description,1,2048) AS description,link,guid,pub_date,image_url,audio_url,video_url,is_read,is_saved,reading_progress,dedup_key,fetched_at`;
function channel(r: Record<string,unknown>): Channel { return { id:n(r.id), url:String(r.url), title:String(r.title), description:r.description == null ? null:String(r.description), imageUrl:r.image_url == null ? null:String(r.image_url), lastFetchedAt:r.last_fetched_at == null ? null:n(r.last_fetched_at), createdAt:n(r.created_at), sortOrder:n(r.sort_order), isPinned:b(r.is_pinned) }; }
function article(r: Record<string,unknown>): Article { return { id:n(r.id), channelId:n(r.channel_id), title:String(r.title), description:r.description == null?null:String(r.description), content:r.content == null?null:String(r.content), link:r.link == null?null:String(r.link), guid:r.guid == null?null:String(r.guid), pubDate:r.pub_date == null?null:String(r.pub_date), imageUrl:r.image_url == null?null:String(r.image_url), audioUrl:r.audio_url == null?null:String(r.audio_url), videoUrl:r.video_url == null?null:String(r.video_url), isRead:b(r.is_read), isSaved:b(r.is_saved), readingProgress:Number(r.reading_progress ?? 0), dedupKey:String(r.dedup_key), fetchedAt:n(r.fetched_at) }; }
export class WatchRssRepository {
  constructor(private readonly db: SqlDatabase, private readonly fetchText: (url: string) => Promise<string>, private readonly hydrateContent: (text:string)=>Promise<string> = async text=>text,private readonly prepareSaveAlias?:(id:number)=>Promise<{sql:string;params:SqlParams}[]>,private readonly prepareSourceDelete?:(id:number)=>Promise<{sql:string;params:SqlParams}[]>) {}
  async addChannel(url: string, title = url): Promise<Channel> { const now=Date.now(); await this.db.execute(`INSERT INTO channels(url,title,created_at) VALUES(?,?,?) ON CONFLICT(url) DO NOTHING`, [url,title,now]); return channel((await this.db.query(`SELECT * FROM channels WHERE url=?`,[url]))[0]); }
  async removeChannel(id: number) { await this.db.transaction([...(this.prepareSourceDelete?await this.prepareSourceDelete(id):[]),{sql:`DELETE FROM channels WHERE id=?`,params:[id]}]); }
  async clearLocalContent(id: number): Promise<void> {
    const row = (await this.db.query("SELECT url FROM channels WHERE id=?", [id]))[0];
    if (!row || !isDeletableLocalContentChannel(String(row.url))) return;
    // Retain identities after cascades for future phone sync; this is a local journal,
    // not a claim that the native sync protocol has been implemented.
    await this.db.transaction([
      {sql:`INSERT INTO local_article_deletions(channel_url,article_url,dedup_key,was_favorite,was_watch_later,changed_at)
        SELECT ?,CASE WHEN trim(COALESCE(a.link,''))='' THEN a.dedup_key ELSE a.link END,a.dedup_key,
        a.is_saved OR EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id AND s.save_type='favorite' AND s.saved=1),
        EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id AND s.save_type='watchLater' AND s.saved=1),?
        FROM articles a WHERE a.channel_id=?`,params:[String(row.url),Date.now(),id]},
      {sql:"DELETE FROM articles WHERE channel_id=?",params:[id]},
    ]);
  }
  async listChannels(): Promise<Channel[]> { return (await this.db.query(`SELECT * FROM channels ORDER BY sort_order,title`)).map(channel); }
  async getSourcePreferences(channelId: number): Promise<SourcePreferences> { const r=(await this.db.query(`SELECT * FROM source_preferences WHERE channel_id=?`,[channelId],"reader.preferences"))[0]; return {channelId,useOriginalContent:b(r?.use_original_content),readPreset:String(r?.read_preset ?? "default")}; }
  async setSourcePreferences(channelId: number, preferences: Partial<Omit<SourcePreferences,"channelId">>): Promise<void> { const current=await this.getSourcePreferences(channelId); await this.db.execute(`INSERT INTO source_preferences(channel_id,use_original_content,read_preset) VALUES(?,?,?) ON CONFLICT(channel_id) DO UPDATE SET use_original_content=excluded.use_original_content,read_preset=excluded.read_preset`,[channelId,(preferences.useOriginalContent ?? current.useOriginalContent) ? 1 : 0,preferences.readPreset ?? current.readPreset]); }
  /** Public-pool refresh and cloud merge must reuse the same SQL row, including
   * old native materializations whose synthetic guid carried a transport ID. */
  private async alignPoolEntries(channelId:number,entries:ParsedArticle[]){
    const rows=await querySyncPages(this.db,`SELECT a.id,a.dedup_key,a.link,a.guid,m.article_id AS binding,p.article_id AS pool_id FROM articles a LEFT JOIN sync_article_ids m ON m.item_id=a.id LEFT JOIN cloud_rss_article_ids p ON p.item_id=a.id WHERE a.channel_id=? ORDER BY a.id`,[channelId],100);
    const promoting=(await this.db.query('SELECT 1 FROM rss_local_sources l JOIN channels c ON c.url=l.url WHERE c.id=?',[channelId])).length>0;
    const byGuid=new Map<string,typeof rows>();for(const row of rows){if(row.guid){const key=String(row.guid);byGuid.set(key,[...(byGuid.get(key)??[]),row]);}}
    const byPool=new Map(rows.filter(r=>r.pool_id).map(r=>[String(r.pool_id),r])),byKey=new Map(rows.map(r=>[String(r.dedup_key),r])),usedLegacy=new Set<number>();
    const web=(url:string)=>{try{return canonicalRssUrl(url,false);}catch{return undefined;}};
    for(const entry of entries){
      if(!entry.poolEntryId)continue;
      const guidMatches=entry.guid?byGuid.get(entry.guid)??[]:[];
      let row=byPool.get(entry.poolEntryId)??byKey.get(entry.dedupKey)??(promoting&&guidMatches.length===1?guidMatches[0]:undefined);
      if(!row){const link=web(entry.link??''),matches=link?rows.filter(r=>!usedLegacy.has(Number(r.id))&&!r.pool_id&&(promoting||!r.guid||r.guid===r.binding&&r.dedup_key===r.binding)&&web(String(r.link??''))===link):[];if(matches.length===1&&entries.filter(e=>web(e.link??'')===link).length===1){row=matches[0];usedLegacy.add(Number(row.id));}}
      if(row)entry.dedupKey=String(row.dedup_key);
    }
  }
  async refreshChannel(id: number, feedText?: string,cancelled?:()=>boolean,pool=false): Promise<{ channel: Channel; articles: Article[] }> { const c=channel((await this.db.query(`SELECT * FROM channels WHERE id=?`,[id]))[0]); const xml=feedText ?? await this.fetchText(c.url); const check=()=>{if(cancelled?.())throw Error("刷新已取消");};check();const parsed=await parseFeedAsync(xml,Date.now(),c.url,{onSlice:check});if(pool)await this.alignPoolEntries(id,parsed.articles);check(); const retained=pool?" AND NOT EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=articles.id AND s.saved=1)":""; const steps=(function*(){const statements:{sql:string;params:SqlParams}[]=[]; for(const a of parsed.articles) { const oversized=(a.content?.length ?? 0)>128_000; statements.push({sql:`INSERT INTO articles(channel_id,title,description,content,link,guid,pub_date,image_url,audio_url,video_url,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,dedup_key) DO UPDATE SET title=excluded.title,description=excluded.description,content=excluded.content,link=excluded.link,pub_date=excluded.pub_date,image_url=excluded.image_url,audio_url=excluded.audio_url,video_url=excluded.video_url,fetched_at=excluded.fetched_at${pool?" WHERE NOT EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=articles.id AND s.saved=1)":""}`,params:[id,a.title,a.description,oversized?null:a.content,a.link,a.guid,a.pubDate,a.imageUrl,a.audioUrl,a.videoUrl,a.dedupKey,a.fetchedAt]}); if(pool&&a.poolEntryId)statements.push({sql:`INSERT INTO cloud_rss_article_ids(item_id,article_id) SELECT id,? FROM articles WHERE channel_id=? AND dedup_key=? ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,params:[a.poolEntryId,id,a.dedupKey]}); const key=a.dedupKey; const preview=traceServiceWork("refresh.preview",()=>articlePreview(a.content,a.description,a.imageUrl,a.link)); statements.push({sql:`INSERT INTO article_previews(article_id,summary,image_url) SELECT id,?,? FROM articles WHERE channel_id=? AND dedup_key=?${retained} ON CONFLICT(article_id) DO UPDATE SET summary=COALESCE(excluded.summary,(SELECT summary FROM article_original_previews WHERE article_id=article_previews.article_id)),image_url=COALESCE(excluded.image_url,(SELECT image_url FROM article_original_previews WHERE article_id=article_previews.article_id))`,params:[preview.summary,preview.imageUrl,id,key]}); statements.push({sql:`DELETE FROM article_body_chunks WHERE article_id=(SELECT id FROM articles WHERE channel_id=? AND dedup_key=?${retained})`,params:[id,key]}); if(oversized) for(let offset=0,index=0; offset<a.content!.length; index++) { let end=Math.min(offset+64_000,a.content!.length);if(end<a.content!.length&&/[\uD800-\uDBFF]/.test(a.content![end-1]!))end--; statements.push({sql:`INSERT INTO article_body_chunks(article_id,chunk_index,body) SELECT id,?,? FROM articles WHERE channel_id=? AND dedup_key=?${retained}`,params:[index,a.content!.slice(offset,end),id,key]});offset=end; } yield; } if(/^https?:\/\//i.test(c.url)&&!isImportedContentUrl(c.url)&&!isLocalOnlyRssSource(c.url))statements.push({sql:pool?'DELETE FROM rss_local_sources WHERE url=?':'INSERT OR IGNORE INTO rss_local_sources(url) VALUES(?)',params:[c.url]}); statements.push({sql:`UPDATE channels SET title=CASE WHEN ?=1 THEN title ELSE ? END,description=?,image_url=?,last_fetched_at=? WHERE id=?`,params:[pool?1:0,parsed.title,parsed.description,parsed.imageUrl,Date.now(),id]}); return statements;})();let statements:{sql:string;params:SqlParams}[]=[],key=0;const work=prepareTextLayout(steps,{key:()=>key++,entry:()=>undefined,publish:({layout})=>statements=layout},{yieldTurn:yieldWorkTurn,onSlice:check});await work.done;check();await this.db.transaction(statements); return { channel:channel((await this.db.query(`SELECT * FROM channels WHERE id=?`,[id]))[0]), articles:(await this.db.query(`SELECT ${ARTICLE_META} FROM articles WHERE channel_id=? ORDER BY fetched_at DESC LIMIT 30`,[id])).map(article) }; }
  async getArticleBody(id:number): Promise<string | null> { if((await this.db.query('SELECT article_id FROM article_register_state WHERE item_id=? AND body_pending=1 LIMIT 1',[id])).length)return null; const direct=(await this.db.query(`SELECT content FROM articles WHERE id=?`,[id],"reader.body"))[0]?.content; if(direct != null) return this.hydrateContent(String(direct)); const parts:string[]=[]; for(let offset=0;;offset++) { const rows=await this.db.query(`SELECT body FROM article_body_chunks WHERE article_id=? ORDER BY chunk_index LIMIT 1 OFFSET ?`,[id,offset]); if(!rows.length) break; parts.push(String(rows[0].body)); } return parts.length ? this.hydrateContent(parts.join("")) : null; }
  async listArticles(channelId: number, page=0, pageSize=30): Promise<Article[]> { return (await this.db.query(`SELECT ${ARTICLE_META} FROM articles WHERE channel_id=? ORDER BY COALESCE(pub_date,'') DESC,fetched_at DESC LIMIT ? OFFSET ?`,[channelId,pageSize,page*pageSize])).map(article); }
  async search(query: string, page=0, pageSize=30): Promise<Article[]> { const q=`%${query}%`; return (await this.db.query(`SELECT ${ARTICLE_META} FROM articles WHERE title LIKE ? OR description LIKE ? OR content LIKE ? ORDER BY fetched_at DESC LIMIT ? OFFSET ?`,[q,q,q,pageSize,page*pageSize])).map(article); }
  async favorites(page=0,pageSize=30): Promise<Article[]> { return (await this.db.query(`SELECT ${ARTICLE_META} FROM articles WHERE is_saved=1 ORDER BY fetched_at DESC LIMIT ? OFFSET ?`,[pageSize,page*pageSize])).map(article); }
  async setSaved(id:number, saved:boolean) { await this.setSaveState(id,"favorite",saved); }
  async reorderSavedItems(type:"favorite"|"watchLater",orderedIds:number[]) {
    if(!orderedIds.length)return;
    if(orderedIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(orderedIds).size!==orderedIds.length)throw new Error("Invalid saved item order");
    const base=Date.now()+orderedIds.length;
    await this.db.transaction(orderedIds.map((id,index)=>({sql:`UPDATE article_saved_states SET sort_order=? WHERE article_id=? AND save_type=? AND saved=1`,params:[-base+index,id,type]})));
  }
  async setSaveState(id:number, type:"favorite"|"watchLater", saved:boolean) {
    const aliases=this.prepareSaveAlias?await this.prepareSaveAlias(id):[];
    const now=Date.now();
    const statements:{sql:string;params:SqlParams}[]=[...aliases,{sql:`INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) SELECT id,?,?,?,? FROM articles WHERE id=? ON CONFLICT(article_id,save_type) DO UPDATE SET saved=excluded.saved,changed_at=CASE WHEN article_saved_states.saved!=excluded.saved THEN excluded.changed_at ELSE article_saved_states.changed_at END,sort_order=CASE WHEN article_saved_states.saved=0 AND excluded.saved=1 THEN excluded.sort_order ELSE article_saved_states.sort_order END`,params:[type,saved?1:0,now,-now,id]}];
    if(saved)statements.unshift({sql:`INSERT INTO article_saved_entry_times(article_id,save_type,created_at)
      SELECT a.id,?,CASE WHEN s.saved=1 THEN s.changed_at ELSE ? END FROM articles a LEFT JOIN article_saved_states s ON s.article_id=a.id AND s.save_type=? WHERE a.id=?
      ON CONFLICT(article_id,save_type) DO UPDATE SET created_at=excluded.created_at WHERE COALESCE((SELECT saved FROM article_saved_states WHERE article_id=excluded.article_id AND save_type=excluded.save_type),0)=0`,params:[type,now,type,id]});
    if(type==="favorite") statements.push({sql:`UPDATE articles SET is_saved=? WHERE id=?`,params:[saved?1:0,id]});
    statements.push(...localSavedStateStatements(id,type));
    await this.db.transaction(statements);
  }
  async setRead(id:number, read=true, progress?:number) {
    await this.db.transaction([
      {sql:`INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json) SELECT id,COALESCE(?,reading_progress),?,0,'',NULL FROM articles WHERE id=? AND (?=0 OR is_read!=? OR ? IS NOT NULL) ON CONFLICT(article_id) DO UPDATE SET progress=excluded.progress,changed_at=max(article_reading_state.changed_at+1,excluded.changed_at),state_json=NULL`,params:[progress??null,Date.now(),id,read?1:0,read?1:0,progress??null]},
      {sql:`UPDATE articles SET is_read=?,reading_progress=COALESCE(?,reading_progress) WHERE id=?`,params:[read?1:0,progress??null,id]},
    ]);
  }
  async notes(articleId:number): Promise<Note[]> { return (await this.db.query(`SELECT * FROM notes WHERE article_id=? ORDER BY updated_at DESC`,[articleId])).map(r=>({id:n(r.id),articleId:n(r.article_id),body:String(r.body),createdAt:n(r.created_at),updatedAt:n(r.updated_at)})); }
  async saveNote(articleId:number, body:string, id?:number): Promise<void> { const now=Date.now(); if(id===undefined) await this.db.execute(`INSERT INTO notes(article_id,body,created_at,updated_at) VALUES(?,?,?,?)`,[articleId,body,now,now]); else await this.db.execute(`UPDATE notes SET body=?,updated_at=? WHERE id=? AND article_id=?`,[body,now,id,articleId]); }
  async deleteNote(id:number) { await this.db.execute(`DELETE FROM notes WHERE id=?`,[id]); }
}
