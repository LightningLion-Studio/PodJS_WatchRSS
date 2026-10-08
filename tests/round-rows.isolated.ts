import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import * as solid from 'solid-js';
import {createComponent,createMemo,createRenderEffect,createSignal,mergeProps,onCleanup} from 'solid-js';
import {roundRowRange} from '@podjs/framework/round-list';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'round-rows',setup(b){b.onLoad({filter:/\/(ScrollEntries|variable-list|round-rows|PlatformNotice|advanced-cache-settings|media-volume-settings|AutoScrollSettingsScreen)\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const fw=Bun.resolveSync('@podjs/framework/variable-list',import.meta.dir);
mock.module(Bun.resolveSync('solid-js',fw),()=>solid);
const {createScrollerWith}=await import(Bun.resolveSync('@pocketjs/framework/kinetics',fw).replace('kinetics.ts','kinetics-core.ts'));
const element=(props:any)=>({props});
for(const [name,impl] of Object.entries({renderer:{createComponent,mergeProps,memo:createMemo,effect:createRenderEffect},components:{View:element,Text:element,Image:element,FocusScope:element},gesture:{createGesture:()=>({dispose(){}})},lifecycle:{onFrame:()=>{}},kinetics:{createScroller:(o:any)=>createScrollerWith(createSignal,o),bindDpadScroll:()=>{}},input:{pressNode:()=>{},hitNode:()=>undefined}}))for(const p of ['@pocketjs/framework/'+name,Bun.resolveSync('@pocketjs/framework/'+name,fw)])mock.module(p,()=>impl);
// Glyph advances by font slot (PocketJS tailwind slots): CJK at full size, Latin at half.
const SLOT_PX:Record<number,number>={0:12,1:14,2:16,3:18,5:24,7:12,8:14,10:18,19:9,20:11,21:13,22:17,23:21,24:9};
const measureText=(text:string,slot:number)=>Array.from(text).reduce((sum,ch)=>sum+(SLOT_PX[slot]??14)*(ch.codePointAt(0)!>255?1:.55),0);
for(const p of ['@pocketjs/framework/host',Bun.resolveSync('@pocketjs/framework/host',fw)])mock.module(p,()=>({getOps:()=>({measureText})}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{left:0,right:0,top:0,bottom:0}}),hasCapability:()=>false,__onHostEvent:()=>()=>{},getFontMetrics:()=>undefined,kv:{get:()=>undefined,set:()=>{},delete:()=>{}},onLifecycleChange:()=>()=>{},lifecycle:()=>'active'}));
const {describedRows,cardSlices,chunkLines,roundRowMaxHeight}=await import('../src/ui/round-rows.tsx');
const {platformCardEntry,platformNoticeEntry}=await import('../src/ui/PlatformNotice.tsx');
const {platformScope,accessBoundary,platformNotice}=await import('../src/announcement/platform.ts');
const {advancedCacheRows}=await import('../src/ui/advanced-cache-settings.tsx');
const {mediaVolumeSettingsRows}=await import('../src/ui/media-volume-settings.tsx');
const {DEFAULT_SETTINGS}=await import('../src/settings/store.ts');

const ROUND={width:233,height:233};
/** Every row of a full-screen list (padding 18) must have a scroll position where it is fully visible. */
function expectAllFit(rows:{height:number;bounds?:any}[],padding=18,viewportHeight=233){
 rows.forEach((row,index)=>expect(roundRowRange(row,ROUND,viewportHeight,padding),`row ${index} (${row.height}px)`).toBeDefined());
}
const settings={width:233,height:233,state:{...DEFAULT_SETTINGS,mediaVolumeControl:true},onChange(){},onNavigate(){}} as any;
const width=233-36,long='平台账号相关操作受账号权限、接口和内容规则影响；当前未提供的官方客户端能力，不等于付费后解锁。'.repeat(4);

test('platform scope/access cards and compact notices fit by their text bounds',()=>{
 expectAllFit([platformCardEntry(width,platformScope),platformCardEntry(width,accessBoundary),platformNoticeEntry(width,platformNotice('哔哩哔哩',true)),platformNoticeEntry(width,platformNotice('抖音',true))]);
});
test('settings rows split their descriptions only when the whole block cannot fit',()=>{
 expectAllFit(advancedCacheRows(settings,width,1024*1024*300));
 expectAllFit(mediaVolumeSettingsRows(settings,width));
 const pill={height:52,render:()=>null as any};
 expect(describedRows(width,pill,[['一行说明']])).toHaveLength(1);
 const split=describedRows(width,pill,[Array.from({length:14},(_,i)=>`第${i}行`),['另一段']]);
 expect(split.length).toBeGreaterThan(2);expectAllFit(split);
});
test('long text chunks and card slices each fit; slices keep one continuous card',()=>{
 const lines=Array.from({length:40},(_,i)=>`line ${i}`);
 const chunks=chunkLines(lines,14,width);
 expect(chunks.flat()).toEqual(lines);
 for(const chunk of chunks)expect(chunk.length*14).toBeLessThanOrEqual(roundRowMaxHeight(width));
 const slices=cardSlices(chunks.map(chunk=>({height:chunk.length*14+12,bounds:{x:12,y:0,width:width-24,height:chunk.length*14},render:()=>null as any})),8,'#1c1f21',16);
 expectAllFit(slices);
 expect(platformCardEntry(width,{title:'当前支持范围',paragraphs:[long]}).bounds).toEqual(expect.objectContaining({x:10,y:8}));
});
test('pages below the fixed platform notice still fit their pills and feed cards',()=>{
 // Bili/Douyin entry, login and action pages: the list fills the display below a ~94px notice.
 const below={...ROUND,viewport:{x:0,y:94,width:233}};
 for(const row of [{height:48},{height:56},{height:78}])expect(roundRowRange(row,below,139,18)).toBeDefined();
});
