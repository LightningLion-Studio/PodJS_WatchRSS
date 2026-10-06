import {expect,test} from "bun:test";
import {readHomeChannelSnapshot,writeHomeChannelSnapshot} from "../src/ui/home-snapshot.ts";
import type {Channel} from "../src/ui/service.ts";
const list:Channel[]=[{id:"42",title:"Saved feed",url:"https://example.test/feed",sortOrder:1,isPinned:false}];
function storage(value:unknown){return {get:<T>(_key:string)=>value as T,set:<T>(_key:string,next:T)=>{value=next;}};}
test("persisted home destination reuses channels without waiting for the live query",()=>{
 const store=storage(undefined);writeHomeChannelSnapshot(store,list);
 expect(readHomeChannelSnapshot(store,{version:1,kind:"home"})).toBe(list);
 expect(readHomeChannelSnapshot(store,null)).toBe(list);
});
test("a resumed reader or feed never flashes the home snapshot",()=>{
 const store=storage(list);
 expect(readHomeChannelSnapshot(store,{version:1,kind:"reader",articleId:"42"})).toBeUndefined();
 expect(readHomeChannelSnapshot(store,{version:1,kind:"articles",channelId:"42"})).toBeUndefined();
});
test("missing or malformed cached channels cannot stand in for actual content",()=>{
 for(const value of [undefined,[],[{}],[{...list[0],id:42}]])expect(readHomeChannelSnapshot(storage(value),null)).toBeUndefined();
 const unavailable={get:<T>():T=>{throw Error("unavailable");}};
 expect(readHomeChannelSnapshot(unavailable,null)).toBeUndefined();
});
