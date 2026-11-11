import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'pairing-completion-solid',setup(builder){builder.onLoad({filter:/\/(MiniProgramPairingPanel|round-rows)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const rendered=Object.create(props);Object.defineProperty(rendered,'children',{value:props.children,enumerable:true});return{kind,props:rendered};};
mock.module('../src/ui/mini-program-pairing-host.ts',()=>({miniProgramPairingHostPorts:()=>({})}));
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:Node['props'])=>element('View',p),Text:(p:Node['props'])=>element('Text',p),Image:(p:Node['props'])=>element('Image',p)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>Array.from(s).length*14})}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,density:2,shape:'round'})}));
mock.module('@podjs/framework/services',()=>({delay:()=>({result:new Promise(()=>{}),cancel(){}})}));
mock.module('@podjs/framework/qr',()=>({QRCode:()=>null,qrPixels:()=>{throw Error('completion must not generate a QR');}}));
let entries:any[]=[];
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(p:Node['props'])=>{entries=p.entries;p.ref?.({scroller:{scrollTo(){}}});return element('ScrollEntries',p);}}));
mock.module('../src/ui/WatchProgressIndicator.tsx',()=>({WatchProgressIndicator:()=>null}));
const {MiniProgramPairingPanel}=await import('../src/ui/MiniProgramPairingPanel.tsx');
import type {PairingPorts} from '../src/ui/mini-program-pairing';
const qr='wrss-pair:'+Buffer.from(JSON.stringify({sessionId:'s',deviceId:'d',installId:'i',secret:Buffer.alloc(32).toString('base64')})).toString('base64url');
test('SAS renders and reactive row updates retain the owned session until explicit back',async()=>{
 const calls:{method:string;args:Record<string,unknown>}[]=[];
 let receive!:(value:any)=>void,back!:()=>boolean,dispose!:()=>void;
 const timers:{ms:number;fn:()=>void;live:boolean}[]=[];
 const [active,setActive]=createSignal(true),[width,setWidth]=createSignal(233);
 const ports:PairingPorts={available:()=>true,identity:async()=>({deviceId:'d',installId:'i'}),now:()=>0,
  after:(ms,fn)=>{const timer={ms,fn,live:true};timers.push(timer);return()=>{timer.live=false;};},
  op:<T>(method:string,args:Record<string,unknown>)=>{calls.push({method,args});return{result:(method==='provision.start'?Promise.resolve({qr,sessionId:'s'}):method==='provision.receive'?new Promise(resolve=>{receive=resolve;}):Promise.resolve({})) as Promise<T>,cancel(){}};},
  handler:async({confirm})=>({handle:async()=>{void confirm('synthetic','12345678');return{success:true};}})};
 const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 createRoot(stop=>{dispose=stop;return MiniProgramPairingPanel({get width(){return width();},height:233,active,ports,onClose(){},ref:value=>{back=value.onRootBack;}});});
 try{
  await settle();receive({action:'prepare',_sequence:0});await settle();
  // Rebuild rows and rerun the activity effect while the page remains current.
  setWidth(240);setActive(true);await settle();
  expect(calls.filter(c=>c.method==='provision.start')).toHaveLength(1);
  expect(calls.filter(c=>c.method==='provision.close')).toHaveLength(0);
  expect(timers.filter(t=>t.live&&t.ms===90_000)).toHaveLength(1);
  expect(back()).toBe(true);await settle();
  expect(calls.filter(c=>c.method==='provision.close').map(c=>c.args.reason)).toEqual(['user_back']);
 }finally{dispose();}
});
