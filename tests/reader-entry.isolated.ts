import {expect,test,mock,spyOn} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
const {createComponent,createMemo,createRoot,createSignal,createRenderEffect,mergeProps,onCleanup}=solid;
const perfText=process.env.READER_ENTRY_CASE==='perf-text';
// File-linked SDK and app use the same Solid owner graph, as the production compiler does.
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@podjs/framework/windowed-list',import.meta.dir)),()=>solid);
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'note-production-solid',setup(builder){builder.onLoad({filter:/\.tsx$/},async({path})=>({loader:'js',contents:transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code}));}});
type Node={kind:string;props:any};let nextNode=1;
const element=(kind:string)=>(props:any)=>{props.ref?.({id:nextNode++});const children='children' in props?createMemo(()=>props.children):undefined;return {kind,props:children?mergeProps(props,{get children(){return children();}}):props};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect,...perfText?{
 createElement:(kind:string)=>({id:nextNode++,kind,props:{},children:[]}),
 insertNode:(p:any,c:any)=>p.children.push(c),
 insert:(p:any,read:()=>unknown)=>createRenderEffect(()=>{p.props.children=read();}),
 setProp:(n:any,k:string,v:unknown)=>n.props[k]=v,
}:Object.fromEntries(['createElement','insertNode','insert','setProp'].map(name=>[name,()=>{throw Error('unexpected component renderer call: '+name);}]))}));
mock.module('@pocketjs/framework/components',()=>({View:element('View'),Text:element('Text'),Image:element('Image')}));
const frames=new Set<()=>void>(),demands=new Map<()=>void,()=>boolean>(),gestures=new Set<unknown>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void,needsFrame=()=>true)=>{frames.add(cb);demands.set(cb,needsFrame);onCleanup(()=>{frames.delete(cb);demands.delete(cb);});}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:unknown)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));},cancelActiveTouches(){}}));
const {createScrollerWith}=await import(new URL('./kinetics-core.ts','file://'+Bun.resolveSync('@pocketjs/framework/kinetics',import.meta.dir)).href);
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(options:any)=>createScrollerWith(createSignal,options),bindDpadScroll(){}}));
mock.module('@pocketjs/framework/input',()=>({pressNode(){},hitNode(){},dispatchAccessibilityAction(){}}));
const images:unknown[][]=[];
let measureCalls=0;const hostOps={measureText:(s:string)=>{measureCalls++;return s.length*7;},setImage:(id:number,handle:number)=>images.push([id,handle]),freeTexture:(handle:number)=>{textureTexts.delete(handle);images.push(['free',handle]);}};
for(const path of new Set([Bun.resolveSync('@pocketjs/framework/host',import.meta.dir),Bun.resolveSync('@pocketjs/framework/host',Bun.resolveSync('@podjs/framework/image',import.meta.dir))])){const real=await import(path);real.installHost({ops:hostOps,kind:'injected',target:'test',strict:true});mock.module(path,()=>({...real,getOps:()=>hostOps}));}
mock.module('../src/ui/reader-fonts.ts',()=>({useReaderFonts:()=>()=>undefined}));
mock.module('../src/ui/NoteInlineEditor.tsx',()=>({NoteInlineEditor:element('Editor')}));
mock.module('../src/ui/ReaderBackground.tsx',()=>({ReaderBackground:element('Background'),useReaderBackgrounds:()=>()=>({state:{presets:[],assets:[]},revision:0})}));
mock.module('../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:element('Download')}));
mock.module('../src/ui/DeleteConfirmDialog.tsx',()=>({DeleteConfirmDialog:element('Delete')}));
const errors:unknown[]=[];
mock.module('../src/logs/app-logger.ts',()=>({createLogConsole:()=>({info(){},warn(...args:unknown[]){errors.push(args);},error(...args:unknown[]){errors.push(args);}}),appLogger:{d(){},i(){},w(){},e(){}}}));

const mode=process.env.READER_ENTRY_CASE??'saved';
const requests:any[]=[],events:any[]=[],calls:any[]=[],storage=new Map<string,string>();
const pending=new Map<number,ReturnType<typeof setTimeout>>();
const textureTexts=new Map<number,string>(),rasterTexts=new Map<string,string>();
let nextTexture=1;
(globalThis as any).pod={
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(json:string)=>{const req=JSON.parse(json);calls.push(req);if(req.t==='service.request')requests.push(req);if(req.t==='service.cancel'){
   const queued=requests.findIndex(request=>request.id===req.id);if(queued>=0)requests.splice(queued,1);
   const timer=pending.get(req.id);if(timer){clearTimeout(timer);pending.delete(req.id);}
 }},
 capabilities:()=>JSON.stringify(perfText?['runtime.timer','data.kv','text.raster']:mode==='portable'?['runtime.timer','data.kv']:['runtime.timer','data.kv','text.layout']),
 ...(perfText?{
  memoryBudgetBytes:()=>256*1024*1024,
  uploadTextureFile:(path:string)=>{const value=nextTexture++;textureTexts.set(value,rasterTexts.get(path)!);return value;},
 }:{}),
 displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),
 fontMetrics:()=>JSON.stringify({cellHeight:26,baseline:20}),
 kvGet:(key:string)=>storage.get(key),kvSet:(key:string,value:string)=>{storage.set(key,value);return 0;},kvDelete:(key:string)=>{storage.delete(key);return 0;},kvKeys:()=>JSON.stringify([...storage.keys()]),
};
for(const name of ['renderer','components','lifecycle','gesture','kinetics','input']){const boundary=await import('@pocketjs/framework/'+name);mock.module(Bun.resolveSync('@pocketjs/framework/'+name,Bun.resolveSync('@podjs/framework/image',import.meta.dir)),()=>boundary);}
const {bindPocketServicePump}=await import('@podjs/framework/testing/bun-runtime');
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
const {__pumpPodEvents}=await import('@podjs/framework/watch');
let readerEntryKeys=0;
if(mode==='imported-window'){
 const layout=await import('../src/reader/content-layout.ts'),key=layout.readerRowKey;
 mock.module('../src/reader/content-layout.ts',()=>({...layout,readerRowKey:(row:Parameters<typeof key>[0])=>{readerEntryKeys++;return key(row);}}));
}
const {ReaderBody}=await import('../src/ui/ReaderBody.tsx');
const {defaultReaderPreset}=await import('../src/reader/preset.ts');
const {createContentLayouter}=await import('../src/reader/content-layout.ts');
const {offsetForDocumentAnchor}=await import('../src/reader/document-layout.ts');
const blocks=Array.from({length:mode.startsWith('windowed')?1000:40},(_,i)=>({type:'text' as const,style:'body' as const,text:`Paragraph-${i} `+'long text 中文 '.repeat(15)}));
const preset=defaultReaderPreset(),text=blocks.map(b=>b.text).join('\n'),progress={offset:0,progress:.7,updatedAt:1,textAnchor:{character:Math.floor(text.length*.7),fraction:.25}};
storage.set('watchrss.reader.progress.12569',JSON.stringify(JSON.stringify((mode==='saved'||mode==='windowed-saved')?progress:{offset:0,progress:0,updatedAt:1})));
const native=new Map<any,any[]>();
function paragraph(args:any){const lines:any[]=[];for(let start=0;start<args.text.length;start+=20)lines.push({start,end:Math.min(args.text.length,start+20),visibleEnd:Math.min(args.text.length,start+20),topPx:lines.length*40,bottomPx:(lines.length+1)*40,baselinePx:lines.length*40+30});return {lines};}
async function pump(){for(let i=0;i<8;i++)await Promise.resolve();for(const req of requests.splice(0)){
 let value:any,ms=1;
 if(req.method==='runtime.delay'){expect(req.args.milliseconds).toBeGreaterThanOrEqual(1);value=null;ms=req.args.milliseconds;}
 else if(req.method==='text.layout'){ms=10;value=paragraph(req.args);}
 else if(req.method==='text.layoutBatch'){
  ms=10;value={results:req.args.paragraphs.map(paragraph)};
  for(const args of req.args.paragraphs){const block=blocks.find(b=>b.text===args.text)!;native.set(block,paragraph(args).lines.map((l:any,index:number)=>({start:l.start,end:l.end,visibleEnd:l.visibleEnd,height:20,baseline:15,paragraph:{...args,lineIndex:index}})));}
 }else if(perfText&&req.method==='text.raster'){
  ms=34;
  const path='texture-'+req.id;rasterTexts.set(path,req.args.text);
  const extent=(n:number)=>2**Math.ceil(Math.log2(n));
  value={path,width:extent(req.args.widthPx),height:extent(req.args.heightPx),carets:Array.from({length:req.args.text.length+1},(_,i)=>i*10)};
 }else throw Error('Unexpected fixture request '+req.method);
 pending.set(req.id,setTimeout(()=>{pending.delete(req.id);events.push({t:'service.result',id:req.id,ok:true,value});__pumpPodEvents();},ms));
 }__pumpPodEvents();await new Promise(resolve=>setTimeout(resolve,2));}
const nodes=(value:any):any[]=>typeof value==='function'?nodes(value()):Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props'in value?[value,...nodes(value.props.children)]:[];
const visible=(root:any)=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('');
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()&&Date.now()<end)await pump();expect(check()).toBe(true);}
if(mode==='imported-window')test('a 128 MiB import only creates UI entries for the current scroll window',async()=>{
 const {ImportedTextStore}=await import('../src/reader/imported-text.ts');
 const {ImportedReaderDocument}=await import('../src/reader/imported-document.ts');
 const blockSnapshots=spyOn(ImportedReaderDocument.prototype,'blocks');
 const size=128*1024*1024,chunk=Buffer.from('书中文😀ab\n'.repeat(1024)),filePath=process.env.READER_IMPORT_FILE;
 const file=filePath?await (await import('node:fs/promises')).open(filePath,'r'):undefined;
 const store=new ImportedTextStore({
  stat:async()=>({file:true,size:file?(await file.stat()).size:size}),
  read:async(_path,offset,bytes)=>{
   if(file){const value=Buffer.alloc(bytes),{bytesRead}=await file.read(value,0,bytes,offset);return value.subarray(0,bytesRead);}
   return Uint8Array.from({length:bytes},(_,index)=>chunk[(offset+index)%chunk.length]!);
  },decode:bytes=>new TextDecoder().decode(bytes)
 });
 let dispose!:()=>void,handle:any;
 try{
  const book=(await store.handle('watchrss-watch-content:book.txt'))!;
  expect(book.byteLength).toBe(size);expect(book.chunkCount).toBe(8192);
  const reads:number[]=[],root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{
   articleId:'12569',text:'',blocks:[],imported:{handle:book,read:index=>{reads.push(index);return store.chunk(book,index);}},preset,width:233,height:193,fontSize:16,lineHeight:24,
   active:true,pageMode:false,autoStart:false,speed:1,onMedia(){},onControls(){},onError:v=>errors.push(v),ref:v=>{handle=v;}
  });});
  const cold=readerEntryKeys;
  await until(()=>handle.ready());expect(visible(root)).toContain('书中文');expect(reads).toEqual([0]);
  const loaded=readerEntryKeys-cold;
  const beforeScroll=readerEntryKeys;handle.scroller.scrollTo(1500,{immediate:true});
  expect(visible(root)).toContain('书中文');
  const scrolled=readerEntryKeys-beforeScroll;
  if(filePath)console.log(JSON.stringify({bytes:book.byteLength,chunks:book.chunkCount,viewportHeight:193,cold,loaded,scrolled,readChunks:reads,blockSnapshots:blockSnapshots.mock.calls.length}));
  expect(cold).toBeGreaterThan(0);expect(cold).toBeLessThan(128);expect(loaded).toBeGreaterThan(0);expect(loaded).toBeLessThan(128);
  expect(scrolled).toBeLessThan(96);expect(blockSnapshots).not.toHaveBeenCalled();expect(errors).toEqual([]);
 }finally{dispose?.();blockSnapshots.mockRestore();await file?.close();}
});
if(!perfText&&mode!=='imported-window')test(`default ReaderBody slices entry, preserves saved geometry and cancels late work: ${mode}`,async()=>{
 let dispose!:()=>void,handle:any;
 // No progressStore, clock, scheduler or yield injection. KV is the IO boundary.
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'12569',text,blocks,preset,width:233,height:193,fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,footer:mode==='prefix'?[{height:40,render:()=>createComponent(element('Text') as any,{children:'END-OF-DOCUMENT'})}]:undefined,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>{handle=v;}});});
 expect(measureCalls).toBe(0);expect(visible(root)).not.toContain('Paragraph-0');
 const storedBefore=storage.get('watchrss.reader.progress.12569');
 if(mode.startsWith('windowed')){
  await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
  expect(visible(root)).toContain('long text');
  const batches=calls.filter(c=>c.method==='text.layoutBatch');expect(batches.length).toBeLessThan(6);
  for(const batch of batches)expect(batch.args.paragraphs.reduce((n:number,p:any)=>n+p.text.length,0)).toBeLessThanOrEqual(2048);
  handle.scroller.scrollTo(handle.scroller.offset()+1,{immediate:true});await handle.flushProgress();
  const saved=JSON.parse(JSON.parse(storage.get('watchrss.reader.progress.12569')!));
  if(mode==='windowed-saved')expect(Math.abs(saved.textAnchor.character-progress.textAnchor.character)).toBeLessThanOrEqual(20);
  expect(errors).toEqual([]);dispose();await pump();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);return;
 }

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
if(!perfText&&!mode.startsWith('windowed')&&mode!=='imported-window')test('production default ReaderBody checkpoints the latest anchor before any async save and cold restores it',async()=>{
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

if(mode==='saved')test('paged line slots keep their owners while text, media and geometry change',async()=>{
 const {ReaderBookPage}=await import('../src/ui/ReaderBookPage.tsx');
 const make=(text:string,left=12):any=>({anchor:{section:'body',character:0,blockIndex:0,sourceStart:0,sectionOffset:0},lines:[{row:{kind:'text',text,top:0,height:23,lineHeight:23,gap:0,blockIndex:0,character:0,fontSlot:2,scale:1,color:'#ffffffff'},left,top:12,width:128}]});
 const [page,setPage]=createSignal(make('旧页'));
 let stop!:()=>void;const root=createRoot(dispose=>{stop=dispose;return createComponent(ReaderBookPage,{get page(){return page();},width:233,height:233,round:false,active:true,header:[],footer:[],blocks:[{type:'text',style:'body',text:'正文'}],fontSize:14,environment:{pixelScale:2,rasterSupported:false,fontMetrics:()=>({cellWidth:14,cellHeight:18,baseline:14,lineHeight:23,rasterDensity:2})},onTap(){},onMedia(){}});});
 const first=nodes(root).find(n=>n.props.debugName==='ReaderPageLine');expect(first).toBeDefined();expect(visible(root)).toContain('旧页');
 setPage(make('新页',20));expect(nodes(root).find(n=>n.props.debugName==='ReaderPageLine')).toBe(first);expect(visible(root)).toContain('新页');expect(visible(root)).not.toContain('旧页');expect(first!.props.style.insetL).toBe(20);
 const media=make('');media.lines[0].row={kind:'video',block:{type:'video',url:'https://example.invalid/video'},blockIndex:0,character:0,top:0,height:80,gap:0};setPage(media);expect(nodes(root).find(n=>n.props.debugName==='ReaderPageLine')).toBe(first);expect(visible(root)).toContain('视频');expect(visible(root)).not.toContain('新页');
 setPage(make('返回页'));expect(visible(root)).toContain('返回页');stop();await pump();expect(gestures.size).toBe(0);
});

if(mode==='saved')test('stationary media reader sleeps and saves the last drag without polling',async()=>{
 const fixture=[{type:'text' as const,style:'body' as const,text:'长文正文'.repeat(300)}];
 const positions:number[]=[],readingErrors:string[]=[];
 let handle!:import('../src/ui/ReaderBody.tsx').ReaderBodyHandle,dispose!:()=>void;
 const initialCalls=calls.length;
 createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{
   articleId:'79',text:fixture[0]!.text,blocks:fixture,preset,width:233,height:193,fontSize:16,lineHeight:24,
   active:true,autoStart:false,speed:1,onMedia(){},onControls(){},onError:v=>readingErrors.push(v),
   progressStore:{load:async()=>({offset:0,progress:0,updatedAt:1}),save:async(_id,offset)=>{positions.push(offset);}},
   ref:v=>{handle=v;},
 });});
 try{
   await until(()=>handle.ready?.()===true&&pending.size===0&&requests.length===0);
   const demand=()=>[...demands.values()].some(needs=>needs());
   const requestsForFrames=Array.from({length:300},demand).filter(Boolean).length;
   expect(requestsForFrames).toBe(0);
   expect(calls.slice(initialCalls).some(call=>call.args?.milliseconds===1500)).toBe(false);
   handle.setPlaying(true);expect(demand()).toBe(true);
   handle.pause();expect(demand()).toBe(false);
   const frame=()=>{for(const cb of frames)cb();};
   handle.scroller.scrollTo(56,{immediate:true});frame();
   await until(()=>positions.includes(56));
   handle.scroller.scrollTo(78,{immediate:true});frame();
   expect(demand()).toBe(false);
   await until(()=>positions.at(-1)===78);
   expect(readingErrors).toEqual([]);
 }finally{dispose();await pump();}
 expect(demands.size).toBe(0);
});

function takeDelay(milliseconds:number):number{
 const index=requests.findIndex(req=>req.method==='runtime.delay'&&req.args.milliseconds===milliseconds);
 expect(index).toBeGreaterThanOrEqual(0);
 return requests.splice(index,1)[0].id;
}
async function completeDelay(id:number){
 events.push({t:'service.result',id,ok:true,value:null});
 __pumpPodEvents();
 await Promise.resolve();await Promise.resolve();
}
const needsAnimationFrame=()=>[...demands.values()].some(wants=>wants());

if(mode==='saved')test('minute clock and QR transition wake at their deadlines and cancel when hidden',async()=>{
 const {useMinuteClock}=await import('../src/ui/minute-clock.ts');
 const {useInputQrTransition}=await import('../src/ui/RemoteInputScreen.tsx');
 const originalNow=Date.now, start=120_100;
 let now=start,stop!:()=>void;
 Date.now=()=>now;
 const [active,setActive]=createSignal(true);
 try{
   const {clock,fade}=createRoot(dispose=>{stop=dispose;return {clock:useMinuteClock(active),fade:useInputQrTransition(active)};});
   const minute=takeDelay(59_900),intro=takeDelay(3000);
   expect(clock().getTime()).toBe(start);expect(fade()).toBe(0);expect(needsAnimationFrame()).toBe(false);
   now+=3000;await completeDelay(intro);expect(needsAnimationFrame()).toBe(true);
   now+=500;for(const frame of frames)frame();expect(fade()).toBe(.5);
   setActive(false);expect(needsAnimationFrame()).toBe(false);
   expect(calls.some(r=>r.t==='service.cancel'&&r.id===minute)).toBe(true);
   now=200_000;await completeDelay(minute);expect(clock().getTime()).toBe(start);
   setActive(true);expect(clock().getTime()).toBe(now);expect(fade()).toBe(1);expect(needsAnimationFrame()).toBe(false);
   const resumed=takeDelay(40_000);
   now=240_000;await completeDelay(resumed);expect(clock().getTime()).toBe(now);
   const following=takeDelay(60_000);stop();
   expect(calls.some(r=>r.t==='service.cancel'&&r.id===following)).toBe(true);
 }finally{stop?.();Date.now=originalNow;}
});

if(mode==='saved')test('novel menu wakes for its two idle deadlines and requests frames only for transitions',async()=>{
 const {NovelReadingMenu}=await import('../src/ui/NovelReadingMenu.tsx');
 const {NOVEL_MENU_SHOW_MS:show,NOVEL_MENU_DIM_MS:dim}=await import('../src/reader/novel.ts');
 const {NOVEL_MENU_OPEN_MS:open,NOVEL_MENU_CLOSE_MS:close}=await import('../src/ui/novel-menu-animation.ts');
 const originalNow=Date.now;
 let now=1000,stop!:()=>void;
 Date.now=()=>now;
 const [moving,setMoving]=createSignal(false),[expanded,setExpanded]=createSignal(false);
 try{
   const root=createRoot(dispose=>{stop=dispose;return createComponent(NovelReadingMenu,{width:233,height:233,active:true,get expanded(){return expanded();},get moving(){return moving();},pageMode:false,preset,onExpanded:setExpanded,onMode(){},onSpeak(){}});});
   const bubble=()=>nodes(root).find(n=>n.props.accessibilityLabel==='阅读方式菜单');
   const first=takeDelay(show);expect(bubble()).toBeUndefined();expect(needsAnimationFrame()).toBe(false);
   setMoving(true);now+=show;await completeDelay(first);expect(bubble()).toBeUndefined();
   setMoving(false);now+=show;await completeDelay(takeDelay(show));expect(bubble()).toBeDefined();expect(needsAnimationFrame()).toBe(false);
   now+=dim-show;await completeDelay(takeDelay(dim-show));
   expect(nodes(bubble()).some(n=>n.props.style?.opacity===.22)).toBe(true);
   setExpanded(true);expect(needsAnimationFrame()).toBe(true);
   now+=open;for(const frame of frames)frame();expect(needsAnimationFrame()).toBe(false);
   expect(visible(root)).toContain('大声朗读');
   setExpanded(false);expect(needsAnimationFrame()).toBe(true);now+=close;for(const frame of frames)frame();
   expect(needsAnimationFrame()).toBe(false);const pendingShow=takeDelay(show);stop();
   expect(calls.some(r=>r.t==='service.cancel'&&r.id===pendingShow)).toBe(true);
 }finally{stop?.();Date.now=originalNow;}
});

if(mode==='saved')test('automatic book paging sleeps between deadlines and cancels stale page turns',async()=>{
 const [active,setActive]=createSignal(true),[seconds,setSeconds]=createSignal(5);
 let dispose!:()=>void,handle!:import('../src/ui/ReaderBody.tsx').ReaderBodyHandle;
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'705',text,blocks,preset,
   width:233,height:233,pageMode:true,fontSize:16,lineHeight:24,get active(){return active();},
   autoStart:true,speed:1,get pageSeconds(){return seconds();},onMedia(){},onControls(){},onError:v=>errors.push(v),ref:v=>handle=v});});
 const frame=()=>{for(const cb of frames)cb();};
 const cancelled=(id:number)=>calls.some(req=>req.t==='service.cancel'&&req.id===id);
 try{
   await until(()=>!!handle.ready?.()&&pending.size===0&&requests.length===0);
   const first=visible(root);
   frame();expect(needsAnimationFrame()).toBe(false);
   const timer=takeDelay(5000);for(let i=0;i<60;i++)frame();
   expect(requests.filter(req=>req.method==='runtime.delay'&&req.args.milliseconds===5000)).toHaveLength(0);
   await completeDelay(timer);expect(visible(root)).not.toBe(first);
   frame();expect(needsAnimationFrame()).toBe(false);
   const second=visible(root),oldInterval=takeDelay(5000);
   setSeconds(7);expect(cancelled(oldInterval)).toBe(true);
   await completeDelay(oldInterval);expect(visible(root)).toBe(second);
   frame();const hidden=takeDelay(7000);
   setActive(false);expect(cancelled(hidden)).toBe(true);expect(needsAnimationFrame()).toBe(false);
   await completeDelay(hidden);expect(visible(root)).toBe(second);
   setActive(true);frame();const background=takeDelay(7000);
   events.push({t:'lifecycle',state:'background'});__pumpPodEvents();
   expect(cancelled(background)).toBe(true);expect(needsAnimationFrame()).toBe(false);
   await completeDelay(background);expect(visible(root)).toBe(second);
   events.push({t:'lifecycle',state:'active'});__pumpPodEvents();
   frame();const resumed=takeDelay(7000);await completeDelay(resumed);
   expect(visible(root)).not.toBe(second);frame();
   const cleanup=takeDelay(7000);dispose();expect(cancelled(cleanup)).toBe(true);
   await completeDelay(cleanup);expect(frames.size).toBe(0);
 }finally{dispose();events.push({t:'lifecycle',state:'active'});__pumpPodEvents();await pump();}
});

if(mode==='saved')test('automatic book paging sleeps through an unloaded final chunk and resumes on its first page',async()=>{
 let release!:(text:string)=>void,requested=false,dispose!:()=>void,handle!:import('../src/ui/ReaderBody.tsx').ReaderBodyHandle;
 const imported={handle:{marker:'watchrss-watch-content:page-delay.txt',byteLength:2000,chunkBytes:1000,chunkCount:2},
   read:async(i:number)=>{if(!i)return 'First chunk';requested=true;return new Promise<string>(resolve=>release=resolve);}};
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'706',text:'',blocks:[],imported,preset,
   width:233,height:233,pageMode:true,fontSize:16,lineHeight:24,active:true,autoStart:true,speed:1,
   onMedia(){},onControls(){},onError:v=>errors.push(v),ref:v=>handle=v});});
 const frame=()=>{for(const cb of frames)cb();};
 try{
   await until(()=>!!handle.ready?.()&&pending.size===0&&requests.length===0);
   frame();await completeDelay(takeDelay(5000));
   expect(requested).toBe(true);expect(handle.playing()).toBe(true);
   frame();expect(needsAnimationFrame()).toBe(false);
   expect(requests.filter(req=>req.method==='runtime.delay'&&req.args.milliseconds===5000)).toHaveLength(0);
   release('Final chunk. '+'Many more words. '.repeat(100));
   await until(()=>visible(root).includes('Final chunk'));
   const first=visible(root);frame();expect(needsAnimationFrame()).toBe(false);
   await completeDelay(takeDelay(5000));expect(visible(root)).not.toBe(first);
 }finally{dispose();await pump();}
});

if(perfText)test('book turn presents all target lines within 120 ms after the same reading dwell',async()=>{
 const {paginateBook}=await import('../src/reader/pagination.ts');
 const {systemTextResourceCounts}=await import('@podjs/framework/text');
 const content=Array.from({length:12},(_,i)=>({type:'text' as const,style:'body' as const,text:`章节 ${i} `+'长篇阅读排版样张'.repeat(12)}));
 const options={width:233,height:233,round:true,fontSize:14,preset,measure:hostOps.measureText,header:[48]};
 const pages=paginateBook(content,options);
 const targetLines=pages[1]!.lines.flatMap(line=>line.row.kind==='text'?[line.row.text]:[]);
 expect(targetLines.length).toBeGreaterThanOrEqual(7);
 let dispose!:()=>void,handle:any;
 try{
  createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{
   articleId:'perf-text',text:content.map(b=>b.text).join('\n'),blocks:content,preset,width:233,height:233,top:0,
   pageMode:true,fontSize:14,lineHeight:24,active:true,autoStart:false,speed:1,
   header:[{height:48,render:()=>createComponent(element('Text') as any,{children:'章节首页'})}],
   onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>handle=v,
  });});
  await until(()=>handle.ready()&&[...gestures].some((g:any)=>g.onTap));
  const dwell=performance.now()+105;
  while(performance.now()<dwell)await pump();
  const presented=new Map<number,string>();
  const readDeliveries=()=>{
   for(const [node,id] of images){
    if(typeof node!=='number'||typeof id!=='number')continue;
    if(id===-1)presented.delete(node);
    else if(textureTexts.has(id))presented.set(node,textureTexts.get(id)!);
   }
   images.length=0;
  };
  readDeliveries();
  const preparedAtTurn=[...textureTexts.values()].filter(value=>targetLines.includes(value)).length;
  const start=performance.now();
  ([...gestures].find((g:any)=>g.onTap) as any).onTap({x:215,y:110});
  await until(()=>{
   readDeliveries();
   const expected=[...targetLines];
   for(const text of presented.values()){const index=expected.indexOf(text);if(index!==-1)expected.splice(index,1);}
   return expected.length===0;
  });
  const latency=performance.now()-start;
  const pssKiB=Number(/Pss:\s+(\d+)/.exec(await Bun.file('/proc/self/smaps_rollup').text())?.[1]);
  const peakRssKiB=Number(/VmHWM:\s+(\d+)/.exec(await Bun.file('/proc/self/status').text())?.[1]);
  console.log(JSON.stringify({pageLines:targetLines.length,dwellMs:105,hostRasterMs:34,preparedAtTurn,turnMs:latency,pssKiB,peakRssKiB}));
  expect(peakRssKiB).toBeLessThanOrEqual(256*1024);
  expect(latency).toBeLessThanOrEqual(120);
  events.push({t:'memory.pressure',level:1});__pumpPodEvents();
  await until(()=>systemTextResourceCounts().active===0&&systemTextResourceCounts().queued===0);
  const before=calls.filter(c=>c.method==='text.raster').length;
  for(let n=0;n<65;n++)await pump();
  expect(calls.filter(c=>c.method==='text.raster')).toHaveLength(before);
 }finally{dispose?.();await pump();}
 expect(errors).toEqual([]);
},10000);
