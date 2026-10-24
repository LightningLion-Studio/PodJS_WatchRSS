// Jobs survive article deletion so cleanup can resume after process death.
const saved=(id:string)=>`EXISTS(SELECT 1 FROM article_saved_states WHERE article_id=${id} AND saved=1)`;
const enqueue=(id:string)=>`INSERT INTO offline_media_jobs(item_id,generation,desired,attempts,next_at,last_error)
 SELECT ${id},1,CASE WHEN ${saved(id)} THEN 'download' ELSE 'cleanup' END,0,0,NULL
 WHERE NOT ${saved(id)} OR (SELECT suppress_download FROM offline_media_policy WHERE id=1)=0
 ON CONFLICT(item_id) DO UPDATE SET generation=CASE WHEN offline_media_jobs.desired=excluded.desired THEN generation ELSE generation+1 END,desired=excluded.desired,attempts=0,next_at=0,last_error=NULL;`;
export const OFFLINE_QUEUE_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS offline_media_jobs(item_id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,desired TEXT NOT NULL CHECK(desired IN ('download','cleanup')),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT)`,
 `CREATE TABLE IF NOT EXISTS offline_media_policy(id INTEGER PRIMARY KEY CHECK(id=1),suppress_download INTEGER NOT NULL DEFAULT 0)`,
 `INSERT OR IGNORE INTO offline_media_policy(id,suppress_download) VALUES(1,0)`,
 ...['INSERT','UPDATE','DELETE'].map(op=>`CREATE TRIGGER IF NOT EXISTS offline_saved_${op.toLowerCase()} AFTER ${op==='UPDATE'?'UPDATE OF saved':op} ON article_saved_states ${op==='UPDATE'?`WHEN OLD.saved IS NOT NEW.saved AND (NEW.saved=1 OR NOT ${saved('NEW.article_id')})`:op==='INSERT'?'WHEN NEW.saved=1':`WHEN OLD.saved=1 AND NOT ${saved('OLD.article_id')}`} BEGIN ${enqueue((op==='DELETE'?'OLD':'NEW')+'.article_id')} END`),
 `CREATE TRIGGER IF NOT EXISTS offline_article_delete BEFORE DELETE ON articles WHEN EXISTS(SELECT 1 FROM offline_media WHERE item_id=OLD.id) OR EXISTS(SELECT 1 FROM offline_media_jobs WHERE item_id=OLD.id) BEGIN INSERT INTO offline_media_jobs(item_id,generation,desired,attempts,next_at,last_error) VALUES(OLD.id,1,'cleanup',0,0,NULL) ON CONFLICT(item_id) DO UPDATE SET generation=generation+1,desired='cleanup',attempts=0,next_at=0,last_error=NULL; END`,
];
