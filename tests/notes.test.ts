import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { SqlDatabase } from "../src/core/types.ts";
import { MemoRepository, initializeMemoSchema } from "../src/notes/index.ts";

class BunDb implements SqlDatabase {
  constructor(readonly raw:Database) {}
  async execute(sql:string,params:readonly unknown[]=[]){this.raw.query(sql).run(...params as any[]);}
  async query(sql:string,params:readonly unknown[]=[]){return this.raw.query(sql).all(...params as any[]) as Record<string,unknown>[];}
  async transaction(statements:{sql:string;params?:readonly unknown[]}[]){this.raw.exec("BEGIN");try{for(const statement of statements)this.raw.query(statement.sql).run(...(statement.params??[]) as any[]);this.raw.exec("COMMIT");}catch(error){this.raw.exec("ROLLBACK");throw error;}}
}
const opened:Database[]=[];
afterEach(()=>{while(opened.length)opened.pop()!.close();});
function repository(clockValues=[100,200,300,400]) { const raw=new Database(":memory:");opened.push(raw);let id=0,time=0;const db=new BunDb(raw);return {db,repo:new MemoRepository(db,"podjs-watch",()=>`00000000-0000-4000-8000-${String(++id).padStart(12,"0")}`,()=>clockValues[Math.min(time++,clockValues.length-1)])}; }

describe("standalone memo repository",()=>{
  test("uses separate tables and preserves the old article-linked notes table",async()=>{const {db}=repository();await db.execute(`CREATE TABLE notes(id INTEGER PRIMARY KEY,article_id INTEGER NOT NULL,body TEXT NOT NULL)`);await db.execute(`INSERT INTO notes VALUES(1,7,'article note')`);await initializeMemoSchema(db);expect((await db.query(`SELECT body FROM notes`))[0].body).toBe("article note");expect((await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memo_%'`)).map(r=>r.name).sort()).toEqual(["memo_folders","memo_notes"]);});

  test("creates, reads, edits and orders pinned notes with compatible identity fields",async()=>{const {repo}=repository();await repo.initialize();const first=await repo.save({title:"标题",markdown:"# 标题\r\n正文"});const second=await repo.save({markdown:"第二条"});expect(first.noteId).toMatch(/^[0-9a-f-]{36}$/);expect(first.markdown).toBe("# 标题\n正文");expect(first.plainText).toBe("标题\n正文");expect(first.contentHash).toBe("c3b3dddb43fb69462abde920f7e0c56d47a1101c6986c2ce8a027aaa39a81ccd");expect(first.baseMarkdown).toBe("# 标题\n正文");expect(first.modifiedBy).toBe("podjs-watch");const edited=await repo.save({noteId:first.noteId,title:"改后",markdown:"新正文"});expect(edited).toMatchObject({title:"改后",markdown:"新正文",createdAt:100});await repo.setPinned(first.noteId,true);expect((await repo.list()).map(n=>n.noteId)).toEqual([first.noteId,second.noteId]);});

  test("moves through persistent folders and rejects missing folders",async()=>{const {repo}=repository();await repo.initialize();const note=await repo.save({markdown:"待整理"});const folder=await repo.createFolder("工作",3);expect(await repo.listFolders()).toEqual([folder]);expect(await repo.move(note.noteId,folder.folderId)).toMatchObject({folderId:folder.folderId});await expect(repo.move(note.noteId,"missing")).rejects.toThrow("文件夹不存在");expect(await repo.move(note.noteId,null)).toMatchObject({folderId:null});});

  test("deletes with a tombstone instead of destroying sync identity",async()=>{const {repo}=repository();await repo.initialize();const saved=await repo.save({markdown:"稍后删除"});const deleted=await repo.delete(saved.noteId);expect(deleted).toMatchObject({noteId:saved.noteId,deleted:true,deletedAt:200,modifiedBy:"podjs-watch"});expect(await repo.get(saved.noteId)).toBeNull();expect(await repo.list()).toEqual([]);expect(await repo.allIncludingDeleted()).toEqual([deleted]);});

  test("rejects empty creates and edits of deleted notes",async()=>{const {repo}=repository();await repo.initialize();await expect(repo.save({markdown:"  "})).rejects.toThrow("新建备忘录不能为空");const saved=await repo.save({markdown:"x"});await repo.delete(saved.noteId);await expect(repo.save({noteId:saved.noteId,markdown:"again"})).rejects.toThrow("笔记不存在");});
  test("preserves explicit raw titles, including whitespace and clearing a prior title",async()=>{const {repo}=repository();await repo.initialize();const note=await repo.save({title:"  原始标题  ",markdown:"正文"});expect(note.title).toBe("  原始标题  ");const cleared=await repo.save({noteId:note.noteId,title:"",markdown:"正文"});expect(cleared.title).toBe("");expect((await repo.save({noteId:note.noteId,markdown:"正文"})).title).toBe("正文");});
});
