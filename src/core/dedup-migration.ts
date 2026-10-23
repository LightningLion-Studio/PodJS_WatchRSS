export interface SchemaStatement {sql:string;params?:readonly (string|number|null)[]}

const WS=`char(9)||char(10)||char(11)||char(12)||char(13)||char(28)||char(29)||char(30)||char(31)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)`;
const trim=(value:string)=>`trim(COALESCE(${value},''),${WS})`;
const HASH=(value:string)=>`length(${value})=64 AND lower(${value})=${value} AND ${value} NOT GLOB '*[^0-9a-f]*'`;
const CHANGED=`affected=1`;
const changed=(alias:string)=>`${alias}.affected=1`;

/** Version-2 migration. Every temporary copy and the final user_version write
 * execute in the caller's single SQLite transaction. A failure therefore
 * restores both data and version, and retrying is safe. */
export function dedupKeyMigration(now:number,onlyProvenDuplicates=false):SchemaStatement[]{
 const guid=trim('a.guid'),link=trim('a.link');
 return [
  {sql:`DROP TABLE IF EXISTS temp._wrss_dedup_plan`},
  {sql:`DROP TABLE IF EXISTS temp._wrss_identity_candidates`},
  {sql:`DROP TABLE IF EXISTS temp._wrss_identity_choice`},
  {sql:`DROP TRIGGER IF EXISTS sync_article_binding_immutable`},
  {sql:`DROP TRIGGER IF EXISTS sync_article_insert_binding_immutable`},
  {sql:`DROP TRIGGER IF EXISTS sync_article_alias_immutable`},
  {sql:`CREATE TEMP TABLE _wrss_dedup_plan(item_id INTEGER PRIMARY KEY,channel_id INTEGER NOT NULL,old_key TEXT NOT NULL,target_key TEXT NOT NULL,survivor_id INTEGER NOT NULL,affected INTEGER NOT NULL DEFAULT 0)`},
  {sql:`INSERT INTO _wrss_dedup_plan(item_id,channel_id,old_key,target_key,survivor_id)
   SELECT a.id,a.channel_id,a.dedup_key,
    ${onlyProvenDuplicates?'a.dedup_key':`CASE WHEN ${HASH('a.dedup_key')} AND ${guid}=a.dedup_key THEN a.dedup_key
     WHEN ${guid}<>'' THEN 'guid:'||${guid}
     WHEN a.dedup_key LIKE 'link:%' THEN a.dedup_key
     WHEN ${link}<>'' THEN 'link:'||${link}
     ELSE 'title:'||a.title END`},a.id
   FROM articles a JOIN channels c ON c.id=a.channel_id
   WHERE (lower(${trim('c.url')}) LIKE 'http://%' OR lower(${trim('c.url')}) LIKE 'https://%')
    AND lower(${trim('c.url')}) NOT LIKE 'https://watchrss.local/import-content%'
    AND lower(${trim('c.url')}) NOT LIKE 'https://watchrss.local/import-epub%'
    AND lower(${trim('c.url')}) NOT LIKE 'https://watchrss.local/import-txt-novel%'`},
  // A sync-materialized SHA row has no feed GUID. It can only be folded when
  // the same source channel already has an exact-link native-prefixed row.
  {sql:`UPDATE _wrss_dedup_plan SET target_key=(SELECT p2.target_key FROM _wrss_dedup_plan p2
    JOIN articles a2 ON a2.id=p2.item_id JOIN articles a1 ON a1.id=_wrss_dedup_plan.item_id
    WHERE p2.channel_id=_wrss_dedup_plan.channel_id AND p2.item_id<>_wrss_dedup_plan.item_id
     AND (p2.target_key LIKE 'guid:%' OR p2.target_key LIKE 'link:%' OR p2.target_key LIKE 'title:%')
     AND ${trim('a2.link')}<>'' AND ${trim('a2.link')}=${trim('a1.link')}
    ORDER BY CASE WHEN p2.old_key=p2.target_key THEN 0 ELSE 1 END,p2.item_id LIMIT 1)
   WHERE ${HASH('old_key')}
    AND EXISTS(SELECT 1 FROM articles legacy JOIN sync_article_ids binding ON binding.item_id=legacy.id AND binding.article_id=_wrss_dedup_plan.old_key WHERE legacy.id=_wrss_dedup_plan.item_id AND (${trim('legacy.guid')}='' OR ${trim('legacy.guid')}=_wrss_dedup_plan.old_key))
    AND NOT EXISTS(SELECT 1 FROM cloud_rss_article_ids canonical WHERE canonical.item_id=_wrss_dedup_plan.item_id)
    AND (SELECT COUNT(DISTINCT p3.target_key) FROM _wrss_dedup_plan p3 JOIN articles a3 ON a3.id=p3.item_id JOIN articles base ON base.id=_wrss_dedup_plan.item_id WHERE p3.channel_id=_wrss_dedup_plan.channel_id AND p3.item_id<>_wrss_dedup_plan.item_id AND (p3.target_key LIKE 'guid:%' OR p3.target_key LIKE 'link:%' OR p3.target_key LIKE 'title:%') AND ${trim('a3.link')}<>'' AND ${trim('a3.link')}=${trim('base.link')})=1 AND EXISTS(SELECT 1 FROM _wrss_dedup_plan p2
    JOIN articles a2 ON a2.id=p2.item_id JOIN articles a1 ON a1.id=_wrss_dedup_plan.item_id
    WHERE p2.channel_id=_wrss_dedup_plan.channel_id AND p2.item_id<>_wrss_dedup_plan.item_id
     AND (p2.target_key LIKE 'guid:%' OR p2.target_key LIKE 'link:%' OR p2.target_key LIKE 'title:%')
     AND ${trim('a2.link')}<>'' AND ${trim('a2.link')}=${trim('a1.link')})`},
  {sql:`CREATE INDEX temp._wrss_dedup_target ON _wrss_dedup_plan(channel_id,target_key)`},
  {sql:`UPDATE _wrss_dedup_plan SET survivor_id=(SELECT p2.item_id FROM _wrss_dedup_plan p2
    WHERE p2.channel_id=_wrss_dedup_plan.channel_id AND p2.target_key=_wrss_dedup_plan.target_key
    ORDER BY CASE WHEN p2.old_key=p2.target_key THEN 0 ELSE 1 END,p2.item_id LIMIT 1)`},

  // Include the already-canonical survivor as well as renamed/deleted rows.
  // All per-item winners and replacements must use the same complete group.
  {sql:`UPDATE _wrss_dedup_plan SET affected=1 WHERE survivor_id IN
    (SELECT survivor_id FROM _wrss_dedup_plan WHERE old_key<>target_key OR item_id<>survivor_id)`},
  {sql:`CREATE INDEX temp._wrss_dedup_survivor ON _wrss_dedup_plan(survivor_id)`},

  // Remember every durable phone/watch identity before any binding is moved.
  {sql:`CREATE TEMP TABLE _wrss_identity_candidates(survivor_id INTEGER NOT NULL,article_id TEXT NOT NULL,priority INTEGER NOT NULL,PRIMARY KEY(survivor_id,article_id))`},
  {sql:`INSERT OR IGNORE INTO _wrss_identity_candidates SELECT p.survivor_id,x.article_id,
    CASE WHEN x.item_id=p.survivor_id THEN 0 ELSE 2 END FROM _wrss_dedup_plan p JOIN sync_article_aliases x ON x.item_id=p.item_id WHERE ${changed('p')}`},
  {sql:`INSERT OR IGNORE INTO _wrss_identity_candidates SELECT p.survivor_id,x.article_id,
    CASE WHEN x.item_id=p.survivor_id THEN 1 ELSE 3 END FROM _wrss_dedup_plan p JOIN sync_article_ids x ON x.item_id=p.item_id WHERE ${changed('p')}`},
  {sql:`INSERT OR IGNORE INTO _wrss_identity_candidates SELECT p.survivor_id,x.article_id,3 FROM _wrss_dedup_plan p JOIN sync_saved_states x ON x.item_id=p.item_id WHERE ${changed('p')}`},
  {sql:`INSERT OR IGNORE INTO _wrss_identity_candidates SELECT survivor_id,old_key,4 FROM _wrss_dedup_plan WHERE ${CHANGED} AND ${HASH('old_key')}`},
  {sql:`CREATE TEMP TABLE _wrss_identity_choice AS SELECT DISTINCT c.survivor_id,
    (SELECT c2.article_id FROM _wrss_identity_candidates c2 WHERE c2.survivor_id=c.survivor_id ORDER BY c2.priority,c2.article_id LIMIT 1) article_id
    FROM _wrss_identity_candidates c`},

  // Merge visible article metadata without discarding a non-empty body. Feed
  // GUID casing is preserved by keeping the canonical survivor's GUID first.
  {sql:`UPDATE articles SET
    title=COALESCE((SELECT NULLIF(s.title,'') FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id ORDER BY s.fetched_at DESC,s.id DESC LIMIT 1),title),
    description=COALESCE((SELECT s.description FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND ${trim('s.description')}<>'' ORDER BY length(s.description) DESC,s.fetched_at DESC LIMIT 1),description),
    content=COALESCE((SELECT s.content FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND ${trim('s.content')}<>'' ORDER BY length(s.content) DESC,s.fetched_at DESC LIMIT 1),content),
    link=COALESCE(NULLIF(link,''),(SELECT NULLIF(s.link,'') FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND ${trim('s.link')}<>'' ORDER BY s.fetched_at DESC LIMIT 1)),
    guid=COALESCE(NULLIF(guid,''),(SELECT NULLIF(s.guid,'') FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND ${trim('s.guid')}<>'' ORDER BY s.fetched_at DESC LIMIT 1)),
    pub_date=COALESCE(pub_date,(SELECT s.pub_date FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND s.pub_date IS NOT NULL ORDER BY s.fetched_at DESC LIMIT 1)),
    image_url=COALESCE(image_url,(SELECT s.image_url FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND s.image_url IS NOT NULL ORDER BY s.fetched_at DESC LIMIT 1)),
    audio_url=COALESCE(audio_url,(SELECT s.audio_url FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND s.audio_url IS NOT NULL ORDER BY s.fetched_at DESC LIMIT 1)),
    video_url=COALESCE(video_url,(SELECT s.video_url FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id AND s.video_url IS NOT NULL ORDER BY s.fetched_at DESC LIMIT 1)),
    is_read=(SELECT max(s.is_read) FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id),
    is_saved=(SELECT max(s.is_saved) FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id),
    reading_progress=(SELECT max(s.reading_progress) FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id),
    fetched_at=(SELECT max(s.fetched_at) FROM _wrss_dedup_plan p JOIN articles s ON s.id=p.item_id WHERE p.survivor_id=articles.id)
   WHERE id IN(SELECT survivor_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},

  // Native reading clocks win; progress breaks ties only for legacy zero clocks.
  {sql:`CREATE TEMP TABLE _wrss_reading_copy AS SELECT p.survivor_id,r.progress,r.changed_at,r.position_bytes,r.position_hash,r.state_json
   FROM _wrss_dedup_plan p JOIN article_reading_state r ON r.article_id=p.item_id
   WHERE p.item_id=(SELECT p2.item_id FROM _wrss_dedup_plan p2 JOIN article_reading_state r2 ON r2.article_id=p2.item_id
    WHERE p2.survivor_id=p.survivor_id ORDER BY r2.changed_at DESC,CASE WHEN r2.changed_at=0 THEN r2.progress ELSE 0 END DESC,CASE WHEN p2.item_id=p2.survivor_id THEN 0 ELSE 1 END,p2.item_id LIMIT 1)
    AND ${changed('p')}`},
  // Saved-state projection follows native changedAt ordering; a tied true value
  // wins so migration cannot silently discard an affirmative user action.
  {sql:`CREATE TEMP TABLE _wrss_saved_winners AS SELECT DISTINCT p.survivor_id,s.save_type,
    (SELECT s2.article_id FROM _wrss_dedup_plan p2 JOIN article_saved_states s2 ON s2.article_id=p2.item_id
     WHERE p2.survivor_id=p.survivor_id AND s2.save_type=s.save_type ORDER BY s2.changed_at DESC,s2.saved DESC,s2.article_id DESC LIMIT 1) source_id
   FROM _wrss_dedup_plan p JOIN article_saved_states s ON s.article_id=p.item_id WHERE ${changed('p')}`},
  {sql:`CREATE TEMP TABLE _wrss_saved_copy AS SELECT w.survivor_id,s.save_type,s.saved,s.changed_at,s.sort_order
   FROM _wrss_saved_winners w JOIN article_saved_states s ON s.article_id=w.source_id AND s.save_type=w.save_type`},
  {sql:`CREATE TEMP TABLE _wrss_saved_time_copy AS SELECT p.survivor_id,t.save_type,min(t.created_at) created_at
   FROM _wrss_dedup_plan p JOIN article_saved_entry_times t ON t.article_id=p.item_id WHERE ${changed('p')} GROUP BY p.survivor_id,t.save_type`},

  // Preserve one complete chunked body per logical row, preferring the largest.
  {sql:`CREATE TEMP TABLE _wrss_body_copy AS SELECT g.survivor_id,b.chunk_index,b.body FROM
    (SELECT DISTINCT p.survivor_id,(SELECT p2.item_id FROM _wrss_dedup_plan p2 JOIN
      (SELECT article_id,sum(length(body)) size FROM article_body_chunks GROUP BY article_id) z ON z.article_id=p2.item_id
      WHERE p2.survivor_id=p.survivor_id ORDER BY z.size DESC,p2.item_id DESC LIMIT 1) source_id
     FROM _wrss_dedup_plan p WHERE ${changed('p')}) g JOIN article_body_chunks b ON b.article_id=g.source_id`},
  {sql:`CREATE TEMP TABLE _wrss_original_body_copy AS SELECT g.survivor_id,b.chunk_index,b.body FROM
    (SELECT DISTINCT p.survivor_id,(SELECT p2.item_id FROM _wrss_dedup_plan p2 JOIN
      (SELECT article_id,sum(length(body)) size FROM article_original_chunks GROUP BY article_id) z ON z.article_id=p2.item_id
      WHERE p2.survivor_id=p.survivor_id ORDER BY z.size DESC,p2.item_id DESC LIMIT 1) source_id
     FROM _wrss_dedup_plan p WHERE ${changed('p')}) g JOIN article_original_chunks b ON b.article_id=g.source_id`},
  {sql:`CREATE TEMP TABLE _wrss_preview_copy AS SELECT g.survivor_id,p.summary,p.image_url FROM
    (SELECT DISTINCT x.survivor_id,(SELECT x2.item_id FROM _wrss_dedup_plan x2 JOIN article_previews p2 ON p2.article_id=x2.item_id
      WHERE x2.survivor_id=x.survivor_id ORDER BY (p2.summary IS NOT NULL)+(p2.image_url IS NOT NULL) DESC,length(COALESCE(p2.summary,'')) DESC,x2.item_id DESC LIMIT 1) source_id
     FROM _wrss_dedup_plan x WHERE ${changed('x')}) g JOIN article_previews p ON p.article_id=g.source_id`},
  {sql:`CREATE TEMP TABLE _wrss_original_preview_copy AS SELECT g.survivor_id,p.summary,p.image_url FROM
    (SELECT DISTINCT x.survivor_id,(SELECT x2.item_id FROM _wrss_dedup_plan x2 JOIN article_original_previews p2 ON p2.article_id=x2.item_id
      WHERE x2.survivor_id=x.survivor_id ORDER BY (p2.summary IS NOT NULL)+(p2.image_url IS NOT NULL) DESC,length(COALESCE(p2.summary,'')) DESC,x2.item_id DESC LIMIT 1) source_id
     FROM _wrss_dedup_plan x WHERE ${changed('x')}) g JOIN article_original_previews p ON p.article_id=g.source_id`},
  {sql:`CREATE TEMP TABLE _wrss_original_meta_copy AS SELECT g.survivor_id,m.source_url,m.fetched_at FROM
    (SELECT DISTINCT x.survivor_id,(SELECT x2.item_id FROM _wrss_dedup_plan x2 JOIN article_original_meta m2 ON m2.article_id=x2.item_id
      WHERE x2.survivor_id=x.survivor_id ORDER BY m2.fetched_at DESC,x2.item_id DESC LIMIT 1) source_id
     FROM _wrss_dedup_plan x WHERE ${changed('x')}) g JOIN article_original_meta m ON m.article_id=g.source_id`},
  // Encoded/native body hashes are derived from the pre-merge body. Clear
  // them and let the normal exporter recompute them from the preserved body.
  {sql:`CREATE TEMP TABLE _wrss_offline_copy AS SELECT p.survivor_id,max(o.media_type) media_type,o.origin_url,max(o.relative_path) relative_path,min(o.created_at) created_at
   FROM _wrss_dedup_plan p JOIN offline_media o ON o.item_id=p.item_id WHERE ${changed('p')} GROUP BY p.survivor_id,o.origin_url`},
  {sql:`CREATE TEMP TABLE _wrss_cleanup_copy AS SELECT p.survivor_id,max(d.content_marker) content_marker FROM _wrss_dedup_plan p
   JOIN article_deletion_cleanup d ON d.item_id=p.item_id WHERE ${changed('p')} GROUP BY p.survivor_id`},

  // Move tables that have no logical conflict before deleting duplicate rows.
  {sql:`UPDATE notes SET article_id=(SELECT survivor_id FROM _wrss_dedup_plan WHERE item_id=notes.article_id) WHERE article_id IN(SELECT item_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},
  {sql:`UPDATE sync_saved_states SET item_id=(SELECT survivor_id FROM _wrss_dedup_plan WHERE item_id=sync_saved_states.item_id) WHERE item_id IN(SELECT item_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},
  {sql:`UPDATE sync_article_ids SET item_id=NULL WHERE item_id IN(SELECT item_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},
  {sql:`DELETE FROM sync_article_aliases WHERE item_id IN(SELECT item_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},

  // Replace per-item tables from the temporary winners.
  ...['article_reading_state','article_saved_states','article_saved_entry_times','article_body_chunks','article_original_chunks','article_previews','article_original_previews','article_original_meta','article_sync_content','article_sync_encoding_cache','article_native_sync_hash','offline_media','article_deletion_cleanup'].map(table=>({sql:`DELETE FROM ${table} WHERE ${table==='offline_media'?'item_id':table==='article_sync_content'||table==='article_sync_encoding_cache'||table==='article_native_sync_hash'||table==='article_deletion_cleanup'?'item_id':'article_id'} IN(SELECT item_id FROM _wrss_dedup_plan WHERE ${CHANGED})`})),
  {sql:`INSERT INTO article_reading_state SELECT * FROM _wrss_reading_copy`},
  {sql:`INSERT INTO article_saved_states SELECT * FROM _wrss_saved_copy`},
  {sql:`INSERT INTO article_saved_entry_times SELECT * FROM _wrss_saved_time_copy`},
  {sql:`INSERT INTO article_body_chunks SELECT * FROM _wrss_body_copy`},
  {sql:`INSERT INTO article_original_chunks SELECT * FROM _wrss_original_body_copy`},
  {sql:`INSERT INTO article_previews SELECT * FROM _wrss_preview_copy`},
  {sql:`INSERT INTO article_original_previews SELECT * FROM _wrss_original_preview_copy`},
  {sql:`INSERT INTO article_original_meta SELECT * FROM _wrss_original_meta_copy`},
  {sql:`INSERT INTO offline_media(item_id,media_type,origin_url,relative_path,created_at) SELECT * FROM _wrss_offline_copy`},
  {sql:`INSERT INTO article_deletion_cleanup SELECT * FROM _wrss_cleanup_copy`},
  {sql:`UPDATE articles SET reading_progress=COALESCE((SELECT progress FROM article_reading_state WHERE article_id=articles.id),reading_progress),
    is_saved=COALESCE((SELECT saved FROM article_saved_states WHERE article_id=articles.id AND save_type='favorite'),is_saved)
   WHERE id IN(SELECT survivor_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},

  // Rebind one canonical sync identity. Other persisted state rows still point
  // to the survivor, so no favorite/watch-later clocks are discarded.
  {sql:`INSERT INTO sync_article_ids(article_id,item_id,url) SELECT i.article_id,i.survivor_id,COALESCE(a.link,p.target_key)
   FROM _wrss_identity_choice i JOIN articles a ON a.id=i.survivor_id JOIN _wrss_dedup_plan p ON p.item_id=i.survivor_id
   WHERE 1 ON CONFLICT(article_id) DO UPDATE SET item_id=excluded.item_id,url=CASE WHEN (SELECT link FROM articles WHERE id=excluded.item_id) IS NULL THEN sync_article_ids.url ELSE excluded.url END`},
  {sql:`INSERT INTO sync_article_aliases(item_id,article_id) SELECT survivor_id,article_id FROM _wrss_identity_choice`},

  {sql:`DELETE FROM articles WHERE id IN(SELECT item_id FROM _wrss_dedup_plan WHERE item_id<>survivor_id)`},
  // Vacate old keys before assigning final keys (a raw GUID can itself start
  // with "guid:"). NUL cannot occur in XML feed text, so this namespace is private.
  {sql:`UPDATE articles SET dedup_key=char(0)||'wrss-dedup:'||id WHERE id IN(SELECT survivor_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},
  {sql:`UPDATE articles SET dedup_key=(SELECT target_key FROM _wrss_dedup_plan WHERE survivor_id=articles.id ORDER BY CASE WHEN old_key=target_key THEN 0 ELSE 1 END,item_id LIMIT 1)
   WHERE id IN(SELECT survivor_id FROM _wrss_dedup_plan WHERE ${CHANGED})`},
  {sql:`INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at)
   SELECT 'article',i.article_id,?,COALESCE((SELECT device_id FROM sync_local_identity WHERE id=1),(SELECT source_device_id FROM sync_saved_states WHERE article_id=i.article_id ORDER BY changed_at DESC LIMIT 1),'dedup-migration'),'dedupMigration',?
   FROM _wrss_identity_choice i`,params:[now,now]},

  {sql:`CREATE TRIGGER sync_article_alias_immutable BEFORE UPDATE OF article_id ON sync_article_aliases WHEN OLD.article_id!=NEW.article_id BEGIN SELECT RAISE(ABORT,'Article alias already bound to another identity'); END`},
  {sql:`CREATE TRIGGER sync_article_binding_immutable BEFORE UPDATE OF item_id ON sync_article_ids WHEN OLD.item_id IS NOT NULL AND NEW.item_id IS NOT NULL AND OLD.item_id!=NEW.item_id AND NOT (
    EXISTS(SELECT 1 FROM sync_article_aliases WHERE item_id=OLD.item_id AND article_id=OLD.article_id) AND
    EXISTS(SELECT 1 FROM sync_article_aliases al JOIN articles a ON a.id=al.item_id WHERE al.item_id=NEW.item_id AND al.article_id=NEW.article_id AND a.dedup_key=NEW.article_id AND a.link IS NEW.url)
   ) BEGIN SELECT RAISE(ABORT,'Article id already bound to another item'); END`},
  {sql:`CREATE TRIGGER sync_article_insert_binding_immutable BEFORE INSERT ON sync_article_ids WHEN NEW.item_id IS NOT NULL AND EXISTS(SELECT 1 FROM sync_article_ids WHERE article_id=NEW.article_id AND item_id IS NOT NULL AND item_id!=NEW.item_id) BEGIN SELECT RAISE(ABORT,'Article id already bound to another item'); END`},
  ...['_wrss_cleanup_copy','_wrss_offline_copy','_wrss_original_meta_copy','_wrss_original_preview_copy','_wrss_preview_copy','_wrss_original_body_copy','_wrss_body_copy','_wrss_saved_time_copy','_wrss_saved_copy','_wrss_saved_winners','_wrss_reading_copy','_wrss_identity_choice','_wrss_identity_candidates','_wrss_dedup_plan'].map(table=>({sql:`DROP TABLE ${table}`})),
 ];
}
