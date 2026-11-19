import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
const {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps}=solid;

const require=createRequire(import.meta.url);
plugin({name:'rss-geometry',setup(builder){
 builder.onLoad({filter:/\/RssScreens\.tsx$/},async({path})=>({
  loader:'js',
  contents:require('@babel/core').transformSync(await Bun.file(path).text(),{
   filename:path,babelrc:false,configFile:false,
   presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],
    [require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]
  }).code
 }));
}});
let calls=0, fontScale=1, space=8, list:any;
const metrics=()=>({cellWidth:14,cellHeight:18,baseline:14,lineHeight:18,rasterDensity:2});
const watchers=new Set<(state:string)=>void>();
const measureText=(s:string)=>{calls++;return s===' '?space:s.length*8*fontScale;};
const framework=Bun.resolveSync('@podjs/framework/text-environment',import.meta.dir);
for(const base of [import.meta.dir,framework]){
 mock.module(Bun.resolveSync('solid-js',base),()=>solid);
}
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText})}));
mock.module('@pocketjs/framework/components',()=>({Text:(p:any)=>p,View:(p:any)=>p,Image:(p:any)=>p}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({density:2,logicalWidth:233,physicalWidth:466}),getFontMetrics:metrics,hasCapability:()=>true,lifecycle:()=> 'active',onLifecycleChange:(cb:(state:string)=>void)=>{watchers.add(cb);return()=>watchers.delete(cb);}}));
mock.module('@podjs/framework/services',()=>({textLayout:{environment:async()=>({density:2,fontScale})}}));
for(const path of ['DeleteConfirmDialog','RemoteImage','SwipeCard']){
 mock.module('../src/ui/'+path+'.tsx',()=>({[path]:(props:any)=>props}));
}
mock.module('../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:(props:any)=>{
 list=props;
 createRenderEffect(()=>{props.entries;props.indexedEntries;props.footerEntries;});
 return null;
}}));
const {RssFeedScreen}=await import('../src/ui/RssScreens.tsx');
const fixtures=Array.from({length:300},(_,i)=>({
 id:String(i),title:'离线阅读标题'+i+'文本'.repeat(18),excerpt:'离线摘要'+i+'内容'.repeat(63),read:false,
}));
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('RSS geometry only measures new or changed cards and invalidates with host geometry',async()=>{
 const [items,setItems]=createSignal(fixtures.slice(0,270)),[width,setWidth]=createSignal(233);
 const stop=createRoot(dispose=>{
  RssFeedScreen({get items(){return items() as any;},get width(){return width();},height:193,title:'离线',
   refreshing:false,loadingMore:false,canNext:false,onOpen(){},onActions(){},onFavorite(){},onWatchLater(){},onRefresh(){},onNext(){}});
  return dispose;
 });
 await settle();
 const measure=(update:()=>void)=>{const start=performance.now();calls=0;update();return {calls,ms:performance.now()-start};};
 try{
  const append=measure(()=>setItems(fixtures));
  const unchanged=measure(()=>setItems(fixtures.map(a=>({...a}))));
  const oneRead=measure(()=>setItems(items().map((a,i)=>i===51?{...a,read:true}:a)));
  const changedWidth=measure(()=>setWidth(225));
  fontScale=1.2;calls=0;watchers.forEach(cb=>cb('active'));await settle();const changedFont=calls;
  space=12;const changedIndent=measure(()=>setItems(items().slice()));
  console.log(JSON.stringify({append,unchanged,oneRead,changedWidth,changedFont,changedIndent}));
  expect(append.calls).toBeLessThan(4000);
  expect(unchanged.calls).toBeLessThan(20);
  expect(oneRead.calls).toBeGreaterThan(20);expect(oneRead.calls).toBeLessThan(200);
  expect(changedWidth.calls).toBeGreaterThan(30000);
  expect(changedFont).toBeGreaterThan(30000);
  expect(changedIndent.calls).toBeGreaterThan(30000);
  expect(list.indexedEntries).toBeDefined();
  const replacement={...items()[51]!,title:'刷新后的标题'};
  const changedTitle=measure(()=>setItems(items().map((a,i)=>i===51?replacement:a)));
  expect(changedTitle.calls).toBeGreaterThan(20);expect(changedTitle.calls).toBeLessThan(200);
  const row=list.indexedEntries.entries[51];
  expect(row.data.article).toBe(replacement);expect(row.data.geometry.title.join('')).toBe(replacement.title);
 }finally{stop();}
});
