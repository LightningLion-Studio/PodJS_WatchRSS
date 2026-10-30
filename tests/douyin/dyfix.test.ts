import {expect,test} from 'bun:test';
import {DouyinClient,DOUYIN_DETAIL_MAX_REQUESTS,DOUYIN_DETAIL_WINDOW_MS} from '../../src/douyin/client.ts';
import {DouyinPlaybackQueue} from '../../src/douyin/playback-queue.ts';
import {parseDouyinFeed,parseDouyinFeedAsync,parseDouyinDetail} from '../../src/douyin/parser.ts';
import {douyinFeedSeenKey} from '../../src/douyin/recommendations.ts';
import {douyinMediaExpiry} from '../../src/douyin/media-expiry.ts';
import {DouyinCodecRuntimePolicy} from '../../src/douyin/playback-selector.ts';
import {formatDouyinError} from '../../src/douyin/errors.ts';
import type {DouyinItem,DouyinErrorCode,DouyinClientOptions} from '../../src/douyin/types.ts';
import type {HttpRequest,HttpResponse} from '../../src/cloud/types.ts';
const item=(id:string):DouyinItem=>({awemeId:id,playUrl:'https://fixture/'+id,description:id,createdAtSeconds:0,authorId:'',authorName:'',likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:100,variants:[]});
const wire=(id:string,url='https://fixture/'+id)=>({aweme_id:id,video:{play_addr:{url_list:[url]}}});
const response=(body:unknown,status=200):HttpResponse=>({status,headers:{},body:new TextEncoder().encode(typeof body==='string'?body:JSON.stringify(body))});
const page=(ids:string[],cursor='same',hasMore=1)=>response({aweme_list:ids.map(id=>wire(id)),cursor,has_more:hasMore});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {resolve,promise};}
const flush=async()=>{for(let i=0;i<150;i++)await Promise.resolve();};
function fixture(extra:Partial<DouyinClientOptions>={}){
 let now=1_800_000_000_000;const values=new Map<string,string>([['douyin.cookie','uid_tt=1; sessionid=SYNTHETIC']]),requests:HttpRequest[]=[],replies:(HttpResponse|Promise<HttpResponse>|Error)[]=[];
 const storage={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};
 const client=new DouyinClient({secureStorage:storage,signer:{sign:()=> 'fixture'},now:()=>now,auth403:{sleep:async()=>{},timer:()=>({result:new Promise(()=>{}),cancel(){}})},transport:{request:async r=>{requests.push(r);const reply=replies.shift();if(reply instanceof Error)throw reply;if(!reply)throw Error('unexpected fixture request');return reply;}},...extra});
 return {client,values,requests,replies,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
for(const code of ['REQUEST_FAILED','CANCELLED'] as const)for(const action of ['next','preview','recover'] as const)test(`DYFIX ${code} ${action} returns immediately and never quarantines`,async()=>{
 let calls=0;const client={resolvePlayback:async()=>{calls++;return {ok:false,code,message:code};}} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:[item('a'),item('b'),item('c')],selectedAwemeId:'a'});
 const result=action==='preview'?await q.preview('next'):await q[action]();expect(result).toMatchObject({code});expect(calls).toBe(1);expect(q.snapshot().item?.awemeId).toBe('a');expect(q.snapshot().playlist).toHaveLength(3);expect(q.diagnostics().quarantinedAwemeIds).toEqual([]);
});
test('DYFIX navigation tries at most three content failures and backs off',async()=>{
 let calls=0;const client={resolvePlayback:async()=>{calls++;return {ok:false,code:'PARSE_FAILED' as const,message:'bad content'};}} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:Array.from({length:20},(_,i)=>item(String(i))),selectedAwemeId:'0'});
 expect(await q.next()).toMatchObject({code:'PARSE_FAILED'});expect(calls).toBe(3);expect(q.diagnostics().quarantinedAwemeIds).toEqual(['1','2','3']);expect(await q.next()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(calls).toBe(3);
});
for(const preview of [false,true])test(`DYFIX duplicate pages keep continuation, back off and refresh (preview=${preview})`,async()=>{
 const original=Date.now;let now=original();Date.now=()=>now;
 try{
  const cursors:(string|null|undefined)[]=[];let pages=0;const client={resolvePlayback:async(id:string)=>({ok:true as const,data:item(id)}),fetchFeedPage:async(input:{cursor?:string|null})=>{cursors.push(input.cursor);pages++;return {ok:true as const,data:{items:[item(pages<3?'a':'b')],nextCursor:'same',hasMore:true}};}} as unknown as DouyinClient;
  const q=new DouyinPlaybackQueue(client,{items:[item('a')],selectedAwemeId:'a',cursor:'same',hasMore:true});const advance=()=>preview?q.preview('next'):q.next();
  for(let i=0;i<2;i++){expect(await advance()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(q.snapshot().hasMore).toBe(true);now+=5000;}
  expect(await advance()).toMatchObject({ok:true,data:{item:{awemeId:'b'},hasMore:true}});expect(cursors).toEqual(['same','same',null]);
 }finally{Date.now=original;}
});
test('DYFIX concurrent preview/next share a page and merge overflow exactly once',async()=>{
 const gate=deferred<any>();let pages=0;const client={fetchFeedPage:async()=>{pages++;return gate.promise;},resolvePlayback:async(id:string)=>({ok:true as const,data:item(id)})} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:[item('a'),item('b')],selectedAwemeId:'b',cursor:'same',hasMore:true,limit:2});
 const preview=q.preview('next'),next=q.next();gate.resolve({ok:true,data:{items:[item('c'),item('d')],nextCursor:'same',hasMore:true}});
 expect(await preview).toMatchObject({code:'CANCELLED'});expect(await next).toMatchObject({ok:true,data:{item:{awemeId:'c'},index:0}});expect(pages).toBe(1);expect(q.snapshot().playlist.map(i=>i.awemeId)).toEqual(['c','d']);
});
test('DYFIX concurrent direct detail and forced playback share one operation',async()=>{
 const gate=deferred<HttpResponse>(),f=fixture();f.replies.push(gate.promise);const a=f.client.fetchDetail('a'),b=f.client.fetchDetail('a'),c=f.client.resolvePlayback('a',{forceRefresh:true});await flush();expect(f.requests).toHaveLength(1);
 gate.resolve(response({aweme_detail:wire('a')}));expect(await a).toEqual(await b);expect(await c).toMatchObject({ok:true,data:{awemeId:'a'}});expect(Reflect.get(f.client,'detailRequests').size).toBe(0);
});
test('DYFIX preloading obeys a global four-detail/10s cap and failed IDs stay cached in the session',async()=>{
 const f=fixture();for(let i=0;i<4;i++)f.replies.push(new Error('offline'));
 for(let i=0;i<8;i++)await f.client.resolvePlayback(String(i),{prefetch:true});expect(f.requests).toHaveLength(DOUYIN_DETAIL_MAX_REQUESTS);
 f.advance(DOUYIN_DETAIL_WINDOW_MS);await f.client.resolvePlayback('0',{prefetch:true});expect(f.requests).toHaveLength(4);
 f.replies.push(response({aweme_detail:wire('4')}));expect(await f.client.resolvePlayback('4',{prefetch:true})).toMatchObject({ok:true});expect(f.requests).toHaveLength(5);
 f.client.resetPrefetchFailures();f.replies.push(response({aweme_detail:wire('0')}));expect(await f.client.resolvePlayback('0',{prefetch:true})).toMatchObject({ok:true});
});
for(const body of ['', '  ', 'blocked'])for(const authenticated of [true,false])test(`DYFIX ${JSON.stringify(body)} only expires on confirmed unauthenticated=${!authenticated}`,async()=>{
 let probes=0,expired=0;const f=fixture({auth403:{probe:async()=>{probes++;return authenticated?'authenticated':'unauthenticated';},timer:()=>({result:new Promise(()=>{}),cancel(){}})}});f.client.onAuthExpired(()=>expired++);f.replies.push(response(body));
 expect(await f.client.fetchFeedPage()).toMatchObject({code:authenticated?'RATE_LIMITED':'NOT_LOGGED_IN'});expect(probes).toBe(1);expect(expired).toBe(authenticated?0:1);expect(await f.client.isLoggedIn()).toBe(authenticated);
});
test('DYFIX feed HTML challenge cools only feed; detail remains usable',async()=>{
 const f=fixture();f.replies.push(response('<html>challenge</html>'),response({aweme_detail:wire('a')}));expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(await f.client.fetchDetail('a')).toMatchObject({ok:true});expect(f.requests).toHaveLength(2);expect(await f.client.isLoggedIn()).toBe(true);
});
test('DYFIX fetch/preview/detail history never mark seen; first-frame settlement does',async()=>{
 const f=fixture();f.replies.push(page(['a','b','c']));const result=await f.client.fetchFeedPage();if(!result.ok)throw Error('feed');const key=douyinFeedSeenKey((await f.client.readCookie())!);
 const q=new DouyinPlaybackQueue(f.client,{items:result.data.items,selectedAwemeId:'a'});await q.preview('next');await f.client.recordHistory(result.data.items[0]!);expect(f.values.has(key)).toBe(false);
 await q.settled();expect(JSON.parse(f.values.get(key)!)).toEqual(['a']);f.replies.push(page(['a','b','c']));expect(await f.client.fetchFeedPage()).toMatchObject({data:{items:[{awemeId:'b'},{awemeId:'c'}]}});
});
test('DYFIX feed cache evicts least recently used entries at 60',async()=>{
 const f=fixture();for(let batch=0;batch<6;batch++){f.replies.push(page(Array.from({length:10},(_,i)=>String(batch*10+i))));const result=await f.client.fetchFeedPage({cursor:String(batch)});expect(result,JSON.stringify({result,requests:f.requests.length,replies:f.replies.length})).toMatchObject({ok:true});}
 expect(Reflect.get(f.client,'feedCache').size).toBe(60);await f.client.resolvePlayback('0');f.replies.push(page(['60']));await f.client.fetchFeedPage();
 const cache=Reflect.get(f.client,'feedCache') as Map<string,unknown>;expect(cache.size).toBe(60);expect(cache.has('0')).toBe(true);expect(cache.has('1')).toBe(false);
});
test('DYFIX x-expires prevents repeated five-minute detail resolution and refreshes before CDN expiry',async()=>{
 const f=fixture(),deadline=Math.floor(f.now()/1000)+1800,url='https://fixture/a?x-expires='+deadline;f.replies.push(response({aweme_list:[wire('a',url)]}));await f.client.fetchFeedPage();
 f.advance(6*60_000);expect(await f.client.resolvePlayback('a')).toMatchObject({source:'feed-cache'});expect(f.requests).toHaveLength(1);
 f.advance(24*60_000);f.replies.push(response({aweme_detail:wire('a')}));expect(await f.client.resolvePlayback('a')).toMatchObject({source:'network'});expect(douyinMediaExpiry(url,f.now()-30*60_000)).toBe(deadline*1000-30000);
});
for(const tag of [{aweme_type:68},{aweme_type:150},{is_ads:true},{is_ads:1},{raw_ad_data:{ad_id:'fixture'}}])test(`DYFIX feed excludes photo/ad ${JSON.stringify(tag)} in both parsers`,async()=>{
 const raw=JSON.stringify({aweme_list:[{...wire('skip'),...tag},wire('keep')],has_more:1});expect(parseDouyinFeed(raw).items.map(i=>i.awemeId)).toEqual(['keep']);expect((await parseDouyinFeedAsync(raw)).items.map(i=>i.awemeId)).toEqual(['keep']);
});
test('DYFIX detail ads return a non-video result; photo details keep existing image policy',async()=>{
 expect(parseDouyinDetail(JSON.stringify({aweme_detail:{...wire('ad'),is_ads:true}}))).toMatchObject({kind:'ad'});
 expect(parseDouyinDetail(JSON.stringify({aweme_detail:{...wire('photo'),aweme_type:68,images:[{url_list:['https://fixture/image']} ]}}))).toMatchObject({kind:'note',imageUrls:['https://fixture/image']});
 const f=fixture();f.replies.push(response({aweme_detail:{...wire('ad'),raw_ad_data:{}}}));expect(await f.client.resolvePlayback('ad')).toMatchObject({code:'UNSUPPORTED'});
});
test('DYFIX codec policy requires confirmed dimensions and remains conservative after HEVC failures',()=>{
 const p=new DouyinCodecRuntimePolicy(),v={width:540,height:960};expect(p.canDecodeHevc(v)).toBe(false);p.confirmHevcSize(v,false);expect(p.canDecodeHevc(v)).toBe(false);p.confirmHevcSize(v,true);expect(p.canDecodeHevc(v)).toBe(true);expect(p.canDecodeHevc({width:720,height:1280})).toBe(false);
 p.recordAutoHevcAttempt();p.recordAutoHevcFailure();p.recordAutoHevcAttempt();p.recordAutoHevcFailure();expect(p.canDecodeHevc(v)).toBe(false);
});
test('DYFIX temporary errors ask for retry without promising automatic retry in all callers',()=>{
 for(const code of ['TEMPORARILY_UNAVAILABLE','RATE_LIMITED'] as DouyinErrorCode[])expect(formatDouyinError(code)).toBe('抖音暂时不可用，请稍后重试');
});

test('DYFIX empty raw_ad_data on ordinary videos does not discard legitimate feed items',async()=>{
 const raw=JSON.stringify({aweme_list:[{...wire('keep'),is_ads:false,raw_ad_data:''}]});expect(parseDouyinFeed(raw).items).toHaveLength(1);expect((await parseDouyinFeedAsync(raw)).items).toHaveLength(1);
});


test('DYFIX recovery counts the current failed source in its three-candidate limit',async()=>{
 let calls=0;const client={resolvePlayback:async()=>{calls++;return {ok:false,code:'PARSE_FAILED' as const,message:'bad content'};}} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:Array.from({length:20},(_,i)=>item(String(i))),selectedAwemeId:'0'});
 expect(await q.recover()).toMatchObject({code:'PARSE_FAILED'});expect(calls).toBe(3);expect(q.snapshot().item?.awemeId).toBe('0');
});
test('DYFIX discard keeps the retry anchor when the next candidate cannot resolve offline',async()=>{
 const client={resolvePlayback:async()=>({ok:false,code:'REQUEST_FAILED' as const,message:'offline'})} as unknown as DouyinClient;
 const q=new DouyinPlaybackQueue(client,{items:[item('a'),item('b')],selectedAwemeId:'a'});
 expect(await q.discard()).toMatchObject({code:'REQUEST_FAILED'});expect(q.snapshot().item?.awemeId).toBe('a');expect(q.snapshot().playlist.map(i=>i.awemeId)).toEqual(['a','b']);expect(q.diagnostics().quarantinedAwemeIds).toEqual([]);
});

test('DYFIX delayed persistence does not reset failures that occurred after the first-frame reset',async()=>{
 const f=fixture();const q=new DouyinPlaybackQueue(f.client,{items:[item('a')],selectedAwemeId:'a'});q.resetAutomaticFailures();
 expect(q.claimAutomaticFailure()).toBe(true);expect(q.claimAutomaticFailure()).toBe(true);await q.settled();expect(q.claimAutomaticFailure()).toBe(false);
 q.resetAutomaticFailures();expect(q.claimAutomaticFailure()).toBe(true);
});
