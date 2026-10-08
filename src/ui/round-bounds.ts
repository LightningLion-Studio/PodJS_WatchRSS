import type {ScrollEntry} from './ScrollEntries.tsx';

/** Upper-bound advance of a single text line without measuring (CJK = size, other = 2/3 size). */
export const textWidthBound=(text:string,size:number)=>Array.from(text).reduce((width,ch)=>width+(ch.codePointAt(0)!>255?size:size*2/3),0);
/** Bounds of narrow content centred in a row of `rowWidth`, so round lists do not treat it as full width. */
export const centredBounds=(rowWidth:number,width:number,top:number,height:number):NonNullable<ScrollEntry['bounds']>=>({x:(rowWidth-width)/2,y:top,width,height});
