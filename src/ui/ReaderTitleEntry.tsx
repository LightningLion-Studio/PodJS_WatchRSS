import {batch,createEffect,createMemo,createSignal,onCleanup,untrack,type Accessor} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {getDisplayMetrics,getFontMetrics,hasCapability} from '@podjs/framework/watch';
import {textLayout} from '@podjs/framework/services';
import {SystemTextLine} from '@podjs/framework/text';
import {useReaderTitle,type ReaderTitleLayoutState} from './reader-title.ts';
import {createContentLayouter,type NativeBlockLayouts} from '../reader/content-layout.ts';
import {requestReaderLayout} from '../reader/platform-layout.ts';
import {systemTextOptions} from '../reader/system-text.ts';
import type {ReaderPreset} from '../reader/preset.ts';
import type {ReaderFontResolver} from '../reader/font-assets.ts';
import type {ContentBlock} from '../reader/content.ts';
import type {ScrollEntry} from './ScrollEntries.tsx';

/** Native DetailTitle outside an article, with the same preset/font pipeline. */
export function useReaderTitleEntry(text:Accessor<string>,width:Accessor<number>,preset:Accessor<ReaderPreset>,fonts:Accessor<ReaderFontResolver>,color:Accessor<string>,onLayoutState?:(state:ReaderTitleLayoutState)=>void):Accessor<ScrollEntry>{
 const [planning,setPlanning]=createSignal<ReaderTitleLayoutState>({settled:false,native:false});
 const title=useReaderTitle(text,width,preset,fonts,'compose',setPlanning);
 const textWidth=createMemo(()=>Math.min(width(),190));
 const block=createMemo<Extract<ContentBlock,{type:'text'}>>(()=>({type:'text',text:title().join('\n'),style:'title'}));
 const paragraphInputs=createMemo(()=>({block:block(),width:textWidth(),preset:preset(),fonts:fonts(),color:color()}));
 const [paragraph,setParagraph]=createSignal<ReaderTitleLayoutState&{inputs:ReturnType<typeof paragraphInputs>}>();
 const [native,setNative]=createSignal<NativeBlockLayouts>(new Map());
 const layOut=createContentLayouter((value,slot)=>getOps().measureText(value,slot),undefined,getFontMetrics);
 createEffect(()=>{
  const inputs=paragraphInputs(),value=inputs.block,w=inputs.width,p=inputs.preset,hex=inputs.color.slice(1);
  const colorArgb=parseInt(hex.length===8?hex.slice(6)+hex.slice(0,6):'ff'+hex,16);
  let current=true,nativeSucceeded=false;
  const isCurrent=()=>current&&untrack(paragraphInputs)===inputs&&untrack(block).text===value.text;
  const finish=(success:boolean)=>{if(isCurrent())setParagraph({inputs,settled:true,native:success});};
  onCleanup(()=>{current=false;});
  batch(()=>{setParagraph({inputs,settled:false,native:false});setNative(new Map());});
  if(!hasCapability('text.layout')){finish(false);return;}
  const metrics=getDisplayMetrics();
  const task=requestReaderLayout([value],w,p.body.fontSizeSp,metrics.physicalWidth/metrics.logicalWidth,p,args=>{
   // requestReaderLayout retains this owned request as the raster paragraph.
   // Its paint must receive the same overrides as the visible title row.
   args.align='center';args.justify=false;args.colorArgb=colorArgb;
   return textLayout.layout(args);
  },layouts=>{
   if(!isCurrent()||!layouts.get(value)?.length)return;
   nativeSucceeded=true;setNative(layouts);
  },error=>{if(isCurrent())console.warn('Detail title layout',String(error));},inputs.fonts);
  void task.done.then(()=>finish(nativeSucceeded&&!!untrack(native).get(value)?.length),error=>{
   if(!isCurrent())return;
   console.warn('Detail title layout',String(error));finish(false);
  });
  onCleanup(()=>{current=false;task.cancel();});
 });
 createEffect(()=>{
  const plan=planning(),result=paragraph(),inputs=paragraphInputs();
  const settled=plan.settled&&result?.inputs===inputs&&result.settled;
  const state:ReaderTitleLayoutState={settled:!!settled,native:!!settled&&plan.native&&!!result?.native&&!!native().get(inputs.block)?.length};
  untrack(()=>onLayoutState?.(state));
 });
 const layout=createMemo(()=>layOut([block()],textWidth(),preset().body.fontSizeSp,{},preset(),native()));
 const pixelScale=()=>{const metrics=getDisplayMetrics();return metrics.physicalWidth/metrics.logicalWidth;};
 return createMemo(()=>({height:layout().height,render:()=> <View class="absolute top-[0] bottom-[0]" style={{insetL:(width()-textWidth())/2,width:textWidth()}}>{layout().rows.map(row=>{
  if(row.kind!=='text')return null;
  const value={...row,textAlign:1,color:color()};
  const fallback=<Text class="absolute" style={{insetL:0,insetT:row.textOffsetY??0,width:textWidth()/row.scale,fontSlot:row.fontSlot,scale:row.scale,originX:-.5,originY:-.5,lineHeight:row.lineHeight/row.scale,textColor:color(),textAlign:1}}>{row.text}</Text>;
  return <View class="absolute left-[0] right-[0]" style={{insetT:row.top,height:row.lineHeight}}>{hasCapability('text.raster')?<SystemTextLine pixelScale={pixelScale()} options={systemTextOptions(value,'title',preset().body.fontSizeSp,textWidth(),pixelScale(),preset(),getFontMetrics(row.fontSlot),fonts())} fallback={fallback}/>:fallback}</View>;
 })}</View>}));
}
