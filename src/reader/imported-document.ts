import type { ContentBlock } from "./content.ts";
import { rowAtOffset, type ContentLayout, type ReaderRow } from "./content-layout.ts";
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
/** Native-style lazy chunks. Heights of unseen chunks are placeholders, never estimated text. */
export class ImportedReaderDocument {
 private chunks=new Map<number,Chunk>();
 private busy=false;
 private closed=false;
 private epoch=0;
 private cached:ContentLayout|undefined;
 constructor(readonly handle:ImportedTextHandle,private readonly read:(index:number)=>Promise<string|null>,
   private readonly measure:(block:ContentBlock)=>Promise<ContentLayout>,private readonly changed:()=>void) {}
 get loading(){return this.busy;}
 text(index:number){return this.chunks.get(index)?.block.text;}
 blocks():ContentBlock[]{return Array.from({length:this.handle.chunkCount},(_,index)=>this.chunks.get(index)?.block??{type:"text",style:"body",text:""});}
 layout():ContentLayout {
  if(this.cached)return this.cached;
  const rows:ReaderRow[]=[];let top=0;
  for(let index=0;index<this.handle.chunkCount;index++){
   const chunk=this.chunks.get(index),gap=index?6:0;
   if(!chunk){const height=index?6:1;rows.push({kind:"text",text:"",blockIndex:index,character:0,sourceStart:0,top,height,gap:0,fontSlot:1,scale:1,color:"#00000000",lineHeight:height});top+=height;continue;}
   for(const row of chunk.layout.rows)rows.push({...row,blockIndex:index,top:top+row.top+(row===chunk.layout.rows[0]?0:gap),height:row.height+(row===chunk.layout.rows[0]?gap:0),gap:row.gap+(row===chunk.layout.rows[0]?gap:0)});
   top+=chunk.layout.rows.length?chunk.layout.height+gap:0;
  }
  return this.cached={rows,height:top,textLength:0};
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
   this.chunks.set(index,{block,layout});this.publish();
  }finally{if(epoch===this.epoch)this.busy=false;}
 }
 async visible(offset:number,height:number):Promise<void>{
  if(this.busy||this.closed)return;
  const rows=this.layout().rows,first=rowAtOffset(rows,Math.max(0,offset));
  for(let i=first;i<rows.length&&rows[i]!.top<=offset+height+80;i++){
   const index=rows[i]!.blockIndex;if(!this.chunks.has(index)){await this.ensure(index);return;}
  }
 }
 async relayout():Promise<void>{
  const epoch=++this.epoch;this.busy=true;
  try{
   const next=new Map<number,Chunk>();
   for(const [index,chunk] of this.chunks){
    const layout=chunk.layout.rows.length?await this.measure(chunk.block):chunk.layout;
    if(this.closed||epoch!==this.epoch)return;next.set(index,{...chunk,layout});
   }
   if(this.closed||epoch!==this.epoch)return;this.chunks=next;this.publish();
  }finally{if(epoch===this.epoch)this.busy=false;}
 }
 anchor(offset:number,header:number,layout=this.layout()):ImportedReadingAnchor|null {
  const base={marker:this.handle.marker,chunkIndex:0,charOffset:0,fraction:0};
  if(offset<header)return {...base,section:"header",sectionOffset:Math.max(0,offset)};
  if(offset>=header+layout.height)return {...base,chunkIndex:Math.max(0,this.handle.chunkCount-1),section:"footer",sectionOffset:offset-header-layout.height};
  const row=layout.rows[rowAtOffset(layout.rows,offset-header)];if(!row||!this.chunks.has(row.blockIndex))return null;
  return {...base,chunkIndex:row.blockIndex,charOffset:row.sourceStart??0,fraction:Math.max(0,Math.min(.999,(offset-header-row.top-row.gap)/Math.max(1,row.height-row.gap)))};
 }
 offset(anchor:ImportedReadingAnchor,header:number,max:number):number{
  const layout=this.layout();if(anchor.section==="header")return Math.min(max,anchor.sectionOffset??0);
  if(anchor.section==="footer")return Math.min(max,header+layout.height+(anchor.sectionOffset??0));
  let chosen:ReaderRow|undefined;
  for(const row of layout.rows){if(row.blockIndex!==anchor.chunkIndex)continue;if(!chosen||(row.sourceStart??0)<=anchor.charOffset)chosen=row;else break;}
  return chosen?Math.max(0,Math.min(max,header+chosen.top+chosen.gap+anchor.fraction*(chosen.height-chosen.gap))):Math.min(max,header);
 }
 progress(anchor:ImportedReadingAnchor):number {
  if(anchor.section==="header")return 0;if(anchor.section==="footer")return 1;
  return Math.fround(Math.max(0,Math.min(1,(anchor.chunkIndex*this.handle.chunkBytes+importedBytesBefore(this.text(anchor.chunkIndex)??"",anchor.charOffset))/Math.max(1,this.handle.byteLength))));
 }
 close(){this.closed=true;this.epoch++;this.chunks.clear();this.cached=undefined;}
}
