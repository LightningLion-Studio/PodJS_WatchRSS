import {expect,test,mock} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
const {createComponent,createMemo,createRoot,createSignal,createRenderEffect,mergeProps,onCleanup}=solid;
// File-linked SDK and app use the same Solid owner graph, as the production compiler does.
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@podjs/framework/windowed-list',import.meta.dir)),()=>solid);
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'note-production-solid',setup(builder){builder.onLoad({filter:/\.tsx$/},async({path})=>({loader:'js',contents:transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code}));}});
type Node={kind:string;props:any};let nextNode=1;
const element=(kind:string)=>(props:any)=>{props.ref?.({id:nextNode++});const children='children' in props?createMemo(()=>props.children):undefined;return {kind,props:children?mergeProps(props,{get children(){return children();}}):props};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect,...Object.fromEntries(['createElement','insertNode','insert','setProp'].map(name=>[name,()=>{throw Error('unexpected component renderer call: '+name);}]))}));
mock.module('@pocketjs/framework/components',()=>({View:element('View'),Text:element('Text'),Image:element('Image')}));
const frames=new Set<()=>void>(),gestures=new Set<unknown>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void)=>{frames.add(cb);onCleanup(()=>frames.delete(cb));}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:unknown)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));},cancelActiveTouches(){}}));
const {createScrollerWith}=await import(new URL('./kinetics-core.ts','file://'+Bun.resolveSync('@pocketjs/framework/kinetics',import.meta.dir)).href);
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(options:any)=>createScrollerWith(createSignal,options),bindDpadScroll(){}}));
mock.module('@pocketjs/framework/input',()=>({pressNode(){},hitNode(){},dispatchAccessibilityAction(){}}));
const images:unknown[][]=[];
let measureCalls=0;const hostOps={measureText:(s:string)=>{measureCalls++;return s.length*7;},setImage:(id:number,handle:number)=>images.push([id,handle]),freeTexture:(handle:number)=>images.push(['free',handle])};
for(const path of new Set([Bun.resolveSync('@pocketjs/framework/host',import.meta.dir),Bun.resolveSync('@pocketjs/framework/host',Bun.resolveSync('@podjs/framework/image',import.meta.dir))])){const real=await import(path);real.installHost({ops:hostOps,kind:'injected',target:'test',strict:true});mock.module(path,()=>({...real,getOps:()=>hostOps}));}
mock.module('../src/ui/reader-fonts.ts',()=>({useReaderFonts:()=>()=>undefined}));
mock.module('../src/ui/NoteInlineEditor.tsx',()=>({NoteInlineEditor:element('Editor')}));
mock.module('../src/ui/ReaderBackground.tsx',()=>({ReaderBackground:element('Background'),useReaderBackgrounds:()=>()=>({state:{presets:[],assets:[]},revision:0})}));
mock.module('../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:element('Download')}));
mock.module('../src/ui/DeleteConfirmDialog.tsx',()=>({DeleteConfirmDialog:element('Delete')}));
const errors:unknown[][]=[];
mock.module('../src/logs/app-logger.ts',()=>({createLogConsole:()=>({info(){},warn(...args:unknown[]){errors.push(args);},error(...args:unknown[]){errors.push(args);}}),appLogger:{d(){},i(){},w(){},e(){}}}));

const mode=process.env.READER_ENTRY_CASE??'saved';
const requests:any[]=[],events:any[]=[],calls:any[]=[],storage=new Map<string,string>();
const pending=new Map<number,ReturnType<typeof setTimeout>>();
(globalThis as any).pod={
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(json:string)=>{const req=JSON.parse(json);calls.push(req);if(req.t==='service.request')requests.push(req);if(req.t==='service.cancel'){const timer=pending.get(req.id);if(timer){clearTimeout(timer);pending.delete(req.id);}}},
 capabilities:()=>JSON.stringify(mode==='portable'?['runtime.timer','data.kv']:['runtime.timer','data.kv','text.layout']),
 displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),
 fontMetrics:()=>JSON.stringify({cellHeight:26,baseline:20}),
 kvGet:(key:string)=>storage.get(key),kvSet:(key:string,value:string)=>{storage.set(key,value);return 0;},kvDelete:(key:string)=>{storage.delete(key);return 0;},kvKeys:()=>JSON.stringify([...storage.keys()]),
};
for(const name of ['renderer','components','lifecycle','gesture','kinetics','input']){const boundary=await import('@pocketjs/framework/'+name);mock.module(Bun.resolveSync('@pocketjs/framework/'+name,Bun.resolveSync('@podjs/framework/image',import.meta.dir)),()=>boundary);}
const {bindPocketServicePump}=await import('@podjs/framework/testing/bun-runtime');
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {ReaderBody}=await import('../src/ui/ReaderBody.tsx');
const {defaultReaderPreset}=await import('../src/reader/preset.ts');
const {createContentLayouter}=await import('../src/reader/content-layout.ts');
const {offsetForDocumentAnchor}=await import('../src/reader/document-layout.ts');
const blocks=Array.from({length:40},(_,i)=>({type:'text' as const,style:'body' as const,text:`Paragraph-${i} `+'long text 中文 '.repeat(15)}));
const preset=defaultReaderPreset(),text=blocks.map(b=>b.text).join('\n'),progress={offset:0,progress:.7,updatedAt:1,textAnchor:{character:Math.floor(text.length*.7),fraction:.25}};
storage.set('watchrss.reader.progress.12569',JSON.stringify(JSON.stringify(mode==='saved'?progress:{offset:0,progress:0,updatedAt:1})));
const native=new Map<any,any[]>();
function paragraph(args:any){const lines:any[]=[];for(let start=0;start<args.text.length;start+=20)lines.push({start,end:Math.min(args.text.length,start+20),visibleEnd:Math.min(args.text.length,start+20),topPx:lines.length*40,bottomPx:(lines.length+1)*40,baselinePx:lines.length*40+30});return {lines};}
async function pump(){for(let i=0;i<8;i++)await Promise.resolve();for(const req of requests.splice(0)){
 let value:any,ms=1;
 if(req.method==='runtime.delay'){expect(req.args.milliseconds).toBeGreaterThanOrEqual(1);value=null;ms=req.args.milliseconds;}
 else if(req.method==='text.layout'){ms=10;value=paragraph(req.args);}
 else if(req.method==='text.layoutBatch'){
  ms=10;value={results:req.args.paragraphs.map(paragraph)};
  for(const args of req.args.paragraphs){const block=blocks.find(b=>b.text===args.text)!;native.set(block,paragraph(args).lines.map((l:any,index:number)=>({start:l.start,end:l.end,visibleEnd:l.visibleEnd,height:20,baseline:15,paragraph:{...args,lineIndex:index}})));}
 }else throw Error('Unexpected fixture request '+req.method);
 pending.set(req.id,setTimeout(()=>{pending.delete(req.id);events.push({t:'service.result',id:req.id,ok:true,value});__pumpPodEvents();},ms));
 }__pumpPodEvents();await new Promise(resolve=>setTimeout(resolve,2));}
const nodes=(value:any):any[]=>typeof value==='function'?nodes(value()):Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props'in value?[value,...nodes(value.props.children)]:[];
const visible=(root:any)=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('');
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()&&Date.now()<end)await pump();expect(check()).toBe(true);}
test(`default ReaderBody slices entry, preserves saved geometry and cancels late work: ${mode}`,async()=>{
 let dispose!:()=>void,handle:any;
 // No progressStore, clock, scheduler or yield injection. KV is the IO boundary.
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'12569',text,blocks,preset,width:233,height:193,fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,footer:mode==='prefix'?[{height:40,render:()=>createComponent(element('Text') as any,{children:'END-OF-DOCUMENT'})}]:undefined,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>{handle=v;}});});
 expect(measureCalls).toBe(0);expect(visible(root)).not.toContain('Paragraph-0');
 const storedBefore=storage.get('watchrss.reader.progress.12569');
 if(mode==='prefix'){
  const gesture=Array.from(gestures).find((g:any)=>g.onPanMove) as any;
  gesture.onDown();gesture.onPanStart();gesture.onPanMove({fdy:-35});
  expect(handle.scroller.offset()).toBe(0);
 }
 if(mode==='cancel'){
  await pump();dispose();for(let i=0;i<12;i++)await pump();
  expect(visible(root)).not.toContain('Paragraph-0');expect(storage.get('watchrss.reader.progress.12569')).toBe(storedBefore);
  expect(calls.some(c=>c.t==='service.cancel')).toBe(true);expect(frames.size).toBe(0);return;
 }
 if(mode==='prefix'){
  await until(()=>visible(root).includes('Paragraph-0'));
  // The first native batch is visible while the tail is still in flight.
  expect(calls.filter(c=>c.method==='text.layoutBatch').length).toBeLessThan(4);
  // Touch can use the prefix while the native tail is outstanding.
  await until(()=>handle.ready());
  expect(visible(root)).not.toContain('END-OF-DOCUMENT');
  handle.scroller.scrollTo(1e6,{immediate:true});expect(handle.reachedBottom()).toBe(false);
  await handle.flushProgress();const prefixProgress=JSON.parse(JSON.parse(storage.get('watchrss.reader.progress.12569')!));expect(prefixProgress.progress).toBeLessThan(1);
  handle.scroller.scrollTo(0,{immediate:true});
  expect(calls.filter(c=>c.method==='text.layoutBatch').length).toBeLessThan(4);
  const gesture=Array.from(gestures).find((g:any)=>g.onPanMove) as any;
  gesture.onDown();gesture.onPanStart();gesture.onPanMove({fdy:-35});
  expect(handle.scroller.offset()).toBe(35);
  gesture.onPanEnd({vy:0});handle.scroller.stop();
  await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
  // Completing the tail must not restore the fresh progress over a manual drag.
  expect(handle.scroller.offset()).toBe(35);
  handle.scroller.scrollTo(0,{immediate:true});
 }
 await until(()=>pending.size===0&&requests.length===0&&calls.some(c=>c.method==='runtime.delay'));
 const expected=createContentLayouter(hostOps.measureText,undefined,()=>({cellHeight:26,baseline:20}))(blocks,205,16,{},preset,mode==='portable'?undefined:native);
 if(mode==='saved')expect(handle.scroller.offset()).toBeCloseTo(offsetForDocumentAnchor(expected,progress.textAnchor,0,expected.height-193));
 else expect(handle.scroller.offset()).toBe(0);
 expect(errors).toEqual([]);expect(calls.some(c=>c.method==='text.layout')).toBe(false);
 handle.scroller.scrollTo(Math.min(100,expected.height-193),{immediate:true});await handle.flushProgress();
 const stored=JSON.parse(JSON.parse(storage.get('watchrss.reader.progress.12569')!));expect(stored.offset).toBe(100);expect(stored.textAnchor.character).toBeGreaterThanOrEqual(0);
 dispose();await pump();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});


// This case crosses two cold entries and the production 1500ms quiet warm-up.
// The budget bounds the integration test; first-input timing has separate assertions.
test('production default ReaderBody checkpoints the latest anchor before any async save and cold restores it',async()=>{
 const props={articleId:'12569',text,blocks,preset,width:233,height:193,fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v)};
 let dispose!:()=>void,handle:any;
 const mount=()=>createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{...props,ref:v=>handle=v});});
 mount();await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 const periodicBefore=storage.get('watchrss.reader.progress.12569');
 handle.scroller.scrollTo(419,{immediate:true});
 events.push({t:'lifecycle',state:'background'});__pumpPodEvents();
 // No frames, clocks, microtasks, Back or cleanup between scroll and process loss.
 const checkpoint=JSON.parse(storage.get('watchrss.reader.checkpoint.12569')!);
 expect(checkpoint.value.offset).toBe(419);expect(checkpoint.value.textAnchor).toBeDefined();
 expect(storage.get('watchrss.reader.progress.12569')).toBe(periodicBefore);
 const durable=new Map(storage);dispose();await pump();
 // Discard writes from the killed realm, including cleanup. Keep durable bytes only.
 storage.clear();for(const [key,value]of durable)storage.set(key,value);
 events.push({t:'lifecycle',state:'active'});__pumpPodEvents();
 mount();await until(()=>!storage.has('watchrss.reader.checkpoint.12569')&&pending.size===0&&requests.length===0);
 expect(handle.scroller.offset()).toBeCloseTo(419,4);
 expect(storage.has('watchrss.reader.checkpoint.12569')).toBe(false);
 handle.scroller.scrollTo(511,{immediate:true});
 events.push({t:'checkpoint',reason:'screen-off'});__pumpPodEvents();
 expect(JSON.parse(storage.get('watchrss.reader.checkpoint.12569')!).value.offset).toBe(511);
 dispose();await pump();expect(errors).toEqual([]);expect(frames.size).toBe(0);
},10000);

if(mode==='saved')test('book pages replace their lines, reverse exactly, preserve anchors and keep double tap',async()=>{
 let dispose!:()=>void,handle:any,opened=0;
 const props={articleId:'12570',text,blocks,preset,width:233,height:233,top:0,pageMode:true,fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,onMedia(){},onControls(){opened++;},onError:(v:any)=>errors.push(v),ref:(v:any)=>handle=v};
 const mount=()=>createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,props);});
 let root=mount();await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 expect(handle.playing()).toBe(false);
 expect(nodes(root).filter(n=>n.props.debugName==='ReaderBookPage')).toHaveLength(1);
 expect([...gestures].some((g:any)=>g.onPanMove)).toBe(false);
 let gesture=[...gestures].find((g:any)=>g.onTap) as any;
 const first=visible(root);
 gesture.onTap({x:215,y:110});await pump();gesture.onTap({x:215,y:110});
 expect(opened).toBe(1);
 const cancelledUntil=Date.now()+350;while(Date.now()<cancelledUntil)await pump();expect(visible(root)).toBe(first);
 gesture.onTap({x:116,y:110});await pump();
 const centerUntil=Date.now()+350;while(Date.now()<centerUntil)await pump();expect(visible(root)).toBe(first);
 gesture.onTap({x:215,y:110});expect(visible(root)).not.toBe(first);await pump();await until(()=>visible(root)!==first);
 const second=visible(root);
 for(let i=0;i<15;i++)for(const frame of [...frames])frame();
 expect(visible(root)).toBe(second);
 gesture.onTap({x:18,y:110});await pump();await until(()=>visible(root)===first);
 gesture.onTap({x:215,y:110});await pump();await until(()=>visible(root)===second);
 await handle.flushProgress();
 const stored=JSON.parse(JSON.parse(storage.get('watchrss.reader.progress.12570')!));expect(stored.textAnchor.character).toBeGreaterThan(0);
 dispose();await pump();root=mount();await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 expect(visible(root)).toBe(second);
 dispose();await pump();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});

if(mode==='saved')test('settings and double-tap controls expose the same persisted segmented selection',async()=>{
 const {AutoScrollSettingsScreen}=await import('../src/ui/AutoScrollSettingsScreen.tsx');
 const {DEFAULT_SETTINGS,SettingsStore}=await import('../src/settings/store.ts');
 let saved:unknown=DEFAULT_SETTINGS;
 const store=new SettingsStore({get:<T>()=>saved as T,set:(_key:string,value:unknown)=>{saved=value;}});
 const [state,setState]=createSignal(store.load());
 const disposers:(()=>void)[]=[];
 const [auto,setAuto]=createSignal(false);
 const mount=(reader:boolean)=>createRoot(dispose=>{disposers.push(dispose);return createComponent(AutoScrollSettingsScreen,{width:233,height:233,get state(){return state();},onChange:patch=>setState(store.update(patch)),onNavigate(){},reader:reader?{playing:auto,setPlaying:setAuto}:undefined});});
 const gestureCount=gestures.size;
 const settings=mount(false),controls=mount(true);
 expect(gestures.size).toBe(gestureCount);
 expect(nodes(settings).some(n=>n.props.debugName==='ScrollControlPanel')).toBe(true);
 const segment=(root:any,label:string)=>nodes(root).find(n=>n.props.accessibilityLabel===label)!;
 expect(visible(settings)).toContain('滚动控制');expect(visible(controls)).toContain('滚动控制');
 expect(segment(settings,'纵向滚动').props.accessibilityState.selected).toBe(true);
 segment(settings,'点击翻页').props.onPress();
 expect(segment(controls,'点击翻页').props.accessibilityState.selected).toBe(true);
 expect(store.load().readerPageMode).toBe(true);
 expect(visible(controls)).toContain('5 秒/页');
 segment(controls,'开始自动翻页').props.onPress();expect(auto()).toBe(true);expect(store.load().readerPageMode).toBe(true);
 segment(controls,'延长翻页间隔').props.onPress();expect(store.load().readerPageSeconds).toBe(6);expect(visible(controls)).toContain('6 秒/页');
 expect(store.load().readerScrollSpeed).toBe(DEFAULT_SETTINGS.readerScrollSpeed);
 segment(controls,'暂停自动翻页').props.onPress();expect(auto()).toBe(false);
 segment(controls,'纵向滚动').props.onPress();
 expect(segment(settings,'纵向滚动').props.accessibilityState.selected).toBe(true);
 expect(store.load().readerPageMode).toBe(false);
 for(const dispose of disposers)dispose();await pump();
});

if(mode==='saved')test('imported book pages load each chunk without rewriting read pages and cold restore the exact page',async()=>{
 const chunks=Array.from({length:3},(_,i)=>`Chunk-${i} `+'中文 long '.repeat(40)),reads:number[]=[];
 const imported={handle:{marker:'watchrss-watch-content:paged-test.txt',byteLength:3000,chunkBytes:1000,chunkCount:3},read:async(index:number)=>{reads.push(index);return chunks[index]??null;}};
 let dispose!:()=>void,handle:any;
 const mount=()=>createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'12571',text:'',blocks:[],imported,preset,width:233,height:233,top:0,pageMode:true,fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>handle=v});});
 let root=mount();await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 expect(visible(root)).toContain('Chunk-0');expect(reads).toEqual([0]);
 let previous=visible(root),count=0;
 while(!visible(root).includes('Chunk-1')&&count++<12){
  const gesture=[...gestures].find((g:any)=>g.onTap) as any;gesture.onTap({x:215,y:110});await pump();await until(()=>visible(root)!==previous);previous=visible(root);
  await until(()=>!visible(root).includes('正在排版')&&pending.size===0&&requests.length===0);
 }
 expect(reads).toEqual([0,1]);expect(visible(root)).toContain('Chunk-1');
 const firstInChunk=visible(root);await handle.flushProgress();
 const progress=JSON.parse(JSON.parse(storage.get('watchrss.reader.progress.12571')!));expect(progress.importedAnchor).toMatchObject({chunkIndex:1,charOffset:0});
 dispose();await pump();root=mount();await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 expect(visible(root)).toBe(firstInChunk);
 dispose();await pump();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});

if(mode==='saved')test('automatic book paging defaults to five seconds, pauses in background and stops after manual input',async()=>{
 let dispose!:()=>void,handle:any;
 const [active,setActive]=createSignal(true);
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'12572',text,blocks,preset,width:233,height:233,top:0,pageMode:true,fontSize:16,lineHeight:24,get active(){return active();},autoStart:true,speed:1,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>handle=v});});
 await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 expect(handle.playing()).toBe(true);
 const first=visible(root),originalNow=Date.now;let now=100000;
 Date.now=()=>now;
 try {
  const frame=()=>{for(const cb of [...frames])cb();};
  frame();now+=4999;frame();expect(visible(root)).toBe(first);
  now++;frame();expect(visible(root)).not.toBe(first);expect(handle.playing()).toBe(true);
  const second=visible(root);setActive(false);now+=60000;frame();expect(visible(root)).toBe(second);
  setActive(true);frame();now+=4999;frame();expect(visible(root)).toBe(second);
  now++;frame();expect(visible(root)).not.toBe(second);
  const gesture=[...gestures].find((g:any)=>g.onTap) as any;gesture.onTap({x:215,y:110});expect(handle.playing()).toBe(false);
  const manual=visible(root);now+=10000;frame();expect(visible(root)).toBe(manual);
 }finally{Date.now=originalNow;dispose();await pump();}
 expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});

if(mode==='saved')test('switching modes without scrolling returns to the same book page',async()=>{
 let dispose!:()=>void,handle:any;
 const [pageMode,setPageMode]=createSignal(true);
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'12573',text,blocks,preset,width:233,height:233,top:0,get pageMode(){return pageMode();},fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>handle=v});});
 await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 const gesture=[...gestures].find((g:any)=>g.onTap) as any;gesture.onTap({x:215,y:110});await pump();
 await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
 const expected=visible(root);setPageMode(false);await pump();setPageMode(true);await pump();
 expect(visible(root)).toBe(expected);
 dispose();await pump();
});
