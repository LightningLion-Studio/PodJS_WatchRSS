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

for(const direction of ['next','previous'] as const)test(`DYFIX ${direction} two-item preview skips resolution and commits only the target`,async()=>{
 const resolved:string[]=[];const client={async resolvePlayback(id:string){resolved.push(id);return {ok:true as const,data:item(id)};}} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:['0','1','2','3','4'].map(item),selectedAwemeId:'2',hasMore:false});
 const target=direction==='next'?'4':'0',preview=await q.preview(direction,2);
 expect(preview).toMatchObject({ok:true,data:{item:{awemeId:target}}});expect(q.snapshot().item?.awemeId).toBe('2');
 expect(resolved).toEqual([target]);q.commitPreview(target);expect(q.snapshot().item?.awemeId).toBe(target);
});

test('T1202 a pending feed page survives promotion within the same queue',async()=>{
 let finish!:(value:any)=>void,requests=0;
 const client={resolvePlayback:async(id:string)=>({ok:true,data:item(id)}),fetchFeedPage:()=>{requests++;return new Promise(resolve=>finish=resolve);}}as unknown as DouyinClient;
 const queue=new DouyinPlaybackQueue(client,{items:[item('a'),item('b'),item('c')],selectedAwemeId:'b',cursor:'cursor-0',hasMore:true});
 const warming=queue.preview('next',2);await Promise.resolve();queue.commitPreview('c');
 finish({ok:true,data:{items:[item('d'),item('e')],nextCursor:'cursor-1',hasMore:true}});expect(await warming).toMatchObject({ok:false,code:'CANCELLED'});
 expect(queue.snapshot()).toMatchObject({item:{awemeId:'c'},cursor:'cursor-1'});
 expect(await queue.preview('next')).toMatchObject({ok:true,data:{item:{awemeId:'d'}}});expect(requests).toBe(1);
});
test('T1202 a pending page cannot evict the selection after a reverse jump',async()=>{
 let finish!:(value:any)=>void;
 const initial=Array.from({length:40},(_,i)=>item(String(i)));
 const client={resolvePlayback:async(id:string)=>({ok:true,data:item(id)}),fetchFeedPage:()=>new Promise(resolve=>finish=resolve)}as unknown as DouyinClient;
 const queue=new DouyinPlaybackQueue(client,{items:initial,selectedAwemeId:'39',cursor:'cursor-0',hasMore:true});
 const warming=queue.preview('next');await Promise.resolve();queue.commitPreview('0');
 finish({ok:true,data:{items:[item('40')],nextCursor:'cursor-1',hasMore:true}});await warming;
 expect(queue.snapshot().item?.awemeId).toBe('0');expect(queue.snapshot().playlist).toHaveLength(40);expect(queue.snapshot().cursor).toBe('cursor-0');
});


test('DYINTENT selects 50 targets synchronously and fences an older delayed resolution',async()=>{
 let finish!:(value:any)=>void;
 const client={resolvePlayback:()=>new Promise(resolve=>finish=resolve)} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:Array.from({length:100},(_,i)=>item(String(i))),selectedAwemeId:'10',hasMore:false});
 const stale=q.next();await Promise.resolve();await Promise.resolve();
 for(let i=0;i<50;i++){expect(q.selectIntent('next')).toMatchObject({ok:true,data:{index:11+i}});expect(q.snapshot().index).toBe(11+i);}
 finish({ok:true,data:item('11')});expect(await stale).toMatchObject({ok:false,code:'CANCELLED'});expect(q.snapshot().index).toBe(60);
 q.selectIntent('previous',2);expect(q.snapshot().index).toBe(58);
});

test('DYHIT near and deep previews in the same direction do not cancel one another',async()=>{
 const pending=new Map<string,(value:any)=>void>();
 const client={resolvePlayback:(id:string)=>new Promise(resolve=>pending.set(id,resolve))}as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:['0','1','2','3','4'].map(item),selectedAwemeId:'2',hasMore:false});
 const all=[q.preview('next'),q.preview('next',2),q.preview('previous'),q.preview('previous',2)];
 await Promise.resolve();await Promise.resolve();
 for(const [id,resolve]of pending)resolve({ok:true,data:item(id)});
 expect((await Promise.all(all)).every(x=>x.ok)).toBe(true);expect(q.snapshot().item?.awemeId).toBe('2');
});

test('DYHIT refill starts at eight remaining items and coalesces while navigation continues',async()=>{
 let requests=0,finish!:(value:any)=>void;
 const client={resolvePlayback:async(id:string)=>({ok:true,data:item(id)}),fetchFeedPage:()=>{requests++;return new Promise(resolve=>finish=resolve);}}as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:Array.from({length:20},(_,i)=>item(String(i))),selectedAwemeId:'2',hasMore:true,cursor:'c0'});
 await q.fillAhead();expect(requests).toBe(0);
 q.commitPreview('12');const first=q.fillAhead(),second=q.fillAhead();expect(requests).toBe(1);expect(q.snapshot().item?.awemeId).toBe('12');
 q.commitPreview('10');finish({ok:true,data:{items:Array.from({length:12},(_,i)=>item(String(20+i))),nextCursor:'c1',hasMore:true}});await Promise.all([first,second]);
 expect(q.snapshot().item?.awemeId).toBe('10');expect(q.snapshot().playlist).toHaveLength(32);expect(q.snapshot().cursor).toBe('c1');
 await q.fillAhead();expect(requests).toBe(1);
});

test('DYFRAME next five and previous two previews never move the anchor or fetch detail',async()=>{
 const calls:{id:string;allowDetail?:boolean}[]=[];let pages=0;
 const client={resolvePlayback:async(id:string,options:any)=>{calls.push({id,allowDetail:options.allowDetail});return {ok:true,data:item(id)};},fetchFeedPage:async()=>{pages++;throw Error('far speculation must not fetch a page');}} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:Array.from({length:8},(_,i)=>item(String(i))),selectedAwemeId:'2',hasMore:true});
 for(const distance of [1,2,3,4,5] as const)expect(await q.preview('next',distance)).toMatchObject({ok:true,data:{item:{awemeId:String(2+distance)}}});
 for(const distance of [1,2] as const)expect(await q.preview('previous',distance)).toMatchObject({ok:true,data:{item:{awemeId:String(2-distance)}}});
 expect(q.snapshot().item?.awemeId).toBe('2');expect(calls).toHaveLength(7);expect(calls.every(c=>c.allowDetail===false)).toBe(true);expect(pages).toBe(0);
 q.commitPreview('7');expect(await q.preview('next',5)).toMatchObject({ok:false,code:'UNSUPPORTED'});expect(pages).toBe(0);
});

for(const limit of [1,2])test(`APPTESTS overflow keeps a bounded retry anchor until resolution succeeds (limit=${limit})`,async()=>{
 const initial=Array.from({length:limit},(_,i)=>item(String(i))),anchor=String(limit-1);
 let pages=0,finish!:(value:any)=>void;
 const calls:string[]=[];
 const client={
  fetchFeedPage:async()=>{pages++;return {ok:true,data:{items:[item('next'),item('tail'),item('last')],nextCursor:'done',hasMore:false}};},
  resolvePlayback:(id:string,options:any)=>{calls.push(id);expect(options.allowDetail).toBe(false);return new Promise(resolve=>finish=resolve);},
 } as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:initial,selectedAwemeId:anchor,cursor:'start',hasMore:true,limit});
 const first=q.next();for(let i=0;i<10;i++)await Promise.resolve();
 expect(calls).toEqual(['next']);expect(pages).toBe(1);
 expect(q.snapshot()).toMatchObject({item:{awemeId:anchor},cursor:'done',hasMore:false});expect(q.snapshot().playlist).toHaveLength(limit);
 finish({ok:false,code:'REQUEST_FAILED',message:'offline'});expect(await first).toMatchObject({code:'REQUEST_FAILED'});
 expect(q.snapshot().item?.awemeId).toBe(anchor);expect(q.snapshot().playlist).toHaveLength(limit);
 expect(q.diagnostics().quarantinedAwemeIds).toEqual([]);
 for(const id of ['next','tail','last']){
  const pending=q.next();for(let i=0;i<10;i++)await Promise.resolve();
  expect(q.snapshot().playlist.length).toBeLessThanOrEqual(limit);finish({ok:true,data:item(id)});
  expect(await pending).toMatchObject({ok:true,data:{item:{awemeId:id}}});expect(q.snapshot().item?.awemeId).toBe(id);
  expect(q.snapshot().playlist.length).toBeLessThanOrEqual(limit);
 }
 expect(await q.next()).toMatchObject({code:'UNSUPPORTED'});expect(pages).toBe(1);
 expect(calls).toEqual(['next','next','tail','last']);
});

test('APPTESTS an overflow preview keeps selection and can commit after a reverse jump',async()=>{
 let pages=0;
 const client={fetchFeedPage:async()=>{pages++;return {ok:true,data:{items:[item('c'),item('d')],nextCursor:'done',hasMore:false}};},resolvePlayback:async(id:string)=>({ok:true,data:item(id)})} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:[item('a'),item('b')],selectedAwemeId:'b',cursor:'start',hasMore:true,limit:2});
 expect(await q.preview('next')).toMatchObject({ok:true,data:{item:{awemeId:'c'},index:0}});
 expect(q.snapshot().item?.awemeId).toBe('b');expect(q.snapshot().playlist.map(i=>i.awemeId)).toEqual(['a','b']);
 q.commitPreview('a');expect(q.snapshot().item?.awemeId).toBe('a');
 expect(await q.preview('next',2)).toMatchObject({ok:true,data:{item:{awemeId:'c'}}});
 expect(q.snapshot().item?.awemeId).toBe('a');
 q.commitPreview('c');expect(q.snapshot().playlist.map(i=>i.awemeId)).toEqual(['c','d']);expect(q.snapshot().item?.awemeId).toBe('c');expect(pages).toBe(1);
});
