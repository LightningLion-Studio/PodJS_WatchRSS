import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import {DouyinClient,DOUYIN_NETWORK_TIMEOUT_MS} from '../src/douyin/client.ts';
import {FEED_KEY,QUEUE_KEY} from '../src/douyin/feed-store.ts';
import {utf8Encode} from '../src/cloud/types.ts';
import type {HttpRequest,HttpResponse} from '../src/cloud/types.ts';
import type {Douyin403Options} from '../src/douyin/auth403.ts';
import type {DouyinScreenProps} from '../src/ui/douyin/index.tsx';

const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'douyin-entry-solid',setup(builder){builder.onLoad({filter:/\/ui\/(douyin\/ImmersiveEntry|PlatformNotice)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>({kind,props});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:Node['props'])=>element('View',p),Text:(p:Node['props'])=>element('Text',p),Image:(p:Node['props'])=>element('Image',p),FocusScope:(p:Node['props'])=>element('FocusScope',p)}));
const realHost=await import('@pocketjs/framework/host');mock.module('@pocketjs/framework/host',()=>({...realHost,getOps:()=>({measureText:(text:string)=>text.length*21})}));
let debugAllowed=false;
mock.module('../src/debug/host.ts',()=>({debugGate:{get allowed(){return debugAllowed;}}}));
let gesture:any;
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gesture=options;return {dispose(){}};}}));
const realServices=await import('@podjs/framework/services');
const retryTimers:Array<{ms:number;cancelled:boolean;fire:()=>void}>=[];
mock.module('@podjs/framework/services',()=>({...realServices,delay:(ms:number)=>{
 if(ms<1000)return {result:Promise.resolve(),cancel(){}};
 let fire!:()=>void;const result=new Promise<void>(r=>fire=r),entry={ms,cancelled:false,fire};retryTimers.push(entry);
 return {result,cancel(){entry.cancelled=true;}};
}}));
const {ImmersiveEntry}=await import('../src/ui/douyin/ImmersiveEntry.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{retryTimers.length=0;debugAllowed=false;for(const stop of stops.splice(0))stop();});
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props' in value))return [];return [value,...nodes(value.props.children)];}
// Event-loop turn only drains component promise chains; no elapsed-time assertions.
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
// Feed parsing now yields host turns. Observe the public settled state instead
// of assuming every response is synchronous after one event-loop turn.
async function settled(f:{text:()=>string}){const end=Date.now()+2000;while((f.text().includes('刷新中...')||f.text().includes('正在读取登录状态'))&&Date.now()<end)await settle();}
async function requestReady(f:{requests:unknown[]},count=1){const end=Date.now()+2000;while(f.requests.length<count&&Date.now()<end)await settle();}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const wire=(id:string)=>({aweme_id:id,desc:'video '+id,video:{play_addr:{url_list:['https://video.test/'+id]}}});
const response=(ids:string[],status=200):HttpResponse=>({status,headers:{},body:utf8Encode(JSON.stringify({aweme_list:ids.map(wire),has_more:0}))});
function mount(options:{cacheCount?:number;hasMore?:boolean;cursor?:string|null;logged?:boolean;resolveDetail?:boolean;autoEnter?:boolean;resume?:string;auth403?:Douyin403Options;secureGate?:Promise<void>;logoutBeforeMount?:boolean;stock?:boolean}={}){
  let now=1_000_000;
  const data=new Map<string,string>();if(options.logged!==false)data.set('douyin.cookie','sessionid=fixture');
  const items=Array.from({length:options.cacheCount??0},(_,i)=>({awemeId:String(i+1),description:'cached',playUrl:`https://old.test/${i+1}`,authorId:'',authorName:'',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[]}));
  const cached={items,anchorAwemeId:items[0]?.awemeId??null,cursor:options.cursor??null,hasMore:options.hasMore??false,savedAtMillis:1,resolved:{}};
  data.set(FEED_KEY,JSON.stringify(cached));data.set(QUEUE_KEY,JSON.stringify(cached));
  const requests:{request:HttpRequest;reply:ReturnType<typeof deferred<HttpResponse>>}[]=[],plays:any[]=[],routes:any[]=[];
  const client=new DouyinClient({auth403:options.auth403,secureStorage:{get:async k=>{await options.secureGate;return data.get(k)??null;},set:async(k,v)=>{data.set(k,v);},remove:async k=>{data.delete(k);}},now:()=>now,signer:{sign:()=> 'fixture-signature'},transport:{request:request=>{const reply=deferred<HttpResponse>();requests.push({request,reply});return reply.promise;}}});
  if(options.logoutBeforeMount)void client.logout();
  const [active,setActive]=createSignal(true);let dispose!:()=>void;
  const root=createRoot(stop=>{dispose=stop;stops.push(stop);return ImmersiveEntry({route:{name:"entry",debugAutoEnterFlow:options.autoEnter,resumeAwemeId:options.resume},width:233,height:233,client,restoreStock:options.stock?async()=>items:undefined,get active(){return active();},onPlay:(value:any)=>plays.push(value),onNavigate:(value:any)=>routes.push(value)} as unknown as DouyinScreenProps);});
  const entryGesture=gesture;
  return {data,client,requests,plays,routes,dispose,setActive,advance:(ms:number)=>{now+=ms;},
    text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),
    swipe:(dy:number)=>entryGesture.onPanEnd({dy}),
    press:()=>nodes(root).find(n=>n.kind==='View'&&n.props.accessibilityRole==='button'&&n.props.class?.includes('rounded-full'))!.props.onPress()};
}

for(const outcome of ['success','timeout','http','empty','expired','status8','parse'] as const)test(`fresh feed ${outcome} leaves 刷新中 and supports the native next action`,async()=>{
  const f=mount();await requestReady(f);
  expect(f.requests).toHaveLength(1);expect(f.text()).toContain('刷新中...');
  const {request,reply}=f.requests[0]!;const url=new URL(request.url);
  expect(request).toMatchObject({method:'POST',timeoutMs:DOUYIN_NETWORK_TIMEOUT_MS,readTimeoutMs:10_000,acceptHttpErrors:true,body:new Uint8Array(0)});
  expect(url.pathname).toBe('/aweme/v2/web/module/feed/');expect(url.searchParams.get('count')).toBe('16');expect(url.searchParams.has('aweme_id')).toBe(false);
  if(outcome==='timeout')reply.reject({code:'host_error',message:'java.net.SocketTimeoutException: read timed out'});
  else if(outcome==='expired')reply.resolve({status:200,headers:{},body:utf8Encode('blocked')});
  else if(outcome==='status8')reply.resolve({status:200,headers:{},body:utf8Encode('{"status_code":8,"status_msg":"synthetic"}')});
  else if(outcome==='parse')reply.resolve({status:200,headers:{},body:utf8Encode('{')});
  else reply.resolve(response(outcome==='empty'?[]:['fresh'],outcome==='http'?503:200));
  await settled(f);expect(f.text()).not.toContain('刷新中...');expect(f.plays).toHaveLength(0);
  if(outcome==='success'){
    expect(f.text()).toContain('下拉刷新，向上进入短视频流');f.swipe(-80);await settle();
    expect(f.plays).toMatchObject([{item:{awemeId:'fresh'},immersive:true}]);expect(f.requests).toHaveLength(1);
  }else if(outcome==='status8'){
    expect(f.text()).toContain('需要登录');expect(f.text()).not.toContain('暂无内容');expect(f.data.has('douyin.cookie')).toBe(false);f.press();await settle();expect(f.routes).toEqual([{name:'login'}]);
  }else if(outcome==='expired'){
    expect(f.data.has('douyin.cookie')).toBe(true);expect(f.text()).toContain('请稍后重试');
  }else{
    expect(f.text()).toContain(outcome==='empty'?'暂无内容，下拉刷新或点箭头重试':outcome==='parse'?'解析失败':'网络请求失败');
    f.press();await settle();expect(f.requests).toHaveLength(2);expect(f.text()).toContain('刷新中...');
    f.requests[1]!.reply.resolve(response(['retry']));await settled(f);expect(f.text()).not.toContain('刷新中...');
  }
});

test('upward entry is immediate even if the expired cached detail refresh never settles',async()=>{
  const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);
  expect(f.requests).toHaveLength(1);expect(new URL(f.requests[0]!.request.url).pathname).toBe('/aweme/v1/web/aweme/detail/');
  expect(f.text()).not.toContain('刷新中...');f.swipe(-80);await settle();
  expect(f.plays).toMatchObject([{item:{awemeId:'1'},playback:{playUrl:'https://old.test/1'},immersive:true}]);
  expect(f.routes).toEqual([{name:'player',awemeId:'1'}]);expect(f.requests).toHaveLength(1);expect(f.text()).not.toContain('刷新中...');
});

for(const options of [{cacheCount:1},{cacheCount:2},{cacheCount:4,hasMore:true,cursor:null}])test(`native bootstrap feed rule ${JSON.stringify(options)}`,async()=>{
  const f=mount(options);await requestReady(f);expect(f.requests).toHaveLength(1);expect(new URL(f.requests[0]!.request.url).pathname).toBe('/aweme/v2/web/module/feed/');
  f.requests[0]!.reply.resolve(response(['fresh']));for(let i=0;i<30;i++)await settle();expect(f.text()).not.toContain('刷新中...');f.swipe(-80);await settle();expect(f.plays[0]?.item.awemeId).toBe('fresh');
});

test('cached feed refresh failure remains retryable without serial detail probes',async()=>{
  const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);f.swipe(80);await settle();
  expect(f.requests).toHaveLength(2);expect(f.text()).not.toContain('刷新中...');
  f.requests[1]!.reply.resolve(response([],503));const deadline=Date.now()+2000;while(!f.text().includes('网络请求失败')&&Date.now()<deadline)await settle();expect(f.text()).toContain('网络请求失败');expect(f.text()).not.toContain('刷新中...');
  f.swipe(-80);await settle();expect(f.plays).toHaveLength(1);expect(f.requests).toHaveLength(2);
});

test('inactive entry reactivation shares a pending page and accepts it only in the current view',async()=>{
 const f=mount();await requestReady(f);f.setActive(false);await settled(f);f.setActive(true);await settle();
 expect(f.requests).toHaveLength(1);f.requests[0]!.reply.resolve(response(['new']));await settled(f);
 expect(f.data.has('douyin.cookie')).toBe(true);f.press();await settle();expect(f.plays[0]?.item.awemeId).toBe('new');
});

test('missing login leaves refresh state without a network request',async()=>{
  const f=mount({logged:false});await settle();expect(f.requests).toHaveLength(0);expect(f.text()).not.toContain('刷新中...');expect(f.text()).toContain('需要登录');f.swipe(-80);await settle();expect(f.routes).toEqual([{name:'login'}]);
});

for(const debug of [false,true])test(`external entry never auto-plays, including a legacy auto-enter flag debug=${debug}`,async()=>{
 debugAllowed=debug;const f=mount({cacheCount:4,hasMore:true,cursor:'c',autoEnter:true,resume:'2'});await settled(f);await settle();
 expect(f.plays).toHaveLength(0);expect(f.routes).toHaveLength(0);
 f.setActive(false);f.setActive(true);await settled(f);await settle();
 expect(f.plays).toHaveLength(0);
 f.press();expect(f.plays).toHaveLength(1);
 expect(f.plays[0].item.awemeId).toBe('2');expect(f.plays[0].immersive).toBe(true);
});


test('failed expired anchor replenishes the preload window with fresh feed without gating entry or clearing login',async()=>{
 const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);expect(f.text()).not.toContain('刷新中...');
 f.requests[0]!.reply.resolve(response([],503));await requestReady(f,2);
 expect(new URL(f.requests[1]!.request.url).pathname).toBe('/aweme/v2/web/module/feed/');
 expect(f.text()).not.toContain('刷新中...');expect(f.data.has('douyin.cookie')).toBe(true);
 f.requests[1]!.reply.resolve(response(['fresh-preload']));
 for(let n=0;n<30;n++)await settle();f.swipe(-80);await settle();
 expect(f.plays.at(-1)?.item.awemeId).toBe('fresh-preload');expect(f.data.has('douyin.cookie')).toBe(true);
});


for(const mode of ['authenticated','unknown'] as const)test(`temporary ${mode} 403 keeps login and retries only when the cooldown timer expires`,async()=>{
 const f=mount({auth403:{sleep:async()=>{},probe:async()=>mode}});await requestReady(f);
 f.requests[0]!.reply.resolve(response([],403));await requestReady(f,2);f.requests[1]!.reply.resolve(response([],403));await settled(f);
 expect(f.text()).toContain('抖音暂时不可用，请稍后重试');expect(f.data.has('douyin.cookie')).toBe(true);expect(f.routes).toEqual([]);expect(retryTimers.filter(t=>!t.cancelled&&t.ms===30000)).toHaveLength(1);const scheduled=retryTimers.find(t=>!t.cancelled&&t.ms===30000)!;expect(scheduled.ms).toBe(30000);
 f.press();await settled(f);expect(f.requests).toHaveLength(2);expect(scheduled.cancelled).toBe(true);
 f.advance(30000);retryTimers.at(-1)!.fire();await requestReady(f,3);f.requests[2]!.reply.resolve(response(['after-cooldown']));await settled(f);
 f.press();await settle();expect(f.plays[0]?.item.awemeId).toBe('after-cooldown');expect(f.data.has('douyin.cookie')).toBe(true);
});

test('leaving or disposing an entry cancels its temporary-failure retry timer',async()=>{
 for(const leave of ['inactive','disposed'] as const){
  retryTimers.length=0;const f=mount({auth403:{sleep:async()=>{}}});await requestReady(f);f.requests[0]!.reply.resolve(response([],403));await requestReady(f,2);f.requests[1]!.reply.resolve(response([],403));await settled(f);
  const timer=retryTimers[0]!;if(leave==='inactive')f.setActive(false);else f.dispose();await settle();expect(timer.cancelled).toBe(true);f.advance(30000);timer.fire();await settle();expect(f.requests).toHaveLength(2);
 }
});

test('cached anchor status8 replaces cached playback with a login action',async()=>{
 const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);f.requests[0]!.reply.resolve({status:200,headers:{},body:utf8Encode('{"status_code":8}')});
 const end=Date.now()+2000;while(!f.text().includes('需要登录')&&Date.now()<end)await settle();
 expect(f.text()).toContain('需要登录');expect(f.text()).not.toContain('暂无内容');expect(f.data.has('douyin.cookie')).toBe(false);f.press();await settle();expect(f.plays).toHaveLength(0);expect(f.routes).toEqual([{name:'login'}]);
});

test('DYFIX exhausted saved feed is refreshed instead of reused as a ready bootstrap',async()=>{
 const f=mount({cacheCount:4,hasMore:false,cursor:'old'});await requestReady(f);expect(new URL(f.requests[0]!.request.url).pathname).toBe('/aweme/v2/web/module/feed/');expect(f.text()).not.toContain('刷新中...');
 f.requests[0]!.reply.resolve(response(['new']));for(let i=0;i<30;i++)await settle();f.press();await settle();expect(f.plays[0]?.item.awemeId).toBe('new');
});

 test('DYUI remembered logout renders login immediately even with secure reads blocked',async()=>{
 const gate=deferred<void>();const f=mount({logoutBeforeMount:true,secureGate:gate.promise});
 const initial=f.text();f.press();const routes=[...f.routes];gate.resolve();await settle();
 expect(initial).toContain('需要登录');expect(initial).not.toContain('刷新中');expect(routes).toEqual([{name:'login'}]);
 });

test('DYBENCH entry requests native needs_login presentation and cancels it on deactivation',async()=>{
 const before=(globalThis as any).pod,events:any[]=[];let seq=300;
 (globalThis as any).pod={benchmark:(raw:string)=>{const value=JSON.parse(raw);if(!value.seq)value.seq=++seq;events.push(value);return value.seq;}};
 try{
  const f=mount({logged:false});await settle();const begin=events.find(x=>x.code==='entry_start'),present=events.find(x=>x.code==='needs_login'&&x.presented);
  expect(begin).toBeDefined();expect(present?.seq).toBe(begin.seq);expect(events.some(x=>x.code==='refreshing')).toBe(false);
  f.setActive(false);await settle();expect(events.some(x=>x.code==='needs_login'&&x.cancel_presented&&x.seq===begin.seq)).toBe(true);
 }finally{(globalThis as any).pod=before;}
});

for(const cacheCount of [0,2])test(`DYFIX bounded never-settling feed preserves cached entry (${cacheCount})`,async()=>{
 const f=mount({cacheCount});await requestReady(f);
 const timeout=retryTimers.find(t=>t.ms===1500&&!t.cancelled)!;expect(timeout).toBeDefined();
 timeout.fire();await settle();expect(f.text()).not.toContain('刷新中');expect(f.data.has('douyin.cookie')).toBe(true);
 if(cacheCount){f.swipe(-80);await settle();expect(f.plays[0]?.item.awemeId).toBe('1');}
 f.requests[0]!.reply.resolve(response(['late']));for(let i=0;i<20;i++)await settle();
 expect(f.text()).not.toContain('刷新中');if(cacheCount){f.swipe(-80);await settle();expect(f.plays.at(-1)?.item.awemeId).toBe('1');}
});

test('DYFIX entry never waits on unrelated history migration',async()=>{
 const f=mount();f.client.prepareHistory=()=>new Promise(()=>{});await requestReady(f);
 expect(f.requests.length).toBe(1);f.requests[0]!.reply.resolve(response(['fresh']));await settled(f);
 expect(f.text()).not.toContain('刷新中');f.press();await settle();expect(f.plays[0]?.item.awemeId).toBe('fresh');
});

test('DYERR cached list is usable while bootstrap is still pending',async()=>{
 const f=mount({cacheCount:2});await requestReady(f);
 expect(f.text()).not.toContain('刷新中');f.press();expect(f.plays).toHaveLength(1);
 expect(f.plays[0].isCurrent()).toBe(true);f.setActive(false);expect(f.plays[0].isCurrent()).toBe(false);
 f.requests[0]!.reply.resolve(response(['late']));await settle();expect(f.plays).toHaveLength(1);
});

test('DYERR foreground failure offers retry, preserves cooldown and retries the same selection',async()=>{
 const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);f.press();
 const first=f.plays[0];expect(first.onFailure).toBeFunction();
 first.onFailure({code:'TEMPORARILY_UNAVAILABLE',retryAfterMs:45000});
 expect(f.text()).toContain('抖音暂时不可用');expect(f.text()).toContain('重试');expect(f.data.has('douyin.cookie')).toBe(true);
 const retry=retryTimers.find(t=>t.ms===45000&&!t.cancelled)!;expect(retry).toBeDefined();
 f.advance(44999);expect(f.plays).toHaveLength(1);f.advance(1);retry.fire();await settle();
 expect(f.plays).toHaveLength(2);expect(f.plays[1].item.awemeId).toBe(first.item.awemeId);expect(first.isCurrent()).toBe(false);
 // Navigation cancels retries and fences callbacks from earlier actions.
 f.plays[1].onFailure({code:'REQUEST_FAILED'});const pending=[...retryTimers].reverse().find(t=>!t.cancelled)!;
 f.setActive(false);expect(pending.cancelled).toBe(true);pending.fire();await settle();expect(f.plays).toHaveLength(2);
});

test('DYERR transport failures back off and never spin on a cached list',async()=>{
 const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);f.press();
 for(const [index,ms] of [1000,2000,4000].entries()){
  f.plays[index].onFailure({code:'REQUEST_FAILED'});expect(f.text()).toContain('重试');
  const timer=[...retryTimers].reverse().find(t=>!t.cancelled&&t.ms===ms)!;expect(timer).toBeDefined();
  timer.fire();await settle();expect(f.plays).toHaveLength(index+2);
 }
});

test('DYERR accepted refresh pairs native presentation with its own sequence and closed failure',async()=>{
 const before=(globalThis as any).pod,events:any[]=[];let seq=700;
 (globalThis as any).pod={benchmark:(raw:string)=>{const value=JSON.parse(raw);if(!value.seq)value.seq=++seq;events.push(value);return value.seq;}};
 try{
  const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);f.swipe(80);await requestReady(f,2);
  expect(f.text()).not.toContain('刷新中');const start=events.find(e=>e.code==='refresh_start');expect(start).toBeDefined();
  expect(events.some(e=>e.code==='refresh_done')).toBe(false);
  const deadline=[...retryTimers].reverse().find(t=>t.ms===1500&&!t.cancelled)!;deadline.fire();await settle();
  expect(f.text()).toContain('网络请求失败');expect(events.filter(e=>e.code==='refresh_done'&&e.presented)).toEqual([{code:'refresh_done',seq:start.seq,presented:true}]);
  expect(events.some(e=>e.code==='error'&&e.seq===start.seq)).toBe(true);
  expect(events.some(e=>e.code==='first_card')).toBe(false);
  f.setActive(false);expect(events.some(e=>e.code==='refresh_done'&&e.cancel_presented&&e.seq===start.seq)).toBe(true);
 }finally{(globalThis as any).pod=before;}
});

test('DYERR feed transport failure automatically retries and successful retry publishes fresh content',async()=>{
 const f=mount();await requestReady(f);f.requests[0]!.reply.resolve(response([],503));await settled(f);
 const timer=retryTimers.find(t=>t.ms===1000&&!t.cancelled)!;expect(timer).toBeDefined();expect(f.text()).toContain('重试');
 timer.fire();await requestReady(f,2);f.requests[1]!.reply.resolve(response(['recovered']));await settled(f);f.press();
 expect(f.plays[0].item.awemeId).toBe('recovered');expect(f.data.has('douyin.cookie')).toBe(true);
});


test('DYERR temporary failures without a cooldown hint back off from thirty to sixty seconds',async()=>{
 const f=mount({cacheCount:4,hasMore:true,cursor:'c'});await requestReady(f);f.press();
 for(const [index,ms] of [30000,60000].entries()){
  f.plays[index].onFailure({code:'TEMPORARILY_UNAVAILABLE'});
  const timer=[...retryTimers].reverse().find(t=>!t.cancelled&&t.ms===ms)!;expect(timer).toBeDefined();
  timer.fire();await settle();expect(f.plays).toHaveLength(index+2);
 }
});


test('persisted ready stock enters with zero feed or detail requests',async()=>{
 const f=mount({cacheCount:3,stock:true});await settled(f);expect(f.requests).toHaveLength(0);f.press();await settle();
 expect(f.plays[0].item.awemeId).toBe('1');expect(f.plays[0].playlist).toHaveLength(3);expect(f.requests).toHaveLength(0);
});
