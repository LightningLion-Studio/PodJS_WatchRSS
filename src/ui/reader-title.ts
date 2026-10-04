import {readerFontPixels} from "../reader/font-assets.ts";
import {createEffect,createSignal,onCleanup,untrack,type Accessor} from 'solid-js';
import {getOps} from '@pocketjs/framework/host';
import {getDisplayMetrics,hasCapability} from '@podjs/framework/watch';
import {textLayout} from '@podjs/framework/services';
import {watchTitleLines} from '../reader/measured-text.ts';
import {requestWatchTitleLines} from '../reader/platform-title.ts';
import {presetContentFont} from '../reader/content-layout.ts';
import {resolvedReaderStyle,type ReaderPreset} from '../reader/preset.ts';
import type {ReaderFontResolver} from '../reader/font-assets.ts';
export type ReaderTitleLayoutState = {settled:boolean;native:boolean};
export function useReaderTitle(title:Accessor<string>,width:Accessor<number>,preset:Accessor<ReaderPreset>,fonts:Accessor<ReaderFontResolver>,profile:"compose"|"preview"="compose",onLayoutState?:(state:ReaderTitleLayoutState)=>void){
 const [lines,setLines]=createSignal<string[]>([]);
 createEffect(()=>{
  const text=title(),w=width(),p=preset(),resolve=fonts(),font=presetContentFont(p,'title'),spec=resolvedReaderStyle(p,'title');
  let current=true,native=false;
  const notify=(state:ReaderTitleLayoutState)=>{if(current)untrack(()=>onLayoutState?.(state));};
  onCleanup(()=>{current=false;});
  notify({settled:false,native:false});
  setLines(watchTitleLines(text,w,t=>getOps().measureText(t,font.fontSlot)*font.scale));
  if(!hasCapability('text.layout')){notify({settled:true,native:false});return;}
  const metrics=getDisplayMetrics(),pixelScale=metrics.physicalWidth/metrics.logicalWidth;
  const task=requestWatchTitleLines(text,w,pixelScale,t=>textLayout.measure({...resolve(spec),text:t,fontSizePx:readerFontPixels(spec,pixelScale),fontWeight:spec.fontWeight,italic:spec.italic,letterSpacingEm:spec.letterSpacingEm,textMotion:profile==="preview"?"subpixel":spec.renderMode==="LINEAR_SMOOTH"?"animated":"static"}),value=>{
   if(!current)return;
   native=true;setLines(value);
  },error=>{if(current)console.warn('Reader title font',String(error));});
  void task.done.then(()=>notify({settled:true,native}),error=>{
   if(!current)return;
   console.warn('Reader title font',String(error));notify({settled:true,native:false});
  });
  onCleanup(()=>{current=false;task.cancel();});
 });
 return lines;
}
