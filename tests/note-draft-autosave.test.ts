import { expect, test } from "bun:test";
import { NoteDraftAutosave } from "../src/notes/draft-autosave.ts";
import type { MemoNote } from "../src/notes/types.ts";

function saved(title:string,markdown:string):MemoNote{return {noteId:"note-1",folderId:null,title,markdown,plainText:markdown,contentHash:"hash",baseContentHash:"hash",baseMarkdown:markdown,pinned:false,createdAt:1,updatedAt:1,modifiedBy:"watch",deleted:false,deletedAt:0};}

test("title-only drafts auto-save raw title and blank create remains empty",async()=>{
  const writes:{noteId?:string;title?:string;markdown:string}[]=[];
  let now=0;
  const draft=new NoteDraftAutosave({save:async value=>{writes.push(value);return saved(value.title??"",value.markdown);}},null,undefined,undefined,undefined,600,()=>now);
  expect(await draft.flush()).toBeNull();
  draft.setTitle("  仅标题  ");
  now=599;draft.tick();expect(writes).toHaveLength(0);
  now=600;draft.tick();await Promise.resolve();await Promise.resolve();
  expect(writes).toEqual([{noteId:undefined,title:"  仅标题  ",markdown:""}]);
  expect(draft.state).toBe("saved");
  draft.dispose();
});

test("a newer edit waits for the older save and wins",async()=>{
  let finishFirst:((note:MemoNote)=>void)|undefined;
  const writes:string[]=[];
  const draft=new NoteDraftAutosave({save:async value=>{
    writes.push(value.markdown);
    if(writes.length===1)return new Promise<MemoNote>(resolve=>{finishFirst=resolve;});
    return saved(value.title??"",value.markdown);
  }},saved("标题","旧内容"),undefined,undefined,undefined,1000);
  draft.setMarkdown("第一版");
  const flushing=draft.flush();
  await Promise.resolve();
  draft.setMarkdown("第二版");
  finishFirst?.(saved("标题","第一版"));
  const final=await flushing;
  expect(writes).toEqual(["第一版","第二版"]);
  expect(final?.markdown).toBe("第二版");
  draft.dispose();
});
