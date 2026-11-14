import {plugin} from 'bun';
// Mount the production WatchRSS navigation/BackMotion and real touch pump.
// Replace only media rendering/decoding with a local player port. The actual
// VideoPlayerScreen and detail panel have separate mounted component checks.
import {bindPocketModules,bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import {mock} from 'bun:test';
import * as solidRuntime from 'solid-js';
for(const base of [Bun.resolveSync('@podjs/framework/watch',import.meta.dir),Bun.resolveSync('@pocketjs/framework',import.meta.dir)])mock.module(Bun.resolveSync('solid-js',base),()=>solidRuntime);
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'rapid-back-solid',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
let clockMs=0,next=1;Date.now=()=>clockMs;
const kv=new Map<string,string>(),events:any[]=[],timers=new Map<number,number>();
const props=new Map<number,Map<number,number>>(),texts=new Map<number,string>();
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000}};
for(const name of ['destroyNode','insertBefore','removeChild','setStyle','setImage','setSprite','setFocus','animate','setAccessibility','setNavigationState'])ops[name]=()=>{};
ops.createNode=()=>next++;
ops.setProp=(id:number,key:number,value:number)=>{let p=props.get(id);if(!p)props.set(id,p=new Map());p.set(key,value);};
ops.setText=ops.replaceText=(id:number,text:string)=>texts.set(id,text);
ops.loadPakImage=()=>next++;ops.uploadTexture=()=>next++;ops.freeTexture=()=>{};ops.measureText=(s:string)=>s.length*8;
ops.wrapText=()=>[];ops.getLayout=()=>({x:0,y:0,w:233,h:193});ops.getProp=(id:number,key:number)=>props.get(id)?.get(key)??0;
(globalThis as any).pod={capabilities:()=>JSON.stringify(['data.kv','runtime.timer','text.layout']),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t!=='service.request')return;let value:any=null;const {method,id,args}=r;
 if(method==='runtime.delay'){timers.set(id,clockMs+args.milliseconds);return;}
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
const {createGesture}=await import('@pocketjs/framework/gesture');
const {playerGesture}=await import('../src/ui/player-gestures.ts');
const {createDetailSlide}=await import('../src/ui/PlayerDetailPanel.tsx');
const navigation=await import('../src/navigation/activity-navigation.ts');
// Seed an already-live video route; this test is not a process-death restore.
mock.module('../src/navigation/startup-navigation.ts',()=>({startupActivityNavigation:navigation.restoreActivityNavigation}));
const platform=process.env.ROTGEST_PLATFORM as 'rss'|'bili'|'douyin',initialAngle=Number(process.env.ROTGEST_ANGLE);
let angle=initialAngle,panel:any;const selected:string[]=[],panelPages:number[]=[];
mock.module('../src/ui/routes/media.tsx',()=>({MediaRoutes(p:any){
 if(p.page()!=='video')return null;
 panel=createDetailSlide(()=>233);p.entry.playback={platform,immersive:platform==='douyin',title:'synthetic local player'};
 p.entry.player={onCrown(){return true;},gestureRotation:()=>angle,canSwipeBack:()=>!panel.shown(),sideSwipe:{begin(){if(panel.shown())return false;panel.begin();return true;},move:panel.move,end:panel.end,cancel:panel.cancel}};
 const viewport=()=>({x:0,y:0,w:233,h:233});
 createGesture(playerGesture({region:{rect:()=>p.active()&&!panel.shown()?viewport():null},axis:'y',panSlop:8,onPanStart(){},onPanEnd:c=>selected.push(c.dy<0?'next':'previous')},()=>angle,viewport));
 // The detail view lives outside the rotated player. Its two screen axes
 // compete with the production shell while canSwipeBack() is false.
 createGesture({region:{rect:()=>panel.shown()?viewport():null},axis:'y',panSlop:8,onPanStart(){},onPanEnd:c=>panelPages.push(c.dy)});
 let closing=false;
 createGesture({region:{rect:()=>panel.shown()?viewport():null},axis:'x',panSlop:8,onPanStart:c=>{closing=c.dx>0;if(closing){panel.begin();panel.move(c.dx);}},onPanMove:c=>{if(closing)panel.move(c.dx);},onPanEnd:c=>{if(closing)panel.end(c.vx);closing=false;}});
 return null;
}}));
const {render}=await import('@pocketjs/framework');
const {setStyleResolver}=await import('@pocketjs/framework/renderer');
const {activityStateHub}=await import('../src/navigation/activity-host.ts');
const article={id:'fixture',channelId:'feed',title:'local fixture',content:'<p>fixture</p>'};
const services:any=new Proxy({listChannels:async()=>[{id:'feed',title:'Test feed',url:'https://example.invalid/rss'}],listArticles:async()=>[article],getArticle:async()=>article,getChannelOriginalMode:async()=>false,getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readingProgress:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{}},readAccountStatus:async()=>null,createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}})}, {get:(t,k)=>Reflect.get(t,k)??(k==='inputRecovery'||k==='retryOfflineMedia'||k==='readSummaryUsage'||k==='subscribeSummaryUsage'||k==='loadImportedTextChunk'?undefined:()=>Promise.resolve(null))});
activityStateHub.seed(navigation.captureActivityNavigation({saved:{},retained:{}},[{page:'home'},{page:'articles',channelId:'feed'},{page:'video',videoTarget:{kind:'rss',articleId:'fixture',url:'local-fixture.mp4'}}]));
const WatchRSS=(await import('../src/ui/screen.tsx')).default;
const stop=render(()=>{setStyleResolver(()=>0);return WatchRSS({services});},{ops});
const frame=(globalThis as any).frame;
const {__packTouch}=await import('../node_modules/@pocketjs/framework/framework/src/touch.ts');
async function tick(points:number[][]=[]){clockMs+=17;for(const [id,at]of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}frame(0,undefined,points.map(([x,y])=>__packTouch(1,x,y)));for(let n=0;n<25;n++)await Promise.resolve();}
const state=()=>((activityStateHub.read().saved['watchrss.content-activity'] as any)?.entries??[]).map((e:any)=>e.page);
async function settle(){for(let i=0;i<35;i++)await tick();}
async function swipe(dx:number,dy:number,degrees:number,resetAfterDown=false){
 const r=degrees*Math.PI/180,x=dx*Math.cos(r)-dy*Math.sin(r),y=dx*Math.sin(r)+dy*Math.cos(r);
 await tick([[116-x/2,116-y/2]]);if(resetAfterDown)angle=0;await tick([[116,116]]);await tick([[116+x/2,116+y/2]]);await tick();await settle();
}
const {expect,test}=await import('bun:test');
test(`production shell ${platform} ${initialAngle}: next, detail, screen panel and locked Back`,async()=>{
 try{
  await settle();expect(state()).toEqual(['home','articles','video']);expect(panel).toBeDefined();
  await swipe(-110,0,angle);expect(panel.shown()).toBe(true);expect(state()).toEqual(['home','articles','video']);
  await swipe(0,-100,0);expect(panelPages).toHaveLength(1);expect(selected).toEqual([]);expect(state()).toEqual(['home','articles','video']);
  await swipe(140,0,0);expect(panel.shown()).toBe(false);expect(state()).toEqual(['home','articles','video']);
  await swipe(60,-80,angle);expect(state()).toEqual(['home','articles','video']);expect(selected).toEqual(['next']);
  await swipe(0,-110,angle);expect(selected).toEqual(['next','next']);expect(state()).toEqual(['home','articles','video']);
  await swipe(70,0,angle,true);expect(state()).toEqual(platform==='douyin'?['home']:['home','articles']);
 }finally{stop();}
});
