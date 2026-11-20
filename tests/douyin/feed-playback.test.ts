import {expect,test} from 'bun:test';
import {URL as NodeURL} from 'node:url';
import {DouyinClient} from '../../src/douyin/client.ts';
import {reloadDouyinPlayback} from '../../src/douyin/reload-playback.ts';
import {DouyinPlaybackQueue} from '../../src/douyin/playback-queue.ts';
import {DOUYIN_AUTH403_COOLDOWN_KEY} from '../../src/douyin/auth403.ts';
import {utf8Encode} from '../../src/cloud/types.ts';
import type {HttpRequest,HttpResponse} from '../../src/cloud/types.ts';
const wire=(id:string)=>({aweme_id:id,video:{play_addr:{url_list:['https://fixture.invalid/'+id]},bit_rate:[{codec_type:'h264',bit_rate:400000,play_addr:{width:540,height:960,url_list:['https://fixture.invalid/'+id+'-540']}}]}});
const response=(body:unknown,status=200):HttpResponse=>({status,headers:{},body:utf8Encode(JSON.stringify(body))});
function fixture(){
 let now=1_000_000;const values=new Map([['douyin.cookie','fixture']]),requests:HttpRequest[]=[],replies:Array<HttpResponse|Promise<HttpResponse>>=[];
 const secure={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};
 const options={now:()=>now,secureStorage:secure,signer:{sign:()=> 'fixture'},auth403:{sleep:async()=>{},probe:async()=> 'authenticated' as const},transport:{request:async(r:HttpRequest)=>{requests.push(r);const reply=replies.shift();if(!reply)throw Error('unexpected request');return reply;}}};
 return {values,requests,replies,options,client:new DouyinClient(options),advance:(ms:number)=>{now+=ms;}};
}
const detailCount=(f:ReturnType<typeof fixture>)=>f.requests.filter(r=>new URL(r.url).pathname.includes('/detail/')).length;
test('feed opens player and resolves both neighbours with zero detail requests',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:['a','b','c'].map(wire)}));const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 const queue=new DouyinPlaybackQueue(f.client,{items:page.data.items,selectedAwemeId:'b',hasMore:false});
 expect(await queue.current()).toMatchObject({ok:true,data:{item:{awemeId:'b',playUrl:'https://fixture.invalid/b-540'}}});
 expect(await queue.preview('previous')).toMatchObject({ok:true,data:{item:{awemeId:'a'}}});
 expect(await queue.preview('next')).toMatchObject({ok:true,data:{item:{awemeId:'c'}}});
 expect(await f.client.resolvePlayback('a',{prefetch:true})).toMatchObject({ok:true,source:'feed-cache'});
 expect(await f.client.resolvePlayback('c',{prefetch:true})).toMatchObject({ok:true,source:'feed-cache'});
 expect(detailCount(f)).toBe(0);expect(f.requests).toHaveLength(1);
});
test('manual retry resolves the selected aweme through detail despite fresh feed metadata',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:[wire('selected')]}));
 const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 const item=page.data.items[0]!;
 const fresh=wire('selected');fresh.video.bit_rate[0]!.play_addr.url_list=['https://fixture.invalid/fresh'];
 f.replies.push(response({aweme_detail:fresh}));
 expect(await reloadDouyinPlayback(f.client,item.awemeId,()=>true,item,'detail')).toMatchObject({item:{awemeId:'selected',playUrl:'https://fixture.invalid/fresh'}});
 const retries=f.requests.slice(1).map(request=>new NodeURL(request.url));
 expect(retries.map(url=>[url.pathname,url.searchParams.get('aweme_id')])).toEqual([['/aweme/v1/web/aweme/detail/','selected']]);
});
test('detail retry refuses the previous URL, its mirror, expired URLs and a mismatched aweme',async()=>{
 const f=fixture(),original=wire('selected'),oldMirror='https://fixture.invalid/old-mirror';
 original.video.bit_rate[0]!.play_addr.url_list.push(oldMirror);
 f.replies.push(response({aweme_list:[original]}));
 const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 const item=page.data.items[0]!;
 const mirror=wire('selected');mirror.video.bit_rate[0]!.play_addr.url_list=[oldMirror];
 const expired=wire('selected');expired.video.bit_rate[0]!.play_addr.url_list=['https://fixture.invalid/new?x-expires=1000000000'];
 f.replies.push(response({aweme_detail:original}),response({aweme_detail:mirror}),response({aweme_detail:wire('other')}),response({aweme_detail:expired}));
 for(let i=0;i<4;i++)await expect(reloadDouyinPlayback(f.client,item.awemeId,()=>true,item,'detail')).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
 expect(detailCount(f)).toBe(4);expect(f.requests).toHaveLength(5);
});
test('manual detail retry uses the persisted detail 403 cooldown and never falls back to feed',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:[wire('selected')]}));
 const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 const item=page.data.items[0]!;
 f.replies.push(response({},403),response({},403));
 await expect(reloadDouyinPlayback(f.client,item.awemeId,()=>true,item,'detail')).rejects.toMatchObject({code:'RATE_LIMITED'});
 const before=f.requests.length;
 const restarted=new DouyinClient(f.options);
 await expect(reloadDouyinPlayback(restarted,item.awemeId,()=>true,item,'detail')).rejects.toMatchObject({code:'RATE_LIMITED'});
 expect(f.requests).toHaveLength(before);expect(detailCount(f)).toBe(before-1);
 expect(f.values.get('douyin.cookie')).toBe('fixture');
});
test('detail 403 cooldown survives restart and feed success without blocking feed playback',async()=>{
 const f=fixture();f.replies.push(response({},403),response({},403));expect(await f.client.resolvePlayback('missing',{prefetch:true})).toMatchObject({code:'RATE_LIMITED'});
 const detailBefore=detailCount(f),before=JSON.parse(f.values.get(DOUYIN_AUTH403_COOLDOWN_KEY)!);expect(before.endpoints.detail.until).toBeGreaterThan(1_000_000);expect(before.endpoints.feed.until).toBe(0);
 const restarted=new DouyinClient(f.options);f.replies.push(response({aweme_list:[wire('missing'),wire('b'),wire('c')]}));expect(await restarted.fetchFeedPage()).toMatchObject({ok:true});
 expect(await restarted.resolvePlayback('missing')).toMatchObject({ok:true,source:'feed-cache'});
 // New feed URLs also supersede a prior speculative failure in the same client.
 f.replies.push(response({aweme_list:[wire('missing')]}));await f.client.fetchFeedPage();expect(await f.client.resolvePlayback('missing',{prefetch:true})).toMatchObject({ok:true,source:'feed-cache'});
 expect(JSON.parse(f.values.get(DOUYIN_AUTH403_COOLDOWN_KEY)!).endpoints.detail).toEqual(before.endpoints.detail);
 expect(detailCount(f)).toBe(detailBefore);expect(f.values.get('douyin.cookie')).toBe('fixture');
});
test('expired feed URL performs one coalesced detail fallback; subsequent playback reuses it',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:[wire('a')]}));await f.client.fetchFeedPage();f.advance(300000);
 f.replies.push(response({aweme_detail:wire('a')}));const results=await Promise.all([f.client.resolvePlayback('a'),f.client.resolvePlayback('a',{prefetch:true})]);
 expect(results.every(r=>r.ok)).toBe(true);expect(detailCount(f)).toBe(1);expect(await f.client.resolvePlayback('a')).toMatchObject({ok:true,source:'feed-cache'});expect(detailCount(f)).toBe(1);
});
test('fresh feed supersedes an outstanding stale detail request without waiting for it',async()=>{
 const f=fixture();let complete!:(r:HttpResponse)=>void;f.replies.push(new Promise<HttpResponse>(r=>complete=r));const stale=f.client.resolvePlayback('a');
 while(f.requests.length===0)await new Promise(r=>setTimeout(r,1));f.replies.push(response({aweme_list:[wire('a')]}));await f.client.fetchFeedPage();
 expect(await f.client.resolvePlayback('a')).toMatchObject({ok:true,source:'feed-cache'});expect(await f.client.fetchDetail('a')).toMatchObject({ok:true,source:'feed-cache'});
 complete(response({},403));f.replies.push(response({},403));await stale;expect(await f.client.resolvePlayback('a')).toMatchObject({ok:true,source:'feed-cache'});
});

test('DYSWIPE3 200 feed swipes, both neighbours and refills never use detail across soft expiry/LRU eviction',async()=>{
 let now=1_000_000,feed=0,detail=0;const values=new Map([['douyin.cookie','fixture']]);
 const client=new DouyinClient({now:()=>now,secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},signer:{sign:()=> 'fixture'},transport:{request:async request=>{
  const url=new NodeURL(request.url);if(url.pathname.includes('/detail/')){detail++;return response({},403);}
  expect(url.pathname).toContain('/feed/');feed++;const start=Number(url.searchParams.get('cursor')??url.searchParams.get('max_cursor')??0);
  return response({aweme_list:Array.from({length:4},(_,i)=>wire(String(start+i))),max_cursor:start+4,has_more:1});
 }}});
 const first=await client.fetchFeedPage();if(!first.ok)throw Error(JSON.stringify(first));
 const queue=new DouyinPlaybackQueue(client,{items:first.data.items,selectedAwemeId:'0',cursor:first.data.nextCursor,hasMore:true});
 now+=300001;
 for(let i=0;i<200;i++){
  if(i)expect((await queue.preview('previous')).ok).toBe(true);
  const next=await queue.preview('next');expect(detail).toBe(0);expect(next.ok).toBe(true);if(!next.ok)throw Error(next.message);
  expect((await client.resolvePlayback(next.data.item.awemeId,{prefetch:true,feedItem:next.data.item,allowDetail:false})).ok).toBe(true);
  await queue.prefetch();expect((await queue.next()).ok).toBe(true);now+=1000;
 }
 expect(detail).toBe(0);expect(feed).toBeGreaterThan(1);expect(queue.snapshot().item?.awemeId).toBe('200');
 console.log('DYSWIPE3_FEED_MODEL '+JSON.stringify({swipes:200,detail,feed,softExpiryCrossed:true,queueBound:40}));
});

test('DYSWIPE3 expired feed-owned URL never starts implicit detail; explicit detail cooldown cannot block it',async()=>{
 const f=fixture();f.replies.push(response({},403),response({},403));await f.client.fetchDetail('explicit',{forceRefresh:true});const before=detailCount(f);
 const supplied={awemeId:'cold',description:'',createdAtSeconds:0,authorId:'',authorName:'',likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:'https://fixture.invalid/cold',durationMs:1000,variants:[]};
 expect(await f.client.resolvePlayback('cold',{feedItem:supplied,allowDetail:false})).toMatchObject({ok:true,source:'feed-cache'});
 f.advance(300001);expect(await f.client.resolvePlayback('cold',{feedItem:supplied,allowDetail:false,prefetch:true})).toMatchObject({ok:true});
 expect(detailCount(f)).toBe(before);
});

test('DYSWIPE3 variant-only feed metadata and expired/rejected URLs use feed instead of detail',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:[wire('a')]}));const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 const item=page.data.items[0]!;f.advance(300001);
 expect(await f.client.resolvePlayback('a',{feedItem:{...item,playUrl:''},allowDetail:false})).toMatchObject({ok:true});
 f.advance(2_000_000_000_000);
 for(const options of [{forceRefresh:true,feedItem:item},{feedItem:{...item,variants:[],playUrl:'https://fixture.invalid/a?expires=100000000'}}]){
  f.advance(300001);f.replies.push(response({aweme_list:[wire('a')]}));expect(await f.client.resolvePlayback('a',{...options,allowDetail:false})).toMatchObject({ok:true});
 }
 expect(detailCount(f)).toBe(0);expect(f.requests).toHaveLength(3);
});

test('pager publishes authorized feed metadata while its queued durable write is pending; logout clears after that write',async()=>{
 const f=fixture();let release!:()=>void,writing=false;
 const gate=new Promise<void>(resolve=>release=resolve),original=f.options.secureStorage.set;
 f.options.secureStorage.set=async(key,value)=>{if(key.startsWith('douyin.playback-item.v2.')){writing=true;await gate;}await original(key,value);};
 f.replies.push(response({aweme_list:[wire('early')]}));
 const page=await f.client.fetchFeedPage({deferPersistence:true});expect(page.ok).toBe(true);
 while(!writing)await new Promise(resolve=>setTimeout(resolve,1));
 expect(await f.client.resolvePlayback('early',{feedItem:page.ok?page.data.items[0]:undefined,allowDetail:false})).toMatchObject({ok:true,source:'feed-cache'});
 let cleared=false;const logout=f.client.clearCookie().then(()=>cleared=true);
 await new Promise(resolve=>setTimeout(resolve,1));expect(cleared).toBe(false);
 release();await logout;
 expect(f.values.has('douyin.cookie')).toBe(false);expect([...f.values.keys()].filter(key=>key.startsWith('douyin.playback-item.v2.'))).toEqual([]);
 expect(detailCount(f)).toBe(0);
});

test('budgeted feed-only source recovery can play while the snapshot write is pending',async()=>{
 const f=fixture();
 f.replies.push(response({aweme_list:[wire('recover')]}));
 const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 const item=page.data.items[0]!;
 const pod=Object.getOwnPropertyDescriptor(globalThis,'pod');
 Object.defineProperty(globalThis,'pod',{configurable:true,value:{memoryBudgetBytes:()=>128_000_000}});
 let release!:()=>void,writeStarted!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 const writing=new Promise<void>(resolve=>writeStarted=resolve);
 const original=f.options.secureStorage.set;
 f.options.secureStorage.set=async(key,value)=>{
  if(key.startsWith('douyin.playback-item.v2.')){writeStarted();await gate;}
  await original(key,value);
 };
 f.advance(1);
 f.replies.push(response({aweme_list:[wire('recover')]}));
 let result:Awaited<ReturnType<DouyinClient['resolvePlayback']>>|undefined;
 const recovery=f.client.resolvePlayback(item.awemeId,{forceRefresh:true,allowDetail:false,feedItem:item}).then(value=>result=value);
 try{
  await writing;
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(result).toMatchObject({ok:true,source:'feed-cache'});
  expect(new NodeURL(f.requests.at(-1)!.url).searchParams.get('count')).toBe('5');
  expect(detailCount(f)).toBe(0);
 }finally{
  release();
  await recovery;
  await f.client.restorePlaybackQueue();
  if(pod)Object.defineProperty(globalThis,'pod',pod);else Reflect.deleteProperty(globalThis,'pod');
 }
});

test('RELOAD forced detail resolution does not join an older unforced request',async()=>{
 const f=fixture();let release!:(v:HttpResponse)=>void;
 f.replies.push(new Promise<HttpResponse>(yes=>release=yes),response({aweme_detail:{...wire('same'),video:{play_addr:{url_list:['https://fixture.invalid/fresh']}}}}));
 const normal=f.client.resolvePlayback('same');
 for(let n=0;n<60;n++)await Promise.resolve();
 const forced=f.client.resolvePlayback('same',{forceRefresh:true,allowDetail:true,freshRequest:true});
 for(let n=0;n<60;n++)await Promise.resolve();
 const count=detailCount(f);release(response({aweme_detail:wire('same')}));
 const [old,fresh]=await Promise.all([normal,forced]);
 expect(count).toBe(2);expect(old.ok).toBe(true);expect(fresh).toMatchObject({ok:true,data:{playUrl:'https://fixture.invalid/fresh'}});
 expect(await f.client.resolvePlayback('same')).toMatchObject({ok:true,data:{playUrl:'https://fixture.invalid/fresh'}});
});

test('first-page publication preserves the requested size and survives an unavailable snapshot store',async()=>{
 const f=fixture();const write=f.options.secureStorage.set;
 f.options.secureStorage.set=async(key,value)=>{if(key.startsWith('douyin.playback-item.v2.'))throw Error('disk full');await write(key,value);};
 f.replies.push(response({aweme_list:[wire('first')]}));
 expect(await f.client.fetchFeedPage({count:16,publishBeforeSave:true})).toMatchObject({ok:true,data:{items:[{awemeId:'first'}]}});
 expect(new NodeURL(f.requests[0]!.url).searchParams.get('count')).toBe('16');
});
test('logout while reading the previous queue cannot reintroduce cached video URLs',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:[wire('old')]}));const page=await f.client.fetchFeedPage();if(!page.ok)throw Error('feed');
 await f.client.savePlaybackQueue(page.data.items,'old',null,false);
 let readStarted!:(value?:unknown)=>void,release!:(value?:unknown)=>void;
 const started=new Promise(r=>readStarted=r),gate=new Promise(r=>release=r),get=f.options.secureStorage.get;
 f.options.secureStorage.get=async key=>{const value=await get(key);if(key.startsWith('douyin.playback-item.v2.')){readStarted();await gate;}return value;};
 const restore=f.client.restorePlaybackQueue();await started;const logout=f.client.logout();release();
 const result=await restore;await logout;
 expect(result.items).toEqual([]);expect(f.client.feedSnapshot().items).toEqual([]);
});

test('cached detail lookup leaves its existing payload weight in place',async()=>{
 const f=fixture();f.replies.push(response({aweme_list:[wire('hot')]}));
 const result=await f.client.fetchFeedPage();if(!result.ok)throw Error('missing hot page');
 const hot=result.data.items[0]!,description=hot.description;let reads=0;
 Object.defineProperty(hot,'description',{configurable:true,enumerable:true,get(){reads++;return description;}});
 expect((await f.client.fetchDetail('hot')).ok).toBe(true);expect(reads).toBe(0);
});
