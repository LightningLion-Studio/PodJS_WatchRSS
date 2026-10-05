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
function sha256(value: string): string {
  const bytes=[...utf8Encode(value)], bitLength=bytes.length*8;
  bytes.push(0x80); while(bytes.length%64!==56) bytes.push(0);
  const high=Math.floor(bitLength/0x100000000), low=bitLength>>>0;
  for(let shift=24;shift>=0;shift-=8) bytes.push((high>>>shift)&255);
  for(let shift=24;shift>=0;shift-=8) bytes.push((low>>>shift)&255);
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rr=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  for(let offset=0;offset<bytes.length;offset+=64){const w=new Array<number>(64);for(let i=0;i<16;i++){const p=offset+i*4;w[i]=((bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3])>>>0;}for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2],s0=rr(a,7)^rr(a,18)^(a>>>3),s1=rr(b,17)^rr(b,19)^(b>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}let[a,b,c,d,e,f,g,z]=h;for(let i=0;i<64;i++){const s1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^(~e&g),t1=(z+s1+ch+k[i]+w[i])>>>0,s0=rr(a,2)^rr(a,13)^rr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(s0+maj)>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+z)>>>0;}
  return h.map(v=>v.toString(16).padStart(8,"0")).join("");
}

export class MemoRepository {
  constructor(private readonly db: SqlDatabase, private readonly deviceId: string, private readonly idFactory: () => string = defaultId, private readonly clock: () => number = Date.now) {}
  async initialize(): Promise<void> { await initializeMemoSchema(this.db); }
  async list(): Promise<MemoNote[]> { return (await this.db.query(`SELECT * FROM memo_notes WHERE deleted=0 ORDER BY pinned DESC,updated_at DESC`)).map(note); }
  async allIncludingDeleted(): Promise<MemoNote[]> { return (await this.db.query(`SELECT * FROM memo_notes ORDER BY updated_at DESC`)).map(note); }
  /** Native WatchNoteRepository rule; tombstones participate in conflict resolution. */
  async merge(incoming: readonly MemoNote[]): Promise<number> {
    let applied=0;
    for(const remote of incoming){
      const row=(await this.db.query("SELECT updated_at,content_hash,base_content_hash FROM memo_notes WHERE note_id=?",[remote.noteId]))[0];
      if(row&&remote.updatedAt<Number(row.updated_at)&&row.content_hash!==row.base_content_hash)continue;
      await this.db.execute("INSERT OR REPLACE INTO memo_notes(note_id,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[remote.noteId,remote.folderId,remote.title,remote.markdown,remote.plainText,remote.contentHash,remote.baseContentHash,remote.baseMarkdown,remote.pinned?1:0,remote.createdAt,remote.updatedAt,remote.modifiedBy,remote.deleted?1:0,remote.deletedAt]);
      applied++;
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
