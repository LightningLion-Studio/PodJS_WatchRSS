import {BOOK_READING_SCHEMA} from './reading-schema';
/** R44 identity and original packages outlive physical chapter rows. */
export const BOOK_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS sync_book_display(book_id TEXT PRIMARY KEY,projection TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS sync_books(book_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,chapter_count INTEGER NOT NULL,state_json TEXT NOT NULL,package_path TEXT,package_sha256 TEXT,package_bytes INTEGER,registration_complete INTEGER NOT NULL DEFAULT 0)`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_identity_immutable BEFORE UPDATE OF fingerprint,chapter_count ON sync_books WHEN OLD.fingerprint!=NEW.fingerprint OR OLD.chapter_count!=NEW.chapter_count BEGIN SELECT RAISE(ABORT,'Book identity is immutable');END`,
 `CREATE TABLE IF NOT EXISTS sync_book_chapters(book_id TEXT NOT NULL REFERENCES sync_books(book_id),chapter_index INTEGER NOT NULL,article_id TEXT NOT NULL,item_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,url TEXT NOT NULL,chapter_hash TEXT NOT NULL,PRIMARY KEY(book_id,chapter_index))`,
 `CREATE TABLE IF NOT EXISTS sync_book_aliases(book_id TEXT NOT NULL REFERENCES sync_books(book_id),chapter_index INTEGER NOT NULL,article_id TEXT NOT NULL,item_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,url TEXT NOT NULL,channel_url TEXT NOT NULL,wire_identity INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(book_id,chapter_index,article_id))`,
 `CREATE INDEX IF NOT EXISTS sync_book_alias_item ON sync_book_aliases(item_id)`,
 `CREATE INDEX IF NOT EXISTS sync_book_alias_article ON sync_book_aliases(article_id)`,
 `CREATE INDEX IF NOT EXISTS sync_book_alias_url ON sync_book_aliases(url)`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading(book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,state_json TEXT NOT NULL,is_read INTEGER NOT NULL,progress REAL NOT NULL,clock INTEGER NOT NULL,position INTEGER NOT NULL,hash TEXT NOT NULL,source TEXT NOT NULL,favorite_saved INTEGER,favorite_clock INTEGER,favorite_order INTEGER,favorite_source TEXT,favorite_source_order TEXT,watchLater_saved INTEGER,watchLater_clock INTEGER,watchLater_order INTEGER,watchLater_source TEXT,watchLater_source_order TEXT,PRIMARY KEY(book_id,chapter_index))`,
 `CREATE TABLE IF NOT EXISTS sync_book_events(book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,changed_at INTEGER NOT NULL,PRIMARY KEY(book_id,chapter_index))`,
 `CREATE TABLE IF NOT EXISTS sync_book_delete_members(book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,PRIMARY KEY(book_id,chapter_index))`,
 `CREATE TABLE IF NOT EXISTS sync_book_context(id INTEGER PRIMARY KEY CHECK(id=1),remote INTEGER NOT NULL)`,
 `INSERT OR IGNORE INTO sync_book_context VALUES(1,0)`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_local_chapter_delete BEFORE DELETE ON articles WHEN (SELECT remote FROM sync_book_context WHERE id=1)=0 BEGIN
 INSERT INTO sync_book_events(book_id,chapter_index,changed_at) SELECT book_id,chapter_index,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM sync_book_aliases WHERE item_id=OLD.id
 ON CONFLICT(book_id,chapter_index) DO UPDATE SET changed_at=max(changed_at,excluded.changed_at);END`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_local_whole_delete BEFORE DELETE ON channels WHEN (SELECT remote FROM sync_book_context WHERE id=1)=0 BEGIN
 INSERT INTO sync_book_events(book_id,chapter_index,changed_at) SELECT DISTINCT m.book_id,0,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM sync_book_aliases m JOIN articles a ON a.id=m.item_id WHERE a.channel_id=OLD.id
 ON CONFLICT(book_id,chapter_index) DO UPDATE SET changed_at=max(changed_at,excluded.changed_at);END`,
 `CREATE TABLE IF NOT EXISTS sync_book_stage(book_id TEXT NOT NULL,package_sha256 TEXT NOT NULL,chapter_index INTEGER NOT NULL,book_article_id TEXT NOT NULL,wire_id TEXT NOT NULL,url TEXT NOT NULL,channel_url TEXT NOT NULL,channel_title TEXT NOT NULL,title TEXT NOT NULL,content TEXT,html TEXT,text TEXT NOT NULL,deleted INTEGER NOT NULL,existing_item INTEGER,chapter_hash TEXT NOT NULL,PRIMARY KEY(book_id,package_sha256,chapter_index))`,
 ...['sync_books','sync_book_reading','sync_book_events'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>`CREATE TRIGGER IF NOT EXISTS sync_book_revision_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} ${operation==='UPDATE'&&table!=='sync_book_events'?'WHEN OLD.state_json IS NOT NEW.state_json':''} BEGIN UPDATE sync_library_revision SET revision=revision+1 WHERE id=1;END`)),
 `CREATE TABLE IF NOT EXISTS sync_book_parts(book_id TEXT NOT NULL,package_sha256 TEXT NOT NULL,fingerprint TEXT NOT NULL,byte_count INTEGER NOT NULL,chunk_count INTEGER NOT NULL,chunk_index INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(book_id,package_sha256,chunk_index))`,
 `CREATE INDEX IF NOT EXISTS sync_saved_states_item ON sync_saved_states(item_id)`,
 `CREATE INDEX IF NOT EXISTS articles_sync_order ON articles(fetched_at DESC,id DESC)`,
 ...BOOK_READING_SCHEMA,
];
