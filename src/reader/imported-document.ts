import type { ContentBlock } from "./content.ts";
import { contentRows, rowAtOffset, type ContentLayout, type ReaderRow, type ReaderRows } from "./content-layout.ts";
import type { ImportedTextHandle } from "./imported-text.ts";
export interface ImportedReadingAnchor { marker:string;chunkIndex:number;charOffset:number;fraction:number;section?:"header"|"footer";sectionOffset?:number }
const byteWidth=(point:number)=>point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
export function importedBytesBefore(text:string,offset:number):number {
 let bytes=0;for(let i=0;i<Math.min(text.length,Math.max(0,offset));){const point=text.codePointAt(i)!;bytes+=byteWidth(point);i+=point>0xffff?2:1;}return bytes;
}
export function importedCharForByte(text:string,offset:number):number {
 let bytes=0,i=0;while(i<text.length){const point=text.codePointAt(i)!,width=byteWidth(point);if(bytes+width>offset)break;bytes+=width;i+=point>0xffff?2:1;}return i;
}
export function importedByteTarget(handle:ImportedTextHandle,progress:number):{chunkIndex:number;byteOffset:number} {
 const byte=Math.max(0,Math.min(Math.max(0,handle.byteLength-1),Math.floor(handle.byteLength*Math.fround(Math.max(0,Math.min(1,progress)))+.5)));
 const chunkIndex=Math.max(0,Math.min(handle.chunkCount-1,Math.floor(byte/handle.chunkBytes)));
 return {chunkIndex,byteOffset:byte-chunkIndex*handle.chunkBytes};
}
interface Chunk {block:ContentBlock & {type:"text"};layout:ContentLayout}
const unloadedBlock:ContentBlock=Object.freeze({type:"text",style:"body",text:""});
interface RowSpan {
 first:number;chunkIndex:number;top:number;height:number;
 measured?:{source:ReaderRow[];placed:ReaderRow[]};
}
/** Unseen chunks form uniform runs. Measured or evicted chunks keep their
 * exact height and source slot, including zero-height evicted blank chunks. */
function importedLayout(count:number,chunks:ReadonlyMap<number,Chunk>,heights:ReadonlyMap<number,number>):ContentLayout {
 const spans:RowSpan[]=[];
 let length=0,top=0,chunkIndex=0;
 const blanks=(end:number,height:number)=>{
  while(chunkIndex<end){
   let size=end-chunkIndex;
   if(size>1&&!Number.isInteger(top)){
    // Adding the integer gap is exact until the next power of two changes
    // floating-point precision. Split there to preserve sequential row edges.
    let boundary=2**Math.ceil(Math.log2(top));if(boundary<=top)boundary*=2;
    size=Math.min(size,Math.max(1,Math.floor((boundary-top)/height)));
   }
   spans.push({first:length,chunkIndex,top,height});
   length+=size;top+=size*height;chunkIndex+=size;
  }
 };
 const unseen=(end:number)=>{
  if(chunkIndex===0&&end>0)blanks(1,1);
  blanks(end,6);
 };
 for(const index of [...heights.keys()].sort((a,b)=>a-b)){
  unseen(index);
  const chunk=chunks.get(index),height=heights.get(index)!;
  if(!chunk){blanks(index+1,height);continue;}
  const source=chunk.layout.rows;
  if(source.length)spans.push({first:length,chunkIndex:index,top,height,measured:{source,placed:[]}});
  length+=source.length;top+=height;chunkIndex=index+1;
 }
 unseen(count);
 let dense:ReaderRow[]|undefined;
 const indexedRows:ReaderRows={length,at(index){
  index=Math.trunc(index)||0;if(index<0)index+=length;
  if(index<0||index>=length)return;
  if(dense)return dense[index];
  let low=0,high=spans.length;
  while(low+1<high){const mid=(low+high)>>>1;if(spans[mid]!.first<=index)low=mid;else high=mid;}
  const span=spans[low]!,line=index-span.first;
  if(span.measured){
   const {source,placed}=span.measured;
   if(placed[line])return placed[line];
   const row=source[line]!,gap=span.chunkIndex?6:0;
   return placed[line]={...row,blockIndex:span.chunkIndex,top:span.top+row.top+(line?gap:0),
    height:row.height+(line?0:gap),gap:row.gap+(line?0:gap)};
  }
  return {kind:"text",text:"",blockIndex:span.chunkIndex+line,character:0,sourceStart:0,top:span.top+line*span.height,
   height:span.height,gap:0,fontSlot:1,scale:1,color:"#00000000",lineHeight:span.height};
 }};
 return {indexedRows,height:top,textLength:0,get rows(){return dense??=Array.from({length},(_,i)=>indexedRows.at(i)!);}};
}
/** Native-style lazy chunks. Heights of unseen chunks are placeholders, never estimated text. */
export class ImportedReaderDocument {
 private chunks=new Map<number,Chunk>();
 // Retain three text/layout windows; evicted windows keep only measured height.
 private heights=new Map<number,number>();
 private busy=false;
 private closed=false;
 private epoch=0;
 private cached:ContentLayout|undefined;
 constructor(readonly handle:ImportedTextHandle,private readonly read:(index:number)=>Promise<string|null>,
   private readonly measure:(block:ContentBlock)=>Promise<ContentLayout>,private readonly changed:()=>void) {}
 get loading(){return this.busy;}
 text(index:number){return this.chunks.get(index)?.block.text;}
 blocks():ContentBlock[]{
  // A new array identifies a new pagination snapshot. Unloaded entries have
  // identical immutable content, irrespective of their source index.
  const blocks=new Array<ContentBlock>(this.handle.chunkCount).fill(unloadedBlock);
  for(const [index,chunk] of this.chunks)blocks[index]=chunk.block;
  return blocks;
 }
 layout():ContentLayout {
  return this.cached??=importedLayout(this.handle.chunkCount,this.chunks,this.heights);
 }
 private publish(){this.cached=undefined;this.changed();}
 async ensure(index:number):Promise<void>{
  if(this.closed||this.busy||index<0||index>=this.handle.chunkCount||this.chunks.has(index))return;
  const epoch=this.epoch;this.busy=true;
  try{
   const text=await this.read(index);if(this.closed||epoch!==this.epoch)return;
   if(text===null)throw new Error("加载失败可重试");
   const block:ContentBlock & {type:"text"}={type:"text",style:"body",text:text??""};
   const layout=text!==null&&/[^\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(text)?await this.measure(block):{rows:[],height:0,textLength:0};
   if(this.closed||epoch!==this.epoch)return;
   this.chunks.set(index,{block,layout});
   this.heights.set(index,layout.rows.length?layout.height+(index?6:0):0);
   while(this.chunks.size>3)this.chunks.delete(this.chunks.keys().next().value!);
   this.publish();
  }finally{if(epoch===this.epoch)this.busy=false;}
 }
 async visible(offset:number,height:number):Promise<void>{
  if(this.busy||this.closed)return;
  const rows=contentRows(this.layout()),first=rowAtOffset(rows,Math.max(0,offset));
  for(let i=first;i<rows.length;i++){
   const row=rows.at(i)!;if(row.top>offset+height+80)break;
   const index=row.blockIndex;if(!this.chunks.has(index)&&this.heights.get(index)!==0){await this.ensure(index);return;}
  }
 }
 async relayout():Promise<void>{
  const epoch=++this.epoch;this.busy=true;
  try{
   const next=new Map<number,Chunk>(),heights=new Map<number,number>();
   for(const [index,chunk] of this.chunks){
    const layout=chunk.layout.rows.length?await this.measure(chunk.block):chunk.layout;
    if(this.closed||epoch!==this.epoch)return;next.set(index,{...chunk,layout});heights.set(index,layout.rows.length?layout.height+(index?6:0):0);
   }
   if(this.closed||epoch!==this.epoch)return;this.chunks=next;this.heights=heights;this.publish();
  }finally{if(epoch===this.epoch)this.busy=false;}
 }
 anchor(offset:number,header:number,layout=this.layout()):ImportedReadingAnchor|null {
  const base={marker:this.handle.marker,chunkIndex:0,charOffset:0,fraction:0};
  if(offset<header)return {...base,section:"header",sectionOffset:Math.max(0,offset)};
  if(offset>=header+layout.height)return {...base,chunkIndex:Math.max(0,this.handle.chunkCount-1),section:"footer",sectionOffset:offset-header-layout.height};
  const rows=contentRows(layout),row=rows.at(rowAtOffset(rows,offset-header));if(!row||!this.chunks.has(row.blockIndex))return null;
  return {...base,chunkIndex:row.blockIndex,charOffset:row.sourceStart??0,fraction:Math.max(0,Math.min(.999,(offset-header-row.top-row.gap)/Math.max(1,row.height-row.gap)))};
 }
 offset(anchor:ImportedReadingAnchor,header:number,max:number):number{
  const layout=this.layout();if(anchor.section==="header")return Math.min(max,anchor.sectionOffset??0);
  if(anchor.section==="footer")return Math.min(max,header+layout.height+(anchor.sectionOffset??0));
  const rows=contentRows(layout);
  let low=0,high=rows.length;
  while(low<high){
   const mid=(low+high)>>>1,row=rows.at(mid)!;
   if(row.blockIndex<anchor.chunkIndex||row.blockIndex===anchor.chunkIndex&&(row.sourceStart??0)<=anchor.charOffset)low=mid+1;else high=mid;
  }
  const before=low>0?rows.at(low-1):undefined,after=rows.at(low);
  const chosen=before?.blockIndex===anchor.chunkIndex?before:after?.blockIndex===anchor.chunkIndex?after:undefined;
  return chosen?Math.max(0,Math.min(max,header+chosen.top+chosen.gap+anchor.fraction*(chosen.height-chosen.gap))):Math.min(max,header);
 }
 progress(anchor:ImportedReadingAnchor):number {
  if(anchor.section==="header")return 0;if(anchor.section==="footer")return 1;
  return Math.fround(Math.max(0,Math.min(1,(anchor.chunkIndex*this.handle.chunkBytes+importedBytesBefore(this.text(anchor.chunkIndex)??"",anchor.charOffset))/Math.max(1,this.handle.byteLength))));
 }
 close(){this.closed=true;this.epoch++;this.chunks.clear();this.heights.clear();this.cached=undefined;}
}
