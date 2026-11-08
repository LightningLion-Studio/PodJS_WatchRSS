/** memo_notes writes shared by account apply and the R2 quarantine copy. */
import type {ProjectionSql,Statement} from '@podjs/framework/sql-projection';
export const upsert=(table:string,columns:string[],values:unknown[],key:string[]):Statement=>({sql:`INSERT INTO ${table}(${columns}) VALUES(${columns.map(()=>'?')}) ON CONFLICT(${key}) DO UPDATE SET ${columns.filter(c=>!key.includes(c)).map(c=>c+'=excluded.'+c)}`,params:values});
/** N1: a long note's text crosses the bridge as bounded appends inside the
 * same prepared program, never as one statement holding the whole note. */
const NOTE_TEXT_PIECE=64*1024;
function pieces(text:string){const out:string[]=[];for(let at=0;at<text.length;){let end=Math.min(text.length,at+NOTE_TEXT_PIECE);const c=text.charCodeAt(end-1);if(end<text.length&&c>=0xd800&&c<=0xdbff)end--;out.push(text.slice(at,end));at=end;}return out;}
export function noteUpsert(v:any):Statement[]{
 const texts:[string,string][]=[['markdown',v.markdown],['plain_text',v.plainText],['base_markdown',v.baseMarkdown]],long=texts.reduce((n,[,t])=>n+t.length,0)>NOTE_TEXT_PIECE;
 const head=upsert('memo_notes','note_id folder_id title markdown plain_text content_hash base_content_hash base_markdown pinned created_at updated_at modified_by deleted deleted_at'.split(' '),[v.noteId,v.folderId,v.title,long?'':v.markdown,long?'':v.plainText,v.contentHash,v.baseContentHash,long?'':v.baseMarkdown,+v.pinned,v.createdAt,v.updatedAt,v.modifiedBy,+v.deleted,v.deletedAt],['note_id']);
 if(!long)return [head];const out=[head];for(const [column,text] of texts)for(const part of pieces(text))out.push({sql:`UPDATE memo_notes SET ${column}=${column}||? WHERE note_id=?`,params:[part,v.noteId]});return out;
}
/** R2: notes this device cannot open are read-only in the business layer. The
 * pull replaces the set for its scope in the same state CAS; edit entries check
 * it only while that scope's projection is enabled. */
export const UNOPENABLE_NOTES_SCHEMA='CREATE TABLE IF NOT EXISTS syncv2_unopenable_notes(scope TEXT NOT NULL,note_id TEXT NOT NULL,PRIMARY KEY(scope,note_id))';
export const unopenableNotesStatements=(scopeKey:string,noteIds:readonly string[]):Statement[]=>[{sql:'DELETE FROM syncv2_unopenable_notes WHERE scope=?',params:[scopeKey]},...noteIds.map(id=>({sql:'INSERT INTO syncv2_unopenable_notes VALUES(?,?)',params:[scopeKey,id]}))];
export async function noteUnopenable(db:Pick<ProjectionSql,'query'>,noteId:string){
 if(!(await db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='syncv2_unopenable_notes'")).length)return false;
 return (await db.query('SELECT 1 FROM syncv2_unopenable_notes u JOIN syncv2_control c ON c.id=1 AND c.scope=u.scope AND c.enabled=1 WHERE u.note_id=? LIMIT 1',[noteId])).length>0;
}
