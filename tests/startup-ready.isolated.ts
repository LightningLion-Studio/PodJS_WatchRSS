import {plugin} from 'bun';
import {expect,mock,test} from 'bun:test';
import type {ActivityState} from '@podjs/framework/services';
import type {AppServices,Article,Channel} from '../src/ui/service.ts';
import {bindPocketModules,bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import * as solidRuntime from 'solid-js';
for(const base of [Bun.resolveSync('@podjs/framework/watch',import.meta.dir),Bun.resolveSync('@pocketjs/framework',import.meta.dir)])mock.module(Bun.resolveSync('solid-js',base),()=>solidRuntime);
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'startup-ready-solid',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
let clockMs=0,next=1;Date.now=()=>clockMs;
const kv=new Map<string,string>(),events:unknown[]=[],timers=new Map<number,number>();
const props=new Map<number,Map<number,number>>();
const ops:Record<string,unknown>={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000}};
for(const name of ['insertBefore','removeChild','setStyle','setImage','setSprite','setFocus','animate','setAccessibility','setNavigationState'])ops[name]=()=>{};
ops.destroyNode=(id:number)=>props.delete(id);
ops.createNode=()=>next++;
ops.setProp=(id:number,key:number,value:number)=>{let p=props.get(id);if(!p)props.set(id,p=new Map());p.set(key,value);};
ops.setText=ops.replaceText=()=>{};
ops.loadPakImage=()=>next++;ops.uploadTexture=()=>next++;ops.freeTexture=()=>{};ops.measureText=(s:string)=>s.length*8;
ops.wrapText=()=>[];ops.getLayout=()=>({x:0,y:0,w:233,h:193});ops.getProp=(id:number,key:number)=>props.get(id)?.get(key)??0;
const pod={capabilities:()=>JSON.stringify(['data.kv','runtime.timer','host.lifecycle','text.layout']),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t!=='service.request')return;let value:unknown=null;const {method,id,args}=r;
 if(method==='runtime.delay'){timers.set(id,clockMs+args.milliseconds);return;}
 if(method==='app.activityState.read')value=taskState;
 else if(method==='splash.release')released.push({ms:clockMs,pages:state(),articleDataReady,paintAcknowledged});
 else if(method==='runtime.afterPaint'){paint.push(id);return;}
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method==='text.layout')value={lines:[{start:0,end:args.text.length,visibleEnd:args.text.length}]};
 else if(method.includes('secure')||method.includes('file')){events.push({t:'service.result',id,ok:false,error:{code:'fixture',message:'unavailable'}});return;}
 events.push({t:'service.result',id,ok:true,value});
 }};
Object.assign(globalThis,{pod});
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
await bindPocketModules(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir),[
 'solid-js','@pocketjs/framework/renderer','@pocketjs/framework/components','@pocketjs/framework/host',
 '@pocketjs/framework/lifecycle','@pocketjs/framework/gesture','@pocketjs/framework/kinetics','@pocketjs/framework/input'
]);

const {render}=await import('@pocketjs/framework');
const {setStyleResolver}=await import('@pocketjs/framework/renderer');
const {captureActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {activityStateHub}=await import('../src/navigation/activity-host.ts');
const {StartupGate}=await import('../src/ui/StartupGate.tsx');
const {default:WatchRSS}=await import('../src/ui/screen.tsx');
const scenario=process.env.WRSS_STARTUP_FIXTURE;
const channel={id:'fixture-feed',title:'Local fixture channel',url:'https://example.invalid/rss'} as Channel;
const article={id:'fixture-item',channelId:channel.id,title:'Local fixture article',content:'<p>fixture</p>'} as Article;
const empty={saved:{},retained:{}};
const taskState:ActivityState=captureActivityNavigation(empty,scenario==='settings'?[{page:'home'},{page:'settings'}]:
 scenario==='feed'||scenario==='missing'?[{page:'home'},{page:'articles',channelId:scenario==='missing'?'missing':channel.id}]:[{page:'home'}]);
const state=()=>((activityStateHub.read().saved['watchrss.content-activity'] as {entries?:{page:string}[]}|undefined)?.entries??[]).map(entry=>entry.page);
const released:{ms:number;pages:string[];articleDataReady:boolean;paintAcknowledged:boolean}[]=[],paint:number[]=[];
let articleDataReady=false;
let paintAcknowledged=false;
let channelLoads=0;
const pending:{at:number;run():void}[]=[];
function at<T>(time:number,value:T):Promise<T>{
 return new Promise(resolve=>pending.push({at:time,run:()=>resolve(value)}));
}
const services=new Proxy({
 listChannels:()=>{channelLoads++;return at(scenario==='settings'||scenario==='timeout'?1600:80,[channel]);},
 listArticles:async()=>{const articles=await at(220,[article]);articleDataReady=true;return articles;},
 getArticle:async()=>article,
 getChannelOriginalMode:async()=>false,
 getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),
 subscribeChannel:()=>()=>{},
 subscribeAccountStatus:()=>()=>{},
 readAccountStatus:async()=>null,
},{get:(target,key)=>Reflect.get(target,key)??(key==='inputRecovery'?undefined:()=>Promise.resolve(null))}) as unknown as AppServices;

async function tick(){
 clockMs+=10;
 for(const [id,at] of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}
 for(const id of paint.splice(0)){
  paintAcknowledged=true;
  events.push({t:'service.result',id,ok:true,value:{committed:true}});
 }
 for(let i=pending.length-1;i>=0;i--)if(pending[i]!.at<=clockMs)pending.splice(i,1)[0]!.run();
 (globalThis as unknown as {frame:(delta:number)=>void}).frame(0);
 for(let step=0;step<40;step++)await Promise.resolve();
}
test(`native splash and production content startup: ${scenario}`,async()=>{
 if(scenario==='home')kv.set('watchrss.home.channels.v1',JSON.stringify([channel]));
 const storage={
  get:()=>scenario==='intro'?undefined:{oobeSeenVersion:3,privacyPolicyAgreedVersion:scenario==='privacy'?1:2},
  set:()=>{throw Error('fixture must not record consent');},
 };
 const stop=render(()=>{setStyleResolver(()=>0);return StartupGate({storage,content:()=>WatchRSS({services})});},{ops:ops as never});
 try{
  for(let i=0;i<155;i++)await tick();
  console.log(JSON.stringify({scenario,release:released.at(0)}));
  expect(released.length).toBeGreaterThan(0);
  // Intro state changes may repeat an idempotent release for the same owner.
  if(scenario!=='intro'&&scenario!=='privacy')expect(released).toHaveLength(1);
  const release=released[0]!;
  switch(scenario){
   case 'feed':expect(release.ms).toBeGreaterThanOrEqual(220);expect(release.articleDataReady).toBe(true);expect(release.paintAcknowledged).toBe(true);expect(release.pages).toEqual(['home','articles']);break;
   case 'settings':expect(release.ms).toBeLessThan(100);expect(release.paintAcknowledged).toBe(true);expect(release.pages).toEqual(['home','settings']);break;
   case 'missing':expect(release.ms).toBeGreaterThanOrEqual(80);expect(release.pages).toEqual(['home']);break;
   case 'home':expect(release.ms).toBeLessThan(80);break;
   case 'timeout':expect(release.ms).toBeGreaterThanOrEqual(1500);break;
   case 'intro':
   case 'privacy':
    expect(release.ms).toBeLessThan(100);
    expect(channelLoads).toBe(0);
    break;
   default:throw Error('missing fixture scenario');
  }
 }finally{stop();}
});
