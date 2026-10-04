import {MediaSurface} from '@podjs/framework/media-surface';
import {delay,mediaSurfaces,type HostOperation,type MediaSurfaceState,type MediaSurfaceStyle} from '@podjs/framework/services';
import {createEffect,createMemo,createSignal,onCleanup,Show} from 'solid-js';
import {createBeianQrSource} from './beian-qr-source.ts';

interface BeianQrSurfaceProps {bitmapSize:number;density:number;widthPx:number;heightPx:number;presentationFrame:NonNullable<MediaSurfaceStyle['presentationFrame']>;blurPx:number;brightnessBias:number;overlayOpacity:number;active:boolean;onReady:()=>void;onError:()=>void}
interface BeianQrFrame {path:string;widthPx:number;heightPx:number}

/** Android samples the unchanged PNG, then applies a saturating RGB bias.
 * A full-frame white SrcOver is equivalent to Native's white Screen. With
 * CLAMP blur its constant overlay can also follow the blur without changing
 * the color algebra, including transparent Fit gutters over this black page.
 * Native presentation applies the entry transform inside a fixed viewport;
 * the scene displays its texture at 1:1 with no additional scale or alpha. */
export function BeianQrSurface(props:BeianQrSurfaceProps){
 const [path,setPath]=createSignal<string>();
 let active=true,failed=false;
 onCleanup(()=>{active=false;});
 const fail=(error:unknown)=>{
  if(!active||failed)return;failed=true;
  console.warn('Beian QR',String(error));props.onError();
 };
 createEffect(()=>{
  const source=createBeianQrSource(props.bitmapSize);let current=true;
  onCleanup(()=>{current=false;source.close();});
  void source.result.then(value=>{if(current)setPath(value);}).catch(error=>{
   if(current)fail(error);
  });
 });
 // Changing measured dimensions replaces the native surface ID. Its poller
 // must be disposed at the same time, while this owner keeps the unchanged
 // source file alive. A late old-ID rejection cannot fail the replacement.
 const frame=createMemo(()=>{const source=path();return source?{path:source,widthPx:props.widthPx,heightPx:props.heightPx}:undefined;});
 return <Show when={frame()} keyed>{value=><BeianQrMedia frame={value} density={props.density}
  presentationFrame={props.presentationFrame}
  blurPx={props.blurPx} brightnessBias={props.brightnessBias} overlayOpacity={props.overlayOpacity}
  active={props.active} onReady={props.onReady} onError={fail}/>}</Show>;
}

function BeianQrMedia(props:Omit<BeianQrSurfaceProps,'bitmapSize'|'widthPx'|'heightPx'|'onError'>&{frame:BeianQrFrame;onError:(error:unknown)=>void}){
 let active=true,polling=false,ready=false,failed=false,timer:HostOperation<void>|undefined,deadline:HostOperation<void>|undefined;
 onCleanup(()=>{active=false;timer?.cancel();deadline?.cancel();});
 const fail=(error:unknown)=>{
  if(!active||failed)return;failed=true;timer?.cancel();deadline?.cancel();props.onError(error);
 };
 const update=(state:MediaSurfaceState)=>{
  if(!active||failed)return;
  if(state.state==='ready'){
   if(!ready){ready=true;timer?.cancel();deadline?.cancel();props.onReady();}return;
  }
  if(state.state!=='loading'){
   fail(state.error??state.state);return;
  }
  if(polling||ready)return;polling=true;
  deadline=delay(5000);
  void deadline.result.then(()=>{if(active&&!ready)fail('二维码图像加载超时');}).catch(()=>{});
  // Open returns before the worker has decoded the image. Start the entry
  // animation after the first real bitmap reaches the native-owned texture.
  void(async()=>{
   try{
    while(active&&!failed&&!ready){
     timer=delay(16);await timer.result;if(!active||failed||ready)return;
     const next=await mediaSurfaces.state('image',state.id);if(!active||failed||ready)return;
     if(next.state!=='loading'){update(next);return;}
    }
   }catch(error){if(active&&!ready)fail(error);}
   finally{polling=false;timer=undefined;}
  })();
 };
 return <MediaSurface kind="image" path={props.frame.path} textureSampling="linear"
  widthPx={props.frame.widthPx} heightPx={props.frame.heightPx} pixelScale={props.density}
  style={{fit:'fit',blurPx:props.blurPx,blurEdgeMode:'clamp',brightness:1,brightnessBias:props.brightnessBias,
   presentationFrame:props.presentationFrame,
   saturation:1,colorArgb:0xff000000,overlayColorArgb:0xffffffff,overlayOpacity:props.overlayOpacity,active:props.active}}
  onState={update} onError={fail}/>;
}
