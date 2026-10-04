import type {ReaderPresetState} from './preset-store.ts';
import type {ReaderTextStyle} from './preset.ts';
import {readerResourcePath} from '../sync/reader-resources.ts';
import type {TextFontOptions} from '@podjs/framework/services';
export type ReaderFontOptions=TextFontOptions & {fontRevision?:string};
export type ReaderFontResolver=(style:ReaderTextStyle)=>ReaderFontOptions;
/** Resolve only live records; native file checks preserve system fallback for missing/corrupt files. */
export function readerFontResolver(state:Pick<ReaderPresetState,'assets'>,revision=0):ReaderFontResolver {
 const fonts=new Map((state.assets?.fonts??[]).filter(row=>!row.deleted&&typeof row.id==='string').map(row=>[row.id,row]));
 return style=>{
  const spec={fontFaceIndex:Math.max(0,Math.trunc(style.fontFaceIndex)),variationSettings:style.variationSettings};
  const row=style.fontAssetId?fonts.get(style.fontAssetId):undefined;
  if(!row||typeof row.fileName!=='string')return spec;
  try{return {...spec,fontPath:readerResourcePath('font',row.fileName),fontRevision:JSON.stringify([row.sha256,row.updatedAt,revision])};}catch{return spec;}
 };
}

/** Kotlin typography uses Float arithmetic; preserve its rounding before shaping. */
export const readerFontPixels=(style:ReaderTextStyle,pixelScale:number)=>Math.fround(Math.fround(style.fontSizeSp)*Math.fround(pixelScale));
export const readerLinePixels=(style:ReaderTextStyle,pixelScale:number)=>Math.fround(readerFontPixels(style,pixelScale)*Math.fround(style.lineHeightEm));
