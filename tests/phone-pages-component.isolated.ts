import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import type {ApplicationSyncEvent} from '../src/sync/application-foreground.ts';
import type {ScrollEntry} from '../src/ui/ScrollEntries.tsx';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'phone-pages-solid',setup(builder){builder.onLoad({filter:/\/(BluetoothConnectionScreen|PhoneConnectionScreen|PhoneConnectionUnavailableScreen|round-rows)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
let nearby=true,discoveryRequests=0,discoveryPermission="granted";
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const rendered=Object.create(props);Object.defineProperty(rendered,'children',{value:props.children,enumerable:true});return {kind,props:rendered};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(props:Node['props'])=>element('View',props),Text:(props:Node['props'])=>element('Text',props)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string,slot:number)=>Array.from(text).length*(slot===23?21:slot===1?14:12)})}));
mock.module('@podjs/framework/watch',()=>({hasCapability:()=>nearby,getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'rect',safeInsets:{top:0,right:0,bottom:0,left:0}})}));
mock.module('@podjs/framework/services',()=>({discovery:{requestPermission:async()=>{discoveryRequests++;return discoveryPermission;},status:async()=>({available:true,enabled:true,permission:discoveryPermission})},rfcomm:{status:async()=>({available:true,enabled:true,permission:'granted'}),requestPermission:()=>({result:Promise.resolve('granted')})}}));
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(props:Node['props'])=>{const children=createMemo(()=>props.entries.map((entry:ScrollEntry)=>entry.render()));return element('ScrollEntries',{...props,get entries(){return props.entries;},children});}}));
mock.module('../src/ui/WatchProgressIndicator.tsx',()=>({WatchProgressIndicator:(props:Node['props'])=>element('Progress',props)}));
mock.module('../src/ui/DownloadPhoneAppDialog.tsx',()=>({DownloadPhoneAppDialog:()=>null}));
mock.module('../src/ui/MiniProgramPairingPanel.tsx',()=>({MiniProgramPairingPanel:(props:Node['props'])=>element('PairingPanel',props)}));
const {PhoneConnectionScreen}=await import('../src/ui/PhoneConnectionScreen.tsx');
const {BluetoothConnectionScreen}=await import('../src/ui/BluetoothConnectionScreen.tsx');
const {PhoneConnectionUnavailableScreen}=await import('../src/ui/PhoneConnectionUnavailableScreen.tsx');
const stops:(()=>void)[]=[];afterEach(()=>{for(const stop of stops.splice(0))stop();});
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function nodes(value:any):Node[]{if(typeof value==='function')return nodes(value());if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props' in value))return [];return [value,...nodes(value.props.children)];}
const text=(root:unknown)=>nodes(root).filter(node=>node.kind==='Text').map(node=>node.props.children);
function mount(){
 const events=new Set<(event:ApplicationSyncEvent)=>void>();let dismissed=0;
 const [active,setActive]=createSignal(true);
 const root=createRoot(stop=>{stops.push(stop);return BluetoothConnectionScreen({width:233,height:233,active,sync:{state:'listening',subscribe:fn=>{events.add(fn);return ()=>{events.delete(fn);};},refresh:async()=>{}},abilityLabel:'收藏',onUrl:()=>{},onDismiss:()=>{dismissed++;}});});
 return {root,events,setActive,dismissed:()=>dismissed,emit:(event:ApplicationSyncEvent)=>{for(const fn of events)fn(event);}};
}
test('busy layout matches native padding, spacing, fonts and indicator; result buttons retry/dismiss',async()=>{
 const f=mount();await settle();
 const scroll=nodes(f.root).find(n=>n.kind==='ScrollEntries')!;
 expect(scroll.props.padding).toBe(18);expect(scroll.props.gap).toBe(8);
 expect(text(f.root)).toContain('蓝牙同步');expect(text(f.root)).toContain('当前操作：收藏');
 const title=nodes(f.root).find(n=>n.kind==='Text'&&n.props.children==='蓝牙同步')!;expect(title.props.style).toMatchObject({fontSlot:23,lineHeight:26,textColor:'#f5f5f5'});
 const progress=nodes(f.root).find(n=>n.kind==='Progress')!;expect(progress.props).toMatchObject({size:40,strokeWidth:4,color:'#ff6026',trackColor:'#00000000'});
 expect(text(f.root)).not.toContain('重新等待');expect(text(f.root)).not.toContain('关闭');
 f.emit({type:'completed',action:'probe',success:true,message:'',count:0,received:0,applied:0});await settle();
 expect(text(f.root)).toContain('蓝牙连接成功');expect(nodes(f.root).some(n=>n.kind==='Progress')).toBe(false);
 const buttons=nodes(f.root).filter(n=>n.props.accessibilityRole==='button');expect(buttons.map(n=>n.props.accessibilityLabel)).toEqual(['重新等待','关闭']);
 buttons[1]!.props.onPress();expect(f.dismissed()).toBe(1);
 f.setActive(false);buttons[1]!.props.onPress();expect(f.dismissed()).toBe(1);
 f.setActive(true);await settle();f.emit({type:'error',message:'连接失败'});await settle();
 nodes(f.root).find(n=>n.props.accessibilityLabel==='重新等待')!.props.onPress();await settle();expect(nodes(f.root).some(n=>n.kind==='Progress')).toBe(true);
});
test('unavailable page centers adjacent text with native colors and no extra control',()=>{
 const root=createRoot(stop=>{stops.push(stop);return PhoneConnectionUnavailableScreen({width:233,height:233,message:'尚未支持'});});
 const texts=nodes(root).filter(n=>n.kind==='Text');expect(text(root)).toEqual(['暂不可用','尚未支持']);
 expect(texts[0]!.props.style).toMatchObject({insetT:96.5,height:26,fontSlot:23,lineHeight:26});
 expect(texts[1]!.props.style).toMatchObject({insetT:122.5,height:14,fontSlot:0,lineHeight:14});
 expect(texts[1]!.props.class).toContain('#b6b6b6');expect(nodes(root).some(n=>n.props.onPress)).toBe(false);
});
test('long unavailable reason wraps at safe bounds with Start alignment; empty message remains valid',()=>{
 const root=createRoot(stop=>{stops.push(stop);return PhoneConnectionUnavailableScreen({width:160,height:160,message:'这是一个用于检查安全边距的很长不可用原因'});});
 const message=nodes(root).filter(n=>n.kind==='Text')[1]!;expect(message.props.children).toContain('\n');expect(message.props.style.width).toBeLessThanOrEqual(124);expect(message.props.class).not.toContain('text-center');
 const empty=createRoot(stop=>{stops.push(stop);return PhoneConnectionUnavailableScreen({width:233,height:233,message:''});});expect(text(empty)).toEqual(['暂不可用','']);
});

test('nearby discovery permission requires an active explicit UI action and reports denial',async()=>{
 nearby=true;discoveryRequests=0;discoveryPermission='granted';const errors:string[]=[];const [active,setActive]=createSignal(true);
 const mountPhone=()=>createRoot(stop=>{stops.push(stop);return PhoneConnectionScreen({width:233,height:233,active,onError:e=>errors.push(e),ref:()=>{}});});
 const root=mountPhone();expect(discoveryRequests).toBe(0);
 expect(nodes(root).some(n=>n.props.accessibilityLabel==='启用附近手机发现')).toBe(false);
 nodes(root).find(n=>String(n.props.accessibilityLabel).startsWith('手机App连接'))!.props.onPress();
 const button=nodes(root).find(n=>n.props.accessibilityLabel==='启用附近手机发现')!;expect(button).toBeDefined();
 button.props.onPress();await settle();expect(discoveryRequests).toBe(1);expect(errors).toEqual([]);
 discoveryPermission='denied';button.props.onPress();await settle();expect(discoveryRequests).toBe(2);expect(errors).toEqual(['请允许附近设备发现权限后重试']);
 setActive(false);button.props.onPress();await settle();expect(discoveryRequests).toBe(2);
 setActive(true);nearby=false;const plain=mountPhone();nodes(plain).find(n=>String(n.props.accessibilityLabel).startsWith('手机App连接'))!.props.onPress();expect(nodes(plain).some(n=>n.props.accessibilityLabel==='启用附近手机发现')).toBe(false);nearby=true;
});

test('landing starts nothing by itself; scan opens the pairing page and the download code stays folded away',async()=>{
 nearby=true;const [active]=createSignal(true);
 const root=createRoot(stop=>{stops.push(stop);return PhoneConnectionScreen({width:233,height:233,active,onError:()=>{},ref:()=>{}});});
 expect(nodes(root).some(n=>n.kind==='PairingPanel')).toBe(false);
 expect(nodes(root).some(n=>n.props.accessibilityLabel==='下载手机端App')).toBe(false);
 nodes(root).find(n=>String(n.props.accessibilityLabel).startsWith('手机App连接'))!.props.onPress();
 expect(nodes(root).some(n=>n.props.accessibilityLabel==='下载手机端App')).toBe(true);
 nodes(root).find(n=>String(n.props.accessibilityLabel).startsWith('微信扫码连接'))!.props.onPress();
 expect(nodes(root).some(n=>n.kind==='PairingPanel')).toBe(true);
});
