import type {JsonObject} from './protocol.ts';
/** The host exposes display size, but no decoder enumeration, refresh rate or
 * free-space query. Do not invent Android codec support from media.video. */
export function buildWatchMediaCapabilities(display:{physicalWidth:number;physicalHeight:number}):JsonObject {
 const size=(n:number)=>Number.isFinite(n)&&n>0?Math.floor(n):0;
 return {widthPx:size(display.physicalWidth),heightPx:size(display.physicalHeight),videoDecoders:[]};
}
