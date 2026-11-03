import {plugin} from 'bun';
import {bindPocketModules,bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import {mock} from 'bun:test';
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
(globalThis as any).pod={capabilities:()=>JSON.stringify(['data.kv','runtime.timer','text.layout']),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t!=='service.request')return;let value:any=null;const {method,id,args}=r;
 if(method==='runtime.delay'){if(args.milliseconds===2500)exitTimerStarted=true;timers.set(id,clockMs+args.milliseconds);return;}
 if(method==='application.activityState.write'||method==='app.activityState.write'){}
 else if(method==='media.video.stop'){}
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method==='text.layout')value={lines:[{start:0,end:args.text.length,visibleEnd:args.text.length}]};
 else if(method.includes('secure')||method.includes('file')){events.push({t:'service.result',id,ok:false,error:{code:'fixture',message:'unavailable'}});return;}
 events.push({t:'service.result',id,ok:true,value});
 }};
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
await bindPocketModules(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir),[
 'solid-js','@pocketjs/framework/renderer','@pocketjs/framework/components','@pocketjs/framework/host',
 '@pocketjs/framework/lifecycle','@pocketjs/framework/gesture','@pocketjs/framework/kinetics','@pocketjs/framework/input'
]);
const {render}=await import('@pocketjs/framework');
const {setStyleResolver,rootMirror}=await import('@pocketjs/framework/renderer');
const {activityStateHub}=await import('../src/navigation/activity-host.ts');
const {captureActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const article={id:'fixture',channelId:'feed',channelTitle:'Test feed',title:'Article',content:Array.from({length:30},()=>'<p>Reader regression body line.</p>').join(''),read:true};
let pendingSave:(()=>void)|undefined;const services:any=new Proxy({listChannels:async()=>[{id:'feed',title:'Test feed',url:'https://example.com/rss'}],listArticles:async()=>[article],getArticle:async()=>article,getChannelOriginalMode:async()=>false,getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readingProgress:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{saveCalls++;await new Promise<void>(r=>{pendingSave=r;});}},readAccountStatus:async()=>null,createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}})}, {get:(t,k)=>Reflect.get(t,k)??(k==='inputRecovery'||k==='retryOfflineMedia'||k==='readSummaryUsage'||k==='subscribeSummaryUsage'||k==='loadImportedTextChunk'?undefined:()=>Promise.resolve(null))});
activityStateHub.seed(captureActivityNavigation({saved:{},retained:{}},[{page:'home'},{page:'articles',channelId:'feed'},{page:'reader',readerArticle:article}]));
const WatchRSS=(await import('../src/ui/screen.tsx')).default;
const stop=render(()=>{setStyleResolver(()=>0);return WatchRSS({services});},{ops});
const frame=(globalThis as any).frame;const watch=await import('@podjs/framework/watch');
async function tick(dt=17){clockMs+=dt;for(const [id,at]of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}frame(0,undefined);for(let n=0;n<25;n++)await Promise.resolve();}

const connected=()=>{const nodes:any[]=[];const walk=(n:any)=>{nodes.push(n);n.children.forEach(walk);};walk(rootMirror);return nodes;};
const state=()=>{const data:any=activityStateHub.read().saved['watchrss.content-activity'];return data?.entries?.map((e:any)=>e.page) as string[];};
const visible=()=>connected().filter(n=>props.get(n.id)?.has(128)).map(n=>({offset:props.get(n.id)!.get(128)!,opacity:props.get(n.id)!.get(69)??1}));
const {expect,test}=await import('bun:test');
const removeEventProbe=watch.__onHostEvent(event=>{if(event.t==='back')backEventsDelivered++;});
const mode=process.env.RAPID_BACK_CASE??'4';
test(`production WatchRSS routes and BackMotion survive ${mode}`,async()=>{
 for(let i=0;i<50;i++)await tick();
 expect(state()).toEqual(['home','articles','reader']);
 // Move the real reader so final progress is dirty before the BACK burst.
 events.push({t:'axis',axis:0,delta:12000});
 for(let i=0;i<12;i++)await tick();
 const count=mode==='8'?8:4;
 events.push(...Array.from({length:count},()=>({t:'back'})));
 await tick();
 for(let i=0;i<8;i++)await tick(); // more hardware BACK during settling
 events.push(...Array.from({length:count},()=>({t:'back'})));
 if(mode==='lifecycle'){
  events.push({t:'lifecycle',state:'inactive'});await tick();
  events.push({t:'lifecycle',state:'background'});await tick();
  events.push({t:'lifecycle',state:'active'});await tick();
  events.push({t:'back'});
 }
 for(let i=0;i<30;i++)await tick();
 if(mode==='delayed'){
  expect(state().at(-1)).toBe('reader');
  events.push(...Array.from({length:8},()=>({t:'back'})));
  for(let i=0;i<20;i++)await tick();
 }
 expect(state().at(-1)).toBe('reader');
 expect(backEventsDelivered).toBeGreaterThanOrEqual(count*2);
 expect(exitTimerStarted).toBe(true);
 expect(saveCalls).toBe(1);
 expect(pendingSave).toBeDefined();
 if(mode!=='timeout')pendingSave!();
 for(let i=0;i<180;i++)await tick();
 expect(state()).toEqual(['home','articles']);
 expect(visible().some(v=>v.opacity===1&&v.offset===0)).toBe(true);
 // List -> home, with another burst arriving while its animation settles.
 events.push(...Array.from({length:8},()=>({t:'back'})));await tick();
 for(let i=0;i<8;i++)await tick();
 events.push(...Array.from({length:8},()=>({t:'back'})));
 for(let i=0;i<30;i++)await tick();
 expect(state()).toEqual(['home']);
 // At root the Android host handles BACK. Even already-queued guest events
 // cannot move or remove the last route.
 events.push(...Array.from({length:8},()=>({t:'back'})));
 for(let i=0;i<30;i++)await tick();
 expect(state()).toEqual(['home']);
 expect(visible()).toEqual([{offset:0,opacity:1}]);
 removeEventProbe();stop();expect(watch.watchResourceCounts().back).toBe(0);
});
