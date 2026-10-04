import type {ContentLayout,ReaderRow} from "./content-layout.ts";
import type {SpeechHighlight} from "./speech-highlight.ts";
export interface HighlightRect {left:number;top:number;width:number;height:number}
export interface HighlightFont {fontSlot:number;scale:number;lineHeight:number;tracking?:number;textAlign?:number}
export function lineHighlightRect(text:string,width:number,font:HighlightFont,start:number,end:number,measure:(text:string,slot:number)=>number,carets?:readonly number[]):HighlightRect|undefined {
  start=Math.max(0,Math.min(text.length,start));end=Math.max(start,Math.min(text.length,end));
  if(end<=start)return undefined;
  if(carets&&carets.length===text.length+1){const left=carets[start]!,right=carets[end]!;return {left:Math.min(left,right),top:0,width:Math.abs(right-left),height:font.lineHeight};}
  const advance=(value:string)=>measure(value,font.fontSlot)*font.scale+Math.max(0,Array.from(value).length-1)*(font.tracking??0);
  const offset=font.textAlign===1?(width-advance(text))/2:0;
  const left=offset+advance(text.slice(0,start)),right=offset+advance(text.slice(0,end));
  return {left,top:0,width:Math.max(0,right-left),height:font.lineHeight};
}
/** Only visit the active segment's rows; unrelated novel pages need no text measurements. */
export function contentHighlightRects(layout:ContentLayout,highlight:SpeechHighlight|undefined,width:number,measure:(text:string,slot:number)=>number,carets?:ReadonlyMap<ReaderRow,readonly number[]>):Map<ReaderRow,HighlightRect> {
  const result=new Map<ReaderRow,HighlightRect>();
  if(!highlight||highlight.isTitle||highlight.contentBlockIndex===undefined)return result;
  const block=highlight.contentBlockIndex,rows=layout.rows;
  let low=0,high=rows.length;
  while(low<high){const mid=(low+high)>>>1,row=rows[mid]!;if(row.blockIndex<block||(row.blockIndex===block&&row.kind==="text"&&(row.sourceStart??0)+row.text.length<=highlight.sourceStart))low=mid+1;else high=mid;}
  for(let index=low;index<rows.length;index++){
    const row=rows[index]!;
    if(row.blockIndex!==block)break;
    if(row.kind!=="text")continue;
    const start=row.sourceStart??0;if(start>=highlight.sourceEnd)break;
    const rect=lineHighlightRect(row.text,width,row,highlight.sourceStart-start,highlight.sourceEnd-start,measure,carets?.get(row));
    if(rect)result.set(row,{...rect,top:row.gap});
  }
  return result;
}
/** Watch titles remove selected whitespace. Retain source positions through that formatting. */
export function titleHighlightRects(raw:string,lines:readonly string[],highlight:SpeechHighlight|undefined,width:number,font:HighlightFont,measure:(text:string,slot:number)=>number,lineBoxes?:readonly {top:number;height:number}[],carets?:readonly (readonly number[]|undefined)[]):HighlightRect[] {
  if(!highlight?.isTitle)return [];
  const result:HighlightRect[]=[];let cursor=0;
  lines.forEach((line,index)=>{
    let first=-1,last=-1;
    for(let offset=0;offset<line.length;offset++){
      const char=line[offset]!;
      if(char===" "){while(cursor<raw.length&&!/\s/.test(raw[cursor]!))cursor++;}
      else {const found=raw.indexOf(char,cursor);if(found<0)continue;cursor=found;}
      if(cursor>=highlight.sourceStart&&cursor<highlight.sourceEnd){if(first<0)first=offset;last=offset+1;}
      cursor++;
    }
    if(first>=0){const box=lineBoxes?.[index],rect=lineHighlightRect(line,width,{...font,lineHeight:box?.height??font.lineHeight,textAlign:1},first,last,measure,carets?.[index]);if(rect)result.push({...rect,top:box?.top??index*font.lineHeight});}
  });
  return result;
}
export function highlightCenter(rects:Iterable<{top:number;height:number}>):number|undefined {
  let top=Infinity,bottom=-Infinity;
  for(const rect of rects){top=Math.min(top,rect.top);bottom=Math.max(bottom,rect.top+rect.height);}
  return Number.isFinite(top)?(top+bottom)/2:undefined;
}
