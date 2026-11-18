import {expect,test,mock} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
import * as universal from 'solid-js/universal';
const {createComponent,createMemo,createRoot,createSignal,createRenderEffect,mergeProps,onCleanup}=solid;
// File-linked SDK and app use the same Solid owner graph, as the production compiler does.
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@podjs/framework/windowed-list',import.meta.dir)),()=>solid);
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@pocketjs/framework/renderer',import.meta.dir)),()=>solid);
mock.module(Bun.resolveSync('solid-js/universal',Bun.resolveSync('@pocketjs/framework/renderer',import.meta.dir)),()=>universal);
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'note-production-solid',setup(builder){builder.onLoad({filter:/\.tsx$/},async({path})=>({loader:'js',contents:transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code}));}});
type Node={kind:string;props:any};let nextNode=1;
const element=(kind:string)=>(props:any)=>{props.ref?.({id:nextNode++});const children='children' in props?createMemo(()=>props.children):undefined;return {kind,props:children?mergeProps(props,{get children(){return children();}}):props};};


const frames=new Set<()=>void>(),gestures=new Set<unknown>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void)=>{frames.add(cb);onCleanup(()=>frames.delete(cb));}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:unknown)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));},cancelActiveTouches(){}}));
const {createScrollerWith}=await import(new URL('./kinetics-core.ts','file://'+Bun.resolveSync('@pocketjs/framework/kinetics',import.meta.dir)).href);
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(options:any)=>createScrollerWith(createSignal,options),bindDpadScroll(){}}));
mock.module('@pocketjs/framework/input',()=>({pressNode(){},hitNode(){},dispatchAccessibilityAction(){}}));
const images:unknown[][]=[];
let measureCalls=0;const hostOps=new Proxy({createNode:()=>nextNode++,measureText:(s:string)=>{measureCalls++;return s.length*7;},setImage:(id:number,handle:number)=>images.push([id,handle]),freeTexture:(handle:number)=>images.push(['free',handle])},{get:(target,key)=>Reflect.get(target,key)??(()=>{})});
for(const path of new Set([Bun.resolveSync('@pocketjs/framework/host',import.meta.dir),Bun.resolveSync('@pocketjs/framework/host',Bun.resolveSync('@podjs/framework/image',import.meta.dir))])){const real=await import(path);real.installHost({ops:hostOps,kind:'injected',target:'test',strict:true});mock.module(path,()=>({...real,getOps:()=>hostOps}));}
mock.module('../src/ui/reader-fonts.ts',()=>({useReaderFonts:()=>()=>undefined}));
mock.module('../src/ui/NoteInlineEditor.tsx',()=>({NoteInlineEditor:element('Editor')}));
mock.module('../src/ui/ReaderBackground.tsx',()=>({ReaderBackground:()=>null,useReaderBackgrounds:()=>()=>({state:{presets:[],assets:[]},revision:0})}));
mock.module('../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:element('Download')}));
mock.module('../src/ui/DeleteConfirmDialog.tsx',()=>({DeleteConfirmDialog:element('Delete')}));
const errors:unknown[][]=[];
mock.module('../src/logs/app-logger.ts',()=>({createLogConsole:()=>({info(){},warn(...args:unknown[]){errors.push(args);},error(...args:unknown[]){errors.push(args);}}),appLogger:{d(){},i(){},w(){},e(){}}}));

const mode=String('windowed-native');
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
for(const name of ['lifecycle','gesture','kinetics','input']){const boundary=await import('@pocketjs/framework/'+name);mock.module(Bun.resolveSync('@pocketjs/framework/'+name,Bun.resolveSync('@podjs/framework/image',import.meta.dir)),()=>boundary);}
const {bindPocketServicePump}=await import('@podjs/framework/testing/bun-runtime');
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const renderer=await import('@pocketjs/framework/renderer');renderer.setStyleResolver(()=>0);
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
 }else throw Error('Unexpected fixture request '+req.method);
 pending.set(req.id,setTimeout(()=>{pending.delete(req.id);events.push({t:'service.result',id:req.id,ok:true,value});__pumpPodEvents();},ms));
 }__pumpPodEvents();await new Promise(resolve=>setTimeout(resolve,2));}
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'children'in value?[value,...nodes(value.children)]:[];
const visible=(root:any)=>nodes(root).map(n=>n.text??'').join('');
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()&&Date.now()<end)await pump();expect(check()).toBe(true);}
test(`default ReaderBody slices entry, preserves saved geometry and cancels late work: ${mode}`,async()=>{
 let dispose!:()=>void,handle:any;
 // No progressStore, clock, scheduler or yield injection. KV is the IO boundary.
 const root=createRoot(stop=>{dispose=stop;return createComponent(ReaderBody,{articleId:'12569',text,blocks,preset,width:233,height:193,fontSize:16,lineHeight:24,active:true,autoStart:false,speed:1,footer:mode==='prefix'?[{height:40,render:()=>createComponent(element('Text') as any,{children:'END-OF-DOCUMENT'})}]:undefined,onMedia(){},onControls(){},onError:(v:any)=>errors.push(v),ref:v=>{handle=v;}});});
 expect(measureCalls).toBe(0);expect(visible(root)).not.toContain('Paragraph-0');
 const storedBefore=storage.get('watchrss.reader.progress.12569');
 {
  await until(()=>handle.ready()&&pending.size===0&&requests.length===0);
  expect(visible(root)).toContain('long text');
  const batches=calls.filter(c=>c.method==='text.layoutBatch');expect(batches.length).toBeLessThan(6);
  for(const batch of batches)expect(batch.args.paragraphs.reduce((n:number,p:any)=>n+p.text.length,0)).toBeLessThanOrEqual(2048);
  for(let i=0;i<120;i++){handle.scroller.scrollTo(handle.scroller.offset()+150,{immediate:true});for(const cb of [...frames])cb();await pump();}
  await until(()=>pending.size===0&&requests.length===0);expect(visible(root)).toContain('long text');
  handle.scroller.scrollTo(handle.scroller.offset()+1,{immediate:true});await handle.flushProgress();
  const saved=JSON.parse(JSON.parse(storage.get('watchrss.reader.progress.12569')!));
  if(mode==='windowed-saved')expect(Math.abs(saved.textAnchor.character-progress.textAnchor.character)).toBeLessThanOrEqual(20);
  expect(errors).toEqual([]);dispose();await pump();expect(frames.size).toBe(0);expect(gestures.size).toBe(0);return;
 }

});
