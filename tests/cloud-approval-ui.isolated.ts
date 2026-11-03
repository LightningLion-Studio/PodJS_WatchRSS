import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import type {CloudApprovalState as WatchApprovalState} from '../src/cloud/approval-controller';
import type {ScrollEntry} from '../src/ui/ScrollEntries';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'cloud-approval-ui',setup(builder){builder.onLoad({filter:/\/CloudSyncScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const output=Object.create(props);Object.defineProperty(output,'children',{value:props.children,enumerable:true});return {kind,props:output};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(props:Node['props'])=>element('View',props),Text:(props:Node['props'])=>element('Text',props)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>Array.from(s).length*10})}));
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(props:Node['props'])=>{const children=createMemo(()=>props.entries.map((entry:ScrollEntry)=>entry.render()));return element('ScrollEntries',{...props,children});}}));
const timers:{milliseconds:number;cancelled:boolean;resolve():void;reject(error:Error):void;throwOnCancel?:boolean}[]=[];
const nativeSetTimeout=globalThis.setTimeout;
const requests:{method:string;args:Record<string,unknown>}[]=[];let inputFinish:(code:string|null)=>void=()=>{},cancels=0;
mock.module('@podjs/framework/services',()=>({delay:(milliseconds:number)=>{requests.push({method:'runtime.delay',args:{milliseconds}});let resolve!:()=>void,reject!:(e:Error)=>void;const result=new Promise<void>((yes,no)=>{resolve=yes;reject=no;}),timer={milliseconds,cancelled:false,resolve,reject,throwOnCancel:false};timers.push(timer);return {result,cancel:()=>{timer.cancelled=true;if(timer.throwOnCancel)throw Error('host closed');reject(Error('cancelled'));}};},hostOperation:(method:string,args:Record<string,unknown>)=>{requests.push({method,args});return {result:new Promise<string|null>(resolve=>{inputFinish=resolve;}),cancel:()=>{cancels++;inputFinish(null);}};}}));
const {CloudSyncScreen}=await import('../src/ui/CloudSyncScreen');
const stops:(()=>void)[]=[];afterEach(()=>{for(const stop of stops.splice(0))stop();requests.length=0;timers.length=0;cancels=0;});
const settle=()=>new Promise<void>(resolve=>nativeSetTimeout(resolve,0));
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return [];return [value,...nodes(value.props.children)];}
function mount(withActions=false,ownerChoice=false){
 let logoutCalls=0;const actionCalls:string[]=[];let dispose=()=>{};
 let state:WatchApprovalState={phase:'idle',message:''},creates=0;const codes:string[]=[],listeners=new Set<()=>void>();
 const [active,setActive]=createSignal(true);
 const update=(next:WatchApprovalState)=>{state=next;for(const fn of listeners)fn();};
 const root=createRoot(stop=>{stops.push(stop);dispose=stop;return CloudSyncScreen({width:233,height:233,active,clearLocal:async()=>{},actions:withActions?{busy:false,message:'',subscribe:()=>()=>{},logout:async()=>{logoutCalls++;return true;},resolveOwner:async choice=>{actionCalls.push(choice);return true;},reregister:async()=>true}:undefined,load:async()=>({phoneLabel:'user',plan:'member',active:true,diagnosticsEnabled:false,accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{phase:'waiting-approval',message:ownerChoice?'本机资料属于其他账号':'waiting',usedBytes:0,quotaBytes:1e9}}),available:()=>true,sync:{pending:false,start:async()=>{}},onPhone:()=>{},onError:()=>{},ref:()=>{},approval:{get state(){return state;},subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};},request:async()=>{creates++;update({phase:'requesting',message:'正在请求旧设备批准…'});return true;},confirmMatches:async()=>true,cancel:async()=>true,setForeground:()=>{}}});});
 return {root,update,setActive,codes,dispose,actionCalls,get logoutCalls(){return logoutCalls;},get creates(){return creates;}};
}
test('v2 approval tap starts only on explicit action and never opens a legacy code input',async()=>{
 const f=mount();await settle();expect(requests).toHaveLength(0);nodes(f.root).find(n=>n.props.accessibilityLabel==='请求设备批准')!.props.onPress();expect(f.creates).toBe(1);f.update({phase:'code',message:'请核对两端的 8 位授权码',code:'84279621',confirmed:false});await settle();expect(nodes(f.root).some(n=>n.props.accessibilityLabel==='输入配对码')).toBe(false);expect(requests).toHaveLength(0);f.setActive(false);await settle();expect(f.codes).toHaveLength(0);
});

async function withoutBrowserTimers(action:()=>Promise<void>){
 const globals=globalThis as unknown as Record<string,unknown>,set=globals.setTimeout,clear=globals.clearTimeout;delete globals.setTimeout;delete globals.clearTimeout;
 try{await action();}finally{globals.setTimeout=set;globals.clearTimeout=clear;}
}
const press=(f:ReturnType<typeof mount>,label:string)=>nodes(f.root).find(n=>n.props.accessibilityLabel===label)!.props.onPress();
const labels=(f:ReturnType<typeof mount>)=>nodes(f.root).map(n=>n.props.accessibilityLabel);
test('release QuickJS cloud page can leave and reopen with both browser timer globals absent',async()=>withoutBrowserTimers(async()=>{
 for(let i=0;i<3;i++){const f=mount();await settle();expect(labels(f)).toContain('请求设备批准');expect(()=>f.dispose()).not.toThrow();}expect(timers).toHaveLength(0);
}));
test('host wall-clock confirmation expires after 4000ms and requires two deliberate presses, with no browser timers',async()=>withoutBrowserTimers(async()=>{
 const f=mount(true);await settle();press(f,'退出账号');expect(f.logoutCalls).toBe(0);expect(timers[0].milliseconds).toBe(4000);expect(labels(f)).toContain('再按一次确认退出');timers[0].resolve();await settle();expect(labels(f)).toContain('退出账号');press(f,'退出账号');expect(f.logoutCalls).toBe(0);press(f,'再按一次确认退出');expect(f.logoutCalls).toBe(1);expect(timers[1].cancelled).toBe(true);f.dispose();
}));
test('superseded host timer cannot disarm a different action; host failure disarms without executing it',async()=>withoutBrowserTimers(async()=>{
 const f=mount(true,true);await settle();press(f,'清空本机资料');press(f,'合并到当前账号');expect(timers[0].cancelled).toBe(true);timers[0].resolve();await settle();expect(labels(f)).toContain('再按一次确认合并');expect(f.actionCalls).toEqual([]);timers[1].reject(Error('timer unavailable'));await settle();expect(labels(f)).toContain('合并到当前账号');expect(f.actionCalls).toEqual([]);f.dispose();
}));
test('disposing an armed cloud page cancels its host timer; even closing host and late completion cannot break cleanup',async()=>withoutBrowserTimers(async()=>{
 const f=mount(true);await settle();press(f,'退出账号');timers[0].throwOnCancel=true;expect(()=>f.dispose()).not.toThrow();expect(timers[0].cancelled).toBe(true);timers[0].resolve();await settle();expect(f.logoutCalls).toBe(0);const next=mount(true);await settle();expect(labels(next)).toContain('退出账号');next.dispose();
}));

test('approver: a pending request is accepted only by tap; digits show with match/mismatch; key goes out only on 一致',async()=>{
 type S=import('../src/cloud/approver-controller').CloudApproverState;
 let state:S={phase:'idle',requests:[],message:''};const listeners=new Set<()=>void>(),calls:string[]=[];
 const update=(next:S)=>{state=next;for(const fn of listeners)fn();};
 const root=createRoot(stop=>{stops.push(stop);return CloudSyncScreen({width:233,height:233,active:()=>true,load:async()=>({phoneLabel:'user',plan:'member',active:true,diagnosticsEnabled:false,accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{phase:'idle',message:'',usedBytes:0,quotaBytes:1e9}}),available:()=>true,sync:{pending:false,start:async()=>{}},onPhone:()=>{},onError:()=>{},ref:()=>{},
  approver:{get state(){return state;},subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},accept:async (id:string)=>{calls.push('accept:'+id);return true;},confirm:async (match:boolean)=>{calls.push('confirm:'+match);return true;},cancel:async()=>{calls.push('cancel');return true;}}} as any);});
 const all=()=>nodes(root).map(n=>n.props.accessibilityLabel).filter(Boolean),tap=(label:string)=>nodes(root).find(n=>n.props.accessibilityLabel===label)!.props.onPress();
 await settle();expect(all()).not.toContain('核对授权码');
 update({phase:'requested',message:'有新设备请求授权',requests:[{requestId:'r1',requesterLabel:'小程序 · 本机',expiresAt:Date.now()+60000}]});await settle();
 expect(calls).toEqual([]);tap('核对授权码');expect(calls).toEqual(['accept:r1']);
 update({...state,phase:'waiting',requestId:'r1',requesterLabel:'小程序 · 本机'});await settle();expect(all()).not.toContain('一致');tap('取消');expect(calls.at(-1)).toBe('cancel');
 update({...state,phase:'code',code:'84279621'});await settle();expect(all()).toContain('核对码 84279621');
 tap('不一致');expect(calls.at(-1)).toBe('confirm:false');tap('一致');expect(calls.at(-1)).toBe('confirm:true');
 update({...state,phase:'unsupported',code:undefined,message:'服务端暂不支持手表批准授权'});await settle();expect(all()).not.toContain('核对授权码');expect(all()).not.toContain('一致');
});
