import {onlyChangedSql} from '@podjs/framework/sql-changes';
import {sha256Hex} from '@podjs/framework/crypto';
import {memoPlainText,memoTitle} from './text.ts';
export {memoPlainText,memoTitle} from './text.ts';
import type { SqlDatabase, SqlParams } from "../core/types.ts";
import type { MemoFolder, MemoNote } from "./types.ts";
import { utf8Encode } from "../cloud/types.ts";

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

export class MemoRepository {
  constructor(private readonly db: SqlDatabase, private readonly deviceId: string, private readonly idFactory: () => string = defaultId, private readonly clock: () => number = Date.now) {}
  async initialize(): Promise<void> { await initializeMemoSchema(this.db); }
  async list(): Promise<MemoNote[]> { return (await this.db.query(`SELECT * FROM memo_notes WHERE deleted=0 ORDER BY pinned DESC,updated_at DESC`)).map(note); }
  async allIncludingDeleted(): Promise<MemoNote[]> { return (await this.db.query(`SELECT * FROM memo_notes ORDER BY updated_at DESC`)).map(note); }
  /** Native WatchNoteRepository rule; tombstones participate in conflict resolution. */
  async merge(incoming: readonly MemoNote[]): Promise<number> {
    let applied=0;
    for(const remote of incoming){
      const row=(await this.db.query("SELECT * FROM memo_notes WHERE note_id=?",[remote.noteId]))[0];
      if(row){
        const local=note(row),remoteClock=Math.max(remote.updatedAt,remote.deletedAt),localClock=Math.max(local.updatedAt,local.deletedAt);
        if(remote.markdown===local.markdown&&remote.contentHash===local.contentHash){
          // Same-body metadata uses the same total LWW order as the phone.
          const keys=(n:MemoNote):Array<number|string|boolean>=>[Math.max(n.updatedAt,n.deletedAt),n.modifiedBy,n.deleted,n.title,n.folderId!==null,n.folderId??'',n.pinned,n.createdAt,n.baseContentHash,n.baseMarkdown];
          const a=keys(remote),b=keys(local);let order=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){order=a[i]!>b[i]!?1:-1;break;}
          if(order<=0)continue;
        }else if(remoteClock<localClock&&(remote.deleted||local.deleted))continue;
        else if(remote.updatedAt<local.updatedAt&&local.contentHash!==local.baseContentHash)continue;
      }
      if(row&&JSON.stringify(note(row))===JSON.stringify(remote))continue;
      const statement={sql:onlyChangedSql("INSERT INTO memo_notes(note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,markdown=excluded.markdown,plain_text=excluded.plain_text,content_hash=excluded.content_hash,base_content_hash=excluded.base_content_hash,base_markdown=excluded.base_markdown,pinned=excluded.pinned,created_at=excluded.created_at,updated_at=excluded.updated_at,modified_by=excluded.modified_by,deleted=excluded.deleted,deleted_at=excluded.deleted_at WHERE (excluded.updated_at>=memo_notes.updated_at OR memo_notes.content_hash=memo_notes.base_content_hash OR (excluded.markdown=memo_notes.markdown AND excluded.content_hash=memo_notes.content_hash AND max(excluded.updated_at,excluded.deleted_at)>=max(memo_notes.updated_at,memo_notes.deleted_at)))"),params:[remote.noteId,remote.folderId,remote.title,remote.markdown,remote.plainText,remote.contentHash,remote.baseContentHash,remote.baseMarkdown,remote.pinned?1:0,remote.createdAt,remote.updatedAt,remote.modifiedBy,remote.deleted?1:0,remote.deletedAt]};
      if(this.db.transactionChanges){const counts=await this.db.transactionChanges([statement]);applied+=counts[0]!>0?1:0;}else{await this.db.execute(statement.sql,statement.params);applied++;}
    }
    return applied;
  }
  async get(noteId: string): Promise<MemoNote | null> { const row=(await this.db.query(`SELECT * FROM memo_notes WHERE note_id=? AND deleted=0 LIMIT 1`,[noteId]))[0]; return row?note(row):null; }
  async listFolders(): Promise<MemoFolder[]> { return (await this.db.query(`SELECT * FROM memo_folders WHERE deleted=0 ORDER BY sort_order,name`)).map(folder); }
  async save(input: {noteId?:string;title?:string;markdown:string}): Promise<MemoNote> {
    // Like native dao.get, saving must include tombstones: an open draft restores
    // the same record with its metadata and sync baseline intact.
    const row=input.noteId ? (await this.db.query(`SELECT * FROM memo_notes WHERE note_id=? LIMIT 1`,[input.noteId]))[0] : undefined;
    const markdown=normalizeMarkdown(input.markdown), old=row ? note(row) : null;
    if (input.noteId && !old) throw new Error("笔记不存在");
    if (!old && !markdown.trim() && !input.title?.trim()) throw new Error("新建备忘录不能为空");
    const now=this.clock(), hash=sha256(markdown), noteId=old?.noteId ?? this.idFactory();
    const title=input.title!==undefined?input.title:(old?.title?.trim()?old.title:memoTitle(markdown));
    await this.db.execute(`INSERT OR REPLACE INTO memo_notes(note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0)`,[noteId,old?.folderId??null,title,markdown,memoPlainText(markdown),hash,old?.baseContentHash??hash,old?.baseMarkdown??markdown,old?.pinned?1:0,old?.createdAt??now,now,this.deviceId]);
    return (await this.get(noteId))!;
  }
  async setPinned(noteId:string,pinned:boolean): Promise<MemoNote> { return this.updateMeta(noteId,`pinned=?`,[pinned?1:0]); }
  async move(noteId:string,folderId:string|null): Promise<MemoNote> { if(folderId && !(await this.db.query(`SELECT 1 FROM memo_folders WHERE folder_id=? AND deleted=0`,[folderId])).length) throw new Error("文件夹不存在"); return this.updateMeta(noteId,`folder_id=?`,[folderId]); }
  async delete(noteId:string): Promise<MemoNote> { const now=this.clock(); return this.updateMeta(noteId,`deleted=1,deleted_at=?`,[now],now,true); }
  async createFolder(name:string,sortOrder=0): Promise<MemoFolder> { const value=name.trim(); if(!value) throw new Error("文件夹名称不能为空"); const id=this.idFactory(), now=this.clock(); await this.db.execute(`INSERT INTO memo_folders(folder_id,name,sort_order,updated_at,modified_by) VALUES(?,?,?,?,?)`,[id,value,sortOrder,now,this.deviceId]); return folder((await this.db.query(`SELECT * FROM memo_folders WHERE folder_id=?`,[id]))[0]); }
  private async updateMeta(noteId:string,setSql:string,params:unknown[],now=this.clock(),includeDeleted=false): Promise<MemoNote> { const current=includeDeleted ? (await this.db.query(`SELECT * FROM memo_notes WHERE note_id=?`,[noteId]))[0] : await this.get(noteId); if(!current) throw new Error("笔记不存在"); await this.db.execute(`UPDATE memo_notes SET ${setSql},updated_at=?,modified_by=? WHERE note_id=?`,[...params,now,this.deviceId,noteId]); return note((await this.db.query(`SELECT * FROM memo_notes WHERE note_id=?`,[noteId]))[0]); }
}
