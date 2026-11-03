import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import type {ScrollEntry} from '../src/ui/ScrollEntries';
import type {AccountStatusSnapshot} from '../src/account/status';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'owner-choice-production-components',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Node={kind:string;props:Record<string,any>};
const element=(kind:string,props:Node['props']):Node=>{const p=Object.create(props);Object.defineProperty(p,'children',{value:props.children,enumerable:true});return {kind,props:p};};
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(p:Node['props'])=>element('View',p),Text:(p:Node['props'])=>element('Text',p)}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>Array.from(s).length*10})}));
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(p:Node['props'])=>element('ScrollEntries',{...p,children:createMemo(()=>p.entries.map((e:ScrollEntry)=>e.render()))})}));
mock.module('@podjs/framework/services',()=>({delay:()=>({result:new Promise(()=>{}),cancel(){}})}));
for(const [name,key]of [['HomeScreen','default'],['ProfileScreen','ProfileScreen'],['AccountStatusScreen','AccountStatusScreen'],['PhoneConnectionScreen','PhoneConnectionScreen']]as const)mock.module('../src/ui/'+name+'.tsx',()=>({[key]:(p:Node['props'])=>element('underlying-route',p)}));
const observers=new Set<()=>void>(),actions:string[]=[];let conflict=false,failClear=false,syncs=0;
const publish=(v:boolean)=>{conflict=v;for(const fn of observers)fn();};
mock.module('../src/cloud/status.ts',()=>({readCloudAccountStatus:()=>({ownerChoiceRequired:conflict}),subscribeCloudAccountStatus:(fn:()=>void)=>{observers.add(fn);return()=>observers.delete(fn);}}));
mock.module('../src/services.ts',()=>({clearLocalPrivateLibrary:async()=>{actions.push('clearLocal');if(failClear)throw Error('private path must never leak');}}));
mock.module('../src/cloud/application.ts',()=>({manualCloudSync:async()=>{syncs++;},applicationCloudApproval:{},applicationCloudApprover:{state:{phase:'idle',requests:[],message:''},subscribe:()=>()=>{}},applicationCloudHandoff:{},applicationCloudActions:{logout:async()=>{throw Error('no logout');},reregister:async()=>{},resolveOwner:async(choice:string,confirmed:boolean,clear?:()=>Promise<void>)=>{expect(confirmed).toBe(true);actions.push(choice);if(choice==='clear')await clear!();publish(false);}}}));
// The owner-choice route does not invoke platform media clients.
mock.module('../src/media-services.ts',()=>({douyinClient:{}}));
const {HomeRoutes}=await import('../src/ui/routes/home');
const stops:(()=>void)[]=[];afterEach(()=>{for(const stop of stops.splice(0))stop();observers.clear();actions.length=0;conflict=false;failClear=false;syncs=0;});
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function nodes(v:any):Node[]{if(typeof v==='function')return nodes(v());if(Array.isArray(v))return v.flatMap(nodes);if(!v||typeof v!=='object'||!('props'in v))return [];return [v,...nodes(v.props.children)];}
function mount(page='home'){
 const [active,setActive]=createSignal(true);
 const snapshot=():AccountStatusSnapshot=>({phoneLabel:'Fixture',plan:'free',active:true,diagnosticsEnabled:false,accessTokenExpired:false,refreshTokenStatus:'valid',cloud:{message:'fixed code',phase:'error',usedBytes:0,quotaBytes:0,ownerChoiceRequired:conflict,errorCode:conflict?'library_owner_mismatch':undefined}});
 const root=createRoot(stop=>{stops.push(stop);return HomeRoutes({entry:{},page:()=>page,active,width:233,height:233,channels:()=>[],notesPlacement:{},refreshing:()=>false,busy:()=>false,platformLoginState:()=>({}),speechState:()=>undefined,speechSpectrum:()=>[],services:{readAccountStatus:async()=>snapshot(),subscribeAccountStatus:(fn:()=>void)=>{observers.add(fn);return()=>observers.delete(fn);}},go:async()=>{},goHome(){},openSpeech(){},openAdd(){},refresh:async()=>{},openBili:async()=>{},openDouyin:async()=>{},openFeed(){},channelAction:async()=>{},moveNotesToTop(){},toggleNotesPinned(){},openInformation(){},setError(){}} as any);});
 const labels=()=>nodes(root).map(n=>n.props.accessibilityLabel);const press=(label:string)=>{const node=nodes(root).find(n=>n.props.accessibilityLabel===label);expect(node).toBeDefined();node!.props.onPress();};return {root,labels,press,setActive};
}
test('owner state immediately opens the actual choice surface over home without starting sync or selecting a destructive action',async()=>{const f=mount();await settle();expect(f.labels()).not.toContain('清空本机资料');publish(true);await settle();expect(f.labels()).toContain('清空本机资料');expect(f.labels()).toContain('合并到当前账号');expect(f.labels()).not.toContain('退出账号');expect(actions).toEqual([]);expect(syncs).toBe(0);});
test('the choice also opens over profile and stays hidden while the route is inactive',async()=>{const f=mount('profile');f.setActive(false);publish(true);await settle();expect(f.labels()).not.toContain('清空本机资料');f.setActive(true);await settle();expect(f.labels()).toContain('清空本机资料');expect(actions).toEqual([]);});
test('clear requires two deliberate presses and runs complete local clear before dismissing the choice',async()=>{publish(true);const f=mount();await settle();f.press('清空本机资料');expect(actions).toEqual([]);f.press('再按一次确认清空');await settle();expect(actions).toEqual(['clear','clearLocal']);expect(f.labels()).not.toContain('清空本机资料');expect(conflict).toBe(false);});
test('merge is explicit and never invokes local clear',async()=>{publish(true);const f=mount();await settle();f.press('合并到当前账号');expect(actions).toEqual([]);f.press('再按一次确认合并');await settle();expect(actions).toEqual(['merge']);expect(conflict).toBe(false);});
test('failed clear retains the owner choice, disarms controls and hides raw errors',async()=>{publish(true);failClear=true;const f=mount();await settle();f.press('清空本机资料');f.press('再按一次确认清空');await settle();expect(conflict).toBe(true);expect(f.labels()).toContain('清空本机资料');expect(actions).toEqual(['clear','clearLocal']);expect(JSON.stringify(nodes(f.root).map(n=>n.props.children))).not.toContain('private path');});
