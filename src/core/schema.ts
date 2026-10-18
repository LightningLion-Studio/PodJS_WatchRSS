import {BUILTIN_CHANNELS} from './builtin-channels.ts';
import {dedupKeyMigration,type SchemaStatement} from './dedup-migration.ts';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS article_deletion_cleanup (item_id INTEGER PRIMARY KEY,content_marker TEXT)`,
  `CREATE TABLE IF NOT EXISTS sync_library_revision (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO sync_library_revision(id,revision) VALUES(1,0)`,
  `CREATE TABLE IF NOT EXISTS sync_article_deletions (article_id TEXT PRIMARY KEY,url TEXT NOT NULL,changed_at INTEGER NOT NULL,source_device_id TEXT NOT NULL,source_order TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_snapshot_fingerprints (kind TEXT NOT NULL,entity_id TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(kind,entity_id))`,
  `CREATE TABLE IF NOT EXISTS sync_source_states (url TEXT PRIMARY KEY,source_device_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,site_url TEXT,image_url TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,sort_order INTEGER NOT NULL,is_pinned INTEGER NOT NULL,deleted INTEGER NOT NULL,deleted_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_peer_state (peer_device_id TEXT PRIMARY KEY,last_local_seq_acked INTEGER NOT NULL DEFAULT 0,last_remote_seq_applied INTEGER NOT NULL DEFAULT 0,last_full_sync_at INTEGER NOT NULL DEFAULT 0,last_protocol_version INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sync_change_log (seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,entity_id TEXT NOT NULL,changed_at INTEGER NOT NULL,origin_device_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sync_change_log_entity ON sync_change_log(kind,entity_id)`,
  `CREATE TABLE IF NOT EXISTS article_reading_state (article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, progress REAL NOT NULL, changed_at INTEGER NOT NULL, position_bytes INTEGER NOT NULL, position_hash TEXT NOT NULL, state_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS article_sync_content (item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, content_html TEXT, content_text TEXT NOT NULL, body_hash TEXT NOT NULL, body_bytes INTEGER NOT NULL, chunk_size INTEGER NOT NULL, chunk_hashes TEXT NOT NULL, content_bytes INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS article_sync_encoding_cache (item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, body_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS article_native_sync_hash (item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,body_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS offline_media (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, media_type TEXT NOT NULL CHECK(media_type IN ('IMAGE','VIDEO')), origin_url TEXT NOT NULL, relative_path TEXT, created_at INTEGER NOT NULL, UNIQUE(item_id,origin_url))`,
  `CREATE TABLE IF NOT EXISTS sync_local_identity (id INTEGER PRIMARY KEY CHECK(id=1), device_id TEXT NOT NULL, device_order TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_article_ids (article_id TEXT PRIMARY KEY, item_id INTEGER UNIQUE CHECK(item_id>0) REFERENCES articles(id) ON DELETE SET NULL, url TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_article_aliases (item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, article_id TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS sync_article_alias_immutable BEFORE UPDATE OF article_id ON sync_article_aliases WHEN OLD.article_id!=NEW.article_id BEGIN SELECT RAISE(ABORT,'Article alias already bound to another identity'); END`,
  `DROP TRIGGER IF EXISTS sync_article_binding_immutable`,
  `CREATE TRIGGER sync_article_binding_immutable BEFORE UPDATE OF item_id ON sync_article_ids WHEN OLD.item_id IS NOT NULL AND NEW.item_id IS NOT NULL AND OLD.item_id!=NEW.item_id AND NOT (
    EXISTS(SELECT 1 FROM sync_article_aliases WHERE item_id=OLD.item_id AND article_id=OLD.article_id) AND
    EXISTS(SELECT 1 FROM sync_article_aliases al JOIN articles a ON a.id=al.item_id WHERE al.item_id=NEW.item_id AND al.article_id=NEW.article_id AND a.dedup_key=NEW.article_id AND a.link IS NEW.url)
   ) BEGIN SELECT RAISE(ABORT,'Article id already bound to another item'); END`,
  `CREATE TRIGGER IF NOT EXISTS sync_article_insert_binding_immutable BEFORE INSERT ON sync_article_ids WHEN NEW.item_id IS NOT NULL AND EXISTS(SELECT 1 FROM sync_article_ids WHERE article_id=NEW.article_id AND item_id IS NOT NULL AND item_id!=NEW.item_id) BEGIN SELECT RAISE(ABORT,'Article id already bound to another item'); END`,
  `CREATE TABLE IF NOT EXISTS article_saved_entry_times (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,save_type TEXT NOT NULL CHECK(save_type IN ('favorite','watchLater')),created_at INTEGER NOT NULL,PRIMARY KEY(article_id,save_type))`,
  `CREATE TABLE IF NOT EXISTS sync_saved_states (article_id TEXT NOT NULL, save_type TEXT NOT NULL CHECK(save_type IN ('favorite','watchLater')), item_id INTEGER REFERENCES articles(id) ON DELETE SET NULL, url TEXT NOT NULL, saved INTEGER NOT NULL CHECK(saved IN (0,1)), changed_at INTEGER NOT NULL, sort_order INTEGER NOT NULL, source_device_id TEXT NOT NULL, source_order TEXT NOT NULL, PRIMARY KEY(article_id,save_type))`,
  `CREATE TABLE IF NOT EXISTS llm_token_usage (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, request_id TEXT NOT NULL, usage_json TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_article_deletions (id INTEGER PRIMARY KEY, channel_url TEXT NOT NULL, article_url TEXT NOT NULL, dedup_key TEXT NOT NULL, was_favorite INTEGER NOT NULL, was_watch_later INTEGER NOT NULL, changed_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS source_media_preferences (channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, continue_in_background INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS article_original_previews (article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, summary TEXT, image_url TEXT)`,
  `CREATE TABLE IF NOT EXISTS article_original_meta (article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, source_url TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS article_original_chunks (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(article_id,chunk_index))`,
  `CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT, image_url TEXT, last_fetched_at INTEGER, created_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT, content TEXT, link TEXT, guid TEXT, pub_date TEXT, image_url TEXT, audio_url TEXT, video_url TEXT, is_read INTEGER NOT NULL DEFAULT 0, is_saved INTEGER NOT NULL DEFAULT 0, reading_progress REAL NOT NULL DEFAULT 0, dedup_key TEXT NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(channel_id, dedup_key))`,
  `CREATE INDEX IF NOT EXISTS articles_channel_date ON articles(channel_id, fetched_at DESC)`,
  `CREATE INDEX IF NOT EXISTS articles_sync_order ON articles(fetched_at DESC,id DESC)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS source_preferences (channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, use_original_content INTEGER NOT NULL DEFAULT 0, read_preset TEXT NOT NULL DEFAULT 'default')`,
  `CREATE TABLE IF NOT EXISTS article_body_chunks (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(article_id, chunk_index))`,
  `CREATE TRIGGER IF NOT EXISTS article_sync_hash_content_update AFTER UPDATE OF content,description,link ON articles WHEN OLD.content IS NOT NEW.content OR OLD.description IS NOT NEW.description OR OLD.link IS NOT NEW.link BEGIN DELETE FROM article_native_sync_hash WHERE item_id=NEW.id;DELETE FROM article_sync_content WHERE item_id=NEW.id; END`,
  ...['article_body_chunks','article_original_chunks'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>
    `CREATE TRIGGER IF NOT EXISTS article_sync_hash_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN DELETE FROM article_native_sync_hash WHERE item_id=${operation==='DELETE'?'OLD':'NEW'}.article_id;DELETE FROM article_sync_content WHERE item_id=${operation==='DELETE'?'OLD':'NEW'}.article_id; END`)),
  `CREATE TABLE IF NOT EXISTS article_previews (article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, summary TEXT, image_url TEXT)`,
  `CREATE TABLE IF NOT EXISTS article_saved_states (article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE, save_type TEXT NOT NULL CHECK(save_type IN ('favorite','watchLater')), saved INTEGER NOT NULL, changed_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(article_id,save_type))`,
  `INSERT OR IGNORE INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) SELECT id,'favorite',1,fetched_at,-fetched_at FROM articles WHERE is_saved=1`,
  `INSERT OR IGNORE INTO sync_article_aliases(item_id,article_id) SELECT item_id,article_id FROM sync_article_ids WHERE item_id IS NOT NULL`,
  `INSERT OR IGNORE INTO article_saved_entry_times(article_id,save_type,created_at) SELECT article_id,save_type,changed_at FROM article_saved_states WHERE saved=1`,
  ...['articles','channels','article_body_chunks','article_original_chunks','article_previews','article_original_previews','article_original_meta','article_saved_states','article_saved_entry_times','sync_saved_states','sync_article_ids','sync_article_aliases','sync_local_identity','local_article_deletions','sync_source_states','sync_article_deletions','article_reading_state'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>
    `CREATE TRIGGER IF NOT EXISTS sync_revision_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN UPDATE sync_library_revision SET revision=revision+1 WHERE id=1; END`)),
];
// Per-item chunk revisions make warm sync caches safe when chunk text changes
// without touching the article row (including equal-length replacements).
const syncChunkRevisions = [
  `CREATE TABLE IF NOT EXISTS sync_body_revision (item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,revision INTEGER NOT NULL)`,
  ...['article_body_chunks','article_original_chunks'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>
    `CREATE TRIGGER IF NOT EXISTS sync_body_revision_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
      INSERT INTO sync_body_revision(item_id,revision) SELECT ${operation==='DELETE'?'OLD':'NEW'}.article_id,1 WHERE EXISTS(SELECT 1 FROM articles WHERE id=${operation==='DELETE'?'OLD':'NEW'}.article_id)
      ON CONFLICT(item_id) DO UPDATE SET revision=revision+1;
      ${operation==='UPDATE'?`INSERT INTO sync_body_revision(item_id,revision) SELECT OLD.article_id,1 WHERE OLD.article_id!=NEW.article_id AND EXISTS(SELECT 1 FROM articles WHERE id=OLD.article_id) ON CONFLICT(item_id) DO UPDATE SET revision=revision+1;`:''}
    END`)),
];
export const SCHEMA_VERSION=3;

function pragmaVersion(row:Record<string,unknown>|undefined):number{
  const value=row?.user_version??(row?Object.values(row)[0]:undefined),version=Number(value);
  if(!Number.isSafeInteger(version)||version<0)throw new Error('Invalid SQLite schema version');
  return version;
}

interface SchemaDatabase {
  query(sql:string,params?:readonly (string|number|null)[]):Promise<Record<string,unknown>[]>;
  transaction(statements:SchemaStatement[]):Promise<void>;
}

export async function initializeSchema(db: SchemaDatabase,options:{seedBuiltinChannels?:boolean;now?:()=>number}={}) {
  const current=pragmaVersion((await db.query('PRAGMA user_version'))[0]);
  if(current===SCHEMA_VERSION)return;
  if(current>SCHEMA_VERSION)throw new Error(`Database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  const now=(options.now??Date.now)(),statements:SchemaStatement[]=[];
  if(current<1){
    statements.push(...SCHEMA.map(sql=>({sql})));
    if(options.seedBuiltinChannels)for(const [index,builtin] of BUILTIN_CHANNELS.entries()){
      const timestamp=now-index;
      statements.push({sql:`INSERT OR IGNORE INTO channels(url,title,description,created_at,sort_order,is_pinned) VALUES(?,?,?,?,?,0)`,params:[builtin.url,builtin.title,builtin.description,timestamp,timestamp]});
      statements.push({sql:`INSERT OR IGNORE INTO source_preferences(channel_id,use_original_content) SELECT id,1 FROM channels WHERE url=?`,params:[builtin.url]});
    }
    statements.push({sql:'PRAGMA user_version=1'});
  }
  if(current<2){
    statements.push(...dedupKeyMigration(now));
    statements.push({sql:`PRAGMA user_version=${SCHEMA_VERSION}`});
  }
  if(current<3)statements.push(...syncChunkRevisions.map(sql=>({sql})),{sql:`PRAGMA user_version=${SCHEMA_VERSION}`});
  await db.transaction(statements);
}
