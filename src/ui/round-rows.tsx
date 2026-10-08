import type {JSX} from 'solid-js';
import {Text,View} from '@pocketjs/framework/components';
import {getDisplayMetrics} from '@podjs/framework/watch';
import type {ScrollEntry} from './ScrollEntries.tsx';

/** Tallest centred row of the given visible width that still fits the round display's safe circle
 * (same 2px margin as the framework round list). Unlimited off round displays. */
export function roundRowMaxHeight(width:number,margin=2):number {
 const metrics=getDisplayMetrics();
 if(metrics.shape!=='round')return Infinity;
 const radius=Math.min(metrics.logicalWidth,metrics.logicalHeight)/2-margin,half=width/2;
 return half>=radius?0:Math.floor(2*Math.sqrt(radius*radius-half*half))-1;
}

/** Groups wrapped lines into consecutive chunks that each fit a row of `width`, so long text becomes
 * several list rows that can each scroll fully into view. `extra` is fixed chrome per chunk. */
export function chunkLines(lines:readonly string[],lineHeight:number,width:number,extra=0):string[][] {
 const perChunk=Math.max(1,Math.floor((roundRowMaxHeight(width)-extra)/lineHeight));
 const chunks:string[][]=[];
 for(let i=0;i<lines.length;i+=perChunk)chunks.push(lines.slice(i,i+perChunk));
 return chunks.length?chunks:[[]];
}

export interface Pill {height:number;render:()=>JSX.Element}
/** Native settings row: a control pill, then muted 12/14 description paragraphs 4dp apart at left 10.
 * One row when the whole block fits the round screen; otherwise the pill and each description chunk
 * become their own rows so every part can scroll fully into view. */
export function describedRows(width:number,pill:Pill,paragraphs:readonly (readonly string[])[]):ScrollEntry[] {
 let bottom=pill.height;
 const placed=paragraphs.filter(lines=>lines.length).map(lines=>{const top=bottom+4;bottom=top+lines.length*14;return {lines,top};});
 const text=(lines:readonly string[],top:number)=> <Text class="absolute left-[10] text-xs leading-[14] text-[#b6b6b6]" style={{insetT:top}}>{lines.join('\n')}</Text>;
 if(bottom<=roundRowMaxHeight(width))return [{height:bottom,render:()=> <View class="absolute inset-0">{pill.render()}{placed.map(p=>text(p.lines,p.top))}</View>}];
 const rows:ScrollEntry[]=[{height:pill.height,render:()=> <View class="absolute inset-0">{pill.render()}</View>}];
 // The text box runs from left 10 to the row's right edge, so the row width bounds its chord.
 for(const p of placed)for(const chunk of chunkLines(p.lines,14,width))
  rows.push({height:chunk.length*14,bounds:{x:10,y:0,width:width-10,height:chunk.length*14},render:()=>text(chunk,0)});
 return rows;
}

export interface CardSlice {height:number;bounds?:ScrollEntry['bounds'];render:()=>JSX.Element}
/** One visual card emitted as consecutive list rows so each part can scroll fully into view on a round
 * screen. Each slice's backdrop reaches up across the list gap and the next slice draws over the
 * previous one's rounded bottom, so the card stays continuous; only the outer corners are rounded. */
export function cardSlices(slices:readonly CardSlice[],gap:number,background:string,radius=12):ScrollEntry[] {
 return slices.map((slice,index)=>{
  const first=index===0,last=index===slices.length-1,top=first?0:-gap,bottom=last?0:radius;
  return {height:slice.height,bounds:slice.bounds,render:()=> <View class="absolute inset-0">
   <View class="absolute left-[0] right-[0]" style={{insetT:top,height:slice.height-top+bottom,bgColor:background,radius}}/>
   {slice.render()}
  </View>};
 });
}
