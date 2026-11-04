import {prepareTextLayout,type TextLayoutSliceOptions} from '@podjs/framework/text-layout';
import {readerMediaRatio} from './media-geometry.ts';
import type {ContentBlock} from './content.ts';
import {contentFont,presetContentFont,type ReaderRow} from './content-layout.ts';
import {breakUnits} from './line-break.ts';
import type {ReaderPreset} from './preset.ts';

export interface PageAnchor {section:'header'|'body'|'footer';character:number;blockIndex:number;sourceStart:number;sectionOffset:number}
export interface PageLine {row:ReaderRow;left:number;top:number;width:number}
export interface BookPage {anchor:PageAnchor;lines:PageLine[];controls?:{index:number;offset:number;height:number}[];loading?:number}
export interface PaginationOptions {width:number;height:number;round:boolean;fontSize:number;preset?:ReaderPreset;measure:(text:string,slot:number)=>number;ratios?:Readonly<Record<number,number>>;header?:readonly number[];footer?:readonly number[];unloaded?:(index:number)=>boolean}
/** The entire line rectangle, including its top and bottom corners, fits the circle. */
export function circleLineBounds(width:number,height:number,top:number,lineHeight:number,round:boolean,margin=6){
 if(!round)return {left:14,width:Math.max(1,width-28)};
 const radius=Math.min(width,height)/2-margin,dy=Math.max(Math.abs(top-height/2),Math.abs(top+lineHeight-height/2));
 const half=Math.sqrt(Math.max(0,radius*radius-dy*dy));
 return {left:width/2-half,width:2*half};
}
const anchor=(section:PageAnchor['section'],character=0,blockIndex=0,sourceStart=0,sectionOffset=0):PageAnchor=>({section,character,blockIndex,sourceStart,sectionOffset});
const MARK=/[\p{M}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/u,FLAG=/[\u{1F1E6}-\u{1F1FF}]/u;
function graphemes(text:string){
 if(!MARK.test(text)&&!FLAG.test(text))return Array.from(text);
 const out:string[]=[];let regional=false;
 for(const cp of text){const last=out.at(-1),mark=MARK.test(cp),flag=FLAG.test(cp);
  if(last&&(mark||last.endsWith('\u200D')||flag&&regional))out[out.length-1]+=cp;else out.push(cp);
  regional=flag&&!regional;
 }
 return out;
}
/** Build discrete pages from source text. No continuous-scroll offsets or viewport cropping. */
export function* paginateBookSteps(blocks:readonly ContentBlock[],options:PaginationOptions):Generator<void,BookPage[]>{
 const {width,height,round}=options,pages:BookPage[]=[];
 const controls=(section:'header'|'footer',heights:readonly number[])=>{
  const safe=round?Math.floor((Math.min(width,height)-16)/Math.SQRT2):height-28;
  let page:BookPage|undefined,y=0,sectionOffset=0;
  for(let index=0;index<heights.length;index++){
   const total=heights[index]!;let offset=0;
   while(offset<total){
    if(!page||y>=safe||offset===0&&total<=safe&&y+total>safe){page={anchor:anchor(section,0,0,0,sectionOffset+offset),lines:[],controls:[]};pages.push(page);y=0;}
    const part=Math.min(total-offset,safe-y);page.controls!.push({index,offset,height:part});y+=part;offset+=part;
   }
   sectionOffset+=total;
  }
 };
 controls('header',options.header??[]);
 let page:BookPage|undefined,y=12,character=0;
 const newPage=(start:PageAnchor)=>{page={anchor:start,lines:[]};pages.push(page);y=12;};
 for(let blockIndex=0;blockIndex<blocks.length;blockIndex++){
  const block=blocks[blockIndex]!;
  // Imported chunks paginate independently, so loading the next chunk cannot rewrite a page already read.
  if(options.unloaded)page=undefined;
  if(options.unloaded?.(blockIndex)){page=undefined;pages.push({anchor:anchor('body',character,blockIndex),lines:[],loading:blockIndex});continue;}
  if(block.type!=='text'){
   const side=round?Math.floor((Math.min(width,height)-16)/Math.SQRT2):width-28;
   const ratio=readerMediaRatio(block,options.ratios?.[blockIndex]);
   const mediaHeight=Math.min(side,side/ratio,height-28),mediaWidth=Math.min(side,mediaHeight*ratio);
   newPage(anchor('body',character,blockIndex));
   page!.lines.push({row:{kind:block.type,block,blockIndex,character,top:0,height:mediaHeight,gap:0},left:(width-mediaWidth)/2,top:(height-mediaHeight)/2,width:mediaWidth});page=undefined;continue;
  }
  const text=block.text.replace(/\r\n?/g,'\n'),font=options.preset?presetContentFont(options.preset,block.style):{...contentFont(options.fontSize,block.style),tracking:0,textAlign:0};
  const lineHeight=font.lineHeight;
  // Retain original UTF-16 positions for imported chunk checkpoints.
  const raw:number[]=[];for(let i=0;i<block.text.length;i++){raw.push(i);if(block.text[i]==='\r'&&block.text[i+1]==='\n')i++;}raw.push(block.text.length);
  const units=text.split(/(\n)/).flatMap(part=>part==='\n'?['\n']:breakUnits(part));
  let unit=0,position=0,paragraphEnd=units.indexOf("\n"),lastCount=8;
  if(paragraphEnd<0)paragraphEnd=units.length;
  const measure=(value:string)=>options.measure(value,font.fontSlot)*font.scale+(font.tracking?Math.max(0,graphemes(value).length-1)*font.tracking:0);
  if(page?.lines.length)y+=6;
  while(unit<units.length){
   if(!page||y+lineHeight>height-34)newPage(anchor('body',character+position,blockIndex,raw[position]??position));
   let bounds=circleLineBounds(width,height,y,lineHeight,round);
   // A tall font can make the first polar chord too narrow. Move down to a usable chord.
   const first=graphemes(units[unit]!)[0]??'';
   while(bounds.width<measure(first)&&y+lineHeight<height/2){y+=2;bounds=circleLineBounds(width,height,y,lineHeight,round);}
   let line='',consumed=0;
   if(unit===paragraphEnd){unit++;consumed=1;}
   else {
    const fits=(count:number)=>measure(units.slice(unit,unit+count).join(''))<=bounds.width;
    let low=0,high=Math.min(paragraphEnd-unit,256),estimated=Math.min(high,lastCount);
    if(fits(estimated)){
     low=estimated;
     while(low<high){const next=Math.min(high,Math.max(low+1,low*2));if(fits(next))low=next;else{high=next-1;break;}}
    }else high=estimated-1;
    while(low<high){const middle=Math.floor((low+high+1)/2);if(fits(middle))low=middle;else high=middle-1;}
    if(low){line=units.slice(unit,unit+low).join('');unit+=low;consumed=line.length;lastCount=low;}
    else {
     const value=units[unit]!,points=graphemes(value);let lo=1,hi=points.length;
     while(lo<hi){const middle=Math.floor((lo+hi+1)/2);if(measure(points.slice(0,middle).join(''))<=bounds.width)lo=middle;else hi=middle-1;}
     line=points.slice(0,lo).join('');consumed=line.length;
     if(lo===points.length)unit++;else units[unit]=points.slice(lo).join('');
    }
    if(unit===paragraphEnd&&units[unit]==='\n'){unit++;consumed++;}
   }
   if(unit>paragraphEnd){paragraphEnd=units.indexOf('\n',unit);if(paragraphEnd<0)paragraphEnd=units.length;}
   const row:ReaderRow={kind:'text',text:line,blockIndex,sourceStart:raw[position]??position,character:character+position,top:y,height:lineHeight,gap:0,...font,lineHeight};
   page!.lines.push({row,left:bounds.left,top:y,width:bounds.width});position+=consumed;y+=lineHeight;yield;
  }
  character+=text.length+1;
 }
 controls('footer',options.footer??[]);
 return pages.length?pages:[{anchor:anchor('body'),lines:[]}];
}
/** Synchronous page mode and sliced speculative preparation consume identical steps. */
export function paginateBook(blocks:readonly ContentBlock[],options:PaginationOptions):BookPage[]{
 const steps=paginateBookSteps(blocks,options);for(;;){const next=steps.next();if(next.done)return next.value;}
}
export function bookPageForAnchor(pages:readonly BookPage[],target:PageAnchor):number{
 const rank=(section:PageAnchor['section'])=>section==='header'?0:section==='body'?1:2;
 const before=(start:PageAnchor)=>rank(start.section)!==rank(target.section)?rank(start.section)<rank(target.section):target.section==='body'?(start.blockIndex<target.blockIndex||start.blockIndex===target.blockIndex&&start.sourceStart<=target.sourceStart):start.sectionOffset<=target.sectionOffset;
 let low=0,high=pages.length;
 while(low<high){const middle=(low+high)>>>1;if(before(pages[middle]!.anchor))low=middle+1;else high=middle;}
 return Math.max(0,low-1);
}

/** Cache body geometry across mode switches and header/action updates. Native measurement is expensive. */
export function createBookPaginator(measure:PaginationOptions['measure']){
 const resized=new WeakMap<BookPage[],{ratios:PaginationOptions["ratios"];pages:BookPage[]}>();
 const bodies=new WeakMap<readonly ContentBlock[],Map<string,BookPage[]>>(),compositions=new WeakMap<BookPage[],Map<string,BookPage[]>>(),widths=new Map<string,number>();
 const measured=(text:string,slot:number)=>{
  const key=slot+':'+text,cached=widths.get(key);if(cached!==undefined)return cached;
  const value=measure(text,slot);if(widths.size>=4096)widths.delete(widths.keys().next().value!);widths.set(key,value);return value;
 };
 const configurationKey=(options:Omit<PaginationOptions,'measure'>)=>JSON.stringify([options.width,options.height,options.round,options.fontSize,options.preset,!!options.unloaded]);
 const paginate=(blocks:readonly ContentBlock[],options:Omit<PaginationOptions,'measure'>)=>{
  const key=configurationKey(options);
  let configurations=bodies.get(blocks);if(!configurations){configurations=new Map();bodies.set(blocks,configurations);}
  let body=configurations.get(key);
  if(!body){body=paginateBook(blocks,{...options,ratios:undefined,measure:measured,header:undefined,footer:undefined});if(configurations.size>=2)configurations.delete(configurations.keys().next().value!);configurations.set(key,body);}
  // Media occupy separate pages. Updating decoded ratios must not measure or
  // paginate the article text again, or change any source page anchor.
  const cached=resized.get(body);
  if(cached&&cached.ratios===options.ratios)body=cached.pages;
  else {
   const original=body;
   body=original.map(page=>{
    const line=page.lines[0];if(!line||line.row.kind==='text')return page;
    const side=options.round?Math.floor((Math.min(options.width,options.height)-16)/Math.SQRT2):options.width-28;
    const ratio=readerMediaRatio(line.row.block,options.ratios?.[line.row.blockIndex]);
    const height=Math.min(side,side/ratio,options.height-28),width=Math.min(side,height*ratio);
    return {...page,lines:[{...line,row:{...line.row,height},left:(options.width-width)/2,top:(options.height-height)/2,width}]};
   });resized.set(original,{ratios:options.ratios,pages:body});
  }
  const chromeKey=JSON.stringify([options.header??[],options.footer??[]]);
  let combined=compositions.get(body);if(!combined){combined=new Map();compositions.set(body,combined);}
  const existing=combined.get(chromeKey);if(existing)return existing;
  const chrome=paginateBook([],{...options,measure:measured,unloaded:undefined}).filter(page=>page.controls);
  const result=[...chrome.filter(page=>page.anchor.section==='header'),...body,...chrome.filter(page=>page.anchor.section==='footer')];
  if(combined.size>=2)combined.delete(combined.keys().next().value!);combined.set(chromeKey,result);return result;
 };
 /** Keep speculative pagination out of one indivisible service callback. */
 paginate.prepare=(blocks:readonly ContentBlock[],options:Omit<PaginationOptions,'measure'>,slices:TextLayoutSliceOptions={})=>{
  const key=configurationKey(options);let configurations=bodies.get(blocks);
  if(!configurations){configurations=new Map();bodies.set(blocks,configurations);}
  if(configurations.has(key))return {done:Promise.resolve(),cancel(){}};
  let index=0;
  return prepareTextLayout(paginateBookSteps(blocks,{...options,ratios:undefined,measure:measured,header:undefined,footer:undefined}),{
   key:()=>index++,entry:()=>undefined,publish:snapshot=>{
    if(configurations!.size>=2)configurations!.delete(configurations!.keys().next().value!);
    configurations!.set(key,snapshot.layout);
   }
  },{rowLimit:1,...slices});
 };
 return paginate;
}
