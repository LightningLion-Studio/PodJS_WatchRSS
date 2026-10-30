import {afterEach,expect,test} from 'bun:test';
import {DouyinClient} from '../../src/douyin/client.ts';
import {createDouyinLoginProbe,DOUYIN_LOGIN_PROBE_PATH} from '../../src/douyin/login-probe.ts';
import {DOUYIN_AUTH403_COOLDOWN_KEY} from '../../src/douyin/auth403.ts';
import {douyinFeedSeenKey} from '../../src/douyin/recommendations.ts';
import {readDouyinStatusCode} from '../../src/douyin/parser.ts';
import {AppLogger,installAppLogger} from '../../src/logs/app-logger.ts';
import type {HttpRequest,HttpResponse} from '../../src/cloud/types.ts';
import type {DouyinClientOptions} from '../../src/douyin/types.ts';

const response=(value:unknown,status=200):HttpResponse=>({status,headers:{},body:new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value))});
const wire=(id:string)=>({aweme_id:id,video:{play_addr:{url_list:['https://fixture/'+id]}}});
const page=(ids:string[],cursor=1,hasMore=1)=>response({status_code:0,aweme_list:ids.map(wire),max_cursor:cursor,has_more:hasMore});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function until(check:()=>boolean){const until=Date.now()+3000;while(!check()&&Date.now()<until)await new Promise(r=>setTimeout(r,0));expect(check()).toBe(true);}
function fixture(extra:Partial<DouyinClientOptions>={}){
 const values=new Map<string,string>([['douyin.cookie','uid_tt=1; sessionid=SYNTHETIC_COOKIE']]),requests:HttpRequest[]=[],signed:Record<string,string>[]=[],replies:Array<HttpResponse|Promise<HttpResponse>|Error>=[];let expired=0;
 const secure={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};
 const transport={request:async(request:HttpRequest)=>{requests.push(request);const next=replies.shift();if(next instanceof Error)throw next;if(!next)throw Error('unexpected fixture request');return next;}};
 const signer={sign:(params:Readonly<Record<string,string>>)=>{signed.push({...params});return 'SYNTHETIC_SIGNATURE';}};
 const timer=()=>({result:new Promise(()=>{}),cancel(){}}),probe=createDouyinLoginProbe({transport,signer,requestConfig:extra.requestConfig});
 const client=new DouyinClient({transport,secureStorage:secure,signer,now:()=>1_000_000,auth403:{probe,sleep:async()=>{},timer},...extra});client.onAuthExpired(()=>expired++);
 return {client,values,secure,requests,signed,replies,expired:()=>expired};
}
afterEach(()=>installAppLogger(undefined));
for(const api of ['feed','detail'] as const)test(`HTTP200 status_code=8 expires ${api} instead of an empty/parse result`,async()=>{
 const f=fixture();f.replies.push(response({status_code:8,status_msg:'SYNTHETIC_PRIVATE_MESSAGE'}));const r=api==='feed'?await f.client.fetchFeedPage():await f.client.fetchDetail('1');expect(r).toMatchObject({ok:false,code:'NOT_LOGGED_IN',message:'登录已失效，请重新登录'});expect(f.expired()).toBe(1);expect(await f.client.isLoggedIn()).toBe(false);expect(f.requests).toHaveLength(1);
});
test('status code parser reads only a numeric top-level value',async()=>{
 for(const [raw,expected] of [['{"status_code":8}',8],['{"data":{"status_code":8},"status_code":0}',0],['{"status_code":"8"}',undefined],['[]',undefined],['{',undefined]] as const)expect(await readDouyinStatusCode(raw)).toBe(expected);
});
for(const [value,status,expected] of [[{status_code:0},200,'RATE_LIMITED'],[{status_code:8},200,'NOT_LOGGED_IN'],[{status_code:9},200,'TEMPORARILY_UNAVAILABLE'],[{},200,'TEMPORARILY_UNAVAILABLE'],['blocked',200,'TEMPORARILY_UNAVAILABLE'],['',200,'TEMPORARILY_UNAVAILABLE'],['<html>verify</html>',200,'TEMPORARILY_UNAVAILABLE'],[{status_code:8},403,'TEMPORARILY_UNAVAILABLE']] as const)test(`real notice adapter classifies status=${status}, body=${JSON.stringify(value)}`,async()=>{
 const f=fixture({requestConfig:()=>({verifyFp:'SYNTHETIC_FP',msToken:'SYNTHETIC_TOKEN'})});f.replies.push(response('',403),response('',403),response(value,status));
 expect(await f.client.fetchFeedPage()).toMatchObject({code:expected});expect(await f.client.isLoggedIn()).toBe(expected!=='NOT_LOGGED_IN');expect(f.expired()).toBe(expected==='NOT_LOGGED_IN'?1:0);expect(f.requests).toHaveLength(3);
 const request=f.requests[2]!,url=new URL(request.url);expect(url.pathname).toBe(DOUYIN_LOGIN_PROBE_PATH);expect(request).toMatchObject({method:'GET',timeoutMs:5000,readTimeoutMs:5000,headers:{Cookie:'uid_tt=1; sessionid=SYNTHETIC_COOKIE'},acceptHttpErrors:true});expect(request.body).toBeUndefined();
 expect(url.searchParams.get('is_new_notice')).toBe('1');expect(url.searchParams.get('need_social_count')).toBe('1');expect(f.signed[2]).toMatchObject({verifyFp:'SYNTHETIC_FP',fp:'SYNTHETIC_FP',msToken:'SYNTHETIC_TOKEN'});expect(Object.fromEntries([...url.searchParams].filter(([key])=>key!=='a_bogus'))).toEqual(f.signed[2]!);
});
test('other numeric business errors never become an empty successful feed or expire a Cookie',async()=>{
 const f=fixture();f.replies.push(response({status_code:42,status_msg:'private'}));expect(await f.client.fetchFeedPage()).toMatchObject({ok:false,code:'REQUEST_FAILED'});expect(await f.client.isLoggedIn()).toBe(true);expect(f.expired()).toBe(0);
});
test('parallel feed/detail recoveries share one actual notice request per Cookie generation',async()=>{
 const notice=deferred<HttpResponse>(),requests:HttpRequest[]=[];
 const f=fixture({transport:{request:async r=>{requests.push(r);return r.url.includes(DOUYIN_LOGIN_PROBE_PATH)?notice.promise:response('',403);}}});
 // Use the same routed transport for the API and the production probe factory.
 (f.client as any).options.auth403.probe=createDouyinLoginProbe({transport:{request:async r=>{requests.push(r);return notice.promise;}},signer:{sign:()=> 'sig'}});
 const a=f.client.fetchFeedPage(),b=f.client.fetchDetail('2');await until(()=>requests.some(r=>r.url.includes(DOUYIN_LOGIN_PROBE_PATH)));await new Promise(r=>setTimeout(r,0));expect(requests.filter(r=>r.url.includes(DOUYIN_LOGIN_PROBE_PATH))).toHaveLength(1);notice.resolve(response({status_code:0}));expect(await a).toMatchObject({code:'RATE_LIMITED'});expect(await b).toMatchObject({code:'RATE_LIMITED'});expect(f.expired()).toBe(0);
});
test('late old-Cookie status8 and actual probe result cannot clear a newly imported Cookie',async()=>{
 for(const probe of [false,true]){
  const late=deferred<HttpResponse>(),f=fixture();f.replies.push(...(probe?[response('',403),response('',403),late.promise]:[late.promise]));const work=f.client.fetchFeedPage();await until(()=>f.requests.length===(probe?3:1));await f.client.applyCookie('uid_tt=2; sessionid=NEW_COOKIE');late.resolve(response({status_code:8}));expect(await work).toMatchObject({code:'CANCELLED'});expect(await f.client.readCookie()).toBe('uid_tt=2; sessionid=NEW_COOKIE');expect(f.expired()).toBe(0);
 }
});
test('probe policy cuts off at five seconds and ignores a late unauthenticated notice',async()=>{
 const timeout=deferred<void>(),notice=deferred<HttpResponse>(),f=fixture();
 const options=(f.client as any).options as DouyinClientOptions;options.auth403!.timer=ms=>{expect(ms).toBe(5000);return {result:timeout.promise,cancel(){}};};
 f.replies.push(response('',403),response('',403),notice.promise);const work=f.client.fetchFeedPage();await until(()=>f.requests.length===3);timeout.resolve();expect(await work).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});notice.resolve(response({status_code:8}));await new Promise(r=>setTimeout(r,0));expect(await f.client.isLoggedIn()).toBe(true);expect(f.expired()).toBe(0);
});
test('cancelling while config/signature awaits suppresses the notice request',async()=>{
 for(const stage of ['config','signer']){
  const gate=deferred<any>();let calls=0;const probe=createDouyinLoginProbe({requestConfig:stage==='config'?()=>gate.promise:undefined,signer:{sign:()=>stage==='signer'?gate.promise:'sig'},transport:{request:async()=>{calls++;return response({status_code:8});}}});
  const operation=probe({cookie:'synthetic',timeoutMs:5000}) as {result:Promise<unknown>;cancel():void};await Promise.resolve();operation.cancel();gate.resolve(stage==='config'?{}:'sig');expect(await operation.result).toBe('unknown');expect(calls).toBe(0);
 }
});
test('request config refreshes on the next API call and is shared by headers, params and signing',async()=>{
 let ua='Chrome/155.0.0.0',version='170400';const f=fixture({requestConfig:()=>({userAgent:ua,versionCode:version,browserVersion:'155.0.0.0',fp:'synthetic-fp'})});f.replies.push(page(['1']),page(['2']));await f.client.fetchFeedPage();ua='rollback-UA';version='290100';await f.client.fetchFeedPage({cursor:'1'});expect(f.requests.map(r=>r.headers['User-Agent'])).toEqual(['Chrome/155.0.0.0','rollback-UA']);expect(f.signed.map(p=>p.version_code)).toEqual(['170400','290100']);expect(await f.client.buildPlaybackHeaders()).toMatchObject({'User-Agent':'rollback-UA'});expect(f.signed[1]).toMatchObject({cursor:'1',max_cursor:'1',verifyFp:'synthetic-fp',fp:'synthetic-fp'});
});
test('only first-frame history commits enter the 512 seen IDs across pages and restart',async()=>{
 const f=fixture();f.replies.push(page(['1','1','2']),page(['2','3'],2),page(['1','3'],3));
 const first=await f.client.fetchFeedPage();expect(first).toMatchObject({data:{items:[{awemeId:'1'},{awemeId:'2'}]}});
 const key=douyinFeedSeenKey((await f.client.readCookie())!);expect(f.values.has(key)).toBe(false);
 if(!first.ok)throw Error('feed');for(const item of first.data.items)await f.client.recordPresented(item);
 const second=await f.client.fetchFeedPage({cursor:'1'});expect(second).toMatchObject({data:{items:[{awemeId:'3'}],nextCursor:'2'}});
 if(!second.ok)throw Error('feed');await f.client.recordPresented(second.data.items[0]!);
 expect(await f.client.fetchFeedPage()).toMatchObject({data:{items:[],hasMore:true}});expect(JSON.parse(f.values.get(key)!)).toEqual(['1','2','3']);
 const restarted=new DouyinClient({secureStorage:f.secure,signer:{sign:()=> 'sig'},transport:{request:async()=>page(['3','4'])}});expect(await restarted.fetchFeedPage()).toMatchObject({data:{items:[{awemeId:'4'}]}});
});
test('512 seen bound advances on playback and is scoped by account',async()=>{
 const f=fixture(),cookie=(await f.client.readCookie())!,key=douyinFeedSeenKey(cookie);f.values.set(key,JSON.stringify(Array.from({length:512},(_,i)=>String(i+1))));f.replies.push(page(['1','513']));
 const result=await f.client.fetchFeedPage();expect(result).toMatchObject({data:{items:[{awemeId:'513'}]}});expect(JSON.parse(f.values.get(key)!)[0]).toBe('1');
 if(!result.ok)throw Error('feed');await f.client.recordPresented(result.data.items[0]!);
 const ids=JSON.parse(f.values.get(key)!);expect(ids).toHaveLength(512);expect(ids[0]).toBe('2');expect(ids).not.toContain('1');expect(key).not.toContain('SYNTHETIC_COOKIE');
 await f.client.applyCookie('uid_tt=2; sessionid=B');f.replies.push(page(['513']));expect(await f.client.fetchFeedPage()).toMatchObject({data:{items:[{awemeId:'513'}]}});
 await f.client.applyCookie('uid_tt=1; sessionid=ROTATED');f.replies.push(page(['513','514']));expect(await f.client.fetchFeedPage()).toMatchObject({data:{items:[{awemeId:'514'}]}});
});
test('same-page consumers share one publication and stale account data cannot enter a new scope',async()=>{
 const f=fixture();f.replies.push(page(['1','2']));const results=await Promise.all([f.client.fetchFeedPage(),f.client.fetchFeedPage()]);expect(results[0]).toEqual(results[1]);expect(f.requests).toHaveLength(1);
 const late=deferred<HttpResponse>();f.replies.push(late.promise);const work=f.client.fetchFeedPage();await until(()=>f.requests.length===2);await f.client.applyCookie('uid_tt=9; sessionid=NEW');late.resolve(page(['OLD']));expect(await work).toMatchObject({code:'CANCELLED'});expect(f.values.has(douyinFeedSeenKey('uid_tt=9; sessionid=NEW'))).toBe(false);
});
test('web pagination stays off by default and cannot run without a verified injected adapter',async()=>{
 const f=fixture({requestConfig:()=>({webPagination:true})});f.replies.push(page(['1']));await f.client.fetchFeedPage({cursor:'42'});expect(f.signed[0]).toMatchObject({cursor:'42',max_cursor:'42'});expect(f.signed[0]).not.toHaveProperty('refresh_index');
 let invoked=0;const adapter:NonNullable<DouyinClientOptions['webFeedPagination']>=({cursor,presentedIds})=>{invoked++;expect(cursor).toBe('opaque');expect(presentedIds).toEqual([]);return {params:{refresh_index:'SYNTHETIC',module_id:'VERIFIED_TEST_CONTRACT'},nextCursor:()=> 'next-opaque'};};
 const off=fixture({webFeedPagination:adapter});off.replies.push(page(['1']));await off.client.fetchFeedPage();expect(invoked).toBe(0);
 const on=fixture({requestConfig:()=>({webPagination:true}),webFeedPagination:adapter});on.replies.push(page(['1']));expect(await on.client.fetchFeedPage({cursor:'opaque'})).toMatchObject({data:{nextCursor:'next-opaque'}});expect(invoked).toBe(1);expect(on.signed[0]).not.toHaveProperty('cursor');expect(on.signed[0]).toMatchObject({refresh_index:'SYNTHETIC',module_id:'VERIFIED_TEST_CONTRACT'});
});
test('actual probe errors and status messages do not leak credentials, query or response text to logs',async()=>{
 let text='';const logger=new AppLogger({read:async()=>text,size:async()=>text.length,replace:async s=>{text=s;},append:async s=>{text+=s;}});installAppLogger(logger);const f=fixture({requestConfig:()=>({msToken:'SYNTHETIC_TOKEN'})});f.replies.push(response('',403),response('',403),new Error('SYNTHETIC_PRIVATE_ERROR'));expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});await logger.flush();expect(text).not.toMatch(/SYNTHETIC|a_bogus|msToken|https:|sessionid/);expect(f.values.has(DOUYIN_AUTH403_COOLDOWN_KEY)).toBe(true);
 const expired=fixture();expired.replies.push(response({status_code:8,status_msg:'SYNTHETIC_PRIVATE_MESSAGE'}));await expired.client.fetchFeedPage();await logger.flush();expect(text).toContain('reason=status8');expect(text).not.toMatch(/SYNTHETIC|a_bogus|msToken|https:|sessionid/);
});

for(const html of ['<!DOCTYPE html><html>SYNTHETIC_CHALLENGE_SECRET</html>',' \ufeff<HTML lang="en">SYNTHETIC_CHALLENGE_SECRET</HTML>'])for(const status of [200,403])test(`detail HTML challenge keeps Cookie and stops requests in persistent cooldown (${status}/${html.slice(0,15)})`,async()=>{
 const f=fixture();f.replies.push(response(html,status));expect(await f.client.fetchDetail('1')).toMatchObject({ok:false,code:'TEMPORARILY_UNAVAILABLE',retryAfterMs:30000});expect(await f.client.isLoggedIn()).toBe(true);expect(f.expired()).toBe(0);expect(f.requests).toHaveLength(1);expect(f.values.has(DOUYIN_AUTH403_COOLDOWN_KEY)).toBe(true);
 expect(await f.client.fetchDetail('2')).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});f.replies.push(page(['feed-still-works']));expect(await f.client.fetchFeedPage()).toMatchObject({ok:true});expect(f.requests).toHaveLength(2);
 const restarted=new DouyinClient({secureStorage:f.secure,now:()=>1_000_000,transport:{request:async()=>{throw Error('must remain in cooldown');}}});expect(await restarted.fetchDetail('1')).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(await restarted.isLoggedIn()).toBe(true);
});
test('detail request/challenge counters are fixed categories; no secsdk signature is fabricated',async()=>{
 let text='';const logger=new AppLogger({read:async()=>text,size:async()=>text.length,replace:async s=>{text=s;},append:async s=>{text+=s;}});installAppLogger(logger);
 const f=fixture();f.replies.push(response('<html>SYNTHETIC_CHALLENGE_SECRET</html>'));await f.client.fetchDetail('SYNTHETIC_AWEME');await f.client.fetchDetail('next');await logger.flush();
 expect(text).toContain('"event":"request","api":"detail","count":1,"mode":"abogus_only"');expect(text).toContain('"event":"challenge","api":"detail","count":1,"mode":"abogus_only"');expect((text.match(/"event":"request"/g)??[])).toHaveLength(1);expect(text).not.toMatch(/SYNTHETIC|https:|a_bogus=|sessionid|Cookie:|timestamp|x-secsdk-web-signature/);
 const url=new URL(f.requests[0]!.url);expect(url.searchParams.has('timestamp')).toBe(false);expect(url.searchParams.has('x-secsdk-web-signature')).toBe(false);expect(await f.client.isLoggedIn()).toBe(true);
});
test('an HTML challenge after a 403 resign never invokes the login probe or expires Cookie',async()=>{
 const f=fixture();f.replies.push(response('',403),response('<html>challenge</html>'));expect(await f.client.fetchDetail('1')).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(f.requests).toHaveLength(2);expect(f.expired()).toBe(0);expect(await f.client.isLoggedIn()).toBe(true);
});
