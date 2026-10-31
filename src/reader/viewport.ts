export interface ReaderViewport {left:number;top:number;width:number;height:number}
/** Safe rectangle for notices and controls. Body pages use per-line circular chords. */
export function readerControlViewport(width:number,height:number,round:boolean,pageMode:boolean):ReaderViewport {
 if(!round||!pageMode)return {left:0,top:0,width,height};
 const side=Math.max(1,Math.floor((Math.min(width,height)-8)/Math.SQRT2));
 return {left:(width-side)/2,top:(height-side)/2,width:side,height:side};
}
