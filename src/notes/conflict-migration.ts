import type {SqlDatabase, SqlParams} from '../core/types';
import {sha256Hex} from '@podjs/framework/crypto';
import {utf8Encode} from '../cloud/types';

/** Normalize existing local rows before UI/export, without a remote download. */
export async function normalizeStoredNoteConflicts(db:Pick<SqlDatabase,'query'|'transaction'>){
 if(!(await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='note_merge_conflicts'")).length)return;
 const rows=await db.query('SELECT * FROM note_merge_conflicts');
 const columns=['note_id','base_markdown','local_markdown','remote_markdown','remote_device_id'];
 const groups=new Map<string,typeof rows>();
 for(const row of rows){const k=JSON.stringify(columns.map(c=>row[c]));groups.set(k,[...(groups.get(k)||[]),row]);}
 const statements:{sql:string;params?:SqlParams}[]=[];
 for(const copies of groups.values()){
  if(copies.length<2)continue;
  const values=columns.map(c=>String(copies[0][c])),old=sha256Hex(utf8Encode(values.join('\0')));
  const ids=copies.map(r=>String(r.conflict_id)),id=ids.includes(old)?old:ids.sort()[0],where=columns.map(c=>c+'=?').join(' AND ');
  // Aggregate the current markers in the final transaction before deleting aliases.
  statements.push({sql:`INSERT OR REPLACE INTO syncv2_note_resolutions(note_id,conflict_id,resolved_at) SELECT ?,?,COALESCE(MAX(resolved_at),0) FROM syncv2_note_resolutions WHERE note_id=? AND conflict_id IN (SELECT conflict_id FROM note_merge_conflicts WHERE ${where})`,params:[values[0],id,values[0],...values]});
  statements.push({sql:`UPDATE note_merge_conflicts SET created_at=(SELECT MIN(created_at) FROM note_merge_conflicts WHERE ${where}) WHERE conflict_id=?`,params:[...values,id]});
  statements.push({sql:`DELETE FROM syncv2_note_resolutions WHERE note_id=? AND conflict_id IN (SELECT conflict_id FROM note_merge_conflicts WHERE ${where} AND conflict_id!=?)`,params:[values[0],...values,id]});
  statements.push({sql:`DELETE FROM note_merge_conflicts WHERE ${where} AND conflict_id!=?`,params:[...values,id]});
 }
 if(statements.length)await db.transaction([{sql:'CREATE TABLE IF NOT EXISTS syncv2_note_resolutions(note_id TEXT NOT NULL,conflict_id TEXT NOT NULL,resolved_at INTEGER NOT NULL,PRIMARY KEY(note_id,conflict_id))'},...statements]);
}
