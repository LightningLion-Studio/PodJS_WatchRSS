import {phoneNotePlainText} from './phone-text';
import {trimNoteText} from './text';
import {mergeNoteMarkdown} from './merge';
import {noteConflictId} from './conflict-id';
import {sha256Hex} from '@podjs/framework/crypto';
import {memoPlainText,memoTitle} from './text.ts';
export {memoPlainText,memoTitle} from './text.ts';
import type { SqlDatabase, SqlParams } from "../core/types.ts";
import type { MemoFolder, MemoNote } from "./types.ts";
import { utf8Encode } from "../cloud/types.ts";
import { noteUnopenable } from "../sync-v2/note-rows.ts";

const MEMO_SCHEMA: { sql: string; params?: SqlParams }[] = [
  { sql: `CREATE TABLE IF NOT EXISTS memo_notes (note_id TEXT PRIMARY KEY, folder_id TEXT, title TEXT NOT NULL, markdown TEXT NOT NULL, plain_text TEXT NOT NULL, content_hash TEXT NOT NULL, base_content_hash TEXT NOT NULL, base_markdown TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, modified_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER NOT NULL DEFAULT 0)` },
  { sql: `CREATE INDEX IF NOT EXISTS memo_notes_folder_deleted_pinned_updated ON memo_notes(folder_id,deleted,pinned,updated_at)` },
  { sql: `CREATE INDEX IF NOT EXISTS memo_notes_content_hash ON memo_notes(content_hash)` },
  { sql: `CREATE TABLE IF NOT EXISTS memo_folders (folder_id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL, updated_at INTEGER NOT NULL, modified_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER NOT NULL DEFAULT 0)` },
  { sql: `CREATE INDEX IF NOT EXISTS memo_folders_deleted_sort ON memo_folders(deleted,sort_order)` },
];

export async function initializeMemoSchema(db: SqlDatabase): Promise<void> {
  await db.transaction(MEMO_SCHEMA);
}

function normalizeMarkdown(value: string): string { return value.replace(/\r\n?/g, "\n"); }

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  for (let i=0;i<bytes.length;i++) bytes[i] = Math.floor(Math.random()*256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map(v => v.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function defaultId(): string { return globalThis.crypto?.randomUUID?.() ?? fallbackUuid(); }
const bool = (v: unknown) => Boolean(Number(v));
function note(row: Record<string,unknown>): MemoNote { return { noteId:String(row.note_id),folderId:row.folder_id == null?null:String(row.folder_id),title:String(row.title),markdown:String(row.markdown),plainText:String(row.plain_text),contentHash:String(row.content_hash),baseContentHash:String(row.base_content_hash),baseMarkdown:String(row.base_markdown),pinned:bool(row.pinned),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),modifiedBy:String(row.modified_by),deleted:bool(row.deleted),deletedAt:Number(row.deleted_at) }; }
function folder(row: Record<string,unknown>): MemoFolder { return {folderId:String(row.folder_id),name:String(row.name),sortOrder:Number(row.sort_order),updatedAt:Number(row.updated_at),modifiedBy:String(row.modified_by),deleted:bool(row.deleted),deletedAt:Number(row.deleted_at)}; }
// Kept local so notes also work in the Android QuickJS host, where Web Crypto is optional.
const sha256=(value:string)=>sha256Hex(utf8Encode(value));

function nextTime(now:number,...notes:(MemoNote|null)[]):number {
 const prior=Math.max(0,...notes.filter(Boolean).flatMap(n=>[n!.updatedAt,n!.deletedAt]));
 if(prior>=Number.MAX_SAFE_INTEGER)throw Error('counter_exhausted');
 return Math.max(now,prior+1);
}
const NOTE_COLUMNS='note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at';
const noteValues=(n:MemoNote)=>[n.noteId,n.folderId,n.title,n.markdown,n.plainText,n.contentHash,n.baseContentHash,n.baseMarkdown,n.pinned?1:0,n.createdAt,n.updatedAt,n.modifiedBy,n.deleted?1:0,n.deletedAt];
export class MemoRepository {
  private cloudSchema?:Promise<void>;
  constructor(private readonly db: SqlDatabase, private readonly deviceId: string, private readonly idFactory: () => string = defaultId, private readonly clock: () => number = Date.now) {}
  async initialize(): Promise<void> { await initializeMemoSchema(this.db); }
  async list(): Promise<MemoNote[]> { return (await this.db.query(`SELECT * FROM memo_notes WHERE deleted=0 ORDER BY pinned DESC,updated_at DESC`)).map(note); }
  async allIncludingDeleted(): Promise<MemoNote[]> { return (await this.db.query(`SELECT * FROM memo_notes ORDER BY updated_at DESC`)).map(note); }
  /** BLE and cloud share the same conflict-preserving transaction. */
  async merge(incoming: readonly MemoNote[]): Promise<number> {
    let applied=0;
    for(const remote of incoming)applied+=await this.applyRemote(remote);
    return applied;
  }
  /** Cloud import follows Phone NoteRepository.applyRemote, including durable conflicts.
   * Each transaction checks the exact read basis; a concurrent editor/link mutation
   * aborts the import so its restore receipt cannot advance. */
  async applyRemote(remote:MemoNote):Promise<number> {
    await (this.cloudSchema??=this.db.transaction([
      {sql:'CREATE TABLE IF NOT EXISTS note_merge_conflicts(conflict_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,base_markdown TEXT NOT NULL,local_markdown TEXT NOT NULL,remote_markdown TEXT NOT NULL,remote_device_id TEXT NOT NULL,created_at INTEGER NOT NULL)'},
      {sql:'CREATE TABLE IF NOT EXISTS note_merge_guard(id INTEGER PRIMARY KEY CHECK(id=1))'},
      {sql:'CREATE TABLE IF NOT EXISTS note_cloud_receipts(remote_hash TEXT PRIMARY KEY,note_id TEXT NOT NULL)'},
    ]).catch(error=>{this.cloudSchema=undefined;throw error;}));
    const remoteHash=sha256(JSON.stringify(remote));
    if((await this.db.query('SELECT 1 FROM note_cloud_receipts WHERE remote_hash=?',[remoteHash])).length)return 0;
    const row=(await this.db.query('SELECT * FROM memo_notes WHERE note_id=?',[remote.noteId]))[0],local=row?note(row):null;
    const finish=async(statements:{sql:string;params?:SqlParams}[],changed:number)=>{
      if(local)statements.unshift({sql:'INSERT INTO note_merge_guard(id) SELECT CASE WHEN EXISTS(SELECT 1 FROM memo_notes WHERE '+NOTE_COLUMNS.split(',').map(c=>c+' IS ?').join(' AND ')+') THEN 1 ELSE 0 END',params:noteValues(local)});
      statements.push({sql:'INSERT INTO note_cloud_receipts VALUES(?,?)',params:[remoteHash,remote.noteId]});
      if(local)statements.push({sql:'DELETE FROM note_merge_guard WHERE id=1'});
      await this.db.transaction(statements);return changed;
    };
    let value=remote,conflict=false,cycle=false;
    if(local){
      if(JSON.stringify(local)===JSON.stringify(remote))return finish([],0);
      const keys=(n:MemoNote):Array<number|string|boolean>=>[Math.max(n.updatedAt,n.deletedAt),n.modifiedBy,n.deleted,n.title,n.folderId!==null,n.folderId??'',n.pinned,n.createdAt,n.baseContentHash,n.baseMarkdown];
      const a=keys(remote),b=keys(local);let order=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){order=a[i]!>b[i]!?1:-1;break;}
      const meta=order>0?remote:local;
      if(local.markdown===remote.markdown)value=local.deleted!==remote.deleted&&(!local.modifiedBy||local.modifiedBy!==remote.modifiedBy)?(local.deleted?local:remote):meta;
      else {
        const restore=local.deleted&&!remote.deleted&&remote.baseMarkdown===local.markdown&&remote.updatedAt>local.updatedAt;
        const localRestore=remote.deleted&&!local.deleted&&local.baseMarkdown===remote.markdown&&local.updatedAt>remote.updatedAt;
        const sequentialDelete=remote.deleted&&!local.deleted&&remote.baseMarkdown===local.markdown&&local.markdown===local.baseMarkdown;
        const deletionConflict=local.deleted!==remote.deleted&&!restore&&!localRestore&&!sequentialDelete;
        cycle=!local.deleted&&!remote.deleted&&remote.baseMarkdown===local.markdown&&local.baseMarkdown===remote.markdown;
        const markdown=deletionConflict||cycle?null:restore?remote.markdown:localRestore?local.markdown:
          remote.baseMarkdown===local.markdown?remote.markdown:local.baseMarkdown===remote.markdown?local.markdown:
          local.baseMarkdown===remote.baseMarkdown?mergeNoteMarkdown(local.baseMarkdown,local.markdown,remote.markdown):null;
        if(markdown===null){conflict=true;if(cycle)value=meta;}
        else if(markdown===remote.markdown)value={...remote,title:meta.title,folderId:meta.folderId,pinned:meta.pinned};
        else if(markdown===local.markdown)value={...local,title:meta.title,folderId:meta.folderId,pinned:meta.pinned};
        else value={...meta,title:trimNoteText(meta.title)?meta.title:memoTitle(markdown),markdown,plainText:phoneNotePlainText(markdown),contentHash:sha256(markdown),updatedAt:nextTime(this.clock(),local,remote),modifiedBy:this.deviceId,deleted:false,deletedAt:0};
        if(markdown!==null&&(markdown===remote.markdown&&meta!==remote||markdown===local.markdown&&meta!==local))value={...value,updatedAt:nextTime(this.clock(),local,remote),modifiedBy:this.deviceId};
      }
      if(!conflict&&JSON.stringify(value)===JSON.stringify(local))return finish([],0);
    }
    const statements:{sql:string;params?:SqlParams}[]=[];
    if(conflict){
      const id=noteConflictId(local!.noteId,local!.baseMarkdown,local!.markdown,remote.markdown,remote.modifiedBy);
      // Repeated old/new IDs for the same immutable content denote one incident.
      if((await this.db.query('SELECT 1 FROM note_merge_conflicts WHERE note_id=? AND base_markdown=? AND local_markdown=? AND remote_markdown=? AND remote_device_id=?',[local!.noteId,local!.baseMarkdown,local!.markdown,remote.markdown,remote.modifiedBy])).length)return finish([],0);
      if((await this.db.query('SELECT 1 FROM note_merge_conflicts WHERE conflict_id=?',[id])).length)throw Error('conflict_identity_mismatch');
      statements.push({sql:'INSERT OR IGNORE INTO note_merge_conflicts VALUES(?,?,?,?,?,?,?)',params:[id,local!.noteId,local!.baseMarkdown,local!.markdown,remote.markdown,remote.modifiedBy,this.clock()]});
    }
    if(!conflict||cycle)statements.push({sql:(local?'INSERT OR REPLACE':'INSERT')+' INTO memo_notes('+NOTE_COLUMNS+') VALUES('+noteValues(value).map(()=>'?').join(',')+')',params:noteValues(value)});
    return finish(statements,1);
  }
  async get(noteId: string): Promise<MemoNote | null> { const row=(await this.db.query(`SELECT * FROM memo_notes WHERE note_id=? AND deleted=0 LIMIT 1`,[noteId]))[0]; return row?note(row):null; }
  async listFolders(): Promise<MemoFolder[]> { return (await this.db.query(`SELECT * FROM memo_folders WHERE deleted=0 ORDER BY sort_order,name`)).map(folder); }
  async save(input: {noteId?:string;title?:string;markdown:string}): Promise<MemoNote> {
    // Like native dao.get, saving must include tombstones: an open draft restores
    // the same record with its metadata and sync baseline intact.
    const row=input.noteId ? (await this.db.query(`SELECT * FROM memo_notes WHERE note_id=? LIMIT 1`,[input.noteId]))[0] : undefined;
    const markdown=normalizeMarkdown(input.markdown), old=row ? note(row) : null;
    if (input.noteId && !old) throw new Error("笔记不存在");
    if (old) await this.requireOpenable(old.noteId);
    if (!old && !markdown.trim() && !input.title?.trim()) throw new Error("新建备忘录不能为空");
    const now=nextTime(this.clock(),old), hash=sha256(markdown), noteId=old?.noteId ?? this.idFactory();
    const rawTitle=input.title??old?.title??'';
    const title=trimNoteText(rawTitle)?rawTitle:memoTitle(markdown);
    await this.db.execute(`INSERT OR REPLACE INTO memo_notes(note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0)`,[noteId,old?.folderId??null,title,markdown,memoPlainText(markdown),hash,old?.deleted?old.contentHash:old?.baseContentHash??hash,old?.deleted?old.markdown:old?.baseMarkdown??markdown,old?.pinned?1:0,old?.createdAt??now,now,this.deviceId]);
    return (await this.get(noteId))!;
  }
  async setPinned(noteId:string,pinned:boolean): Promise<MemoNote> { return this.updateMeta(noteId,`pinned=?`,[pinned?1:0]); }
  async move(noteId:string,folderId:string|null): Promise<MemoNote> { if(folderId && !(await this.db.query(`SELECT 1 FROM memo_folders WHERE folder_id=? AND deleted=0`,[folderId])).length) throw new Error("文件夹不存在"); return this.updateMeta(noteId,`folder_id=?`,[folderId]); }
  async delete(noteId:string): Promise<MemoNote> { return this.updateMeta(noteId,`deleted=1`,[],this.clock(),true); }
  async createFolder(name:string,sortOrder=0): Promise<MemoFolder> { const value=name.trim(); if(!value) throw new Error("文件夹名称不能为空"); const id=this.idFactory(), now=this.clock(); await this.db.execute(`INSERT INTO memo_folders(folder_id,name,sort_order,updated_at,modified_by) VALUES(?,?,?,?,?)`,[id,value,sortOrder,now,this.deviceId]); return folder((await this.db.query(`SELECT * FROM memo_folders WHERE folder_id=?`,[id]))[0]); }
  /** Sync v2 R2: a note this device cannot open is read-only; edits fail with
   * `note_unopenable` so the interface can explain why. */
  private async requireOpenable(noteId:string){ if(await noteUnopenable(this.db,noteId)) throw new Error("note_unopenable"); }
  private async updateMeta(noteId:string,setSql:string,params:unknown[],now=this.clock(),includeDeleted=false): Promise<MemoNote> { const current=includeDeleted ? (await this.db.query(`SELECT * FROM memo_notes WHERE note_id=?`,[noteId]))[0] : await this.get(noteId); if(!current) throw new Error("笔记不存在"); await this.requireOpenable(noteId); const currentNote=includeDeleted?note(current as Record<string,unknown>):current as MemoNote; now=nextTime(now,currentNote); if(includeDeleted){setSql+=',deleted_at=?';params.push(now);} await this.db.execute(`UPDATE memo_notes SET ${setSql},updated_at=?,modified_by=? WHERE note_id=?`,[...params,now,this.deviceId,noteId]); return note((await this.db.query(`SELECT * FROM memo_notes WHERE note_id=?`,[noteId]))[0]); }
}
