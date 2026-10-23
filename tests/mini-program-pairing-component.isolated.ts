import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'pairing-completion-solid',setup(builder){builder.onLoad({filter:/\/(MiniProgramPairingPanel|round-rows)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const rendered=Object.create(props);Object.defineProperty(rendered,'children',{value:props.children,enumerable:true});return{kind,props:rendered};};
let cloudReady=true,events:string[]=[],entries:any[]=[];
const business=await import('../src/ui/mini-program-pairing.ts');
mock.module('../src/ui/mini-program-pairing.ts',()=>({...business,MiniProgramPairing:class{
 constructor(_ports:unknown,private changed:(s:unknown)=>void){}
 start(){this.changed({kind:'done',cloudReady});}setForeground(){}dispose(){events.push('dispose');}
}}));
mock.module('../src/ui/mini-program-pairing-host.ts',()=>({miniProgramPairingHostPorts:()=>({})}));
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:Node['props'])=>element('View',p),Text:(p:Node['props'])=>element('Text',p),Image:(p:Node['props'])=>element('Image',p)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>Array.from(s).length*14})}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,density:2,shape:'round'})}));
mock.module('@podjs/framework/services',()=>({delay:()=>{throw Error('completion must not start a timer');}}));
mock.module('@podjs/framework/qr',()=>({QRCode:()=>null,qrPixels:()=>{throw Error('completion must not generate a QR');}}));
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(p:Node['props'])=>{entries=p.entries;return element('ScrollEntries',p);}}));
mock.module('../src/ui/WatchProgressIndicator.tsx',()=>({WatchProgressIndicator:()=>null}));
const {MiniProgramPairingPanel}=await import('../src/ui/MiniProgramPairingPanel.tsx');
function mount(onDone?:(()=>void)){
 const [active,setActive]=createSignal(true);let dispose!:()=>void;
 createRoot(stop=>{dispose=stop;return MiniProgramPairingPanel({width:233,height:233,active,onClose:()=>events.push('close'),onDone,ref:()=>{}});});
 const done=entries.map(e=>e.render()).find((n:Node)=>n?.props.accessibilityLabel==='完成') as Node;
 expect(done).toBeDefined();return{done,setActive,dispose};
}
for(const ready of [true,false])test(`completion (${ready?'cloud ready':'account only'}) invokes onDone home action after disposing, not onClose`,()=>{
 cloudReady=ready;events=[];const f=mount(()=>events.push('goHome'));
 try{f.setActive(false);f.done.props.onPress();expect(events).toEqual([]);f.setActive(true);f.done.props.onPress();expect(events).toEqual(['dispose','goHome']);}finally{f.dispose();}
});
test('completion keeps the ordinary close fallback when no home callback was supplied',()=>{
 events=[];const f=mount();try{f.done.props.onPress();expect(events).toEqual(['dispose','close']);}finally{f.dispose();}
});
