import {readerFontPixels} from "./font-assets.ts";
import type {ReaderFontResolver} from "./font-assets.ts";
import type {ReaderRow,AtlasLineMetrics} from "./content-layout.ts";
import type {ContentStyle} from "./content.ts";
import {DEFAULT_READER_TEXT,resolvedReaderStyle,type ReaderPreset} from "./preset.ts";
import type {SystemTextLineOptions} from "@podjs/framework/text";
import {lazyRegExpTest} from "../core/lazy-regexp.ts";
/** Color fonts and emoji grapheme composition need the system shaper, not an outline-only atlas. */
export const requiresSystemText=lazyRegExpTest('[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\uFE0F\\u20E3]','u');
export function systemTextOptions(row:ReaderRow & {kind:"text"},style:ContentStyle,fontSize:number,width:number,pixelScale:number,preset?:ReaderPreset,metrics?:AtlasLineMetrics,resolveFont?:ReaderFontResolver,profile:"compose"|"preview"="compose"):SystemTextLineOptions{
 const spec=preset?(style==="body"?preset.body:resolvedReaderStyle(preset,style)):{...DEFAULT_READER_TEXT,fontSizeSp:fontSize*(style==="title"?1.55:style==="subtitle"?1.12:style==="code"?.9:1),fontWeight:style==="title"?700:400};
 const hex=row.color.slice(1),colorArgb=parseInt(hex.length===8?hex.slice(6)+hex.slice(0,6):"ff"+hex,16);
 const baseline=row.nativeBaseline??(metrics?((row.lineHeight-metrics.cellHeight*row.scale)/2+metrics.baseline*row.scale+(row.textOffsetY??0)):row.lineHeight*.8);
 return {...resolveFont?.(spec),...(row.nativeParagraph?{paragraph:row.nativeParagraph}:{}),textMotion:profile==="preview"?"subpixel":spec.renderMode==="LINEAR_SMOOTH"?"animated":"static",text:row.text,widthPx:Math.max(1,Math.ceil(width*pixelScale)),heightPx:Math.max(1,Math.ceil(row.lineHeight*pixelScale)),baselinePx:Math.max(0,Math.min(row.lineHeight*pixelScale,baseline*pixelScale)),fontSizePx:readerFontPixels(spec,pixelScale),fontWeight:spec.fontWeight,italic:spec.italic,underline:spec.underline,strikethrough:spec.strikethrough,letterSpacingEm:spec.letterSpacingEm,colorArgb,align:row.textAlign===1?"center":"left"};
}

export function requiresReaderSystemText(text:string,preset?:ReaderPreset,style:ContentStyle="body"):boolean {
 const spec=preset?(style==="body"?preset.body:resolvedReaderStyle(preset,style)):undefined;
 return requiresSystemText(text)||!!spec;
}
