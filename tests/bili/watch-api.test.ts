import {expect,test} from 'bun:test';
import {createBiliClient} from '../../src/bili/client.ts';
import type {BiliHttpRequest,BiliHttpResponse,BiliPlayUrl} from '../../src/bili/types.ts';
import {applyWatchConfig,readWatchConfig,WATCH_CONFIG_KEY,WATCH_COOLDOWN_MS,WATCH_LOCAL_SWITCH} from '../../src/bili/watch-api/config.ts';
import {BiliFeedBrowser} from '../../src/bili/browse.ts';
import {createBiliPlaybackRetry} from '../../src/playback.ts';
import {videoResponseBudget} from '../../src/media/traffic-policy.ts';

const config={appkey:'fixture-client',mobiApp:'fixture-watch',platform:'fixture',device:'watch',build:'1'};
const bytes=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x));
const ok=(data:unknown):BiliHttpResponse=>({status:200,headers:{},body:bytes({code:0,data})});
const play=(url='https://fixture.invalid/watch.mp4',quality=16)=>({quality,format:'mp4',video_codecid:7,durl:[{url,backup_url:[]}]});
function setup(responses:BiliHttpResponse[],options:{session?:boolean;verified?:boolean;enabled?:boolean}={}){
 const values=new Map<string,string>();
 values.set('watchrss.bili.session.v1.wbi',JSON.stringify({imgKey:'a'.repeat(32),subKey:'b'.repeat(32)}));
 if(options.session)values.set('watchrss.bili.session.v1',JSON.stringify({cookies:{SESSDATA:'fixture-session',bili_jct:'fixture-csrf'},updatedAt:1}));
 const requests:BiliHttpRequest[]=[],events:unknown[]=[];
 let now=100000,cooldown=0,current={...config,biliWatchApi:options.enabled,webCookieVerified:options.verified};
 const client=createBiliClient({transport:{async request(r){requests.push(r);const response=responses.shift();if(!response)throw Error('unexpected_request');return response;}},secureStore:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},delete:async k=>{values.delete(k);}},watchApi:()=>current,now:()=>now,watchCooldown:{get:()=>cooldown,set:v=>{cooldown=v;}},onWatchRoute:e=>events.push(e)});
 return {client,requests,events,values,setConfig:(v:Partial<typeof current>)=>{current={...current,...v};},advance:(ms:number)=>{now+=ms;},cooldown:()=>cooldown};
}
test('default-on switch supports local and remote kill, rotation and identifier whitelist',()=>{
 const values=new Map<string,unknown>(),store={get:<T>(k:string)=>values.get(k) as T|undefined,set:<T>(k:string,v:T)=>values.set(k,v)};
 expect(readWatchConfig(store).biliWatchApi).toBe(true);
 applyWatchConfig(store,{...config,appsecret:'never-store'} as any);
 expect(values.get(WATCH_CONFIG_KEY)).not.toHaveProperty('appsecret');
 values.set(WATCH_LOCAL_SWITCH,false);expect(readWatchConfig(store).biliWatchApi).toBe(false);
 values.set(WATCH_LOCAL_SWITCH,true);applyWatchConfig(store,{...config,biliWatchApi:false});expect(readWatchConfig(store).biliWatchApi).toBe(false);
 applyWatchConfig(store,{...config,appkey:'rotated-fixture'});expect(readWatchConfig(store).appkey).toBe('rotated-fixture');
 expect(()=>applyWatchConfig(store,{appkey:'bad\r\nvalue'})).toThrow();
});
test('watch recommendation maps real schema, preserves cid and limits page/resources',async()=>{
 const f=setup([ok({items:[{item_type:'ugc',aid:7,cid:8,title:'fixture',author:{mid:9,name:'up'}}],page_next:'{"pn":2,"ps":20}'})]);
 const page=await f.client.feed({ps:100});expect(page.source).toBe('watch');expect(page.items[0]).toMatchObject({aid:7,cid:8,owner:{mid:9,name:'up'}});
 const r=f.requests[0],q=new URL(r.url).searchParams;expect(q.has('sign')).toBe(false);expect(q.has('access_key')).toBe(false);expect(r.headers.Cookie).toBeUndefined();expect(r.timeoutMs).toBe(10000);expect(JSON.parse(q.get('page_next')!).ps).toBe(20);
 expect(videoResponseBudget(r.url,false)).toBe(2*1024*1024);
});
test.each(['api','parse','empty','http','oversize'] as const)('%s watch feed failure falls back once without passing watch cursor to WBI',async reason=>{
 const response=reason==='api'?{status:200,headers:{},body:bytes({code:-400})}:reason==='parse'?ok(null):reason==='empty'?ok({items:[{item_type:'ad'}]}):reason==='http'?{status:500,headers:{},body:bytes({code:0})}:{status:200,headers:{},body:new Uint8Array(2*1024*1024+1)};
 const f=setup([response,ok({item:[{goto:'av',aid:9}]})]);
 expect((await f.client.feed({page_next:'{"pn":2}'})).source).toBe('web');expect(f.requests).toHaveLength(2);expect(new URL(f.requests[1].url).searchParams.has('page_next')).toBe(false);expect(f.events).toHaveLength(1);
});
test('412 immediately falls back once, persists two-hour watch cooldown, then admits later watch',async()=>{
 const f=setup([{status:412,headers:{},body:bytes({code:-412})},ok({item:[]}),ok({item:[]}),ok({items:[]})]);
 await f.client.feed();expect(f.cooldown()).toBe(100000+WATCH_COOLDOWN_MS);await f.client.feed();expect(f.requests.map(r=>new URL(r.url).hostname)).toEqual(['app.bilibili.com','api.bilibili.com','api.bilibili.com']);
 f.advance(WATCH_COOLDOWN_MS);expect((await f.client.feed()).source).toBe('watch');
 expect(JSON.stringify(f.events)).not.toContain('fixture-client');
});
test.each([-352,-412,-509])('business risk %s also opens circuit',async code=>{const f=setup([{status:200,headers:{},body:bytes({code})},ok({item:[]})]);await f.client.feed();expect(f.cooldown()).toBeGreaterThan(100000);});
test('logged-in account functions stay Web before cookie verification; verified requests reuse secure session',async()=>{
 const f=setup([ok({item:[]}),ok(play())],{session:true});
 expect((await f.client.feed()).source).toBe('web');expect(f.requests[0].headers.Cookie).toContain('fixture-session');
 f.setConfig({webCookieVerified:true});expect((await f.client.resolvePlayback({aid:7,cid:8,preferMp4:true,qn:16})).apiSource).toBe('watch');expect(f.requests[1].headers.Cookie).toContain('fixture-session');
 expect([...f.values.keys()]).not.toContain('access_token');
});
test.each([false,true])('360P and higher stay watch below requested qn; authenticated=%s',async session=>{
 for(const quality of [16,32,64,80]){
  const f=setup([ok(play(undefined,quality))],{session,verified:session});
  const stored=f.values.get('watchrss.bili.session.v1');
  const result=await f.client.resolvePlayback({aid:7,cid:8,qn:120,preferMp4:true});
  expect(result.apiSource).toBe('watch');expect(result.quality).toBe(quality);expect(f.requests).toHaveLength(1);
  expect(new URL(f.requests[0].url).searchParams.get('qn')).toBe('120');
  expect(f.events).toEqual([{operation:'playurl',route:'watch',elapsedMs:0,quality,requestedQn:120}]);
  expect(f.values.get('watchrss.bili.session.v1')).toBe(stored);
  const metrics=JSON.stringify(f.events);for(const secret of ['fixture-client','fixture-session','fixture-csrf','https://'])expect(metrics).not.toContain(secret);
 }
});
test.each([false,true])('below 360P or unknown quality falls back once; authenticated=%s',async session=>{
 for(const quality of [0,15,undefined,Number.NaN,Number.POSITIVE_INFINITY]){
  const f=setup([ok({...play(),quality}),ok(play('https://fixture.invalid/web.mp4',80))],{session,verified:session});
  const result=await f.client.resolvePlayback({aid:7,cid:8,qn:8,preferMp4:true});
  expect(result.apiSource).toBe('web');expect(result.quality).toBe(80);expect(f.requests).toHaveLength(2);
  expect(f.requests.map(r=>new URL(r.url).pathname)).toEqual(['/x/watch/player/playurl','/x/player/wbi/playurl']);
  expect(f.events).toEqual([{operation:'playurl',route:'web',reason:'quality',elapsedMs:0,quality:Number.isFinite(quality)?quality:undefined,requestedQn:8}]);
 }
});
test.each([true,false])('default request qn is recorded separately from actual 360P; preferMp4=%s',async preferMp4=>{
 const f=setup([ok(play())],{session:true,verified:true});
 expect((await f.client.resolvePlayback({aid:7,cid:8,preferMp4})).apiSource).toBe('watch');
 const requestedQn=preferMp4?32:64;
 expect(new URL(f.requests[0].url).searchParams.get('qn')).toBe(String(requestedQn));
 expect(f.events).toEqual([{operation:'playurl',route:'watch',elapsedMs:0,quality:16,requestedQn}]);
});
test('unverified logged-in playback stays Web and does not invent watch quality',async()=>{
 const f=setup([ok(play('https://fixture.invalid/web.mp4',80))],{session:true});
 const stored=f.values.get('watchrss.bili.session.v1');
 expect((await f.client.resolvePlayback({aid:7,cid:8,qn:80,preferMp4:true})).apiSource).toBe('web');
 expect(f.requests).toHaveLength(1);expect(new URL(f.requests[0].url).hostname).toBe('api.bilibili.com');
 expect(f.events).toEqual([{operation:'playurl',route:'web',reason:'logged_in_web',elapsedMs:0,requestedQn:80,quality:undefined}]);
 expect(f.values.get('watchrss.bili.session.v1')).toBe(stored);
});
test.each([false,true])('360P still requires a playable track; authenticated=%s',async session=>{
 for(const data of [{...play(),durl:[]},{...play(),video_codecid:12},play('file:///private/data'),{quality:16,dash:{video:[{base_url:'https://fixture.invalid/hevc',codecid:12}],audio:[]}}]){
  const f=setup([ok(data),ok(play('https://fixture.invalid/web.mp4',80))],{session,verified:session});
  expect((await f.client.resolvePlayback({aid:7,cid:8,qn:80,preferMp4:true})).apiSource).toBe('web');
  expect(f.requests).toHaveLength(2);
  expect(f.events).toEqual([{operation:'playurl',route:'web',reason:'empty',elapsedMs:0,quality:16,requestedQn:80}]);
 }
});
test('authenticated H264 DASH at 360P is usable below requested qn',async()=>{
 const f=setup([ok({quality:16,dash:{video:[{id:16,base_url:'https://fixture.invalid/video',codecid:7}],audio:[{base_url:'https://fixture.invalid/audio'}]}})],{session:true,verified:true});
 const source=await f.client.resolvePlayback({aid:7,cid:8,qn:80});
 expect(source.apiSource).toBe('watch');expect(source.dash?.video[0].baseUrl).toBe('https://fixture.invalid/video');expect(f.requests).toHaveLength(1);
 expect(f.events).toEqual([{operation:'playurl',route:'watch',elapsedMs:0,quality:16,requestedQn:80}]);
});

test.each(['expired','invalid','hevc','voucher'] as const)('unusable watch source %s falls back once',async kind=>{
 const d=kind==='expired'?play('https://fixture.invalid/a?deadline=1'):kind==='invalid'?play('file:///private/data'):kind==='hevc'?{...play(),video_codecid:12}:{v_voucher:'fixture'};
 const f=setup([ok(d),ok(play('https://fixture.invalid/web.mp4'))]);expect((await f.client.resolvePlayback({aid:7,cid:8,preferMp4:true})).apiSource).toBe('web');expect(f.requests).toHaveLength(2);
});
test('bvid-only, disabled and unconfigured paths use Web without watch request',async()=>{
 const f=setup([ok(play()),ok(play()),ok(play())]);await f.client.resolvePlayback({bvid:'BVfixture',cid:8,preferMp4:true});f.setConfig({biliWatchApi:false});await f.client.resolvePlayback({aid:7,cid:8,preferMp4:true});f.setConfig({biliWatchApi:true,appkey:undefined as any});await f.client.resolvePlayback({aid:7,cid:8,preferMp4:true});expect(f.requests.every(r=>new URL(r.url).hostname==='api.bilibili.com')).toBe(true);
});
test('watch feed browser forwards cursor and stops at final page',async()=>{
 const calls:unknown[]=[],store={get:<T>()=>undefined as T|undefined,set:()=>{}};
 const browser=new BiliFeedBrowser({feed:async p=>{calls.push(p);return calls.length===1?{source:'watch',items:[{aid:7,cid:8}],nextPage:'{"pn":2}'}:{source:'watch',items:[{aid:9,cid:10}]};}},store);
 await browser.refresh();await browser.loadMore();await browser.loadMore();expect(calls).toEqual([undefined,{page_next:'{"pn":2}'}]);expect(browser.state.canLoadMore).toBe(false);expect(browser.state.items).toHaveLength(2);
});
test('watch direct failure forces one Web resolution even with recovery flag off; exhausted Web never retries watch',async()=>{
 const initial:BiliPlayUrl={apiSource:'watch',acceptQuality:[],acceptDescription:[],durl:[{url:'https://fixture.invalid/watch',backupUrl:['https://fixture.invalid/watch-backup']}]};
 const calls:unknown[]=[];
 const retry=createBiliPlaybackRetry(initial,async options=>{calls.push(options);return {...initial,apiSource:'web',durl:[{url:'https://fixture.invalid/web',backupUrl:[]}]};},'fixture',{});
 expect((await retry()).url).toBe('https://fixture.invalid/web');await expect(retry()).rejects.toThrow();expect(calls).toEqual([{forceWeb:true}]);
});
test('HTTP risk HTML/oversize still opens cooldown before JSON parsing',async()=>{
 const f=setup([{status:412,headers:{},body:new Uint8Array(2*1024*1024+1)},ok({item:[]})]);await f.client.feed();expect(f.cooldown()).toBeGreaterThan(100000);
});
test('numeric-only Web fallback signs avid and excludes absent bvid/platform fields',async()=>{
 const f=setup([ok(play())]);await f.client.resolvePlayback({aid:170001,cid:279786,forceWeb:true});
 const q=new URL(f.requests[0].url).searchParams;expect(q.get('avid')).toBe('170001');expect(q.has('aid')).toBe(false);expect(q.has('bvid')).toBe(false);expect(q.has('platform')).toBe(false);expect(q.has('w_rid')).toBe(true);
});
test('invalid first durl cannot mask valid DASH and escape API-level Web fallback',async()=>{
 const f=setup([ok({...play('file:///private'),dash:{video:[{base_url:'https://fixture.invalid/dash',codecid:7}],audio:[]}}),ok(play())]);expect((await f.client.resolvePlayback({aid:7,cid:8,preferMp4:true})).apiSource).toBe('web');
});
test('direct Web fallback coalesces concurrent failures and retains local preview if Web fails',async()=>{
 const source:BiliPlayUrl={apiSource:'watch',acceptQuality:[],acceptDescription:[],durl:[{url:'https://fixture.invalid/watch',backupUrl:[]}]};
 let calls=0,release!:()=>void;
 const retry=createBiliPlaybackRetry(source,async options=>{calls++;expect(options?.forceWeb).toBe(true);await new Promise<void>(r=>{release=r;});throw Error('offline');},'',{},async()=>({url:'managed-cache/bili-preview/fixture.mp4',title:'fixture'}));
 const a=retry(),b=retry();release();expect(a).toBe(b);expect((await a).url).toContain('managed-cache');expect(calls).toBe(1);
});
