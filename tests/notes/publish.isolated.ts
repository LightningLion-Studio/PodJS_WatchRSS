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
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect,// Preserve the imperative text scene at the same native renderer boundary.
createElement:(tag:string)=>{const children:any[]=[];return {id:nextNode++,kind:tag==='text'?'Text':tag==='image'?'Image':'View',nativeChildren:children,props:{get children(){return children.map(child=>child.read?child.read():child);}}};},
insertNode:(parent:any,child:any)=>parent.nativeChildren.push(child),
insert:(parent:any,read:()=>unknown)=>{const child=createMemo(read);parent.nativeChildren.push({read:child});},
setProp:(node:any,key:string,value:unknown)=>{node.props[key]=value;}}));
mock.module('@pocketjs/framework/components',()=>({View:element('View'),Text:element('Text'),Image:element('Image')}));
const frames=new Set<()=>void>(),gestures=new Set<unknown>();
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(cb:()=>void)=>{frames.add(cb);onCleanup(()=>frames.delete(cb));}}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:(opts:unknown)=>{gestures.add(opts);onCleanup(()=>gestures.delete(opts));},cancelActiveTouches(){}}));
const {createScrollerWith}=await import(new URL('./kinetics-core.ts','file://'+Bun.resolveSync('@pocketjs/framework/kinetics',import.meta.dir)).href);
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(options:any)=>createScrollerWith(createSignal,options),bindDpadScroll(){}}));
mock.module('@pocketjs/framework/input',()=>({pressNode(){},hitNode(){},dispatchAccessibilityAction(){}}));
const images:unknown[][]=[];
const hostOps={measureText:(s:string)=>s.length*7,setImage:(id:number,handle:number)=>images.push([id,handle]),freeTexture:(handle:number)=>images.push(['free',handle])};
for(const path of new Set([Bun.resolveSync('@pocketjs/framework/host',import.meta.dir),Bun.resolveSync('@pocketjs/framework/host',Bun.resolveSync('@podjs/framework/image',import.meta.dir))])){const real=await import(path);real.installHost({ops:hostOps,kind:'injected',target:'test',strict:true});mock.module(path,()=>({...real,getOps:()=>hostOps}));}
mock.module('../../src/ui/reader-fonts.ts',()=>({useReaderFonts:()=>()=>undefined}));
mock.module('../../src/ui/NoteInlineEditor.tsx',()=>({NoteInlineEditor:element('Editor')}));
mock.module('../../src/ui/ReaderBackground.tsx',()=>({ReaderBackground:element('Background')}));
mock.module('../../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:element('Download')}));
mock.module('../../src/ui/DeleteConfirmDialog.tsx',()=>({DeleteConfirmDialog:element('Delete')}));
const errors:unknown[][]=[];
mock.module('../../src/logs/app-logger.ts',()=>({createLogConsole:()=>({info(){},warn(...args:unknown[]){errors.push(args);},error(...args:unknown[]){errors.push(args);}}),appLogger:{d(){},i(){},w(){},e(){}}}));
const requests:any[]=[],events:any[]=[],calls:any[]=[];
(globalThis as any).pod={
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(line:string)=>{const req=JSON.parse(line);calls.push(req);if(req.t==='service.request')requests.push(req);else if(req.t==='service.cancel'){const timer=timers.get(req.id);if(timer&&timerMethods.get(req.id)==='runtime.delay'){clearTimeout(timer);timers.delete(req.id);}}},
 capabilities:()=>JSON.stringify(['runtime.timer','data.images','data.files.chunks','text.layout','text.raster']),
 displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),
 kvGet:()=>undefined,kvSet:()=>0,kvDelete:()=>0,kvKeys:()=> '[]',uploadTextureFile:()=>41,
};
for(const name of ['renderer','components','lifecycle','gesture','kinetics','input']){const boundary=await import('@pocketjs/framework/'+name);mock.module(Bun.resolveSync('@pocketjs/framework/'+name,Bun.resolveSync('@podjs/framework/image',import.meta.dir)),()=>boundary);}
const {bindPocketServicePump}=await import('@podjs/framework/testing/bun-runtime');
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
const {defaultReaderPreset}=await import('../../src/reader/preset.ts');
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {NoteDetailScreen}=await import('../../src/ui/NotesScreen.tsx');
const {releaseRetainedRemoteImages,remoteImageResourceCounts}=await import('../../src/ui/RemoteImage.tsx');
const nodes=(value:any):Node[]=>typeof value==='function'?nodes(value()):Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props'in value?[value,...nodes(value.props.children)]:[];
const timers=new Map<number,ReturnType<typeof setTimeout>>();
let batchNumber=0,headerBatches=0;const timerMethods=new Map<number,string>();
const delivery:string[]=[];
const reply=(req:any,value:any,ms:number)=>{timerMethods.set(req.id,req.method);timers.set(req.id,setTimeout(()=>{timers.delete(req.id);delivery.push(req.method);events.push({t:'service.result',id:req.id,ok:true,value});__pumpPodEvents();},ms));};
const paragraph=(args:any)=>({lines:[{start:0,end:args.text.length,visibleEnd:args.text.length,topPx:0,bottomPx:40,baselinePx:30}]});
async function pump(){for(let i=0;i<8;i++)await Promise.resolve();for(const req of requests.splice(0)){
 if(req.method==='text.layout'){reply(req,paragraph(req.args),req.args.text==='README'?35:1);continue;}
 if(req.method==='text.layoutBatch'){const header=req.args.paragraphs[0]?.text==='README';if(header){headerBatches++;expect(req.args.paragraphs).toHaveLength(2);expect(req.args.paragraphs[0]).toMatchObject({widthPx:380,align:'center'});expect(req.args.paragraphs[1].widthPx).toBe(410);}reply(req,{results:req.args.paragraphs.map(paragraph)},header?35:[40,1,20][batchNumber++%3]);continue;}
 if(req.method==='text.raster'){reply(req,{path:'text/local.rgba',width:512,height:64,carets:Array(req.args.text.length+1).fill(0)},1);continue;}
 if(req.method==='runtime.delay'){if(req.args.milliseconds<1||req.args.milliseconds>120000){events.push({t:'service.result',id:req.id,ok:false,code:'invalid_argument',message:'Timer delay must be 1..120000ms'});}else reply(req,null,req.args.milliseconds);continue;}
 let value:unknown=null;
 if(req.method==='image.decode')value={path:'images/local.rgba',width:2,height:1,sourceWidth:400,sourceHeight:200};
 else if(req.method==='file.delete')value={deleted:true};
 else throw Error(req.method);
 events.push({t:'service.result',id:req.id,ok:true,value});
 }__pumpPodEvents();await new Promise(resolve=>setTimeout(resolve,2));}
const markdown=process.env.WRSS_NOTE_FIXTURE?await Bun.file(process.env.WRSS_NOTE_FIXTURE).text():'# hymission\n\n![4024](assets/local.jpg)\n\n'+Array.from({length:24},(_,i)=>`Paragraph ${i} ${'long text 中 '.repeat(60)}\n\n| Option | Default |\n|---|---|\n| foo | bar |\n`).join('\n');
const note=()=>({noteId:'fixture',folderId:null,title:'README',markdown,plainText:'fixture',contentHash:'h',baseContentHash:'h',baseMarkdown:'',pinned:false,createdAt:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0});
async function until(check:()=>boolean){const end=Date.now()+3500;while(!check()&&Date.now()<end)await pump();expect(check()).toBe(true);}
const visibleText=(root:any)=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('');
const mode=process.env.NOTE_PUBLISH_CASE??'first';
test(`production note publishes with valid host timers and delayed native replies: ${mode}`,async()=>{
 let dispose!:()=>void,handle:any;
 const [active,setActive]=createSignal(mode!=='entry'),[refresh,setRefresh]=createSignal(0);
 const mount=()=>createRoot(stop=>{dispose=stop;return createComponent(NoteDetailScreen,{width:233,height:233,noteId:'fixture',preset:defaultReaderPreset(),repository:{get:async()=>note()} as never,input:async()=>null,onBack(){},get active(){return active();},get refreshKey(){return refresh();},ref:value=>handle=value});});
 let root=mount();for(let i=0;i<8;i++)await Promise.resolve();
 expect(visibleText(root)).toContain('README');expect(calls.some(c=>c.method==='image.decode')).toBe(false);
 if(mode==='entry'){
  expect(calls.some(c=>c.method==='runtime.delay')).toBe(false);setActive(true);
  // Pause while the source parse is still pending, then resume it.
  await pump();setActive(false);await pump();setActive(true);
 }
 if(mode==='late'){
  // Native body and header share host turns. Leave while their replies are
  // pending; old native replies still arrive after reactivation and are ignored.
  await until(()=>calls.some(c=>c.method==='text.layoutBatch'&&c.args.paragraphs[0]?.text!=='README'));
  setActive(false);await pump();setActive(true);
  expect(calls.some(c=>c.t==='service.cancel')).toBe(true);
 }
 await until(()=>calls.some(c=>c.method==='image.decode'));
 if(mode==='first')expect(batchNumber).toBe(0); // first screen precedes all full body batches
 await until(()=>timers.size===0&&requests.length===0);
 expect(errors).toEqual([]);
 expect(calls.filter(c=>c.method==='image.decode')).toHaveLength(1);
 expect(calls.find(c=>c.method==='image.decode').args.path).toMatch(/^notes\/assets\//);
 expect(calls.some(c=>c.method==='file.read'||c.method==='http.request')).toBe(false);
 expect(images.some(call=>call[1]===41)).toBe(true);
 expect(visibleText(root)).toContain('hymission');expect(batchNumber).toBeGreaterThan(1);
 expect(calls.find(c=>c.method==='text.raster'&&c.args.text==='README')?.args).toMatchObject({widthPx:380,align:'center',paragraph:{widthPx:380,align:'center'}});
 expect(delivery).toContain('text.layoutBatch');expect(headerBatches).toBeGreaterThan(0);expect(calls.some(c=>c.method==='text.layout')).toBe(false);
 expect(calls.filter(c=>c.method==='runtime.delay').every(c=>c.args.milliseconds>=1&&c.args.milliseconds<=120000)).toBe(true);
 handle.scroller.scrollTo(200,{immediate:true});expect(handle.scroller.offset()).toBe(200);
 setActive(false);await pump();setActive(true);
 await until(()=>timers.size===0&&requests.length===0);
 expect(handle.scroller.offset()).toBe(200);
 // Same source loaded again must retain ready source and publish fresh native
 // geometry without dropping the body or repeatedly decoding the image.
 setRefresh(1);await pump();await until(()=>timers.size===0&&requests.length===0);
 expect(handle.scroller.offset()).toBe(200);expect(calls.filter(c=>c.method==='image.decode')).toHaveLength(1);
 dispose();releaseRetainedRemoteImages();await pump();
 expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
 if(mode==='revisit'){
  calls.length=0;setActive(true);root=mount();
  await until(()=>calls.some(c=>c.method==='image.decode'));await until(()=>timers.size===0&&requests.length===0);
  expect(visibleText(root)).toContain('hymission');expect(errors).toEqual([]);
  dispose();releaseRetainedRemoteImages();await pump();expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});
 }
});
