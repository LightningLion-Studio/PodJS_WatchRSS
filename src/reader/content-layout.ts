import {readerMediaHeight} from './media-geometry.ts';
import type {TextParagraphLine} from "@podjs/framework/services";
import type {ContentBlock, ContentStyle} from "./content.ts";
import {wrapAtlasText} from "@podjs/framework/text-wrap";
import {lineStarts, type TextAnchor} from "./text-anchor.ts";
import { resolvedReaderStyle, type ReaderPreset } from "./preset.ts";
export interface ContentAnchor extends TextAnchor {mediaIndex?:number}
export type ReaderRow = {top:number;height:number;gap:number;blockIndex:number;character:number;sourceStart?:number;nativeBaseline?:number;nativeParagraph?:TextParagraphLine} & ({kind:"text";text:string;fontSlot:number;scale:number;color:string;lineHeight:number;tracking?:number;textAlign?:number;textOffsetY?:number}|{kind:"image"|"video";block:Exclude<ContentBlock,{type:"text"}>});
export interface ContentLayout {rows:ReaderRow[];height:number;textLength:number}
/** Uses existing baked atlases; fractional scaling preserves requested geometry. */
export function contentFont(size:number,style:ContentStyle){
 const target=size*(style==="title"?1.55:style==="subtitle"?1.12:style==="code"?.9:1);
 const choices=style==="title"?[[12,7],[14,8],[18,10]]:[[12,0],[14,1],[16,2],[18,3]];
 const nearest=choices.reduce((a,b)=>Math.abs(a[0]-target)<Math.abs(b[0]-target)?a:b);
 return {fontSlot:nearest[1],scale:target/nearest[0],lineHeight:target*1.35,color:style==="subtitle"?"#c1c1c1":style==="quote"?"#c5c5c5":"#f2f2f2"};
}
export function readerColor(argb:number):string { const hex=(argb>>>0).toString(16).padStart(8,"0");return `#${hex.slice(2)}${hex.slice(0,2)}`; }
/** Literal font classes also include dynamically selected bold atlases in the package. */
export function readerTextClass(slot:number):string {
 return slot===7?"absolute left-[0] right-[0] text-xs font-bold":slot===8?"absolute left-[0] right-[0] text-sm font-bold":slot===10?"absolute left-[0] right-[0] text-lg font-bold":"absolute left-[0] right-[0]";
}
export function presetContentFont(preset:ReaderPreset,style:ContentStyle){
 const spec=style==="body"?preset.body:resolvedReaderStyle(preset,style);
 const choices=spec.fontWeight>=600?[[12,7],[14,8],[18,10],[21.7,37]]:[[12,33],[14,34],[16,35],[18,36]];
 const nearest=choices.reduce((a,b)=>Math.abs(a[0]-spec.fontSizeSp)<Math.abs(b[0]-spec.fontSizeSp)?a:b);
 return {fontSlot:nearest[1],scale:spec.fontSizeSp/nearest[0],lineHeight:spec.fontSizeSp*spec.lineHeightEm,color:readerColor(spec.colorArgb),tracking:spec.fontSizeSp*spec.letterSpacingEm,textAlign:spec.alignment==="CENTER"?1:0};
}
export interface ParagraphLine { start:number; end:number; visibleEnd:number; height?:number; baseline?:number; paragraph?:TextParagraphLine }
export interface AtlasLineMetrics {cellHeight:number;baseline:number}
export type NativeBlockLayouts=ReadonlyMap<ContentBlock,readonly ParagraphLine[]>;
interface TextBlockLayout {native?:readonly ParagraphLine[];width:number;fontSize:number;fontKey:string;text:string;style:ContentStyle;normalized:string;lines:string[];starts:number[]}
/** Native atlas wrapping can return no breakpoints for a long unsupported run.
 * Binary-search each line using actual measured width, retaining code point
 * boundaries and bounding a line to the host's 4096-byte semantic limit. */
function measuredHardWrap(text:string,width:number,measure:(value:string)=>number):string[]{
 const offsets=[0];for(const point of text)offsets.push(offsets[offsets.length-1]!+point.length);
 const lines:string[]=[];let start=0,lastLength=1;
 const fits=(end:number)=>measure(text.slice(offsets[start],offsets[end]))<=width;
 while(start<offsets.length-1){
  let low=start,high=Math.min(offsets.length-1,start+1024);
  const estimated=Math.min(high,start+lastLength);
  if(fits(estimated)){
   low=estimated;let step=1;
   while(low<high){const next=Math.min(high,low+step);if(fits(next)){low=next;step*=2;}else{high=next-1;break;}}
  }else high=estimated-1;
  while(low<high){const middle=Math.floor((low+high+1)/2);if(fits(middle))low=middle;else high=middle-1;}
  const end=Math.max(start+1,low);lines.push(text.slice(offsets[start],offsets[end]));lastLength=end-start;start=end;
 }
 return lines;
}
/** Reuse text wrapping while image aspect ratios change; replaced blocks can be collected. */
export function createContentLayouter(measure:(text:string,slot:number)=>number,wrap?:(text:string,slot:number,width:number)=>number[]|undefined,atlasMetrics?:(slot:number)=>AtlasLineMetrics|undefined){
 const textCache=new WeakMap<object,TextBlockLayout>(),widths=new Map<string,number>();
 const measured=(text:string,slot:number)=>{if(text.length>128)return measure(text,slot);const key=slot+":"+text,hit=widths.get(key);if(hit!==undefined){widths.delete(key);widths.set(key,hit);return hit;}const value=measure(text,slot);if(widths.size>=4096)widths.delete(widths.keys().next().value!);widths.set(key,value);return value;};
 const steps=(blocks:readonly ContentBlock[],width:number,fontSize:number,ratios:Readonly<Record<number,number>>={},preset?:ReaderPreset,native?:NativeBlockLayouts,viewportHeight=width)=>contentLayoutSteps(blocks,width,fontSize,measured,ratios,textCache,wrap,preset,native,atlasMetrics,viewportHeight);
 return Object.assign((...args:Parameters<typeof steps>)=>finishContentLayout(steps(...args)),{steps});
}
export function layoutContent(blocks:readonly ContentBlock[],width:number,fontSize:number,measure:(text:string,slot:number)=>number,ratios:Readonly<Record<number,number>>={},textCache?:WeakMap<object,TextBlockLayout>,wrap?:(text:string,slot:number,width:number)=>number[]|undefined,preset?:ReaderPreset,native?:NativeBlockLayouts,atlasMetrics?:(slot:number)=>AtlasLineMetrics|undefined,viewportHeight=width):ContentLayout {
 return finishContentLayout(contentLayoutSteps(blocks,width,fontSize,measure,ratios,textCache,wrap,preset,native,atlasMetrics,viewportHeight));
}
function finishContentLayout(steps:Generator<ReaderRow,ContentLayout>):ContentLayout {
 let next=steps.next();while(!next.done)next=steps.next();return next.value;
}
/** The synchronous and sliced paths share every geometry calculation. */
export function* contentLayoutSteps(blocks:readonly ContentBlock[],width:number,fontSize:number,measure:(text:string,slot:number)=>number,ratios:Readonly<Record<number,number>>={},textCache?:WeakMap<object,TextBlockLayout>,wrap?:(text:string,slot:number,width:number)=>number[]|undefined,preset?:ReaderPreset,native?:NativeBlockLayouts,atlasMetrics?:(slot:number)=>AtlasLineMetrics|undefined,viewportHeight=width):Generator<ReaderRow,ContentLayout> {
 const rows:ReaderRow[]=[];let top=0,character=0;
 for(let blockIndex=0;blockIndex<blocks.length;blockIndex++){
  const block=blocks[blockIndex]!;
  const gap=blockIndex?6:0;
  if(block.type==="text"){
   const font=preset?presetContentFont(preset,block.style):{...contentFont(fontSize,block.style),tracking:0,textAlign:0};let cached=textCache?.get(block);
   const platformLines=native?.get(block);
   const fontKey=`${font.fontSlot}:${font.scale}:${font.tracking}`;
   const normalized=cached?.text===block.text?cached.normalized:block.text.replace(/\r\n?/g,"\n");
   if(!platformLines&&(!cached||cached.native!==platformLines||cached.width!==width||cached.fontSize!==fontSize||cached.fontKey!==fontKey||cached.text!==block.text||cached.style!==block.style)){const lines=normalized.split("\n").flatMap(paragraph=>{
     // For a single word without grapheme extenders, native hard wrapping is
     // identical to the existing grapheme loop. Keep that loop for spaced
     // text and combining/ZWJ clusters rather than changing their boundaries.
     if(wrap&&!font.tracking&&paragraph&&!/[\s\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\u200d\ufe0f]/u.test(paragraph)){
      const breaks=wrap(paragraph,font.fontSlot,Math.max(1,width)/font.scale);
      if(breaks?.length){const result:string[]=[];let start=0;for(const end of breaks){result.push(paragraph.slice(start,end));start=end;}result.push(paragraph.slice(start));return result;}
      return measuredHardWrap(paragraph,Math.max(1,width),value=>measure(value,font.fontSlot)*font.scale);
     }
     return wrapAtlasText(paragraph,{width:Math.max(1,width),fontSlot:font.fontSlot,scale:font.scale,tracking:font.tracking,measure:s=>measure(s,font.fontSlot)*font.scale+Math.max(0,Array.from(s).length-1)*font.tracking});
    });cached={width,fontSize,fontKey,text:block.text,style:block.style,normalized,lines,starts:lineStarts(block.text,lines),native:undefined};textCache?.set(block,cached);}
   const lines=cached?.lines??[],starts=cached?.starts??[];
   let rawOffset=0,normalizedOffset=0;
   for(let i=0;i<(platformLines?.length??lines.length);i++){const metrics=platformLines?.[i],start=metrics?.start??starts[i],text=metrics?normalized.slice(metrics.start,metrics.visibleEnd):lines[i];while(normalizedOffset<start&&rawOffset<block.text.length){if(block.text[rawOffset]==="\r"&&block.text[rawOffset+1]==="\n")rawOffset++;rawOffset++;normalizedOffset++;}const rowGap=i?0:gap,lineHeight=metrics?.height??font.lineHeight,height=rowGap+lineHeight;
    const atlas=metrics?.baseline===undefined?undefined:atlasMetrics?.(font.fontSlot);
    const textOffsetY=atlas?metrics!.baseline!-((lineHeight-atlas.cellHeight*font.scale)/2+atlas.baseline*font.scale):0;
    rows.push({kind:"text",text,blockIndex,sourceStart:rawOffset,character:character+start,top,height,gap:rowGap,...font,lineHeight,textOffsetY,...(metrics?.baseline!==undefined?{nativeBaseline:metrics.baseline}:{}),...(metrics?.paragraph?{nativeParagraph:metrics.paragraph}:{})});top+=height;yield rows[rows.length-1]!;}
   character+=normalized.length+1;
  }else{
   const height=gap+readerMediaHeight(block,width,ratios[blockIndex],viewportHeight);
   rows.push({kind:block.type,block,blockIndex,character,top,height,gap});top+=height;yield rows[rows.length-1]!;
  }
 }
 return {rows,height:top,textLength:Math.max(0,character-1)};
}
export function rowAtOffset(rows:readonly {top:number;height:number}[],offset:number):number {
 let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].top+rows[mid].height<=offset)lo=mid+1;else hi=mid;}return Math.min(lo,Math.max(0,rows.length-1));
}
export function contentAnchorAt(layout:ContentLayout,offset:number):ContentAnchor {
 const row=layout.rows[rowAtOffset(layout.rows,Math.max(0,offset))];if(!row)return {character:0,fraction:0};
 const fraction=Math.max(0,Math.min(.999,(offset-row.top-row.gap)/Math.max(1,row.height-row.gap)));
 return {character:row.character,fraction,...(row.kind!=="text"?{mediaIndex:row.blockIndex}:{})};
}
export function offsetForContentAnchor(layout:ContentLayout,anchor:ContentAnchor,maximum:number):number {
 let row=anchor.mediaIndex===undefined?undefined:layout.rows.find(r=>r.kind!=="text"&&r.blockIndex===anchor.mediaIndex);
 if(!row){
  let lo=0,hi=layout.rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(layout.rows[mid]!.character<=anchor.character)lo=mid+1;else hi=mid;}
  for(let i=Math.max(0,lo-1);i>=0;i--)if(layout.rows[i]!.kind==="text"){row=layout.rows[i];break;}
  if(!row)row=layout.rows.find(candidate=>candidate.kind==="text");
 }
 if(!row)return 0;
 return Math.max(0,Math.min(maximum,row.top+row.gap+Math.max(0,Math.min(.999,anchor.fraction))*(row.height-row.gap)));
}

/** WatchRSS line identity follows the source block and raw UTF-16 offset. */
export function readerRowKey(row:ReaderRow):string {return `${row.kind}:${row.blockIndex}:${row.sourceStart??0}`;}
