import type {ContentBlock} from './content.ts';
type MediaBlock=Exclude<ContentBlock,{type:'text'}>;
/** Decoded source geometry wins over HTML hints. Unknown images start square;
 * video retains its conventional preview. The image itself uses contain. */
export function readerMediaRatio(block:MediaBlock,measured?:number):number {
 const valid=(value:number|undefined):value is number=>value!==undefined&&Number.isFinite(value)&&value>0;
 if(valid(measured))return measured;
 if(block.type==='image'){
  if(valid(block.width)&&valid(block.height)&&block.width>1&&block.height>1)return block.width/block.height;
  if(valid(block.aspectRatio))return block.aspectRatio;
 }
 return block.type==='video'?16/9:1;
}
export function readerMediaHeight(block:MediaBlock,width:number,measured?:number,viewportHeight=width):number {
 const maximum=Math.max(1,viewportHeight),minimum=Math.min(32,maximum);
 return Math.max(minimum,Math.min(maximum,Math.max(1,width)/readerMediaRatio(block,measured)));
}
