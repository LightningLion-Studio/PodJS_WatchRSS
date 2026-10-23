import {test,expect,mock,spyOn} from 'bun:test';
import {plugin} from 'bun';
import * as solid from 'solid-js';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const app=resolve(import.meta.dir,'..'),fw=resolve(dirname(Bun.resolveSync('@podjs/framework/round-list',import.meta.dir)),'../../..');
const {createScrollerWith}=await import(fw+'/vendor/pocketjs/framework/src/kinetics-core.ts');
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
const fontRequire=createRequire(fw+'/vendor/pocketjs/framework/compiler/bake-font.ts');
const font=fontRequire('opentype.js').parse(await Bun.file(app+'/assets/fonts/watch_sans.ttf').arrayBuffer());
const {fontSlotInfo}=await import(fw+'/vendor/pocketjs/framework/compiler/tailwind.ts');
const measure=(s:string,slot:number)=>Array.from(s).reduce((v,c)=>v+Math.round(font.charToGlyph(c).advanceWidth*fontSlotInfo(slot).px/font.unitsPerEm),0);
plugin({name:'pairing-layout',setup(b){b.onLoad({filter:/\/(MiniProgramPairingPanel|WatchProgressIndicator|qr-code|round-rows|ScrollEntries|variable-list)\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:any;id:number};let nextNode=0,uploads=0,frees=0,timerRuns=0,timerCancels=0;
const timerQueue:Array<()=>void>=[];
const element=(kind:string,props:any):Node=>{const rendered=Object.create(props);let children=props.children;if(kind==='Text')createRenderEffect(()=>{children=props.children;});Object.defineProperty(rendered,'children',{get:()=>children,enumerable:true});const n={kind,props:rendered,id:++nextNode};props.ref?.(n);return n;};
let scene:any,emitPairing:(value:any)=>void;
const business=await import(app+'/src/ui/mini-program-pairing.ts');
mock.module(app+'/src/ui/mini-program-pairing.ts',()=>({...business,MiniProgramPairing:class{constructor(_p:any,private emit:any){emitPairing=emit;}start(){this.emit(scene);}setForeground(){}dispose(){}}}));
mock.module(app+'/src/ui/mini-program-pairing-host.ts',()=>({miniProgramPairingHostPorts:()=>({})}));
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:any)=>element('View',p),Text:(p:any)=>element('Text',p),Image:(p:any)=>element('Image',p)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:measure,uploadTexture:()=>++uploads,setImage:()=>{},freeTexture:()=>{frees++;}})}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}})}));
mock.module('@podjs/framework/services',()=>({delay:()=>{let active=true;return {result:new Promise<void>(resolve=>timerQueue.push(()=>{if(active){timerRuns++;resolve();}})),cancel(){timerCancels++;active=false;}};}}));
mock.module('@podjs/framework/service-trace',()=>({traceServiceWork:(_label:any,fn:any)=>fn()}));
mock.module(app+'/src/debug/gate.ts',()=>({debugGate:{allowed:false}}));
mock.module(app+'/src/ui/route-activity.tsx',()=>({routeActivity:()=>undefined}));
mock.module(app+'/src/navigation/activity-navigation.ts',()=>({routeMemory:()=>undefined}));
const frameCallbacks=new Set<()=>void>();
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>{}}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:(fn:()=>void)=>{frameCallbacks.add(fn);}}));
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:(o:any)=>createScrollerWith(createSignal,o),bindDpadScroll:()=>{}}));
mock.module('@pocketjs/framework/input',()=>({pressNode:()=>{},hitNode:()=>undefined}));
const frameworkBase=fw+'/packages/framework/src';
mock.module(Bun.resolveSync('solid-js',frameworkBase),()=>solid);
mock.module(Bun.resolveSync('solid-js',Bun.resolveSync('@pocketjs/framework/kinetics',frameworkBase)),()=>solid);
let listProps:any;
const {VariableList:ProductionVariableList}=await import('@podjs/framework/variable-list');
mock.module('@podjs/framework/variable-list',()=>({VariableList:(p:any)=>{listProps=p;return ProductionVariableList(p);}}));
const rectInsideCircle=(r:{x:number;y:number;width:number;height:number},c:{cx:number;cy:number;radius:number},margin:number)=>[r.x,r.x+r.width].every(x=>[r.y,r.y+r.height].every(y=>Math.hypot(x-c.cx,y-c.cy)<=c.radius-margin+1e-6));
const {MiniProgramPairingPanel}=await import(app+'/src/ui/MiniProgramPairingPanel.tsx');
const scenes=[
 {name:'confirm-masked',state:{kind:'confirm',account:'138****0000',sas:'12345678',phoneMaskedTrusted:false}},
 {name:'confirm-fallback',state:{kind:'confirm',account:'当前账号',sas:'12345678',phoneMaskedTrusted:false}},
 {name:'confirm-long-label',state:{kind:'confirm',account:'测'.repeat(24),sas:'12345678',phoneMaskedTrusted:false}},
 {name:'cancelled',state:{kind:'cancelled'}},
 {name:'paused',state:{kind:'paused'}},
 ...business.PAIRING_STEPS.map(({step}:any)=>({name:'working-'+step,state:{kind:'working',step}})),
 {name:'starting',state:{kind:'starting',transport:'internet'}},
 {name:'scan',state:{kind:'scan',transport:'internet',qr:'fixture-qr',expiresAt:Date.now()+300000}},
 ...[
 ['failed-upgrade',Error('client_upgrade_required')],['failed-reregistration',Error('device_key_conflict')],
 ['failed-offline',{code:'provision_offline'}],['failed-expired',{code:'provision_expired'}],['failed-generic',Error('fixture')],
 ].map(([name,error])=>({name,state:business.pairingFailure(error,'internet',false)})),
 {name:'failed-unsupported',state:{kind:'failed',title:'暂不支持扫码配对',detail:'请更新手表上的腕上RSS后再试',suggestOther:false}},
 {name:'failed-timeout',state:{kind:'failed',title:'等待确认超时',detail:'请重新开始配对',suggestOther:false}},
 {name:'failed-disconnected',state:{kind:'failed',title:'连接已断开',detail:'请重新开始，再用手机扫码',suggestOther:false}},
 {name:'failed-long',state:{kind:'failed',title:'手表已登录其他账号',detail:'请先在手表上退出原账号，再重新配对',suggestOther:false}},
 {name:'done-cloud',state:{kind:'done',cloudReady:true}},
 {name:'done-account-only',state:{kind:'done',cloudReady:false}},
];
function nodes(v:any):any[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v?.props)return[];return[v,...nodes(v.props.children)];}
test('a countdown tick updates its text without rebuilding the QR texture or shifting the scrolled page',async()=>{
 let time=1000000;const clock=spyOn(Date,'now').mockImplementation(()=>time);uploads=0;frees=0;timerRuns=0;timerCancels=0;timerQueue.length=0;
 scene={kind:'scan',transport:'internet',qr:'fixture-qr',expiresAt:time+300000};let stop!:()=>void,handle:any;
 const tree=createRoot(dispose=>{stop=dispose;return MiniProgramPairingPanel({width:233,height:233,active:()=>true,onClose:()=>{},ref:(v:any)=>{handle=v;}});});
 try{
  expect(uploads).toBe(1);handle.scroller.scrollTo(1e6,{immediate:true});const offset=handle.scroller.offset();
  expect(offset).toBeGreaterThan(0);
  for(let i=0;i<3;i++){time+=1000;expect(timerQueue.length).toBeGreaterThan(0);timerQueue.shift()!();await Bun.sleep(1);nodes(tree);}
  expect(timerRuns).toBe(3);expect(timerCancels).toBe(0);
  expect(uploads).toBe(1);expect(frees).toBe(0);expect(handle.scroller.offset()).toBe(offset);
  expect(nodes(tree).filter(n=>n.kind==='Text').map(n=>String(n.props.children)).join('|')).toContain('4:57');
 }finally{stop();clock.mockRestore();timerQueue.length=0;frameCallbacks.clear();}
 expect(frees).toBe(1);
});
test('a new pairing phase opens at the top after the scan page was scrolled to the bottom',()=>{
 scene={kind:'scan',transport:'internet',qr:'fixture-qr',expiresAt:Date.now()+300000};let stop!:()=>void,handle:any;
 const tree=createRoot(dispose=>{stop=dispose;return MiniProgramPairingPanel({width:233,height:233,active:()=>true,onClose:()=>{},ref:(v:any)=>{handle=v;}});});
 try{
  handle.scroller.scrollTo(1e6,{immediate:true});expect(handle.scroller.offset()).toBeGreaterThan(0);
  emitPairing({kind:'failed',title:'连接已断开',detail:'请重新开始，再用手机扫码',suggestOther:false});
  for(const frame of frameCallbacks)frame();expect(handle.scroller.offset()).toBe(0);
  expect(nodes(tree).some(n=>n.props.accessibilityLabel==='重试')).toBe(true);
 }finally{stop();timerQueue.length=0;frameCallbacks.clear();}
});
test('the real starting indicator occupies its declared visible bounds with the native default row flex direction',()=>{
 scene={kind:'starting',transport:'internet'};let stop!:()=>void,handle:any;
 const tree=createRoot(dispose=>{stop=dispose;return MiniProgramPairingPanel({width:233,height:233,active:()=>true,onClose:()=>{},ref:(v:any)=>{handle=v;}});});
 try{
  let path:any[]=[];
  function find(v:any,ancestors:any[]=[]):void{
   if(typeof v==='function'){find(v(),ancestors);return;}if(Array.isArray(v)){v.forEach(n=>find(n,ancestors));return;}if(!v?.props)return;
   const current=[...ancestors,v];if(v.props.accessibilityState?.busy){path=current;return;}find(v.props.children,current);
  }
  find(tree);expect(path.length).toBeGreaterThan(0);
  const at=path.findIndex(n=>n.props.style?.insetL===18&&n.props.style?.insetR===18);
  expect(at).toBeGreaterThanOrEqual(0);
  let box={x:18,y:path[at].props.style.insetT-handle.scroller.offset(),width:197,height:40};
  for(let i=at+1;i<path.length;i++){
   const parent=path[i-1].props,p=path[i].props,cls=String(p.class??''),pc=String(parent.class??''),st=p.style??{};
   const width=st.width??box.width,height=st.height??box.height,absolute=/\babsolute\b/.test(cls),column=/\bflex-col\b/.test(pc);
   // PocketJS layout.rs defaults to Row: items-center is vertical alignment,
   // while justify-center is horizontal alignment for in-flow children.
   const x=st.insetL??(!absolute&&(column?/\bitems-center\b/:/\bjustify-center\b/).test(pc)?(box.width-width)/2:0);
   const y=st.insetT??(!absolute&&(column?/\bjustify-center\b/:/\bitems-center\b/).test(pc)?(box.height-height)/2:0);
   box={x:box.x+x,y:box.y+y,width,height};
  }
  const b=listProps.entries[0].visibleBounds??listProps.entries[0].bounds;
  expect(box).toEqual({x:18+b.x,y:path[at].props.style.insetT-handle.scroller.offset()+b.y,width:b.width,height:b.height});
  expect(rectInsideCircle(box,{cx:116.5,cy:116.5,radius:116.5},2)).toBe(true);
 }finally{stop();frameCallbacks.clear();}
});
for(const item of scenes.filter(s=>s.name!=='scan'))test(`production pairing ${item.name}: first/top and last/bottom visible row bounds fit without page spacers`,()=>{
 scene=item.state;let stop!:()=>void,handle:any;
 const tree=createRoot(dispose=>{stop=dispose;return MiniProgramPairingPanel({width:233,height:233,active:()=>true,onClose:()=>{},ref:(v:any)=>{handle=v;}});});
 try{
  expect(listProps.round).toMatchObject({width:233,height:233});expect(handle.roundInsets().unfit).toEqual([]);
  const renderedRows=()=>nodes(tree).filter(n=>n.kind==='View'&&n.props.style?.insetL===18&&n.props.style?.insetR===18&&typeof n.props.style?.insetT==='number');
  for(const end of [false,true]){
   handle.scroller.scrollTo(end?1e6:0,{immediate:true});
   const entry=end?listProps.entries.at(-1):listProps.entries[0],row=end?renderedRows().at(-1):renderedRows()[0];
   const bounds=entry.visibleBounds??entry.bounds??{x:0,y:0,width:197,height:entry.height};
   const y=row.props.style.insetT-handle.scroller.offset()+bounds.y;
   expect(rectInsideCircle({x:18+bounds.x,y,width:bounds.width,height:bounds.height},{cx:116.5,cy:116.5,radius:116.5},2)).toBe(true);
  }
 }finally{stop();frameCallbacks.clear();}
});

for(const cloudReady of [true,false])test(`pairing completion cloudReady=${cloudReady}: done invokes the home callback`,()=>{
 scene={kind:'done',cloudReady};let stop!:()=>void,done=0,closed=0;
 const tree=createRoot(dispose=>{stop=dispose;return MiniProgramPairingPanel({width:233,height:233,active:()=>true,onClose:()=>closed++,onDone:()=>done++,ref:()=>{}});});
 try{
  const button=nodes(tree).find(n=>n.props.accessibilityLabel==='完成'&&n.props.accessibilityRole==='button');
  expect(button).toBeDefined();button.props.onPress();expect(done).toBe(1);expect(closed).toBe(0);
 }finally{stop();frameCallbacks.clear();}
});
