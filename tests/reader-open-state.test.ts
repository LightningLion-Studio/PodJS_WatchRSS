import {expect,test} from "bun:test";
import {markFeedArticleRead} from "../src/ui/reader-open-state.ts";
import type {Article} from "../src/ui/service.ts";
const article=(id:string,read:boolean):Article=>({id,title:id,content:"body",read,saved:true,watchLater:true,channelId:"40"});
test("reopening a read article preserves retained feed identity",()=>{
 const items=[article("411",true),article("410",false)];
 expect(markFeedArticleRead(items,"411")).toBe(items);
 expect(markFeedArticleRead(items,"missing")).toBe(items);
});
test("an unread article changes only its read flag and keeps saved state, order and other rows",()=>{
 const first=article("411",false),other=article("410",false),items=[first,other];
 const result=markFeedArticleRead(items,"411");
 expect(result).toEqual([{...first,read:true},other]);
 expect(result[1]).toBe(other);expect(first.read).toBe(false);
 expect(markFeedArticleRead(result,"411")).toBe(result);
});
