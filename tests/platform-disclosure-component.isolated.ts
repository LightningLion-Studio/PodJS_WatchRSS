import {plugin} from 'bun';
import {bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import {afterEach, expect, mock, test} from 'bun:test';
import {createComponent, createMemo, onCleanup} from 'solid-js';
import * as solidRuntime from 'solid-js';
for(const base of [Bun.resolveSync('@podjs/framework/watch',import.meta.dir),Bun.resolveSync('@pocketjs/framework',import.meta.dir)])mock.module(Bun.resolveSync('solid-js',base),()=>solidRuntime);
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'platform-disclosure-solid',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
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
(globalThis as any).pod={capabilities:()=>JSON.stringify(['data.kv','data.secure','runtime.timer','text.layout']),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t!=='service.request')return;let value:any=null;const {method,id,args}=r;
 if(method==='runtime.delay'){timers.set(id,clockMs+args.milliseconds);return;}
 if(method==='application.activityState.write'||method==='app.activityState.write'){}
 else if(method==='media.video.stop'){}
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method==='text.layout')value={lines:[{start:0,end:args.text.length,visibleEnd:args.text.length}]};
 else if(method==='secure.get')value={exists:false};
 else if(method.includes('secure')||method.includes('file')){events.push({t:'service.result',id,ok:false,error:{code:'fixture',message:'unavailable'}});return;}
 events.push({t:'service.result',id,ok:true,value});
 }};
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
const {render}=await import('@pocketjs/framework');
const {setStyleResolver,rootMirror}=await import('@pocketjs/framework/renderer');
const {activityStateHub}=await import('../src/navigation/activity-host.ts');
const {captureActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
// Real WatchRSS, HomeRoutes, HomeScreen, MediaRoutes and PendingDisclosure;
// the list renderer and media content are boundaries, not disclosure models.
const {View}=await import('@pocketjs/framework/components');
const lists:{input:any;scrolls:number[];disposed:boolean}[]=[];
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(input:any)=>{
 const list={input,scrolls:[] as number[],disposed:false};lists.push(list);
 const scroller={offset:()=>0,stop(){},scrollBy:(delta:number)=>list.scrolls.push(delta)};
 input.ref?.({scroller});onCleanup(()=>{list.disposed=true;});
 const children=createMemo(()=>input.entries.map((entry:any)=>entry.render()));
 return createComponent(View,{get children(){return children();}});
}}));
const media:{platform:string;input:any;disposed:boolean}[]=[];
function mediaScreen(platform:string,input:any){
 const mount={platform,input,disposed:false};media.push(mount);
 input.ref?.({scroller:{offset:()=>0,stop(){},scrollBy(){}},onRootBack:()=>false});
 onCleanup(()=>{mount.disposed=true;});
 return createComponent(View,{});
}
mock.module('../src/ui/bili/index.tsx',()=>({BiliScreen:(input:any)=>mediaScreen('bili',input)}));
mock.module('../src/ui/douyin/index.tsx',()=>({DouyinScreen:(input:any)=>mediaScreen('douyin',input)}));
const {INITIAL_DISCLOSURE_KEY,initialDisclosure,platformDisclosure}=await import('../src/announcement/platform.ts');
const WatchRSS=(await import('../src/ui/screen.tsx')).default;
const watch=await import('@podjs/framework/watch');
const {getFocused,pressNode}=await import('@pocketjs/framework/input');
const channel=(platform:string)=>({id:platform,title:platform,url:'builtin:'+platform});
const services:any=new Proxy({
 listChannels:async()=>[channel('bili'),channel('douyin')],listArticles:async()=>[],
 subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readAccountStatus:async()=>null,
 createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}}),
},{get:(target,key)=>Reflect.get(target,key)??(['inputRecovery','retryOfflineMedia','readSummaryUsage','subscribeSummaryUsage','loadImportedTextChunk'].includes(String(key))?undefined:()=>Promise.resolve(null))});
const connected=()=>{const result:any[]=[];const walk=(node:any)=>{result.push(node);node.children.forEach(walk);};walk(rootMirror);return result;};
const text=()=>connected().map(node=>texts.get(node.id)??'').join('\n').replaceAll('\n','');
const button=(label:string)=>connected().find(node=>(node.domAttrs?.accessibilityLabel===label||(label.endsWith('，')&&node.domAttrs?.accessibilityLabel?.startsWith(label)))&&node.onPress);
const confirm=(label:string)=>{const node=button(label);expect(node,`visible ${label}`).toBeDefined();pressNode(node);};
const homeList=()=>lists.find(list=>!list.disposed&&typeof list.input.onLongPress==='function')!;
const dialogList=()=>lists.find(list=>!list.disposed&&list.input.accessibilityLabel==='使用前说明');
const currentMedia=()=>[...media].reverse().find(mount=>!mount.disposed&&mount.input.active)!;
const state=()=>{const content:any=activityStateHub.read().saved['watchrss.content-activity'];return content?.entries?.map((entry:any)=>entry.page) as string[];};
let stop:(()=>void)|undefined;
async function tick(dt=17){clockMs+=dt;for(const [id,at]of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}(globalThis as any).frame(0,undefined);for(let n=0;n<25;n++)await Promise.resolve();}
async function settle(){for(let n=0;n<5;n++)await tick();}
async function mount(announcementServices?:any,entries:any[]=[{page:'home'}]){
 activityStateHub.seed(captureActivityNavigation({saved:{},retained:{}},entries));
 stop=render(()=>{setStyleResolver(()=>0);return WatchRSS({services,announcements:announcementServices});},{ops});await settle();
}
afterEach(()=>{stop?.();stop=undefined;kv.clear();lists.length=0;media.length=0;events.length=0;timers.clear();texts.clear();props.clear();});

for(const kind of ['announcement','push'] as const)test(`Home gives ${kind} priority over first-use disclosure`,async()=>{
 // Source policy disables version announcements; inject only the remote result
 // boundary to exercise an existing announcement without changing that policy.
 const announcement=kind==='announcement'?{version:'99',changelogMarkdown:'fixture announcement',forceUpdate:false,downloadUrl:'https://fixture.test/update'}:null;
 const messages=kind==='push'?[{id:1,title:'fixture push',body:'fixture body'}]:[];
 mock.module('../src/announcement/home.ts',()=>({loadHomeNotices:async()=>({announcement,messages})}));
 const dismissed:any[]=[];
 await mount({repository:{markDismissed:(value:any)=>dismissed.push(value)},updater:{state:{kind:'idle'},subscribe:()=>()=>{},launchInstaller:async()=>{}}});
 expect(button('我已了解')).toBeUndefined();expect(dialogList()).toBeUndefined();
 expect(homeList().input.inputActive()).toBe(false);
 confirm(kind==='announcement'?'稍后':'知道了');
 expect(button('我已了解')).toBeDefined();expect(homeList().input.inputActive()).toBe(false);
 if(kind==='announcement')expect(dismissed).toEqual([announcement]);
});

test('Home disables input, swallows Back and persists only explicit confirmation',async()=>{
 await mount();expect(button('我已了解')).toBeDefined();
 expect(homeList().input.inputActive()).toBe(false);
 expect(getFocused()?.domAttrs?.accessibilityLabel).toBe('我已了解');
 events.push({t:'back'});await tick();expect(button('我已了解')).toBeDefined();
 expect(kv.has(INITIAL_DISCLOSURE_KEY)).toBe(false);
 confirm('我已了解');expect(JSON.parse(kv.get(INITIAL_DISCLOSURE_KEY)!)).toBe(true);
 expect(dialogList()).toBeUndefined();expect(homeList().input.inputActive()).toBe(true);
 stop!();stop=undefined;lists.length=0;
 await mount();expect(button('我已了解')).toBeUndefined();expect(homeList().input.inputActive()).toBe(true);
});

test('Home crown scroll reaches disclosure instead of the inactive Home list',async()=>{
 await mount();const home=homeList(),dialog=dialogList()!;
 events.push({t:'axis',axis:0,delta:1200});await tick();
 expect(dialog.scrolls.length).toBe(1);expect(home.scrolls).toEqual([]);
});

for(const platform of ['bili','douyin'] as const)test(`${platform}: initial then platform, fresh instance confirms again, child return stays confirmed`,async()=>{
 await mount(undefined,[{page:'home'},{page:platform,[platform+'Route']:{name:'entry'}}]);
 expect(button('我已了解')).toBeDefined();expect(button('知道了，继续')).toBeUndefined();
 for(const paragraph of initialDisclosure.paragraphs)expect(text()).toContain(paragraph);
 const visible=()=>connected().filter(node=>props.get(node.id)?.has(128)).map(node=>props.get(node.id)!.get(128));
 events.push({t:'back'});for(let n=0;n<5;n++){await tick();expect(visible().every(offset=>offset===0)).toBe(true);}
 await settle();expect(state()).toEqual(['home',platform]);expect(button('我已了解')).toBeDefined();
 const home=homeList();expect(home.input.inputActive()).toBe(false);
 const dialog=dialogList()!;events.push({t:'axis',axis:0,delta:1200});await tick();expect(dialog.scrolls.length).toBe(1);
 confirm('我已了解');expect(button('知道了，继续')).toBeDefined();
 for(const paragraph of platformDisclosure(platform==='bili'?'哔哩哔哩':'抖音').paragraphs)expect(text()).toContain(paragraph);
 expect([...media].reverse().find(value=>!value.disposed)!.input.active).toBe(false);
 confirm('知道了，继续');expect(button('知道了，继续')).toBeUndefined();expect(currentMedia()).toBeDefined();
 currentMedia().input.onNavigate({name:'channel-info'});await settle();expect(state()).toEqual(['home',platform,platform]);
 expect(button('知道了，继续')).toBeUndefined();
 events.push({t:'back'});for(let n=0;n<30;n++)await tick();
 expect(state()).toEqual(['home',platform]);expect(button('知道了，继续')).toBeUndefined();
 events.push({t:'back'});for(let n=0;n<30;n++)await tick();expect(state()).toEqual(['home']);
 confirm(platform+'，');await settle();
 expect(button('我已了解')).toBeUndefined();expect(button('知道了，继续')).toBeDefined();
});
