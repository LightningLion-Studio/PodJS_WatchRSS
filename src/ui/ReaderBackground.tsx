import {createMemo,createEffect,createSignal,onCleanup,Show} from 'solid-js';
import {View} from '@pocketjs/framework/components';
import {getDisplayMetrics,hasCapability} from '@podjs/framework/watch';
import {fileChunks} from '@podjs/framework/services';
import {MediaSurface} from '@podjs/framework/media-surface';
import type {ReaderBackground as Background} from '../reader/preset.ts';
import {ReaderPresetStore,onReaderPresetsChanged} from '../reader/preset-store.ts';
import {readerBackgroundResources,selectReaderBackgroundFiles,readerBackgroundStyle,type ReaderBackgroundSnapshot} from '../reader/background-assets.ts';
import {readerColor} from '../reader/content-layout.ts';
export function useReaderBackgrounds(){
 const store=new ReaderPresetStore(),[revision,setRevision]=createSignal(0);onCleanup(onReaderPresetsChanged(()=>setRevision(v=>v+1)));
 return createMemo<ReaderBackgroundSnapshot>(()=>({state:store.load(),revision:revision()}));
}
export function ReaderBackground(props:{background:Background;snapshot:ReaderBackgroundSnapshot;width:number;height:number;active:boolean}){
 const resourceKey=createMemo(()=>JSON.stringify([props.background.type,props.background.assetId]));
 const resources=createMemo(()=>{const [type,assetId]=JSON.parse(resourceKey());return readerBackgroundResources({type,assetId},props.snapshot);});
 const revision=createMemo(()=>resources().revision);
 const [files,setFiles]=createSignal<Awaited<ReturnType<typeof selectReaderBackgroundFiles>>>(undefined,{equals:(a,b)=>a?.kind===b?.kind&&a?.path===b?.path&&a?.posterPath===b?.posterPath});
 createEffect(()=>{const value=resources();let cancelled=false;
  void selectReaderBackgroundFiles(value,async path=>(await fileChunks.stat(path)).file).then(next=>{if(!cancelled)setFiles(next);}).catch(()=>{if(!cancelled)setFiles(undefined);});
  onCleanup(()=>{cancelled=true;});
 });
 const pixelScale=()=>{const m=getDisplayMetrics();return m.physicalWidth/m.logicalWidth;};
 const overlay=()=>readerColor((props.background.overlayColorArgb&0xffffff)|(Math.round(props.background.overlayOpacity*255)<<24));
 return <View accessibilityHidden class="absolute inset-0 overflow-hidden" style={{bgColor:readerColor(props.background.colorArgb)}}>
  <Show when={props.background.overlayOpacity>0}><View class="absolute inset-0" style={{bgColor:overlay()}}/></Show>
  <Show when={(files()||props.background.overlayOpacity>0)&&hasCapability(files()?.kind==='video'?'media.video':'data.images')}><MediaSurface kind={files()?.kind??'image'} path={files()?.path} posterPath={files()?.posterPath} revision={revision()} widthPx={Math.round(props.width*pixelScale())} heightPx={Math.round(props.height*pixelScale())} pixelScale={pixelScale()} style={readerBackgroundStyle(props.background,pixelScale(),props.active)}/></Show>
 </View>;
}
