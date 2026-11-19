import type {ContentBlock} from './content';
import {rowAtOffset,type ContentLayout,type ContentAnchor,type ReaderRow} from './content-layout';
import {readerTextChunks} from './platform-layout';
export interface ReaderWindowPart {block:ContentBlock;blockIndex:number;sourceStart:number;character:number;continues:boolean}
interface Part {blockIndex:number;start:number;end:number;character:number}
interface Group {parts:Part[];character:number}
export function needsReaderWindows(blocks:readonly ContentBlock[]):boolean {
 return blocks.length>256||blocks.reduce((n,b)=>n+(b.type==='text'?b.text.length:0),0)>32768;
}
/** Only three measured windows retain rows, raster descriptions and native layouts.
 * Other windows retain source ranges and previously measured heights, not lines. */
export class WindowedReaderDocument {
 private groups:Group[]=[];
 private windows=new Map<number,ContentLayout>();
 private heights=new Map<number,number>();
 private cached:ContentLayout|undefined;
 private epoch=0;private closed=false;private busy=false;
 private length=0;private maximum=3;
 private ranges=new Map<number,{start:number;end:number;group:number}[]>();
 constructor(private source:readonly ContentBlock[],private readonly measure:(parts:readonly ReaderWindowPart[])=>Promise<readonly ContentLayout[]>,private readonly changed:()=>void){
  let parts:Part[]=[],units=0;
  const flush=()=>{if(parts.length){const group=this.groups.length;this.groups.push({parts,character:parts[0]!.character});for(const part of parts){let ranges=this.ranges.get(part.blockIndex);if(!ranges){ranges=[];this.ranges.set(part.blockIndex,ranges);}ranges.push({start:part.start,end:part.end,group});}}parts=[];units=0;};
  source.forEach((block,blockIndex)=>{
   if(block.type==='text'){
    let normalized=0;
    for(const chunk of readerTextChunks(block.text,2048)){
     if(parts.length&&(parts.length>=16||units+chunk.text.length>2048))flush();
     parts.push({blockIndex,start:chunk.offset,end:chunk.offset+chunk.text.length,character:this.length+normalized});
     units+=chunk.text.length;normalized+=chunk.text.replace(/\r\n?/g,'\n').length;
    }
    this.length+=normalized+1;
   }else{if(parts.length>=16)flush();parts.push({blockIndex,start:0,end:0,character:this.length});}
  });flush();this.length=Math.max(0,this.length-1);
 }
 get loading(){return this.busy;}
 get retainedWindows(){return this.windows.size;}
 get windowCount(){return this.groups.length;}
 private parts(index:number):ReaderWindowPart[]{return this.groups[index]!.parts.map(part=>{
  const source=this.source[part.blockIndex]!;
  return {block:source.type==='text'?{...source,text:source.text.slice(part.start,part.end)}:source,blockIndex:part.blockIndex,sourceStart:part.start,character:part.character,continues:source.type==='text'&&part.end<source.text.length};
 });}
 private async measured(index:number):Promise<ContentLayout>{
  const parts=this.parts(index),layouts=await this.measure(parts);
  if(layouts.length!==parts.length)throw Error('Invalid reader window layouts');
  const rows:ReaderRow[]=[];let top=0;
  parts.forEach((part,index)=>{
   const measured=layouts[index]!,values=measured.rows.slice();let height=measured.height;
   const last=values.at(-1);
   if(part.continues&&part.block.type==='text'&&part.block.text.endsWith('\n')&&last?.kind==='text'&&last.sourceStart===part.block.text.length&&last.text===''){values.pop();height-=last.height;}
   const gap=part.blockIndex>0&&part.sourceStart===0?6:0;
   values.forEach((row,line)=>rows.push({...row,blockIndex:part.blockIndex,sourceStart:part.sourceStart+(row.sourceStart??0),character:part.character+row.character,top:top+row.top+(line?gap:0),height:row.height+(line?0:gap),gap:row.gap+(line?0:gap)}));
   top+=height+(values.length?gap:0);
  });return {rows,height:top,textLength:this.length};
 }
 private publish(){this.cached=undefined;this.changed();}
 layout():ContentLayout {
  if(this.cached)return this.cached;
  const rows:ReaderRow[]=[];let top=0;
  this.groups.forEach((group,index)=>{
   const known=this.windows.get(index);
   if(known){for(const row of known.rows)rows.push({...row,top:top+row.top});top+=known.height;}
   else{const first=group.parts[0]!,height=this.heights.get(index)??(index?6:1);if(height)rows.push({kind:'text',text:'',fontSlot:1,scale:1,color:'#00000000',lineHeight:height,blockIndex:first.blockIndex,sourceStart:first.start,character:first.character,top,height,gap:0});top+=height;}
  });return this.cached={rows,height:top,textLength:this.length};
 }
 async ensure(index:number):Promise<void>{
  if(this.closed||index<0||index>=this.groups.length)return;
  const known=this.windows.get(index);if(known){this.windows.delete(index);this.windows.set(index,known);return;}
  if(this.busy)return;const epoch=this.epoch;this.busy=true;
  try{const value=await this.measured(index);if(this.closed||epoch!==this.epoch)return;
   this.windows.set(index,value);this.heights.set(index,value.height);
   while(this.windows.size>this.maximum)this.windows.delete(this.windows.keys().next().value!);
   this.publish();
  }finally{if(epoch===this.epoch)this.busy=false;}
 }
 private groupFor(anchor:ContentAnchor&{section?:'header'|'footer'}):number {
  if(anchor.section==='header')return 0;if(anchor.section==='footer')return this.groups.length-1;
  if(anchor.mediaIndex!==undefined){const first=this.ranges.get(anchor.mediaIndex)?.[0];if(first)return first.group;}
  let low=0,high=this.groups.length;
  while(low<high){const mid=(low+high)>>>1;if(this.groups[mid]!.character<=anchor.character)low=mid+1;else high=mid;}
  return Math.max(0,low-1);
 }
 private groupForSource(blockIndex:number,offset:number):number{const ranges=this.ranges.get(blockIndex);if(!ranges?.length)return -1;let low=0,high=ranges.length;while(low<high){const mid=(low+high)>>>1;if(ranges[mid]!.start<=offset)low=mid+1;else high=mid;}return ranges[Math.max(0,low-1)]!.group;}
 ensureSource(blockIndex:number,offset:number){return this.ensure(this.groupForSource(blockIndex,offset));}
 ensureAnchor(anchor:ContentAnchor&{section?:'header'|'footer'}){return this.ensure(this.groupFor(anchor));}
 async visible(offset:number,height:number):Promise<void>{
  if(this.closed||this.busy)return;
  const rows=this.layout().rows,first=rowAtOffset(rows,Math.max(0,offset));
  for(let i=first;i<rows.length&&rows[i]!.top<=offset+height+80;i++){
   const row=rows[i]!;
   const index=this.groupForSource(row.blockIndex,row.sourceStart??0);
   if(index>=0&&!this.windows.has(index)){await this.ensure(index);return;}
  }
 }
 trimMemory(anchor:ContentAnchor&{section?:'header'|'footer'},level:number){
  this.maximum=level>0?2:3;const keep=this.groupFor(anchor);let changed=false;
  while(this.windows.size>this.maximum){const victim=[...this.windows.keys()].filter(index=>index!==keep).sort((a,b)=>Math.abs(b-keep)-Math.abs(a-keep))[0];if(victim===undefined)break;this.windows.delete(victim);changed=true;}
  if(changed)this.publish();
 }
 async relayout():Promise<void>{
  const epoch=++this.epoch;this.busy=true;
  try{const next=new Map<number,ContentLayout>(),heights=new Map<number,number>();
   for(const index of this.windows.keys()){const value=await this.measured(index);if(this.closed||epoch!==this.epoch)return;next.set(index,value);heights.set(index,value.height);}
   if(this.closed||epoch!==this.epoch)return;this.windows=next;this.heights=heights;this.publish();
  }finally{if(epoch===this.epoch)this.busy=false;}
 }
 close(){this.closed=true;this.epoch++;this.windows.clear();this.heights.clear();this.groups=[];this.ranges.clear();this.source=[];this.length=0;this.cached=undefined;}
}
