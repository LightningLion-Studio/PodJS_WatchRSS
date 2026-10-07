import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import {DouyinClient,DOUYIN_NETWORK_TIMEOUT_MS} from '../src/douyin/client.ts';
import {FEED_KEY,QUEUE_KEY} from '../src/douyin/feed-store.ts';
import {utf8Encode} from '../src/cloud/types.ts';
import type {HttpRequest,HttpResponse} from '../src/cloud/types.ts';
import type {DouyinScreenProps} from '../src/ui/douyin/index.tsx';

const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'douyin-entry-solid',setup(builder){builder.onLoad({filter:/\/ui\/douyin\/ImmersiveEntry\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>({kind,props});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:Node['props'])=>element('View',p),Text:(p:Node['props'])=>element('Text',p),Image:(p:Node['props'])=>element('Image',p)}));
const realHost=await import('@pocketjs/framework/host');mock.module('@pocketjs/framework/host',()=>({...realHost,getOps:()=>({measureText:(text:string)=>text.length*21})}));
let gesture:any;
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(options:any)=>{gesture=options;return {dispose(){}};}}));
const {ImmersiveEntry}=await import('../src/ui/douyin/ImmersiveEntry.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{for(const stop of stops.splice(0))stop();});
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props' in value))return [];return [value,...nodes(value.props.children)];}
// Event-loop turn only drains component promise chains; no elapsed-time assertions.
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
// Feed parsing now yields host turns. Observe the public settled state instead
// of assuming every response is synchronous after one event-loop turn.
async function settled(f:{text:()=>string}){const end=Date.now()+2000;while(f.text().includes('刷新中...')&&Date.now()<end)await settle();}
async function requestReady(f:{requests:unknown[]},count=1){const end=Date.now()+2000;while(f.requests.length<count&&Date.now()<end)await settle();}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const wire=(id:string)=>({aweme_id:id,desc:'video '+id,video:{play_addr:{url_list:['https://video.test/'+id]}}});
const response=(ids:string[],status=200):HttpResponse=>({status,headers:{},body:utf8Encode(JSON.stringify({aweme_list:ids.map(wire),has_more:0}))});
function mount(options:{cacheCount?:number;hasMore?:boolean;cursor?:string|null;logged?:boolean;resolveDetail?:boolean}={}){
  const data=new Map<string,string>();if(options.logged!==false)data.set('douyin.cookie','sessionid=fixture');
  const items=Array.from({length:options.cacheCount??0},(_,i)=>({awemeId:String(i+1),description:'cached',playUrl:`https://old.test/${i+1}`,authorId:'',authorName:'',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[]}));
  const cached={items,anchorAwemeId:items[0]?.awemeId??null,cursor:options.cursor??null,hasMore:options.hasMore??false,savedAtMillis:1,resolved:{}};
  data.set(FEED_KEY,JSON.stringify(cached));data.set(QUEUE_KEY,JSON.stringify(cached));
  const requests:{request:HttpRequest;reply:ReturnType<typeof deferred<HttpResponse>>}[]=[],plays:any[]=[],routes:any[]=[];
  const client=new DouyinClient({secureStorage:{get:async k=>data.get(k)??null,set:async(k,v)=>{data.set(k,v);},remove:async k=>{data.delete(k);}},now:()=>1_000_000,signer:{sign:()=> 'fixture-signature'},transport:{request:request=>{const reply=deferred<HttpResponse>();requests.push({request,reply});return reply.promise;}}});
  const [active,setActive]=createSignal(true);let dispose!:()=>void;
  const root=createRoot(stop=>{dispose=stop;stops.push(stop);return ImmersiveEntry({width:233,height:233,client,get active(){return active();},onPlay:(value:any)=>plays.push(value),onNavigate:(value:any)=>routes.push(value)} as unknown as DouyinScreenProps);});
  const entryGesture=gesture;
  return {data,client,requests,plays,routes,dispose,setActive,
    text:()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('\n'),
    swipe:(dy:number)=>entryGesture.onPanEnd({dy}),
    press:()=>nodes(root).find(n=>n.kind==='View'&&n.props.accessibilityRole==='button'&&n.props.class?.includes('rounded-full'))!.props.onPress()};
}

for(const outcome of ['success','timeout','http','empty','expired','parse'] as const)test(`fresh feed ${outcome} leaves 刷新中 and supports the native next action`,async()=>{
  const f=mount();await requestReady(f);
  expect(f.requests).toHaveLength(1);expect(f.text()).toContain('刷新中...');
  const {request,reply}=f.requests[0]!;const url=new URL(request.url);
  expect(request).toMatchObject({method:'POST',timeoutMs:DOUYIN_NETWORK_TIMEOUT_MS,readTimeoutMs:10_000,acceptHttpErrors:true,body:new Uint8Array(0)});
  expect(url.pathname).toBe('/aweme/v2/web/module/feed/');expect(url.searchParams.get('count')).toBe('16');expect(url.searchParams.has('aweme_id')).toBe(false);
  if(outcome==='timeout')reply.reject({code:'host_error',message:'java.net.SocketTimeoutException: read timed out'});
  else if(outcome==='expired')reply.resolve({status:200,headers:{},body:utf8Encode('blocked')});
  else if(outcome==='parse')reply.resolve({status:200,headers:{},body:utf8Encode('{')});
  else reply.resolve(response(outcome==='empty'?[]:['fresh'],outcome==='http'?503:200));
  await settled(f);expect(f.text()).not.toContain('刷新中...');expect(f.plays).toHaveLength(0);
  if(outcome==='success'){
    expect(f.text()).toContain('下拉刷新，向上进入短视频流');f.swipe(-80);await settle();
    expect(f.plays).toMatchObject([{item:{awemeId:'fresh'},immersive:true}]);expect(f.requests).toHaveLength(1);
  }else if(outcome==='expired'){
    expect(f.text()).toContain('需要登录');expect(f.data.has('douyin.cookie')).toBe(false);f.press();await settle();expect(f.routes).toEqual([{name:'login'}]);
  }else{
    expect(f.text()).toContain(outcome==='empty'?'暂无内容，下拉刷新或点箭头重试':outcome==='parse'?'解析失败':'网络请求失败');
    f.press();await settle();expect(f.requests).toHaveLength(2);expect(f.text()).toContain('刷新中...');
    f.requests[1]!.reply.resolve(response(['retry']));await settled(f);expect(f.text()).not.toContain('刷新中...');
  }
});

test('upward entry is immediate even if the expired cached detail refresh never settles',async()=>{
  const f=mount({cacheCount:4});await requestReady(f);
  expect(f.requests).toHaveLength(1);expect(new URL(f.requests[0]!.request.url).pathname).toBe('/aweme/v1/web/aweme/detail/');
  expect(f.text()).not.toContain('刷新中...');f.swipe(-80);await settle();
  expect(f.plays).toMatchObject([{item:{awemeId:'1'},playback:{playUrl:'https://old.test/1'},immersive:true}]);
  expect(f.routes).toEqual([{name:'player',awemeId:'1'}]);expect(f.requests).toHaveLength(1);expect(f.text()).not.toContain('刷新中...');
});

for(const options of [{cacheCount:1},{cacheCount:2},{cacheCount:4,hasMore:true,cursor:null}])test(`native bootstrap feed rule ${JSON.stringify(options)}`,async()=>{
  const f=mount(options);await requestReady(f);expect(f.requests).toHaveLength(1);expect(new URL(f.requests[0]!.request.url).pathname).toBe('/aweme/v2/web/module/feed/');
  f.requests[0]!.reply.resolve(response(['fresh']));await settled(f);expect(f.text()).not.toContain('刷新中...');f.swipe(-80);await settle();expect(f.plays[0]?.item.awemeId).toBe('fresh');
});

test('cached feed refresh failure remains retryable without serial detail probes',async()=>{
  const f=mount({cacheCount:4});await requestReady(f);f.swipe(80);await settle();
  expect(f.requests).toHaveLength(2);expect(f.text()).toContain('刷新中...');
  f.requests[1]!.reply.resolve(response([],403));await settle();expect(f.text()).toContain('网络请求失败');expect(f.text()).not.toContain('刷新中...');
  f.swipe(-80);await settle();expect(f.plays).toHaveLength(1);expect(f.requests).toHaveLength(2);
});

test('late response from an inactive entry cannot erase login or a newer feed',async()=>{
  const f=mount();await requestReady(f);f.setActive(false);await settled(f);expect(f.text()).not.toContain('刷新中...');
  f.setActive(true);await requestReady(f,2);expect(f.requests).toHaveLength(2);
  f.requests[1]!.reply.resolve(response(['new']));await settled(f);
  f.requests[0]!.reply.resolve({status:200,headers:{},body:utf8Encode('blocked')});await settle();
  expect(f.text()).not.toContain('刷新中...');expect(f.data.has('douyin.cookie')).toBe(true);f.press();await settle();expect(f.plays[0]?.item.awemeId).toBe('new');
});

test('missing login leaves refresh state without a network request',async()=>{
  const f=mount({logged:false});await settle();expect(f.requests).toHaveLength(0);expect(f.text()).not.toContain('刷新中...');expect(f.text()).toContain('需要登录');f.swipe(-80);await settle();expect(f.routes).toEqual([{name:'login'}]);
});
