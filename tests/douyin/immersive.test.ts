import { expect, test } from "bun:test";
import { DouyinClient } from "../../src/douyin/client.ts";
import { DouyinPlaybackQueue } from "../../src/douyin/playback-queue.ts";
import { DouyinFeedStore, FEED_KEY, RECENT_KEY } from "../../src/douyin/feed-store.ts";
import type { DouyinItem, DouyinSecureStorage } from "../../src/douyin/types.ts";
import { utf8Encode } from "../../src/cloud/types.ts";

class Store implements DouyinSecureStorage {
  values=new Map<string,string>();
  async get(k:string){return this.values.get(k)??null;}
  async set(k:string,v:string){this.values.set(k,v);}
  async remove(k:string){this.values.delete(k);}
}
const item=(id:string):DouyinItem=>({awemeId:id,description:id,createdAtSeconds:0,authorId:"",authorName:"",likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:100,variants:[]});
const wire=(id:string)=>({aweme_id:id,desc:id,video:{play_addr:{url_list:[`https://video/${id}`]}}});
function fixture(){
  const store=new Store();store.values.set("douyin.cookie","sessionid=test");let now=1000,calls=0,fail=false;
  const make=()=>new DouyinClient({secureStorage:store,now:()=>now,signer:{sign:()=>"test"},transport:{async request(request){calls++;return {status:fail?403:200,headers:{},body:utf8Encode(JSON.stringify(request.method==="POST"?{aweme_list:[wire("1"),wire("2"),wire("3")],cursor:"tail",has_more:1}:{aweme_detail:wire(new URL(request.url).searchParams.get("aweme_id")!)}))};}}});
  return {store,make,advance:()=>now+=300_000,calls:()=>calls,fail:()=>fail=true};
}

test("restart restores the prepared video anchor and page cursor without a network request",async()=>{
  const f=fixture(),client=f.make();await client.fetchFeedPage();
  const queue=new DouyinPlaybackQueue(client,{items:client.feedSnapshot().items,selectedAwemeId:"1",cursor:"tail",hasMore:true});
  await queue.next();await queue.settled();
  const restored=f.make(),snapshot=await restored.restoreFeed();
  expect(snapshot).toMatchObject({anchorAwemeId:"2",cursor:"tail",hasMore:true});
  const resumed=new DouyinPlaybackQueue(restored,{...snapshot,selectedAwemeId:snapshot.anchorAwemeId!});
  expect(await resumed.current()).toMatchObject({ok:true,data:{item:{awemeId:"2"}}});expect(f.calls()).toBe(1);
  expect(await restored.listHistory()).toMatchObject([{item:{awemeId:"2"}}]);
});

test("expired persisted URLs are re-resolved, forced recovery never falls back to the failed URL",async()=>{
  const f=fixture(),client=f.make();await client.fetchFeedPage();await client.saveRecentWindow(client.feedSnapshot().items,"2","tail",true);
  f.advance();const restored=f.make();await restored.restoreFeed();
  expect(await restored.resolvePlayback("2")).toMatchObject({ok:true,source:"network"});expect(f.calls()).toBe(2);
  f.fail();expect(await restored.resolvePlayback("2",{forceRefresh:true})).toMatchObject({ok:false,code:"REQUEST_FAILED"});
});

test("prefetch resolves adjacent URLs without changing selection or history",async()=>{
  const f=fixture(),client=f.make();await client.fetchFeedPage();f.advance();
  const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2"),item("3")],selectedAwemeId:"1"});
  await queue.prefetch();expect(f.calls()).toBe(3);expect(queue.snapshot().item?.awemeId).toBe("1");expect(await client.listHistory()).toEqual([]);
  await queue.next();expect(f.calls()).toBe(3);await queue.settled();expect(await client.listHistory()).toHaveLength(1);
});

test("failed source refresh quarantines that item and skips unresolvable successors",async()=>{
  const requests:string[]=[];const client={async resolvePlayback(id:string,options?:{forceRefresh?:boolean}){requests.push(`${id}:${!!options?.forceRefresh}`);return id==="3"?{ok:true,data:item(id)}:{ok:false,code:"REQUEST_FAILED",message:"expired"};}} as unknown as DouyinClient;
  const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2"),item("3")],selectedAwemeId:"1"});
  expect(await queue.recover()).toMatchObject({ok:true,data:{item:{awemeId:"3"},index:0}});
  expect(requests).toEqual(["1:true","2:false","3:false"]);expect(queue.snapshot().playlist.map(x=>x.awemeId)).toEqual(["3"]);
});

test("discarding the sole item can refill with the first new page item",async()=>{
  const client={async resolvePlayback(id:string){return {ok:true,data:item(id)};},async fetchFeedPage(){return {ok:true,data:{items:[item("1"),item("2")],nextCursor:null,hasMore:false}};}} as unknown as DouyinClient;
  const queue=new DouyinPlaybackQueue(client,{items:[item("1")],selectedAwemeId:"1",cursor:"tail",hasMore:true});
  expect(await queue.discard()).toMatchObject({ok:true,data:{item:{awemeId:"2"},index:0}});
});

test("late recovery cannot replace a newer navigation",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const client={async resolvePlayback(id:string,options?:{forceRefresh?:boolean}){if(options?.forceRefresh)await gate;return {ok:true,data:item(id)};}} as unknown as DouyinClient;
  const queue=new DouyinPlaybackQueue(client,{items:[item("1"),item("2")],selectedAwemeId:"1"});
  const recovery=queue.recover();await queue.next();release();expect(await recovery).toMatchObject({ok:false,code:"CANCELLED"});expect(queue.snapshot().item?.awemeId).toBe("2");
});

test("duplicate-only pagination is bounded and does not resurrect quarantined videos",async()=>{
  let pages=0;const client={async resolvePlayback(){return {ok:false,code:"REQUEST_FAILED",message:"bad"};},async fetchFeedPage(){pages++;return {ok:true,data:{items:[item("1")],nextCursor:"same",hasMore:true}};}} as unknown as DouyinClient;
  const queue=new DouyinPlaybackQueue(client,{items:[item("1")],selectedAwemeId:"1",cursor:"same",hasMore:true});
  expect(await queue.discard()).toMatchObject({ok:false});expect(pages).toBe(1);expect(queue.snapshot().playlist).toEqual([]);
});

test("persistent cache tolerates corruption, deduplicates, bounds windows and preserves a late anchor",async()=>{
  const store=new Store(),feed=new DouyinFeedStore(store);store.values.set(FEED_KEY,"{");store.values.set(RECENT_KEY,JSON.stringify({items:[null,{},item("1"),item("1"),{...item("2"),playUrl:""}],anchorAwemeId:"missing"}));
  expect(await feed.bootstrap()).toMatchObject({items:[item("1")],anchorAwemeId:null});
  const f=fixture(),client=f.make(),items=Array.from({length:90},(_,i)=>item(String(i)));
  await client.saveRecentWindow(items,"80","cursor",true);const snapshot=await f.make().restoreFeed();expect(snapshot.items.length).toBeLessThanOrEqual(40);expect(JSON.parse(f.store.values.get(RECENT_KEY)!).items).toHaveLength(4);expect(snapshot.anchorAwemeId).toBe("80");
  const queue=new DouyinPlaybackQueue(client,{items,selectedAwemeId:"80"});expect(queue.snapshot().playlist).toHaveLength(40);expect(queue.snapshot().item?.awemeId).toBe("80");
});

test("logout clears feed/recent cache but preserves local watch history",async()=>{
  const f=fixture(),client=f.make();await client.fetchFeedPage();await client.recordHistory(item("2"));await client.saveRecentWindow([item("2")],"2",null,false);await client.logout();
  expect((await f.make().restoreFeed()).items).toEqual([]);expect(await client.listHistory()).toHaveLength(1);
});

test("bootstrap uses the newer URL with its own timestamp and starts at the recent anchor",async()=>{
  const store=new Store(),feed=new DouyinFeedStore(store);
  await feed.save(FEED_KEY,{items:[item("2"),{...item("3"),playUrl:"https://fresh/3"},item("4")],anchorAwemeId:null,cursor:"new",hasMore:true,savedAtMillis:2000,resolved:{"2":2000,"3":2000,"4":2000}});
  await feed.save(RECENT_KEY,{items:[item("1"),item("2"),item("3")],anchorAwemeId:"2",cursor:"old",hasMore:true,savedAtMillis:1000,resolved:{"1":1000,"2":1000,"3":1000}});
  const restored=await feed.bootstrap();expect(restored.items.map(x=>x.awemeId)).toEqual(["2","3","4"]);expect(restored.items[1].playUrl).toBe("https://fresh/3");expect(restored.resolved["3"]).toBe(2000);
});

test("rapid prepared transitions persist in order and the last anchor wins",async()=>{
  const f=fixture(),client=f.make();await client.fetchFeedPage();const queue=new DouyinPlaybackQueue(client,{items:client.feedSnapshot().items,selectedAwemeId:"1",cursor:"tail",hasMore:true});
  const first=queue.settled();await queue.next();const second=queue.settled();await Promise.all([first,second]);
  expect((await f.make().restoreFeed()).anchorAwemeId).toBe("2");expect((await client.listHistory()).map(x=>x.item.awemeId)).toEqual(["2","1"]);
});

test("clearing an exhausted playback window does not delete history",async()=>{
  const f=fixture(),client=f.make();await client.fetchFeedPage();await client.recordHistory(item("1"));await client.saveRecentWindow([item("1")],"1",null,false);await client.clearPlaybackWindow();
  expect((await client.restoreFeed()).items).toEqual([]);expect(await client.isLoggedIn()).toBe(true);expect(await client.listHistory()).toHaveLength(1);
});
