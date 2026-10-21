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
const requests:{method:string;args:Record<string,unknown>}[]=[];let inputFinish:(code:string|null)=>void=()=>{},cancels=0;
mock.module('@podjs/framework/services',()=>({hostOperation:(method:string,args:Record<string,unknown>)=>{requests.push({method,args});return {result:new Promise<string|null>(resolve=>{inputFinish=resolve;}),cancel:()=>{cancels++;inputFinish(null);}};}}));
const {CloudSyncScreen}=await import('../src/ui/CloudSyncScreen');
const stops:(()=>void)[]=[];afterEach(()=>{for(const stop of stops.splice(0))stop();requests.length=0;cancels=0;});
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return [];return [value,...nodes(value.props.children)];}
function mount(){
 let state:WatchApprovalState={phase:'idle',message:''},creates=0;const codes:string[]=[],listeners=new Set<()=>void>();
 const [active,setActive]=createSignal(true);
 const update=(next:WatchApprovalState)=>{state=next;for(const fn of listeners)fn();};
 const root=createRoot(stop=>{stops.push(stop);return CloudSyncScreen({width:233,height:233,active,load:async()=>({phoneLabel:'user',plan:'member',active:true,diagnosticsEnabled:false,accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{phase:'waiting-approval',message:'waiting',usedBytes:0,quotaBytes:1e9}}),available:()=>true,sync:{pending:false,start:async()=>{}},onPhone:()=>{},onError:()=>{},ref:()=>{},approval:{get state(){return state;},subscribe:fn=>{listeners.add(fn);return ()=>{listeners.delete(fn);};},request:async()=>{creates++;update({phase:'requesting',message:'正在请求旧设备批准…'});return true;},confirmMatches:async()=>true,cancel:async()=>true,setForeground:()=>{}}});});
 return {root,update,setActive,codes,get creates(){return creates;}};
}
test('v2 approval tap starts only on explicit action and never opens a legacy code input',async()=>{
 const f=mount();await settle();expect(requests).toHaveLength(0);nodes(f.root).find(n=>n.props.accessibilityLabel==='请求设备批准')!.props.onPress();expect(f.creates).toBe(1);f.update({phase:'code',message:'请核对两端的 8 位授权码',code:'84279621',confirmed:false});await settle();expect(nodes(f.root).some(n=>n.props.accessibilityLabel==='输入配对码')).toBe(false);expect(requests).toHaveLength(0);f.setActive(false);await settle();expect(f.codes).toHaveLength(0);
});
