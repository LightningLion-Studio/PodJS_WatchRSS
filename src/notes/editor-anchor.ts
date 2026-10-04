import {memoPlainText} from './text.ts';

export interface NoteLineAnchor {
  renderedText:string;
  mappingText:string;
  renderedStart:number;
  sourceMarkup:string;
  sourceStart:number|null;
  fontSlot:number;
  scale?:number;
  tracking?:number;
  inset:number;
}
export interface NotePositionedAnchor {anchor:NoteLineAnchor;x:number;y:number;width:number;height:number}
export interface NoteAnchorEntry {height:number;anchor?:NoteLineAnchor;positionedAnchors?:()=>readonly NotePositionedAnchor[]}

/** Port of NotesActivity.mapNoteTextAnchorOffset for a displayed text block. */
export function mapNoteTextAnchorOffset(sourceText:string,targetText:string,sourceOffset:number):number {
  if(!targetText)return 0;
  if(!sourceText)return Math.max(0,Math.min(targetText.length,sourceOffset));
  const safe=Math.max(0,Math.min(sourceText.length,sourceOffset));
  if(sourceText===targetText)return safe;
  if(memoPlainText(sourceText)===targetText)return Math.min(targetText.length,memoPlainText(sourceText.slice(0,safe)).length);
  if(memoPlainText(targetText)===sourceText){
    let low=0,high=targetText.length;
    while(low<high){const middle=(low+high)>>>1;if(memoPlainText(targetText.slice(0,middle)).length<safe)low=middle+1;else high=middle;}
    return low;
  }
  for(const radius of [32,24,16,12,8]){
    const start=Math.max(0,safe-radius),end=Math.min(sourceText.length,safe+radius),anchor=sourceText.slice(start,end).trim();
    if(anchor.length<4)continue;
    const match=targetText.indexOf(anchor);
    if(match>=0)return Math.max(0,Math.min(targetText.length,match+safe-start));
  }
  return Math.max(0,Math.min(targetText.length,Math.trunc(targetText.length*safe/sourceText.length)));
}

function caretAtX(line:string,x:number,measure:(text:string,slot:number)=>number,slot:number,scale=1,tracking=0):number {
  if(x<=0)return 0;
  const starts=[0];for(const cp of line)starts.push(starts.at(-1)!+cp.length);
  const width=(end:number)=>measure(line.slice(0,end),slot)*scale+Math.max(0,Array.from(line.slice(0,end)).length-1)*tracking;
  let low=0,high=starts.length-1;
  while(low<high){const middle=(low+high)>>>1;if(width(starts[middle])<x)low=middle+1;else high=middle;}
  if(low===0)return 0;
  const previous=starts[low-1]!,current=starts[low]!;
  return x-width(previous)<=width(current)-x?previous:current;
}

/** Finds the nearest displayed text line to the watch center and maps its caret to raw Markdown. */
export function noteEditorAnchor(entries:readonly NoteAnchorEntry[],markdown:string,scrollOffset:number,width:number,height:number,measure:(text:string,slot:number)=>number,layout:{top?:number;gap?:number;horizontalInset?:number}={}):number {
  const targetY=scrollOffset+height/2,targetX=width/2-(layout.horizontalInset??18);
  let top=layout.top??18,best:NoteLineAnchor|undefined,bestX=targetX,bestDistance=Infinity;
  for(const entry of entries){
    if(entry.anchor){
      const distance=targetY<top?top-targetY:targetY>top+entry.height?targetY-top-entry.height:0;
      if(distance<bestDistance){best=entry.anchor;bestX=targetX-entry.anchor.inset;bestDistance=distance;}
    }
    for(const region of entry.positionedAnchors?.()??[]){
      const left=region.x,right=left+region.width,regionTop=top+region.y,bottom=regionTop+region.height;
      const dx=targetX<left?left-targetX:targetX>right?targetX-right:0;
      const dy=targetY<regionTop?regionTop-targetY:targetY>bottom?targetY-bottom:0;
      const distance=Math.hypot(dx,dy);
      if(distance<bestDistance){best=region.anchor;bestX=targetX-left;bestDistance=distance;}
    }
    top+=entry.height+(layout.gap??2);
  }
  if(!best)return 0;
  const caret=caretAtX(best.renderedText,Math.max(0,bestX),measure,best.fontSlot,best.scale,best.tracking);
  const displayOffset=best.renderedStart+caret;
  return Math.max(0,Math.min(markdown.length,best.sourceStart===null
    ?mapNoteTextAnchorOffset(best.mappingText,markdown,displayOffset)
    :best.sourceStart+mapNoteTextAnchorOffset(best.mappingText,best.sourceMarkup,displayOffset)));
}
