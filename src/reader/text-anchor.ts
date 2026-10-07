import {anchorAtOffset as textAnchorAtOffset,offsetForAnchor as textOffsetForAnchor,type TextPositionAnchor} from "@podjs/framework/text-anchor";
export {lineStarts} from "@podjs/framework/text-anchor";
/** Optional media identity belongs to the reader document model. */
export interface TextAnchor extends TextPositionAnchor {mediaIndex?:number}
export function anchorAtOffset(offset:number,lineHeight:number,starts:readonly number[]):TextAnchor{return textAnchorAtOffset(offset,lineHeight,starts);}
export function offsetForAnchor(anchor:TextAnchor,lineHeight:number,starts:readonly number[],maximum:number):number{return textOffsetForAnchor(anchor,lineHeight,starts,maximum);}
