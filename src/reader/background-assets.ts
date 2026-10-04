import type {ReaderPresetState} from './preset-store.ts';
import type {ReaderBackground} from './preset.ts';
import type {MediaSurfaceStyle} from '@podjs/framework/services';
import {readerResourcePath} from '../sync/reader-resources.ts';
export interface ReaderBackgroundResources {imagePaths:string[];videoPath?:string;revision:string}
export interface ReaderBackgroundSnapshot {state:Pick<ReaderPresetState,'assets'>;revision:number}
/** Native watch selects the watch variant (video: watchPoster), falling back to
 * the master for the still image. Video playback requires the watch variant. */
export function readerBackgroundResources(background:Pick<ReaderBackground,'type'|'assetId'>,snapshot:ReaderBackgroundSnapshot):ReaderBackgroundResources {
 const empty={imagePaths:[],revision:String(snapshot.revision)};
 if(background.type==='SOLID')return empty;
 const asset=snapshot.state.assets?.backgrounds.find(row=>row.id===background.assetId&&!row.deleted);
 if(!asset)return empty;
 let variants:Record<string,{fileName?:unknown}>={};try{const raw=JSON.parse(String(asset.variantsJson));if(raw&&typeof raw==='object')variants=raw;}catch{}
 const path=(kind:'background'|'variant',name:unknown)=>{if(typeof name!=='string')return undefined;try{return readerResourcePath(kind,name);}catch{return undefined;}};
 const still=path('variant',variants[asset.kind==='VIDEO'?'watchPoster':'watch']?.fileName),master=path('background',asset.masterFileName);
 return {imagePaths:[still,master].filter((p):p is string=>!!p),...(background.type==='VIDEO'&&asset.kind==='VIDEO'?{videoPath:path('variant',variants.watch?.fileName)}:{}),revision:JSON.stringify([asset.sha256,asset.updatedAt,asset.variantsJson,snapshot.revision])};
}
export async function selectReaderBackgroundFiles(resources:ReaderBackgroundResources,exists:(path:string)=>Promise<boolean>){
 let imagePath:string|undefined;for(const path of resources.imagePaths){if(await exists(path)){imagePath=path;break;}}
 const videoPath=resources.videoPath&&await exists(resources.videoPath)?resources.videoPath:undefined;
 return videoPath?{kind:'video' as const,path:videoPath,posterPath:imagePath}:imagePath?{kind:'image' as const,path:imagePath}:undefined;
}
/** Trim and posterAssetId are wire metadata; native watch playback uses its
 * already prepared watch variant and does not apply them a second time. */
export function readerBackgroundStyle(background:ReaderBackground,pixelScale:number,active:boolean):MediaSurfaceStyle {
 return {fit:background.fit.toLowerCase() as 'crop'|'fit'|'fill',zoom:background.zoom,focusX:background.focusX,focusY:background.focusY,rotationDegrees:background.rotationDegrees,
  blurPx:Math.fround(Math.fround(background.blurDp)*Math.fround(pixelScale)),brightness:background.brightness,saturation:background.saturation,colorArgb:background.colorArgb,overlayColorArgb:background.overlayColorArgb,overlayOpacity:background.overlayOpacity,speed:background.videoSpeed,loop:background.loop,active};
}
