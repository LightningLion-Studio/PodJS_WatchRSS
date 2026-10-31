import {plugin} from 'bun';
import {bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import {mock,expect,test} from 'bun:test';
import {createComponent,createMemo,onCleanup} from 'solid-js';
import * as solidRuntime from 'solid-js';
for(const base of [Bun.resolveSync('@podjs/framework/watch',import.meta.dir),Bun.resolveSync('@pocketjs/framework',import.meta.dir)])mock.module(Bun.resolveSync('solid-js',base),()=>solidRuntime);
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'rapid-back-solid',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
let clockMs=0,next=1;Date.now=()=>clockMs;
const kv=new Map<string,string>(),events:any[]=[],timers=new Map<number,number>();
let backEventsDelivered=0,saveCalls=0;let exitTimerStarted=false;
const props=new Map<number,Map<number,number>>(),texts=new Map<number,string>();
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000}};
for(const name of ['destroyNode','insertBefore','removeChild','setStyle','setImage','setSprite','setFocus','animate','setAccessibility','setNavigationState'])ops[name]=()=>{};
ops.createNode=()=>next++;
ops.setProp=(id:number,key:number,value:number)=>{let p=props.get(id);if(!p)props.set(id,p=new Map());p.set(key,value);};
ops.setText=ops.replaceText=(id:number,text:string)=>texts.set(id,text);
ops.loadPakImage=()=>next++;ops.uploadTexture=()=>next++;ops.freeTexture=()=>{};ops.measureText=(s:string)=>s.length*8;
ops.wrapText=()=>[];ops.getLayout=()=>({x:0,y:0,w:233,h:193});ops.getProp=(id:number,key:number)=>props.get(id)?.get(key)??0;
(globalThis as any).pod={capabilities:()=>JSON.stringify(['data.kv','runtime.timer']),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t!=='service.request')return;let value:any=null;const {method,id,args}=r;
 if(method==='runtime.delay'){if(args.milliseconds===2500)exitTimerStarted=true;timers.set(id,clockMs+args.milliseconds);return;}
 if(method==='application.activityState.write'||method==='app.activityState.write'){}
 else if(method==='media.video.stop'){}
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method==='text.layout')value={lines:[{start:0,end:args.text.length,visibleEnd:args.text.length}]};
 else if(method.includes('secure')||method.includes('file')){events.push({t:'service.result',id,ok:false,error:{code:'fixture',message:'unavailable'}});return;}
 events.push({t:'service.result',id,ok:true,value});
 }};
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
const {render}=await import('@pocketjs/framework');
const {setStyleResolver,rootMirror}=await import('@pocketjs/framework/renderer');
const {activityStateHub}=await import('../src/navigation/activity-host.ts');
const {captureActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {View}=await import('@pocketjs/framework/components');
const lists:any[]=[];
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(input:any)=>{
 const list={input,disposed:false};lists.push(list);
 input.ref?.({scroller:{offset:()=>0,stop(){},scrollBy(){}}});
 onCleanup(()=>{list.disposed=true;});
 const children=createMemo(()=>[...(input.entries??[]),...(input.indexedEntries?.entries??[]),...(input.footerEntries??[])].map((entry:any)=>entry.render()));
 return createComponent(View,{get children(){return children();}});
}}));
let rss:any;
mock.module('../src/ui/routes/rss.tsx',()=>({RssRoutes:(props:any)=>{rss=props;return null;}}));
const source='https://watchrss.local/import-txt-novel/book';
const article={id:'1811',channelId:'feed',title:'饮血巫术',link:source+'/chapter/1811',content:'',read:false};
const channel={id:'feed',title:'Book',url:source};
let resolveOpen!:(value:any)=>void,resolveMark!:()=>void,markCalls=0,delayMark=false;
let answer:any=article,fileAvailable=false,progressSaves=0;
const services:any=new Proxy({listChannels:async()=>[channel],listArticles:async()=>[article],getArticle:()=>new Promise(resolve=>{resolveOpen=resolve;}),markRead:async()=>{markCalls++;if(delayMark)await new Promise<void>(resolve=>resolveMark=resolve);},loadImportedTextChunk:async()=>fileAvailable?'正文恢复成功':null,listNovelChapters:async()=>[article],getChannelOriginalMode:async()=>false,getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readingProgress:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{progressSaves++;}},readAccountStatus:async()=>null,createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}})}, {get:(t,k)=>Reflect.get(t,k)??(['inputRecovery','retryOfflineMedia','readSummaryUsage','subscribeSummaryUsage','loadImportedTextChunk'].includes(String(k))?undefined:()=>Promise.resolve(null))});
const {DEFAULT_SETTINGS}=await import('../src/settings/store.ts');
const mode=process.env.BOOKQUERY_CASE??'late';
if(['late','input','mark-late','roundtrip','superseded'].includes(mode))answer={...article,content:'Ready body'};
kv.set('watchrss.transparency.initial_app_disclosure_v1','true');
if(mode.startsWith('restoring'))answer={...article,readerBodyState:'restoring'};
if(mode.startsWith('chunk'))answer={...article,importedText:{marker:'watchrss-watch-content:chapter.txt',byteLength:21,chunkBytes:16384,chunkCount:1}};
kv.set('watchrss.settings',JSON.stringify(JSON.stringify({...DEFAULT_SETTINGS,readerPageMode:mode.endsWith('page'),llmEnabled:false})));
activityStateHub.seed(captureActivityNavigation({saved:{},retained:{}},[{page:'home'},{page:'articles',channelId:'feed'}]));
const WatchRSS=(await import('../src/ui/screen.tsx')).default;
const stop=render(()=>{setStyleResolver(()=>0);return WatchRSS({services});},{ops});
async function tick(dt=17){clockMs+=dt;for(const [id,at]of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}(globalThis as any).frame(0,undefined);for(let n=0;n<25;n++)await Promise.resolve();}
async function settle(){for(let n=0;n<30;n++)await tick();}
const state=()=>{const data:any=activityStateHub.read().saved['watchrss.content-activity'];return data?.entries?.map((e:any)=>e.page) as string[];};
const connected=()=>{const result:any[]=[];const walk=(node:any)=>{result.push(node);node.children.forEach(walk);};walk(rootMirror);return result;};
const text=()=>connected().map(node=>texts.get(node.id)??'').join('');
test(`production chapter open: ${mode}`,async()=>{
 await settle();expect(state()).toEqual(['home','articles']);
 const opening=rss.openArticle(article);await tick();
 if(mode==='superseded'){
  const first=resolveOpen,second=rss.openArticle({...article,id:'1812',title:'新章节'});
  first(answer);await settle();expect(state()).toEqual(['home','articles']);expect(markCalls).toBe(0);
  resolveOpen({...article,id:'1812',title:'新章节',content:'新章节正文'});await second;await opening;await settle();
  expect(state().at(-1)).toBe('reader');expect(text()).toContain('新章节正文');expect(markCalls).toBe(1);
 }else if(mode==='late'||mode==='input'||mode==='mark-late'||mode==='roundtrip'){
  if(mode==='mark-late'){delayMark=true;resolveOpen(answer);await settle();expect(markCalls).toBe(1);}
  rss.popPage();await settle();expect(state()).toEqual(['home']);
  if(mode==='roundtrip'){rss.setPage('articles',{channelId:'feed'});rss.popPage();await settle();}
  if(mode==='input')expect(lists.find(list=>!list.disposed&&list.input.onLongPress)?.input.inputActive()).toBe(true);
  if(mode==='mark-late')resolveMark();else resolveOpen(answer);
  await opening;await settle();expect(state()).toEqual(['home']);
  if(mode!=='mark-late')expect(markCalls).toBe(0);
 }else{
  resolveOpen(answer);await opening;await settle();expect(state().at(-1)).toBe('reader');
  expect(text()).toContain(mode.startsWith('restoring')?'正在从云端恢复':'加载失败可重试');
  expect(progressSaves).toBe(0);expect(markCalls).toBe(mode.startsWith('chunk')?1:0);
  const {pressNode}=await import('@pocketjs/framework/input');
  const retry=connected().find(node=>node.domAttrs?.accessibilityLabel==='重试加载正文');expect(retry).toBeDefined();
  pressNode(retry);await tick();
  if(mode.startsWith('retry-late')){rss.popPage();await settle();}
  fileAvailable=true;resolveOpen({...article,content:'正文恢复成功'});await settle();
  if(mode.startsWith('retry-late'))expect(state()).toEqual(['home','articles']);
  else {expect(text()).toContain('正文恢复成功');expect(text()).not.toContain('加载失败可重试');expect(text()).not.toContain('正在从云端恢复');}

 }
 stop();
});
