import { expect, test } from "bun:test";
import { DouyinClient, parseDouyinDetail, parseDouyinFeed, type DouyinSecureStorage } from "../../src/douyin/index.ts";
import { utf8Encode } from "../../src/cloud/types.ts";
import type { HttpRequest, HttpTransport } from "../../src/cloud/types.ts";

class MemoryStore implements DouyinSecureStorage { values=new Map<string,string>();async get(k:string){return this.values.get(k)??null;}async set(k:string,v:string){this.values.set(k,v);}async remove(k:string){this.values.delete(k);} }
const item={aweme_id:"7",desc:"demo",create_time:12,author:{uid:"u",nickname:"作者",avatar_thumb:{url_list:["https://img/avatar"]}},statistics:{digg_count:9,comment_count:2,share_count:3,collect_count:4},video:{duration:1500,play_addr:{url_list:["https://video/main"],width:720,height:1280},cover:{url_list:["https://img/cover"]},bit_rate:[{gear_name:"normal_720_0",codec_type:"h264",bit_rate:123,play_addr:{url_list:["https://video/h264"],width:720,height:1280}}]}};

test("parses Android-compatible feed and detail shapes",()=>{const page=parseDouyinFeed(JSON.stringify({aweme_list:[item],max_cursor:99,has_more:1}));expect(page.nextCursor).toBe("99");expect(page.hasMore).toBe(true);expect(page.items[0]).toMatchObject({awemeId:"7",playUrl:"https://video/h264",authorName:"作者"});expect(page.items[0].variants[0].codec).toBe("h264");expect(parseDouyinDetail(JSON.stringify({aweme_detail:item}))).toMatchObject({kind:"video",item:{awemeId:"7"}});expect(parseDouyinDetail(JSON.stringify({aweme_detail:{...item,aweme_type:68,images:[{url_list:["https://img/1"]}]}}))).toEqual({kind:"note",awemeId:"7",description:"demo",authorName:"作者",likeCount:9,imageUrls:["https://img/1"]});});

test("requires secure cookie and signed Android request contract",async()=>{const requests:HttpRequest[]=[];const transport:HttpTransport={async request(r){requests.push(r);return {status:200,headers:{},body:utf8Encode(JSON.stringify({aweme_list:[item],cursor:"next",has_more:0}))};}};const store=new MemoryStore();let signed:Readonly<Record<string,string>>|undefined;const client=new DouyinClient({transport,secureStorage:store,signer:{sign(p){signed=p;return "signature";}}});expect(await client.fetchFeedPage()).toEqual({ok:false,code:"NOT_LOGGED_IN",message:"未登录"});await client.applyCookie(" sessionid=secret ");const result=await client.fetchFeedPage({cursor:"42",count:99});expect(result.ok&&result.data.items[0].awemeId).toBe("7");expect(requests[0]).toMatchObject({method:"POST",headers:{Cookie:"sessionid=secret",Referer:"https://www.douyin.com/",Accept:"application/json"},body:new Uint8Array(0)});expect(requests[0].url).toContain("/aweme/v2/web/module/feed/");expect(requests[0].url).toContain("count=20");expect(requests[0].url).toContain("a_bogus=signature");expect(signed).toMatchObject({aid:"6383",cursor:"42",max_cursor:"42",msToken:""});});

test("history stays local across logout and unsupported operations perform no request",async()=>{let requests=0;const store=new MemoryStore();const client=new DouyinClient({transport:{async request(){requests++;throw new Error("must not call");}},secureStorage:store,signer:{sign:()=>"x"},now:()=>123});await client.recordHistory(parseDouyinFeed(JSON.stringify({aweme_list:[item]})).items[0]);expect(await client.listHistory()).toMatchObject([{watchedAtMillis:123,item:{awemeId:"7"}}]);expect(await client.listWatchedIds()).toEqual(["7"]);expect(await client.search("猫")).toMatchObject({ok:false,code:"UNSUPPORTED"});expect(await client.interact("7","like")).toMatchObject({ok:false,code:"UNSUPPORTED"});expect(requests).toBe(0);await client.logout();expect(await client.listHistory()).toHaveLength(1);await client.clearHistory();expect(await client.listHistory()).toEqual([]);expect(await client.listWatchedIds()).toEqual([]);});

test("favorites and watch later are separate local app lists",async()=>{const store=new MemoryStore(),client=new DouyinClient({transport:{async request(){throw new Error("unused");}},secureStorage:store,signer:{sign:()=>"x"},now:()=>456});const video=parseDouyinFeed(JSON.stringify({aweme_list:[item]})).items[0];expect(await client.getSavedState("7")).toEqual({favorite:false,watchLater:false});expect(await client.toggleSaved(video,"favorite")).toBe(true);expect(await client.setSaved(video,"watchLater",true)).toBe(true);expect(await client.getSavedState("7")).toEqual({favorite:true,watchLater:true});expect(await client.listSaved("favorite")).toMatchObject([{platform:"douyin",awemeId:"7",kind:"favorite",shareUrl:"https://www.douyin.com/video/7",savedAtMillis:456}]);expect(await client.toggleSaved(video,"favorite")).toBe(false);expect(await client.getSavedState("7")).toEqual({favorite:false,watchLater:true});await client.logout();expect(await client.listSaved("watchLater")).toHaveLength(1);});

test("cookie import follows Android rule: trimmed non-empty header, no sessionid requirement",async()=>{const store=new MemoryStore(),client=new DouyinClient({transport:{async request(){throw new Error("unused");}},secureStorage:store,signer:{sign:()=>"x"}});expect(await client.applyCookie(" ttwid=only-cookie ")).toEqual({ok:true,data:undefined});expect(await client.readCookie()).toBe("ttwid=only-cookie");expect(await client.applyCookie("  ")).toMatchObject({ok:false,code:"NOT_LOGGED_IN"});});

test('blocked responses preserve authentication; malformed JSON is a parse failure',async()=>{
 const store=new MemoryStore();await store.set('douyin.cookie','x');let now=0;const replies=['blocked','{'];
 const client=new DouyinClient({now:()=>now,transport:{async request(){return {status:200,headers:{},body:utf8Encode(replies.shift()!) };}},secureStorage:store,signer:{sign:()=> 'x'}});
 expect(await client.fetchFeedPage()).toMatchObject({ok:false,code:'TEMPORARILY_UNAVAILABLE'});expect(await client.isLoggedIn()).toBe(true);
 now=30000;expect(await client.fetchFeedPage()).toMatchObject({ok:false,code:'PARSE_FAILED'});
});
test('disabled retry preserves Cookie for both returned and thrown HTTP403',async()=>{
 for(const thrown of [false,true]){
  const store=new MemoryStore();await store.set('douyin.cookie','x');let redirects=0;
  const client=new DouyinClient({auth403:{enabled:false},secureStorage:store,signer:{sign:()=> 'x'},transport:{async request(){if(thrown)throw new Error('http_status:403');return {status:403,headers:{},body:utf8Encode('forbidden')};}}});
  client.onAuthExpired(()=>redirects++);expect(await client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
  expect(await client.isLoggedIn()).toBe(true);expect(redirects).toBe(0);
 }
});

test("resolvePlayback refreshes when the feed cache is expired",async()=>{let now=0,calls=0;const store=new MemoryStore();await store.set("douyin.cookie","x");const client=new DouyinClient({transport:{async request(){calls++;return {status:200,headers:{},body:utf8Encode(JSON.stringify(calls===1?{aweme_list:[item]}:{aweme_detail:{...item,desc:"fresh"}}))};}},secureStorage:store,signer:{sign:()=>"x"},now:()=>now});await client.fetchFeedPage();now=5*60*1000;const result=await client.resolvePlayback("7");expect(result).toMatchObject({ok:true,source:"network",data:{description:"fresh"}});expect(calls).toBe(2);});

import nativeFeed from '../fixtures/douyin-feed-native.json';
test('recommendation keeps native parameters with the observed web version defaults',async()=>{
  const store=new MemoryStore();await store.set('douyin.cookie','fixture');let signed:Readonly<Record<string,string>>={};const requests:HttpRequest[]=[];
  const client=new DouyinClient({secureStorage:store,signer:{sign:params=>{signed=params;return 'sig';}},transport:{request:async request=>{requests.push(request);return {status:200,headers:{},body:utf8Encode('{"aweme_list":[]}')};}}});
  await client.fetchFeedPage({count:16});
  expect(signed).toEqual({...nativeFeed.params,version_code:'170400',version_name:'17.4.0',browser_version:'155.0.0.0',engine_version:'155.0.0.0'});expect(new URL(requests[0]!.url).pathname).toBe(nativeFeed.path);expect(requests[0]!.method).toBe(nativeFeed.method);
});
