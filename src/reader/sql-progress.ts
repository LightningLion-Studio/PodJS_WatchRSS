import type {SqlDatabase} from "../core/types.ts";
import {ReadingProgressStore,normalizeReadingProgress} from "./progress.ts";
import type {ReadingProgress} from "./types.ts";

/** SQL is authoritative once migrated. The old KV entry remains available for
 * rollback; INSERT OR IGNORE prevents a delayed migration overwriting sync. */
export class SqlReadingProgressStore {
 private readonly pending=new Map<number,Promise<void>>();
 constructor(private readonly db:SqlDatabase,private readonly legacy:ReadingProgressStore){}
 async migrate(articleId:number):Promise<void>{
  if((await this.db.query("SELECT article_id FROM article_reading_state WHERE article_id=?",[articleId])).length)return;
  const old=await this.legacy.load(articleId);
  await this.db.transaction([
   {sql:`INSERT OR IGNORE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json)
    SELECT id,CASE WHEN ?>0 THEN ? ELSE reading_progress END,?,0,'',? FROM articles WHERE id=?`,params:[old.updatedAt,Math.fround(old.progress),old.updatedAt,old.updatedAt>0?JSON.stringify(old):null,articleId]},
   {sql:"UPDATE articles SET reading_progress=(SELECT progress FROM article_reading_state WHERE article_id=?) WHERE id=?",params:[articleId,articleId]},
  ]);
 }
 /** Plan legacy migration for inclusion in a caller-owned guarded transaction. */
 async migrationStatements(articleIds:readonly number[]):Promise<{sql:string;params:(string|number|null)[]}[]>{
  const result:{sql:string;params:(string|number|null)[]}[]=[];
  const unique=[...new Set(articleIds)];
  for(let offset=0;offset<unique.length;offset+=200){
   const page=unique.slice(offset,offset+200),marks=page.map(()=>'?').join(',');
   const missing=(await this.db.query(`SELECT a.id FROM articles a LEFT JOIN article_reading_state r ON r.article_id=a.id WHERE a.id IN (${marks}) AND r.article_id IS NULL`,page)).map(row=>Number(row.id));
   if(!missing.length)continue;
   const statements:{sql:string;params:(string|number|null)[]}[]=[];
   for(const id of missing){const old=await this.legacy.load(id);if(old.updatedAt<=0)continue;
    statements.push({sql:`INSERT OR IGNORE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json)
     SELECT id,?,?,0,'',? FROM articles WHERE id=?`,params:[Math.fround(old.progress),old.updatedAt,JSON.stringify(old),id]});
   }
   const missingMarks=missing.map(()=>'?').join(',');
   statements.push({sql:`INSERT OR IGNORE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json)
    SELECT id,reading_progress,0,0,'',NULL FROM articles WHERE id IN (${missingMarks})`,params:missing});
   statements.push({sql:`UPDATE articles SET reading_progress=(SELECT progress FROM article_reading_state WHERE article_id=articles.id) WHERE id IN (${missingMarks})`,params:missing});
   result.push(...statements);
  }
  return result;
 }
 async migrateMany(articleIds:readonly number[]):Promise<void>{for(let at=0;at<articleIds.length;at+=200){const statements=await this.migrationStatements(articleIds.slice(at,at+200));if(statements.length)await this.db.transaction(statements);}}

 async load(articleId:number):Promise<ReadingProgress>{
  await this.pending.get(articleId)?.catch(()=>{});
  await this.migrate(articleId);
  const row=(await this.db.query("SELECT * FROM article_reading_state WHERE article_id=?",[articleId]))[0];
  if(!row)return normalizeReadingProgress({});
  if(row.state_json){try{return normalizeReadingProgress({...JSON.parse(String(row.state_json)),progress:Number(row.progress),updatedAt:Number(row.changed_at)});}catch{/* retain valid SQL progress */}}
  return normalizeReadingProgress({progress:Number(row.progress),updatedAt:Number(row.changed_at)});
 }
 save(articleId:number,offset:number,progress:number,textAnchor?:ReadingProgress["textAnchor"],importedAnchor?:ReadingProgress["importedAnchor"]):Promise<void>{
  return this.saveSnapshot(articleId,normalizeReadingProgress({offset,progress,updatedAt:Date.now(),textAnchor,importedAnchor}));
 }
 saveSnapshot(articleId:number,snapshot:ReadingProgress):Promise<void>{
  const value=normalizeReadingProgress(snapshot);
  // Preserve local call order without using the remote wall clock as a veto.
  const task=(this.pending.get(articleId)??Promise.resolve()).catch(()=>{}).then(()=>this.persist(articleId,value));
  this.pending.set(articleId,task);
  return task.finally(()=>{if(this.pending.get(articleId)===task)this.pending.delete(articleId);});
 }
 private async persist(articleId:number,value:ReadingProgress):Promise<void>{
  await this.migrate(articleId);
  const fraction=Math.fround(value.progress);
  await this.db.transaction([
   {sql:`INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json)
    SELECT a.id,?,?,CAST(COALESCE(c.content_bytes,length(CAST(COALESCE(a.content,'') AS BLOB)))*?+0.5 AS INTEGER),COALESCE(c.body_hash,''),?
    FROM articles a LEFT JOIN article_sync_content c ON c.item_id=a.id WHERE a.id=?
    ON CONFLICT(article_id) DO UPDATE SET progress=CASE WHEN abs(article_reading_state.progress-excluded.progress)>=0.0010000000474974513 THEN excluded.progress ELSE article_reading_state.progress END,
     changed_at=CASE WHEN abs(article_reading_state.progress-excluded.progress)>=0.0010000000474974513 THEN excluded.changed_at ELSE article_reading_state.changed_at END,
     position_bytes=CASE WHEN abs(article_reading_state.progress-excluded.progress)>=0.0010000000474974513 THEN excluded.position_bytes ELSE article_reading_state.position_bytes END,
     position_hash=CASE WHEN abs(article_reading_state.progress-excluded.progress)>=0.0010000000474974513 THEN excluded.position_hash ELSE article_reading_state.position_hash END,
     state_json=excluded.state_json`,params:[fraction,value.updatedAt,fraction,JSON.stringify(value),articleId]},
   {sql:"UPDATE articles SET reading_progress=(SELECT progress FROM article_reading_state WHERE article_id=?) WHERE id=?",params:[articleId,articleId]},
  ]);
 }
}
