import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
const {createComponent,createMemo,createRoot,createSignal,createRenderEffect,mergeProps}=solid;
const textPath=Bun.resolveSync('@podjs/framework/text',import.meta.dir);
mock.module(Bun.resolveSync('solid-js',textPath),()=>solid);
const require=createRequire(import.meta.url);
plugin({name:'paged-prefetch-components',setup(b){b.onLoad({filter:/\/(ReaderBookPage|ReaderTextRow)\.tsx$/},async({path})=>({loader:'js',contents:require('@babel/core').transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code}));}});
type Node={id:number;kind:string;props:any;children:any[]};let id=0;
const node=(kind:string,props:any={}):Node=>({id:++id,kind,props,children:[]});
const renderer={createComponent,mergeProps,memo:createMemo,effect:createRenderEffect,createElement:node,insertNode:(p:Node,c:Node)=>p.children.push(c),insert:(p:Node,read:()=>unknown)=>{const index=p.children.length;p.children.push(undefined);createRenderEffect(()=>{p.children[index]=read();});},setProp:(n:Node,key:string,v:unknown)=>n.props[key]=v};
const component=(kind:string)=>(props:any)=>{const n=node(kind,props);props.ref?.(n);if('children'in props)createRenderEffect(()=>n.children=[props.children]);return n;};
const images:[number,number][]=[],freed:number[]=[],requests:{options:any;resolve:(v:any)=>void}[]=[];let uploads=0;
const host={getOps:()=>({measureText:(s:string)=>s.length*7,setImage:(n:number,h:number)=>images.push([n,h]),freeTexture:(h:number)=>freed.push(h)})};
const services={textRaster:{line:(options:any)=>{let resolve!:(v:any)=>void;const result=new Promise(yes=>resolve=yes);requests.push({options,resolve});return{result,cancel(){}};}},fileChunks:{remove:async()=>{}},base64ToBytes:()=>{throw Error('expected direct texture file');},hasTextureFileUpload:()=>true,uploadTextureFile:()=>900+uploads++};
for(const base of [import.meta.dir,textPath]){
 mock.module(Bun.resolveSync('@pocketjs/framework/renderer',base),()=>renderer);
 mock.module(Bun.resolveSync('@pocketjs/framework/components',base),()=>({View:component('view'),Text:component('text'),Image:component('image')}));
 mock.module(Bun.resolveSync('@pocketjs/framework/host',base),()=>host);
}
mock.module(new URL('./services.ts','file://'+textPath).pathname,()=>services);
mock.module('@pocketjs/framework/gesture',()=>({createGesture(){},cancelActiveTouches(){}}));
mock.module('@pocketjs/framework/input',()=>({hitNode(){},pressNode(){},dispatchAccessibilityAction(){}}));
mock.module('../src/ui/RemoteImage.tsx',()=>({RemoteImage:component('remote-image')}));
const {createSystemTextCache,prefetchSystemTextLines,systemTextResourceCounts}=await import('@podjs/framework/text');
const {ReaderBookPage}=await import('../src/ui/ReaderBookPage.tsx');
const {adjacentPageTextOptions}=await import('../src/reader/page-text-prefetch.ts');
const {defaultReaderPreset}=await import('../src/reader/preset.ts');
const environment={rasterSupported:true,pixelScale:2,fontMetrics:()=>({cellWidth:14,cellHeight:18,baseline:14,lineHeight:23,rasterDensity:2})};
const page=(text:string)=>({anchor:{section:'body' as const,character:0,blockIndex:0,sourceStart:0,sectionOffset:0},lines:[{row:{kind:'text' as const,text,top:0,height:23,lineHeight:23,gap:0,blockIndex:0,character:0,fontSlot:2,scale:1,color:'#ffffffff',nativeBaseline:18},left:12,top:12,width:128}]});
const settle=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
test('real paged rows consume prepared adjacent textures without reraster or reupload',async()=>{
 const cache=createSystemTextCache(),pages=[page('原页😀'),page('下一页龘')],preset=defaultReaderPreset(),blocks=[{type:'text' as const,style:'body' as const,text:'正文'}];
 let dispose=()=>{};const [current,setCurrent]=createSignal(pages[0]!);
 try{
  createRoot(stop=>{dispose=stop;return createComponent(ReaderBookPage,{get page(){return current();},width:233,height:233,round:true,active:true,header:[],footer:[],blocks,preset,fontSize:14,environment,cache,onTap(){},onMedia(){}});});
  expect(requests).toHaveLength(1);requests[0]!.resolve({path:'current',width:256,height:64,carets:Array.from({length:requests[0]!.options.text.length+1},(_,i)=>i*18)});await settle();
  const cancel=prefetchSystemTextLines(adjacentPageTextOptions(pages,0,blocks,14,preset,()=>({}),environment),cache);
  expect(requests).toHaveLength(2);requests[1]!.resolve({path:'next',width:256,height:64,carets:Array.from({length:requests[1]!.options.text.length+1},(_,i)=>i*20)});await settle();cancel();
  const preparedHandle=901;expect(uploads).toBe(2);setCurrent(pages[1]!);await settle();
  expect(requests).toHaveLength(2);expect(uploads).toBe(2);expect(images.at(-1)![1]).toBe(preparedHandle);
  setCurrent(pages[0]!);await settle();expect(requests).toHaveLength(2);expect(uploads).toBe(2);expect(images.at(-1)![1]).toBe(900);
 }finally{dispose();cache.close();for(const r of requests)r.resolve({path:'late',width:256,height:64,carets:[]});await settle();}
 expect(freed.sort()).toEqual([900,901]);expect(systemTextResourceCounts()).toEqual({active:0,queued:0,cached:0});
});
