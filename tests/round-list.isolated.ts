import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps,onCleanup} from 'solid-js';
import {rectInsideCircle} from '@podjs/framework/round-layout';
import {roundListInsets,roundRowRange} from '@podjs/framework/round-list';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'u11-production-list',setup(b){b.onLoad({filter:/\/(ScrollEntries|variable-list|HomeScreen|SavedItemsScreen|NotesScreen)\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const fw=Bun.resolveSync('@podjs/framework/variable-list',import.meta.dir);
mock.module(Bun.resolveSync('solid-js',fw),()=>solid);
const {createScrollerWith}=await import(Bun.resolveSync('@pocketjs/framework/kinetics',fw).replace('kinetics.ts','kinetics-core.ts'));
const frames=new Set<()=>void>();let gestures:any[]=[];const element=(props:any)=>{const p=Object.create(props);Object.defineProperty(p,'children',{value:props.children,enumerable:true});const n={props:p};props.ref?.(n);return n;};
for(const [name,impl] of Object.entries({renderer:{createComponent,mergeProps,memo:createMemo,effect:createRenderEffect,...Object.fromEntries(["createElement","insertNode","insert","setProp"].map(name=>[name,()=>{throw Error("unexpected native renderer call: "+name);}]))},components:{View:element,Text:element,Image:element},gesture:{createGesture:(g:any)=>{gestures.push(g);onCleanup(()=>gestures=gestures.filter(v=>v!==g));}},lifecycle:{onFrame:(f:any)=>{frames.add(f);onCleanup(()=>frames.delete(f));}},kinetics:{createScroller:(o:any)=>createScrollerWith(createSignal,o),bindDpadScroll:()=>{}},input:{pressNode:()=>{},hitNode:()=>undefined}}))for(const p of ['@pocketjs/framework/'+name,Bun.resolveSync('@pocketjs/framework/'+name,fw)])mock.module(p,()=>impl);
let shape='round';mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,shape,safeInsets:{left:0,right:0,top:0,bottom:0}}),hasCapability:()=>false,__onHostEvent:()=>()=>{},getFontMetrics:()=>undefined}));
const {ScrollEntries}=await import('../src/ui/ScrollEntries.tsx');
const nodes=(v:any):any[]=>{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v?.props)return [];return [v,...nodes(v.props.children)];};
test('default controller below a notice places every real row within the physical circle at some offset',()=>{
 shape='round';let dispose!:()=>void,scroller:any;
 const tree=createRoot(d=>{dispose=d;return ScrollEntries({height:153,entries:Array.from({length:4},()=>({height:48,render:()=>null})),ref:v=>scroller=v.scroller});});
 const canvas=nodes(tree)[1];scroller.scrollTo(1e5,{immediate:true});const max=scroller.offset();expect(max).toBeGreaterThan(0);
 for(const row of nodes(tree).slice(2)){
  const top=row.props.style.insetT,offset=Math.min(max,Math.max(0,top-(116.5-80-24)));
  expect(rectInsideCircle({x:18,y:80+top-offset,width:197,height:48},{cx:116.5,cy:116.5,radius:116.5},2)).toBe(true);
 }
 const first=nodes(tree)[2];expect(rectInsideCircle({x:18,y:80+first.props.style.insetT,width:197,height:48},{cx:116.5,cy:116.5,radius:116.5},2)).toBe(true);
 expect(max).toBeCloseTo(canvas.props.style.height-153,8);dispose();expect(frames.size).toBe(0);
});
test('rectangular, fixed, explicit opt-out and document-owned controllers keep their previous geometry',()=>{
 for(const options of [{shape:'rect'},{shape:'round',round:null},{shape:'round',fixed:true},{shape:'round',controller:createScrollerWith(createSignal,{max:()=>100})}]){
  shape=options.shape;let dispose!:()=>void;const tree=createRoot(d=>{dispose=d;return ScrollEntries({height:233,entries:[{height:48,render:()=>null}],...options});});
  expect(nodes(tree)[2].props.style.insetT).toBe(18);expect(nodes(tree)[1].props.style.height).toBe(84);dispose();
 }
});
test('explicit centered menu viewport supersedes the bottom-aligned default',()=>{
 shape='round';let dispose!:()=>void;
 const tree=createRoot(d=>{dispose=d;return ScrollEntries({height:80,padding:12,round:{width:233,height:233,viewport:{x:18,y:76.5,width:197}},entries:[{height:48,render:()=>null}]});});
 expect(nodes(tree)[2].props.style.insetT).toBe(12);dispose();
});
test('source/V3 dimensions: buttons fit; scope background cannot fit but measured text can',()=>{
 for(const padding of [18,22,24])for(const height of [48,52,70,84])expect(roundRowRange({height},{width:233,height:233},233,padding)).toBeDefined();
 // V3 inclusive bbox sizes converted at density=2. These are recorded old
 // measurements used as geometry fixtures, not evidence for this new build.
 expect(roundRowRange({height:119},{width:233,height:233},233,18)).toBeUndefined();
 expect(roundRowRange({height:119,bounds:{x:10,y:10,width:174.5,height:99.5}},{width:233,height:233},233,18)).toBeDefined();
 expect(roundRowRange({height:205},{width:233,height:233},233,18)).toBeUndefined();
 expect(roundListInsets([{top:18,height:52},{top:80,height:52}],150,233,{width:233,height:233},18).unfit).toEqual([]);
});

mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>Array.from(text).length*6})}));
mock.module('../src/ui/DeleteConfirmDialog.tsx',()=>({DeleteConfirmDialog:()=>null}));
mock.module('../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:()=>null}));
const {default:HomeScreen}=await import('../src/ui/HomeScreen.tsx');
const {SavedItemsScreen}=await import('../src/ui/SavedItemsScreen.tsx');
const rowNodes=(tree:any)=>nodes(tree).filter(n=>n.props.style?.insetL===18&&typeof n.props.style?.insetT==='number'&&typeof n.props.style?.height==='number'&&n.props.style?.insetR===18);
test('home long-press still selects the displayed channel after round padding',()=>{
 shape='round';let dispose!:()=>void,handle:any,read='';const noop=()=>{},done=async()=>{};
 const tree=createRoot(d=>{dispose=d;return HomeScreen({width:233,height:233,channels:[{id:'first',title:'第一条',url:'https://example.com/1',unreadCount:1,sortOrder:2},{id:'second',title:'第二条',url:'https://example.com/2',sortOrder:1}],notesPlacement:{sortOrder:-1,isPinned:false},refreshing:false,busy:false,platformLoginState:{bili:false,douyin:false},onProfile:noop,onNotes:noop,onRecommend:noop,onSpeech:noop,onAdd:noop,onChannel:noop,onBeian:noop,onRefresh:noop,onMoveChannelToTop:done,onToggleChannelPinned:done,onMarkChannelRead:async c=>{read=c.id;},onDeleteChannel:done,onClearChannel:done,onMoveNotesToTop:noop,onToggleNotesPinned:noop,ref:v=>handle=v});});
 // Home's narrow header declares its bounds, so it needs no start inset; the hit mapping must hold either way.
 expect(handle.roundInsets().start).toBeGreaterThanOrEqual(0);handle.scroller.scrollTo(50,{immediate:true});
 const row=rowNodes(tree)[1],y=row.props.style.insetT-handle.scroller.offset()+row.props.style.height-4;
 gestures.find(g=>g.onLongPress).onLongPress({x:100,y});
 nodes(tree).find(n=>n.props.accessibilityLabel==='标记已读')!.props.onPress();expect(read).toBe('first');dispose();
});
test('saved-list drag hit and floating row share the padded content position',()=>{
 shape='round';let dispose!:()=>void,handle:any;const noop=()=>{};
 const items=['first','second'].map((key,i)=>({key,kind:'rss' as const,title:key,summary:'摘要',channelTitle:'来源',savedAt:0,sortOrder:i}));
 const tree=createRoot(d=>{dispose=d;return SavedItemsScreen({width:233,height:233,active:true,type:'favorite',items,loading:false,undoVisible:false,onOpen:noop,onRemove:noop,onUndo:noop,onReorder:noop,onError:noop,ref:v=>handle=v});});
 expect(handle.roundInsets().start).toBeGreaterThan(0);handle.scroller.scrollTo(170,{immediate:true});
 const first=rowNodes(tree)[2],top=first.props.style.insetT-handle.scroller.offset(),own=gestures.find(g=>g.axis==='x');
 own.onDown({y:top+70});own.onLongPress();
 expect(nodes(tree).find(n=>n.props.accessibilityHidden===true)?.props.accessibilityLabel).toContain('first');
 expect(nodes(tree).find(n=>n.props.style?.width===197&&n.props.style?.height===84&&n.props.style?.insetR===undefined)?.props.style.insetT).toBe(top);
 dispose();
});

mock.module('../src/ui/NoteInlineEditor.tsx',()=>({NoteInlineEditor:()=>null}));
mock.module('../src/ui/NotePreview.tsx',()=>({notePreviewEntrySteps:function*(){}}));
mock.module('../src/ui/ReaderBackground.tsx',()=>({ReaderBackground:()=>null}));
mock.module('../src/ui/reader-fonts.ts',()=>({useReaderFonts:()=>()=>undefined}));
const {NotesListScreen}=await import('../src/ui/NotesScreen.tsx');
test('note tap and long-press still address the displayed row after round padding',async()=>{
 shape='round';let dispose!:()=>void,handle:any,opened='',actions='';
 const notes=['first','second'].map(noteId=>({noteId,title:noteId,markdown:'正文',plainText:'正文',pinned:false,updatedAt:1}));
 const tree=createRoot(d=>{dispose=d;return NotesListScreen({width:233,height:233,repository:{list:async()=>notes} as any,onOpenNote:id=>opened=id,onOpenActions:id=>actions=id,onCreateNote:()=>{},onError:()=>{},ref:v=>handle=v});});
 await new Promise<void>(resolve=>setTimeout(resolve,0));expect(handle.roundInsets().start).toBeGreaterThanOrEqual(0);handle.scroller.scrollTo(100,{immediate:true});
 const first=rowNodes(tree)[2],y=first.props.style.insetT-handle.scroller.offset()+first.props.style.height-2,g=gestures.find(g=>g.onLongPress);
 g.onTap({x:100,y});await Promise.resolve();expect(opened).toBe('first');g.onLongPress({x:100,y});expect(actions).toBe('first');dispose();
});
