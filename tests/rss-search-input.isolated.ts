import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solidRuntime from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup,Show} from 'solid-js';
import {createScrollerWith} from '/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/src/kinetics-core.ts';
import {captureActivityNavigation,restoreActivityNavigation,routeMemory,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
// Match production's single-Solid alias for the file-linked framework.
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@podjs/framework/windowed-list',import.meta.dir)),()=>solidRuntime);
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'activity-recreation-solid',setup(builder){builder.onLoad({filter:/\/ui\/(route-activity|ScrollEntries|RssSearchScreen|AddRssScreen|VideoPlayerScreen|NoteInlineEditor|NotesScreen)\.tsx$|\/variable-list\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
// Keep the production Solid owner/effect graph and scroller state machine.
// Only native rendering and hardware registration are replaced at their boundaries.
type Node={kind:string;props:Record<string,any>};
const element=(kind:string)=>(props:Node['props']):Node=>{
 const children='children' in props?createMemo(()=>props.children):undefined;
 return {kind,props:children?mergeProps(props,{get children(){return children();}}):props};
};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:element('View'),Text:element('Text'),Image:element('Image')}));
const frames=new Set<()=>void>(),gestures=new Set<any>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void)=>{frames.add(cb);onCleanup(()=>frames.delete(cb));}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:any)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));return {dispose(){}};}}));
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(opts:any)=>createScrollerWith(createSignal,opts),bindDpadScroll:()=>{}}));
mock.module('@pocketjs/framework/input',()=>({pressNode:()=>{},hitNode:()=>undefined}));
// Restoration fixtures below use rectangular display geometry. Round fitting
// is covered separately with a full display/viewport contract in U11.
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,shape:'rect',safeInsets:{left:0,right:0,top:0,bottom:0}}),hasCapability:()=>false,__onHostEvent:()=>()=>{},getFontMetrics:()=>undefined,lifecycle:()=> 'active',onLifecycleChange:()=>()=>{},normalizedRelativeAxisStep:(n:number)=>n,kv:{get:()=>undefined,set(){},delete(){}}}));

mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>s.length*8})}));
// file: installations can resolve PocketJS differently from the app. The list
// must use these same rendering/input boundaries, not native-tree primitives.
const frameworkImporter=Bun.resolveSync('@podjs/framework/variable-list',import.meta.dir);
for(const name of ['renderer','components','lifecycle','gesture','kinetics','input','host']){
 const boundary=await import('@pocketjs/framework/'+name);
 mock.module(Bun.resolveSync('@pocketjs/framework/'+name,frameworkImporter),()=>boundary);
}
const {RssSearchScreen}=await import('../src/ui/RssSearchScreen.tsx');
function all(v:any):any[]{if(typeof v==='function')return all(v());if(Array.isArray(v))return v.flatMap(all);if(!v?.props)return[];return[v,...all(v.props.children)];}

test('search scene stays mounted for empty input, early submit, loading, results and route cancellation',async()=>{
 let stop!:()=>void,submit!:()=>void,change!:(v:string)=>void,finish!:(s:{close():Promise<void>})=>void,closed=0;
 const [keyword,setKeyword]=createSignal(''),[results,setResults]=createSignal<any[]>([]),[loading,setLoading]=createSignal(false),[active,setActive]=createSignal(true);
 const tree=createRoot(d=>{stop=d;return RssSearchScreen({width:233,height:233,get active(){return active();},get keyword(){return keyword();},get results(){return results();},get loading(){return loading();},onInput:()=>{throw Error('fallback forbidden');},onKeywordChange:setKeyword,onOpen:()=>{},openInlineInput:async(_v,_bounds,onChange,onSubmit)=>{change=onChange;submit=onSubmit;return new Promise(r=>finish=r);}});});
 const text=()=>all(tree).filter(n=>n.kind==='Text').map(n=>n.props.children).join('|');
 const press=()=>all(tree).find(n=>n.props.accessibilityLabel==='输入关键词开始搜索')!.props.onPress();
 try{
  expect(text()).toContain('输入关键词开始搜索');press();submit();finish({close:async()=>{closed++;}});await Bun.sleep(0);expect(closed).toBe(1);expect(text()).toContain('输入关键词开始搜索');
  press();finish({close:async()=>{closed++;}});await Bun.sleep(0);change('599');setLoading(true);expect(text()).toContain('搜索中');setLoading(false);expect(text()).toContain('没有找到相关结果');setResults([{id:'1',title:'Fixture 599',searchSnippet:'Section 0'}]);expect(text()).toContain('Fixture 599');
  setActive(false);await Bun.sleep(0);expect(closed).toBe(2);expect(all(tree).filter(n=>n.kind==='Text').length).toBeGreaterThan(2);
 }finally{stop();}
});
