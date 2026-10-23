/** Durable R46 derived caches. No credentials or article bodies are stored here. */
export const BOOK_READING_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS sync_book_registration_cache(cache_key TEXT PRIMARY KEY,revision INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS sync_book_display_dirty(book_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1)`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_display_article_dirty AFTER UPDATE OF title ON articles WHEN OLD.title IS NOT NEW.title BEGIN
 INSERT INTO sync_book_display_dirty(book_id) SELECT DISTINCT book_id FROM sync_book_aliases WHERE item_id=NEW.id ON CONFLICT(book_id) DO UPDATE SET revision=revision+1;END`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_display_channel_dirty AFTER UPDATE OF title ON channels WHEN OLD.title IS NOT NEW.title BEGIN
 INSERT INTO sync_book_display_dirty(book_id) SELECT DISTINCT book_id FROM sync_book_aliases WHERE channel_url=NEW.url ON CONFLICT(book_id) DO UPDATE SET revision=revision+1;END`,
 `INSERT OR IGNORE INTO sync_book_display_dirty(book_id) SELECT b.book_id FROM sync_books b LEFT JOIN sync_book_display d ON d.book_id=b.book_id WHERE b.registration_complete=1 AND d.book_id IS NULL`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,root TEXT,count INTEGER NOT NULL DEFAULT 0,capture_seeded INTEGER NOT NULL DEFAULT 0)`,
 `INSERT OR IGNORE INTO sync_book_reading_meta(id,epoch) VALUES(1,lower(hex(randomblob(16))))`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_versions(book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(book_id,chapter_index))`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL)`,
 // Historical values, rather than the mutable current projection, freeze a window.
 // A separate table also upgrades an already-created R46 journal without ALTER.
 `CREATE TABLE IF NOT EXISTS sync_book_reading_history(seq INTEGER PRIMARY KEY,book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,state_json TEXT NOT NULL)`,
 `CREATE INDEX IF NOT EXISTS sync_book_reading_history_key ON sync_book_reading_history(book_id,chapter_index,seq)`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_reading_journal_history AFTER INSERT ON sync_book_reading_journal BEGIN
 INSERT INTO sync_book_reading_history SELECT NEW.seq,NEW.book_id,NEW.chapter_index,r.state_json FROM sync_book_reading r WHERE r.book_id=NEW.book_id AND r.chapter_index=NEW.chapter_index;END`,
 `CREATE TRIGGER IF NOT EXISTS sync_book_reading_journal_version AFTER INSERT ON sync_book_reading_journal BEGIN
 SELECT CASE WHEN NEW.seq>9007199254740991 THEN RAISE(ABORT,'reading sequence exhausted') END;
 INSERT INTO sync_book_reading_versions VALUES(NEW.book_id,NEW.chapter_index,NEW.seq) ON CONFLICT(book_id,chapter_index) DO UPDATE SET seq=excluded.seq;END`,
 `CREATE INDEX IF NOT EXISTS sync_book_reading_version_seq ON sync_book_reading_versions(seq)`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_hashes(book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(book_id,chapter_index))`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_book_hashes(book_id TEXT PRIMARY KEY,root TEXT NOT NULL,count INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_hash_dirty(book_id TEXT PRIMARY KEY)`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_dirty(item_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1)`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_projection(id INTEGER PRIMARY KEY CHECK(id=1),active INTEGER NOT NULL)`,
 `INSERT OR IGNORE INTO sync_book_reading_projection VALUES(1,0)`,
 `CREATE TABLE IF NOT EXISTS sync_book_reading_peers(peer TEXT PRIMARY KEY,local_epoch TEXT NOT NULL,local_seq INTEGER NOT NULL,remote_epoch TEXT NOT NULL,remote_seq INTEGER NOT NULL,root TEXT NOT NULL)`,
 ...(['INSERT','UPDATE','DELETE'] as const).map(op=>{const ref=op==='DELETE'?'OLD':'NEW';return `CREATE TRIGGER IF NOT EXISTS sync_book_reading_delta_${op.toLowerCase()} AFTER ${op} ON sync_book_reading ${op==='UPDATE'?'WHEN OLD.state_json IS NOT NEW.state_json':''} BEGIN
 ${op==='DELETE'?`DELETE FROM sync_book_reading_versions WHERE book_id=OLD.book_id AND chapter_index=OLD.chapter_index;`:`INSERT INTO sync_book_reading_journal(book_id,chapter_index) VALUES(NEW.book_id,NEW.chapter_index);`}
 DELETE FROM sync_book_reading_hashes WHERE book_id=${ref}.book_id AND chapter_index=${ref}.chapter_index;
 INSERT INTO sync_book_reading_hash_dirty VALUES(${ref}.book_id) ON CONFLICT(book_id) DO NOTHING;
 UPDATE sync_book_reading_meta SET root=NULL WHERE id=1;END`; }),
 ...[
  {table:'articles',key:'id',columns:['is_read','reading_progress']},
  {table:'article_reading_state',key:'article_id',columns:['progress','changed_at','position_bytes','position_hash']},
  {table:'article_saved_states',key:'article_id',columns:['saved','changed_at','sort_order']},
  {table:'sync_saved_states',key:'item_id',columns:['item_id','saved','changed_at','sort_order','source_device_id']},
 ].flatMap(({table,key,columns})=>(table==='articles'?['UPDATE']:['INSERT','UPDATE','DELETE']).map(op=>{
  const refs=op==='UPDATE'?['OLD','NEW']:[op==='DELETE'?'OLD':'NEW'];
  return `CREATE TRIGGER IF NOT EXISTS sync_book_reading_dirty_${table}_${op.toLowerCase()} AFTER ${op} ${op==='UPDATE'?'OF '+columns.join(','):''} ON ${table}
 WHEN (SELECT active FROM sync_book_reading_projection WHERE id=1)=0 ${op==='UPDATE'?'AND ('+columns.map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR ')+')':''} BEGIN
 ${refs.map(ref=>`INSERT INTO sync_book_reading_dirty(item_id) SELECT ${ref}.${key} WHERE ${ref}.${key} IS NOT NULL AND EXISTS(SELECT 1 FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE m.item_id=${ref}.${key} AND b.registration_complete=1) ON CONFLICT(item_id) DO UPDATE SET revision=revision+1;`).join('\n')}END`;
 })),
 ...['INSERT','UPDATE'].map(op=>`CREATE TRIGGER IF NOT EXISTS sync_book_reading_alias_dirty_${op.toLowerCase()} AFTER ${op} ${op==='UPDATE'?'OF item_id':''} ON sync_book_aliases ${op==='UPDATE'?'WHEN OLD.item_id IS NOT NEW.item_id':''} BEGIN
 INSERT INTO sync_book_reading_dirty(item_id) SELECT NEW.item_id WHERE NEW.item_id IS NOT NULL AND EXISTS(SELECT 1 FROM sync_books b WHERE b.book_id=NEW.book_id AND b.registration_complete=1) ON CONFLICT(item_id) DO UPDATE SET revision=revision+1;END`),
 `CREATE TRIGGER IF NOT EXISTS sync_book_reading_registration_dirty AFTER UPDATE OF registration_complete ON sync_books WHEN OLD.registration_complete=0 AND NEW.registration_complete=1 BEGIN
 INSERT INTO sync_book_reading_dirty(item_id) SELECT DISTINCT item_id FROM sync_book_aliases WHERE book_id=NEW.book_id AND item_id IS NOT NULL ON CONFLICT(item_id) DO UPDATE SET revision=revision+1;END`,
 // Once per schema migration; all later startups use the persistent dirty set.
 `INSERT INTO sync_book_reading_journal(book_id,chapter_index) SELECT r.book_id,r.chapter_index FROM sync_book_reading r WHERE (SELECT capture_seeded FROM sync_book_reading_meta WHERE id=1)=0 AND NOT EXISTS(SELECT 1 FROM sync_book_reading_versions v WHERE v.book_id=r.book_id AND v.chapter_index=r.chapter_index)`,
 `INSERT OR IGNORE INTO sync_book_reading_hash_dirty SELECT DISTINCT book_id FROM sync_book_reading WHERE (SELECT capture_seeded FROM sync_book_reading_meta WHERE id=1)=0`,
 `INSERT OR IGNORE INTO sync_book_reading_dirty(item_id) SELECT DISTINCT m.item_id FROM sync_book_aliases m JOIN sync_books b ON b.book_id=m.book_id WHERE b.registration_complete=1 AND m.item_id IS NOT NULL AND (SELECT capture_seeded FROM sync_book_reading_meta WHERE id=1)=0`,
 `UPDATE sync_book_reading_meta SET capture_seeded=1 WHERE id=1 AND capture_seeded=0`,
 // Old R46 windows are connection-local and cannot survive schema startup. Only
 // current versions need seeding; never label today's state with an older seq.
 `INSERT INTO sync_book_reading_history SELECT v.seq,v.book_id,v.chapter_index,r.state_json FROM sync_book_reading_versions v JOIN sync_book_reading r ON r.book_id=v.book_id AND r.chapter_index=v.chapter_index WHERE NOT EXISTS(SELECT 1 FROM sync_book_reading_history h WHERE h.seq=v.seq)`,
];
