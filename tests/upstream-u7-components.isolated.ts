import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
const fw=Bun.resolveSync('@podjs/framework/tiled-image',import.meta.dir);
mock.module(Bun.resolveSync('solid-js',fw),()=>solid);
let events:any[]=[],pending:any[]=[],nextHandle=0,nextNode=0;
const provider={acquire:(url:string)=>{events.push(['acquire',url]);return {result:Promise.resolve({path:'source',release:()=>events.push(['lease-release'])}),cancel:()=>events.push(['source-cancel'])};}};
mock.module('../src/cache/host.ts',()=>({managedCache:provider}));
mock.module('../src/ui/route-activity.tsx',()=>({routeActivity:()=>({entry:{}})}));
mock.module('../src/navigation/activity-navigation.ts',()=>({routeMemory:()=>({id:'owner'})}));
plugin({name:'u7-solid',setup(b){b.onLoad({filter:/\/(QRCode|TiledImage|qr-code|tiled-image)\.tsx(?:\.txt)?$|\/modal-input\.ts\.txt$/},async args=>{
 let source=await Bun.file(args.path).text();
 if(args.path.includes('/fixtures/'))source=source.replace('"../cache/host.ts"',JSON.stringify(import.meta.dir+'/../src/cache/host.ts')).replace("'./route-activity.tsx'",JSON.stringify(import.meta.dir+'/../src/ui/route-activity.tsx')).replace("'../navigation/activity-navigation.ts'",JSON.stringify(import.meta.dir+'/../src/navigation/activity-navigation.ts'));
 return {contents:transformSync(source,{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:!args.path.includes('modal-input'),allExtensions:true}]]}).code,loader:'js'};
});}});
type Node={id:number;kind:string;props:any};
const element=(kind:string)=>(props:any):Node=>{const p=Object.create(props);if('children'in props)Object.defineProperty(p,'children',{value:props.children,enumerable:true});const node={id:++nextNode,kind,props:p};props.ref?.(node);return node;};
const renderer={createComponent,mergeProps,memo:createMemo,effect:createRenderEffect},components={View:element('View'),Image:element('Image')};
const ops={uploadTexture:(b:Uint8Array,w:number,h:number,p:number)=>{events.push(['upload',w,h,p,Bun.hash(b).toString()]);return ++nextHandle;},uploadTextureSampled:(b:Uint8Array,w:number,h:number,p:number,s:number)=>{events.push(['sampled',w,h,p,s,b.length]);return ++nextHandle;},setImage:(id:number,h:number)=>events.push(['image',id,h]),freeTexture:(h:number)=>events.push(['free',h])};
for(const [name,impl] of Object.entries({renderer,components,host:{getOps:()=>ops}})){mock.module('@pocketjs/framework/'+name,()=>impl);mock.module(Bun.resolveSync('@pocketjs/framework/'+name,fw),()=>impl);}
class HostServiceError extends Error {constructor(public code:string){super(code);}}
const listeners:Array<(event:any)=>void>=[];
let busyDelete=false;
const services={HostServiceError,base64ToBytes:(s:string)=>new Uint8Array(Buffer.from(s,'base64')),hostOperation:(name:string,args:any)=>{
 events.push([name,args]);
 if(name==='file.delete'&&busyDelete){busyDelete=false;return {result:Promise.reject(new HostServiceError('busy')),cancel(){}};}
 if(name==='image.decode'||name==='image.decodeRegion'){
  let resolve!:(value:any)=>void;const result=new Promise(r=>{resolve=r;});pending.push({name,args,resolve});return {result,cancel:()=>events.push(['cancel',name])};
 }
 return {result:Promise.resolve({}),cancel(){}};
}};
for(const path of ['@podjs/framework/services',Bun.resolveSync('@podjs/framework/services',fw)])mock.module(path,()=>services);
for(const path of ['@podjs/framework/watch',Bun.resolveSync('@podjs/framework/watch',fw)])mock.module(path,()=>({__onHostEvent:(cb:any)=>listeners.push(cb)}));
(globalThis as any).pod={readDecodedRgba:()=>new Uint8Array(512*512*4)};
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
function snapshot(value:any):any{if(typeof value==='function')return snapshot(value());if(Array.isArray(value))return value.map(snapshot);if(!value||typeof value!=='object')return value;if('props'in value){const p=value.props,result:any={kind:value.kind};for(const k in p)if(!['ref'].includes(k))result[k]=snapshot(p[k]);return result;}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,snapshot(v)]));}
const {QRCode}=await import('../src/ui/QRCode');
const {QRCode:OldQRCode}=await import('./fixtures/upstream-u7/ui/QRCode');
const {TiledImage}=await import('../src/ui/TiledImage');
const oldTilePath='./fixtures/upstream-u7/ui/TiledImage.tsx.txt';
const {TiledImage:OldTiled}=await import(oldTilePath);
const {useModalInput}=await import('../src/ui/modal-input');
const oldInputPath='./fixtures/upstream-u7/ui/modal-input.ts.txt';
const {useModalInput:OldInput}=await import(oldInputPath);
function reset(){events=[];pending=[];nextHandle=0;nextNode=0;}
test('QR component tree, pixel padding, reactive upload and cleanup match frozen source',async()=>{
 async function run(C:typeof QRCode,pixelSize?:number){reset();let dispose!:()=>void;const [value,setValue]=createSignal('hello');const tree=createRoot(d=>{dispose=d;return C({get value(){return value();},size:233,pixelSize,nativeWatch:true,onError:e=>events.push(['error',e])});});await tick();const before=snapshot(tree);setValue('中文');await tick();dispose();return {before,events};}
 for(const size of [undefined,233,256,0,513])expect(await run(QRCode,size)).toEqual(await run(OldQRCode,size));
});
test('tiled decode, geometry, sampled upload, busy delete retry and late cleanup match frozen source',async()=>{
 async function run(C:typeof TiledImage,early:boolean){reset();let dispose!:()=>void;const tree=createRoot(d=>{dispose=d;return C({url:'https://example.test/a',geometry:{width:233,height:233,imageWidth:1200,imageHeight:1200,density:2},state:{scale:1,x:0,y:0},onSize:(...v)=>events.push(['size',...v]),onError:e=>events.push(['error',String(e)]),onVisibleTilesReady:()=>events.push(['ready'])});});await tick();
  if(early)dispose();
  pending.shift().resolve({path:'overview',width:512,height:512,sourceWidth:1200,sourceHeight:1200});await tick();
  if(!early){expect(pending.length).toBe(4);busyDelete=true;const jobs=pending.splice(0);jobs.forEach((job,i)=>job.resolve({path:'tile-'+i,width:512,height:512,contentWidth:job.args.width,contentHeight:job.args.height}));await tick();listeners.forEach(cb=>cb({t:'service.result'}));await tick();const view=snapshot(tree);dispose();for(const job of pending.splice(0))job.resolve({path:'late',width:512,height:512});await tick();expect(events.filter(e=>e[0]==='lease-release')).toHaveLength(1);return {view,events};}
  await tick();expect(events.some(e=>e[0]==='sampled')).toBe(false);expect(events.filter(e=>e[0]==='lease-release')).toHaveLength(1);return events;
 }
 for(const early of [false,true])expect(await run(TiledImage,early)).toEqual(await run(OldTiled,early));
});
test('modal pending recovery, stale epochs, errors and owner disposal match frozen source',async()=>{
 async function run(use:typeof useModalInput,mode:string){const log:any[]=[];let dispose!:()=>void,resolve!:(v:string|null)=>void,check!:(v:boolean)=>void;const [active,setActive]=createSignal(true);const open=createRoot(d=>{dispose=d;return use({key:'edit',title:'Title',value:()=> 'draft',active,input:mode==='missing'?undefined:async(...args)=>{log.push(['input',...args]);return new Promise<string|null>(r=>resolve=r);},recovery:{pending:async key=>{log.push(['pending',key]);return new Promise<boolean>(r=>check=r);},dismiss:async key=>{log.push(['dismiss',key]);}},onValue:v=>{log.push(['value',v]);if(mode==='reject')throw Error('save');},onError:e=>log.push(['error',String(e)])});});await tick();check(true);await tick();if(mode==='stale')setActive(false);if(mode==='dispose')dispose();await tick();resolve?.('result');await tick();if(mode==='stale'){setActive(true);await tick();const p=open();await tick();resolve('new');await p;}dispose();return log;}
 for(const mode of ['normal','stale','dispose','missing','reject'])expect(await run(useModalInput,mode)).toEqual(await run(OldInput,mode));
});
