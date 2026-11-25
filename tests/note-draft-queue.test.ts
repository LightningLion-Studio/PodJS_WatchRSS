import {expect,test} from "bun:test";
import {noteDraftQueue} from "../src/notes/draft-queue.ts";
import type {MemoNote} from "../src/notes/types.ts";

function saved(noteId:string,title:string,markdown:string):MemoNote{
 return {noteId,title,markdown,folderId:null,plainText:markdown,contentHash:"hash",baseContentHash:"hash",baseMarkdown:markdown,pinned:false,createdAt:1,updatedAt:1,modifiedBy:"watch",deleted:false,deletedAt:0};
}
const observer={state:()=>{},saved:()=>{},error:()=>{}};

test("reopening a note joins the pending write rather than submitting the same draft again",async()=>{
 const initial=saved("existing","Title","original");
 const written=saved("existing","Title","pending body");
 let finish!: (note:MemoNote)=>void;
 const writes:string[]=[];
 const queue=noteDraftQueue({save:async value=>{
  writes.push(value.markdown);
  return new Promise(resolve=>{finish=resolve;});
 }});
 const first=queue.open(initial);
 const release=first.observe(observer);
 first.draft.setMarkdown(written.markdown);
 const closing=first.close();
 release();
 queue.retryDetached();

 const reopened=queue.open(initial);
 expect(reopened).toBe(first);
 expect(reopened.draft.markdown).toBe(written.markdown);
 expect(reopened.close()).toBe(closing);
 expect(writes).toEqual([written.markdown]);
 finish(written);
 expect(await closing).toBe(written);
 expect(writes).toEqual([written.markdown]);
});

test("new edits after reopening join the same series of writes and keep the assigned ID",async()=>{
 const firstNote=saved("assigned","Original","Original");
 const finalNote=saved("assigned","Reopened","Original");
 let finish!: (note:MemoNote)=>void;
 const writes:Array<{noteId?:string;title?:string;markdown:string}>=[];
 const queue=noteDraftQueue({save:async value=>{
  writes.push(value);
  if(writes.length===1)return new Promise(resolve=>{finish=resolve;});
  return finalNote;
 }});
 const first=queue.open(null);
 const release=first.observe(observer);
 first.draft.setMarkdown(firstNote.markdown);
 const closing=first.close();
 release();

 const reopened=queue.open(null);
 expect(reopened).toBe(first);
 reopened.draft.setTitle(finalNote.title);
 expect(reopened.close()).toBe(closing);
 finish(firstNote);
 expect(await closing).toBe(finalNote);
 expect(writes).toEqual([
  {noteId:undefined,title:"",markdown:"Original"},
  {noteId:"assigned",title:"Reopened",markdown:"Original"},
 ]);
});

test("failed background work is recoverable and the list can retry the retained draft",async()=>{
 let attempts=0,refreshes=0;
 const committed=saved("created","Draft","Draft");
 const queue=noteDraftQueue({save:async()=>{
  if(++attempts===1)throw Error("storage unavailable");
  return committed;
 }});
 const session=queue.open(null);
 const release=session.observe(observer);
 session.draft.setMarkdown(committed.markdown);
 const closing=session.close();
 release();
 await expect(closing).rejects.toThrow("storage unavailable");
 expect(queue.open(null)).toBe(session);
 expect(session.draft.markdown).toBe(committed.markdown);

 const unsubscribe=queue.subscribe(()=>refreshes++);
 queue.retryDetached();
 expect(await session.flush()).toBe(committed);
 expect(attempts).toBe(2);
 expect(refreshes).toBe(1);
 expect(queue.open(null)).not.toBe(session);
 unsubscribe();
});
