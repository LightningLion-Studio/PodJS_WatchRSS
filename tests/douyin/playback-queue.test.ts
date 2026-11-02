import { expect, test } from "bun:test";
import { DouyinPlaybackQueue, type DouyinClient, type DouyinItem } from "../../src/douyin/index.ts";

const item=(id:string):DouyinItem=>({awemeId:id,description:id,createdAtSeconds:0,authorId:"",authorName:"",likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:1,variants:[]});

test("queue resolves previous/next and incrementally fetches the page tail",async()=>{const fetched:string[]=[];const client={async resolvePlayback(id:string){return {ok:true as const,data:{...item(id),description:`resolved-${id}`},source:"feed-cache" as const};},async fetchFeedPage({cursor}:{cursor?:string|null}){fetched.push(cursor??"");return {ok:true as const,data:{items:[item("3"),item("4")],nextCursor:"next-2",hasMore:false},source:"network" as const};}} as unknown as DouyinClient;const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2")],selectedAwemeId:"2",cursor:"next-1",hasMore:true});const previous=await queue.previous();expect(previous).toMatchObject({ok:true,data:{item:{awemeId:"1"},index:0}});await queue.next();const loaded=await queue.next();expect(loaded).toMatchObject({ok:true,data:{item:{awemeId:"3"},cursor:"next-2",hasMore:false,index:2}});expect(fetched).toEqual(["next-1"]);});

test("queue is bounded to 40 while retaining newly appended items",async()=>{const initial=Array.from({length:40},(_,i)=>item(String(i)));const client={async resolvePlayback(id:string){return {ok:true as const,data:item(id)};},async fetchFeedPage(){return {ok:true as const,data:{items:[item("40")],nextCursor:null,hasMore:false}};}} as unknown as DouyinClient;const queue=new DouyinPlaybackQueue(client,{items:initial,selectedAwemeId:"39",cursor:"c",hasMore:true});const result=await queue.next();expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.message);expect(result.data.item.awemeId).toBe("40");expect(result.data.playlist[0].awemeId).toBe("1");expect(result.data.playlist).toHaveLength(40);expect(result.data.index).toBe(39);});

test("new navigation cancels stale async queue results",async()=>{let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const client={async resolvePlayback(id:string){if(id==="2")await gate;return {ok:true as const,data:item(id)};},async fetchFeedPage(){throw new Error("unused");}} as unknown as DouyinClient;const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2")],selectedAwemeId:"1"});const pending=queue.next();const replacement=await queue.current();release();expect(replacement).toMatchObject({ok:true,data:{item:{awemeId:"1"}}});expect(await pending).toEqual({ok:false,code:"CANCELLED",message:"播放队列操作已被更新的导航取消"});expect(queue.snapshot().item?.awemeId).toBe("1");});

test("page and playback failures remain typed failures",async()=>{const client={async resolvePlayback(){return {ok:false as const,code:"REQUEST_FAILED" as const,message:"media expired"};},async fetchFeedPage(){return {ok:false as const,code:"REQUEST_FAILED" as const,message:"feed 503"};}} as unknown as DouyinClient;const current=new DouyinPlaybackQueue(client,{items:[item("1")],selectedAwemeId:"1"});expect(await current.current()).toEqual({ok:false,code:"REQUEST_FAILED",message:"media expired"});const tail=new DouyinPlaybackQueue(client,{items:[item("1")],selectedAwemeId:"1",cursor:"c",hasMore:true});expect(await tail.next()).toEqual({ok:false,code:"REQUEST_FAILED",message:"feed 503"});});

test("session preview resolves ahead without moving the anchor until promotion",async()=>{const resolved:string[]=[];const client={async resolvePlayback(id:string){resolved.push(id);return {ok:true as const,data:{...item(id),description:`resolved-${id}`},source:"feed-cache" as const};}} as unknown as DouyinClient;const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2"),item("3")],selectedAwemeId:"1",hasMore:false});const preview=await queue.preview("next");expect(preview).toMatchObject({ok:true,data:{item:{awemeId:"2"},index:1}});expect(queue.snapshot().item?.awemeId).toBe("1");expect(queue.commitPreview("2")).toMatchObject({ok:true,data:{item:{awemeId:"2"},index:1}});expect(queue.snapshot().item?.awemeId).toBe("2");expect(resolved).toEqual(["2"]);});

test("rapid adjacent previews cancel stale results without changing selection",async()=>{let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const client={async resolvePlayback(id:string){if(id==="2")await gate;return {ok:true as const,data:item(id),source:"feed-cache" as const};}} as unknown as DouyinClient;const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2")],selectedAwemeId:"1",hasMore:false});const stale=queue.preview("next"),replacement=queue.preview("next");release();expect(await stale).toMatchObject({ok:false,code:"CANCELLED"});expect(await replacement).toMatchObject({ok:true,data:{item:{awemeId:"2"}}});expect(queue.snapshot().item?.awemeId).toBe("1");});

test('diagnostic quarantine IDs come from actual failed candidate removals and return copies',async()=>{
 const client={async resolvePlayback(id:string){return id==='2'?{ok:false as const,code:'PARSE_FAILED' as const,message:'fixture_failure'}:{ok:true as const,data:item(id)};}} as unknown as DouyinClient;
 const queue=new DouyinPlaybackQueue(client,{items:[item('1'),item('2'),item('3')],selectedAwemeId:'1',hasMore:false});
 expect(queue.diagnostics().quarantinedAwemeIds).toEqual([]);await queue.preview('next');const d=queue.diagnostics();expect(d.quarantinedAwemeIds).toEqual(['2']);expect(d.itemCount).toBe(2);d.quarantinedAwemeIds.push('forged');expect(queue.diagnostics().quarantinedAwemeIds).toEqual(['2']);expect(queue.snapshot().item?.awemeId).toBe('1');
});


for(const code of ['RATE_LIMITED','TEMPORARILY_UNAVAILABLE'] as const)test(`${code} retains the selected item and neighbours during recover, next and preview`,async()=>{
 let calls=0;const client={resolvePlayback:async()=>{calls++;return {ok:false as const,code,message:'temporary',retryAfterMs:30000};}} as unknown as DouyinClient;
 const queue=new DouyinPlaybackQueue(client,{items:[item('1'),item('2'),item('3')],selectedAwemeId:'1',hasMore:false});
 expect(await queue.recover()).toMatchObject({code});expect(await queue.next()).toMatchObject({code});expect(await queue.preview('next')).toMatchObject({code});
 expect(queue.snapshot().item?.awemeId).toBe('1');expect(queue.snapshot().playlist).toHaveLength(3);expect(queue.diagnostics().quarantinedAwemeIds).toEqual([]);expect(calls).toBe(3);
});


test('PREWARM opposite previews resolve concurrently without cancelling each other; navigation still rejects both late results',async()=>{
 const pending=new Map<string,(value:any)=>void>();
 const client={resolvePlayback:(id:string)=>new Promise(resolve=>pending.set(id,resolve))} as unknown as DouyinClient;
 const queue=new DouyinPlaybackQueue(client,{items:[item('1'),item('2'),item('3')],selectedAwemeId:'2',hasMore:false});
 const next=queue.preview('next'),prev=queue.preview('previous');
 await Promise.resolve();await Promise.resolve();
 pending.get('3')!({ok:true,data:item('3')});pending.get('1')!({ok:true,data:item('1')});
 expect(await next).toMatchObject({ok:true,data:{item:{awemeId:'3'}}});expect(await prev).toMatchObject({ok:true,data:{item:{awemeId:'1'}}});expect(queue.snapshot().item?.awemeId).toBe('2');
 const staleNext=queue.preview('next'),stalePrev=queue.preview('previous');await Promise.resolve();await Promise.resolve();queue.commitPreview('3');
 pending.get('3')!({ok:true,data:item('3')});pending.get('1')!({ok:true,data:item('1')});
 expect(await staleNext).toMatchObject({ok:false,code:'CANCELLED'});expect(await stalePrev).toMatchObject({ok:false,code:'CANCELLED'});expect(queue.snapshot().item?.awemeId).toBe('3');
});
