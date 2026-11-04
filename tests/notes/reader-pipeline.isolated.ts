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
let delayDecode=false,missingImage=false,pendingDecode:any;
(globalThis as any).pod={
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(line:string)=>{const req=JSON.parse(line);calls.push(req);if(req.t==='service.request')requests.push(req);},
 capabilities:()=>JSON.stringify(['runtime.timer','data.images','data.files.chunks']),
 displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),
 kvGet:()=>undefined,kvSet:()=>0,kvDelete:()=>0,kvKeys:()=> '[]',uploadTextureFile:()=>41,
};
for(const name of ['renderer','components','lifecycle','gesture','kinetics','input']){const boundary=await import('@pocketjs/framework/'+name);mock.module(Bun.resolveSync('@pocketjs/framework/'+name,Bun.resolveSync('@podjs/framework/image',import.meta.dir)),()=>boundary);}
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {NoteDetailScreen}=await import('../../src/ui/NotesScreen.tsx');
const {releaseRetainedRemoteImages,remoteImageResourceCounts}=await import('../../src/ui/RemoteImage.tsx');
const nodes=(value:any):Node[]=>typeof value==='function'?nodes(value()):Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props'in value?[value,...nodes(value.props.children)]:[];
async function pump(){for(let i=0;i<8;i++)await Promise.resolve();for(const req of requests.splice(0)){
 if(req.method==='image.decode'&&delayDecode){pendingDecode=req;continue;}
 if(req.method==='image.decode'&&missingImage){events.push({t:'service.result',id:req.id,ok:false,code:'file_not_found',message:'fixture asset absent'});continue;}
 let value:unknown=null;
 if(req.method==='image.decode')value={path:'images/local.rgba',width:2,height:1,sourceWidth:400,sourceHeight:200};
 else if(req.method==='file.delete')value={deleted:true};
 else expect(req.method).toBe('runtime.delay');
 events.push({t:'service.result',id:req.id,ok:true,value});
 }__pumpPodEvents();for(let i=0;i<8;i++)await Promise.resolve();}
const note=()=>({noteId:'fixture',folderId:null,title:'README',markdown:'# hymission\n\n![4024](assets/local.jpg)\n\n'+Array.from({length:24},(_,i)=>`Paragraph ${i} ${'long text 中 '.repeat(60)}\n\n| Option | Default |\n|---|---|\n| foo | bar |\n`).join('\n'),plainText:'fixture',contentHash:'h',baseContentHash:'h',baseMarkdown:'',pinned:false,createdAt:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0});
test('actual default NoteDetailScreen yields before parse, decodes notes/assets path once and preserves scroller/resources',async()=>{
 let dispose!:()=>void,handle:any;const [active,setActive]=createSignal(true);
 const root=createRoot(stop=>{dispose=stop;return createComponent(NoteDetailScreen,{width:233,height:233,noteId:'fixture',repository:{get:async()=>note()} as never,input:async()=>null,onBack(){},get active(){return active();},ref:value=>handle=value});});
 for(let i=0;i<8;i++)await Promise.resolve();expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('')).toContain('README');
 expect(calls.some(c=>c.method==='runtime.delay')).toBe(true);
 for(let i=0;i<150;i++)await pump();
 expect(errors).toEqual([]);expect(calls.filter(c=>c.method==='image.decode'),JSON.stringify(calls)).toHaveLength(1);
 expect(calls.find(c=>c.method==='image.decode').args.path).toBe('notes/assets/local.jpg');
 expect(calls.some(c=>c.method==='file.read'||c.method==='http.request')).toBe(false);
 expect(images.some(call=>call[1]===41)).toBe(true);
 expect(remoteImageResourceCounts().active).toBe(0);
 handle.scroller.scrollTo(200,{immediate:true});expect(handle.scroller.offset()).toBe(200);
 setActive(false);setActive(true);for(let i=0;i<30;i++)await pump();expect(handle.scroller.offset()).toBe(200);
 dispose();releaseRetainedRemoteImages();await pump();expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});
test('disposal closes a pending local decode and late replies cannot upload or leave row owners',async()=>{
 delayDecode=true;calls.length=0;let dispose!:()=>void;
 createRoot(stop=>{dispose=stop;return createComponent(NoteDetailScreen,{width:233,height:233,noteId:'fixture',repository:{get:async()=>note()} as never,input:async()=>null,onBack(){}});});
 for(let i=0;i<150&&!pendingDecode;i++)await pump();expect(pendingDecode).toBeDefined();const before=images.filter(c=>c[1]===41).length;
 dispose();expect(calls.some(c=>c.t==='service.cancel'&&c.id===pendingDecode.id)).toBe(true);
 events.push({t:'service.result',id:pendingDecode.id,ok:true,value:{path:'images/late.rgba',width:2,height:1}});await pump();releaseRetainedRemoteImages();await pump();
 expect(images.filter(c=>c[1]===41).length).toBe(before);expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});

test('missing local note asset displays the existing sync failure hint instead of an empty image',async()=>{
 delayDecode=false;missingImage=true;errors.length=0;calls.length=0;let dispose!:()=>void;
 const root=createRoot(stop=>{dispose=stop;return createComponent(NoteDetailScreen,{width:233,height:233,noteId:'fixture',repository:{get:async()=>note()} as never,input:async()=>null,onBack(){}});});
 for(let i=0;i<150;i++)await pump();
 expect(nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('')).toContain('图片未同步');
 expect(calls.filter(c=>c.method==='image.decode')).toHaveLength(1);expect(errors).toHaveLength(1);
 dispose();releaseRetainedRemoteImages();await pump();expect(remoteImageResourceCounts()).toEqual({active:0,queued:0,cached:0});
 expect(frames.size).toBe(0);expect(gestures.size).toBe(0);
});
