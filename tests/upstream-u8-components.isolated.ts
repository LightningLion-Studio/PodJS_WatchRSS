import {expect,mock,test} from 'bun:test';
import * as solid from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
import {oracle} from './upstream-u8-loader.ts';
import {routeMemory} from '../src/navigation/activity-navigation.ts';
const fw=Bun.resolveSync('@podjs/framework/variable-list',import.meta.dir);
mock.module(Bun.resolveSync('solid-js',fw),()=>solid);
const core=Bun.resolveSync('@pocketjs/framework/kinetics',fw).replace('kinetics.ts','kinetics-core.ts');
const {createScrollerWith}=await import(core);
let trace:any[]=[],gestures:any[]=[],frames=new Set<()=>void>(),dpad:any[]=[];
const element=(kind:string)=>(props:any)=>{const p=Object.create(props);Object.defineProperty(p,'children',{value:props.children,enumerable:true});const node={kind,props:p};props.ref?.(node);return node;};
let displayReads=0,capReads=0,fontReads=0,missing=true;
const metrics={cellWidth:16,cellHeight:18,baseline:14,lineHeight:18,rasterDensity:2};
const mocks={renderer:{createComponent,mergeProps,memo:createMemo,effect:createRenderEffect},components:{View:element('View'),Text:element('Text'),Image:element('Image')},host:{getOps:()=>({measureText:()=>40})},gesture:{createGesture:(g:any)=>{gestures.push(g);onCleanup(()=>gestures=gestures.filter(v=>v!==g));}},lifecycle:{onFrame:(f:any)=>{frames.add(f);onCleanup(()=>frames.delete(f));}},kinetics:{createScroller:(opts:any)=>createScrollerWith(createSignal,opts),bindDpadScroll:(_s:any,opts:any)=>{dpad.push(opts);}},input:{hitNode:()=>({id:7}),pressNode:(v:any)=>trace.push(['press',v])}};
for(const [name,impl] of Object.entries(mocks))for(const path of ['@pocketjs/framework/'+name,Bun.resolveSync('@pocketjs/framework/'+name,fw)])mock.module(path,()=>impl);
const watch={getDisplayMetrics:()=>{displayReads++;return {logicalWidth:233,physicalWidth:466};},hasCapability:()=>{capReads++;return true;},getFontMetrics:()=>{fontReads++;return missing?undefined:metrics;}};
for(const path of ['@podjs/framework/watch',Bun.resolveSync('@podjs/framework/watch',fw)])mock.module(path,()=>watch);
for(const path of ['@podjs/framework/text',Bun.resolveSync('@podjs/framework/text',fw)])mock.module(path,()=>({SystemTextLine:element('Raster')}));
const {ReaderTextRow,createReaderTextEnvironment}=await import('../src/ui/ReaderTextRow.tsx'),oldText=await oracle('ui/ReaderTextRow.tsx');
const {ScrollEntries}=await import('../src/ui/ScrollEntries.tsx'),oldList=await oracle('ui/ScrollEntries.tsx');
const activity=await import('../src/ui/route-activity.tsx'),oldActivity=await oracle('ui/route-activity.tsx');
const {defaultReaderPreset}=await import('../src/reader/preset.ts');
function nodes(v:any):any[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v||typeof v!=='object'||!('props'in v))return [];return [v,...nodes(v.props.children)];}
function snapshot(v:any):any{if(typeof v==='function')return '[callback]';if(Array.isArray(v))return v.map(x=>typeof x==='function'?snapshot(x()):snapshot(x));if(!v||typeof v!=='object')return v;if('props'in v){const result:any={kind:v.kind};for(const k in v.props)if(k!=='ref')result[k]=snapshot(k==='children'&&typeof v.props[k]==='function'?v.props[k]():v.props[k]);return result;}return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,snapshot(x)]));}
test('U8 reader environment cache hits/missing retry and complete row geometry match oracle',()=>{
 function run(C:any,make:any){displayReads=capReads=fontReads=0;missing=true;let dispose!:()=>void;const [row,setRow]=createSignal<any>({kind:'text',text:'普通文本😀',fontSlot:35,scale:1,lineHeight:18,height:18,gap:0,top:0,blockIndex:0,color:'#221f1bff'});
  const tree=createRoot(d=>{dispose=d;const env=make();expect(env.fontMetrics(35)).toBeUndefined();missing=false;env.fontMetrics(35);env.fontMetrics(35);const preset=defaultReaderPreset('paper','纸张',false,16);return C({get row(){return row();},style:'body',fontSize:16,width:205,preset,environment:env,onCarets:(v:any)=>trace.push(['carets',v])});});
  const before=snapshot(tree);setRow({...row(),text:'新行汉字',textAlign:1,fontSlot:34});const after=snapshot(tree);dispose();return {before,after,displayReads,capReads,fontReads};
 }
 expect(run(ReaderTextRow,createReaderTextEnvironment)).toEqual(run(oldText.ReaderTextRow,oldText.createReaderTextEnvironment));
 // Production path without an environment injection.
 function defaults(C:any){let tree:any;createRoot(d=>{tree=snapshot(C({row:{kind:'text',text:'正文',fontSlot:35,scale:1,lineHeight:18,height:18,color:'#ffffffff'},style:'body',fontSize:16,width:205}));d();});return tree;}
 expect(defaults(ReaderTextRow)).toEqual(defaults(oldText.ReaderTextRow));
});
test('U8 provider validation, saved/retained/function setters and disabled state match oracle',()=>{
 function run(api:any){const entry:any={page:'settings',memory:{id:'fixture',saved:{x:'bad',yes:true},retained:{draft:'retained'}}},changes:any[]=[];let stop!:()=>void,signals:any[]=[];
  createRoot(d=>{stop=d;return createComponent(api.RouteActivityProvider,{entry,changed:()=>changes.push(structuredClone(entry.memory)),checkpoints:new Set(),scrollSlots:new Set(),get children(){const x=api.restoredSignal('saved','x',1,api.finiteState),yes=api.restoredSignal('saved','yes',false,api.booleanState),draft=api.restoredSignal('retained','draft','initial',api.stringState),disabled=api.restoredSignal('saved','ignored','initial',api.stringState,false);signals=[x,yes,draft,disabled];return null;}});});const [x,yes,draft,disabled]=signals;changes.push([x[0](),yes[0](),draft[0](),disabled[0]()]);x[1]((n:number)=>n+2);yes[1](false);draft[1]('edited');disabled[1]('not persisted');stop();return {changes,memory:entry.memory};}
 expect(run(activity)).toEqual(run(oldActivity));
});
test('U8 list gesture/refresh/accessibility/settle/restore/cleanup sequence matches oracle',()=>{
 function run(C:any,api:any,page:string,controllerProvided:boolean,fixed:boolean){trace=[];gestures=[];frames=new Set();dpad=[];let stop!:()=>void,scroller:any;
  const entry:any={page,memory:{id:'fixture',saved:{'scroll:0':300},retained:{}}},checkpoints=new Set<()=>void>(),scrollSlots=new Set<number>(),[entries,setEntries]=createSignal<any[]>([]),[active,setActive]=createSignal(true),[settle,setSettle]=createSignal(1);
  const injected=controllerProvided?createScrollerWith(createSignal,{max:()=>900}):undefined;
  const tree=createRoot(d=>{stop=d;return createComponent(api.RouteActivityProvider,{entry,changed:()=>trace.push(['changed']),checkpoints,scrollSlots,get children(){return createComponent(C,{height:100,get entries(){return entries();},get settleKey(){return settle();},controller:injected,gap:0,padding:18,fixed,inputActive:active,accessibilityLabel:'List',onRefresh:()=>trace.push(['refresh']),onManualScroll:()=>trace.push(['manual']),onTap:()=>false,onLongPress:()=>trace.push(['long']),onScrollStateChange:(v:any)=>trace.push(['scroll-state',v]),onOffsetChange:(...v:any)=>trace.push(['offset',...v]),onSettledRange:(...v:any)=>trace.push(['range',...v]),ref:(v:any)=>scroller=v.scroller});}});});
  const frame=()=>{for(const cb of [...frames])cb();trace.push(['position',scroller.offset(),scroller.state()]);};
  frame();for(const cp of checkpoints)cp();setEntries([{height:180,render:()=>null}]);frame();setEntries([{height:700,render:()=>null}]);frame();
  const before=snapshot(tree),g=gestures[0];scroller.scrollTo(0,{immediate:true});g.onDown();g.onPanStart();g.onPanMove({fdy:50});g.onPanEnd({vy:0});for(let i=0;i<40;i++)frame();
  g.onLongPress({});g.onTap({x:30,y:30});g.onDown();g.onPanStart();g.onPanMove({fdy:-30});frame();g.onCancel();for(let i=0;i<40;i++)frame();
  setSettle(2);frame();const viewport=nodes(tree)[0];viewport.props.onAccessibilityAction({actionName:'increment'});for(let i=0;i<20;i++)frame();
  setActive(false);trace.push(['dpad-active',dpad[0].active()]);g.onDown();g.onPanStart();g.onPanMove({fdy:60});g.onPanEnd({vy:0});g.onTap({});g.onLongPress({});frame();setActive(true);frame();
  for(const cp of checkpoints)cp();const after=snapshot(tree);stop();return {before,after,trace,memory:routeMemory(entry),frames:frames.size,gestures:gestures.length,slots:scrollSlots.size,checkpoints:checkpoints.size};
 }
 for(const page of ['settings','reader','information','bili','douyin'])for(const supplied of [false,true])for(const fixed of [false,true])expect(run(ScrollEntries,activity,page,supplied,fixed)).toEqual(run(oldList.ScrollEntries,oldActivity,page,supplied,fixed));
});
test('U8 indexed list preserves row owners across immutable publications and height reflow',()=>{
 function run(C:any){let dispose!:()=>void,mounts=0,releases=0,scroller:any;const key={},scope={},render=()=>{mounts++;onCleanup(()=>releases++);return element('Row')({});},[rows,setRows]=createSignal([{key,top:0,height:260,render}]);const source=createMemo(()=>({entries:rows(),indices:new Map([[key,0]]),scope}));
  createRoot(d=>{dispose=d;return C({height:100,entries:[],get indexedEntries(){return source();},padding:0,gap:0,ref:(v:any)=>scroller=v.scroller});});
  for(let i=0;i<9;i++)setRows([{key,top:i,height:260,render}]);setRows([{key,top:9,height:140,render}]);const before={mounts,releases,offset:scroller.offset()};dispose();return {before,mounts,releases};
 }
 expect(run(ScrollEntries)).toEqual(run(oldList.ScrollEntries));
});
