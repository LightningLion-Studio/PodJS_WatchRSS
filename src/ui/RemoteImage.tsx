import {createLogConsole} from '../logs/app-logger.ts';
import {managedCache} from '../cache/host.ts';
import {createImageLoader,RemoteImage as FrameworkRemoteImage,type ImageSource} from '@podjs/framework/image';
import type {NodeMirror} from '@pocketjs/framework/components';
export interface RemoteImageProps {
  url: string;
  inline?:boolean;
  cacheBucket?:"images"|"bili-preview";
  filePath?: string;
  width: number;
  height: number;
  class?: string;
  headers?: Record<string, string>;
  fit?: "stretch" | "cover" | "contain";
  onSize?: (width:number,height:number)=>void;
  onError?: (error:unknown)=>void;
}


interface WatchImageSource extends ImageSource {inline?:boolean;cacheBucket?:"images"|"bili-preview"}
const loader=createImageLoader<WatchImageSource>({
  sourceProvider:{acquire:source=>managedCache.acquire(source.url,source.headers,source.inline,source.cacheBucket)},
  logger:createLogConsole('RemoteImage'),
  messages:{dimensions:'远程图片尺寸无效',size:'远程图片解码结果过大',data:'远程图片数据不完整',texture:'远程图片纹理创建失败'},
});
function source(props:RemoteImageProps):WatchImageSource {
  return {url:props.url,filePath:props.filePath,headers:props.headers,inline:props.inline,cacheBucket:props.cacheBucket,
    namespace:`${props.cacheBucket??"images"}\u0000${props.inline?"inline":"general"}`};
}
export function bindRemoteImage(props:RemoteImageProps,node:NodeMirror,onSize?:RemoteImageProps['onSize']) {
  return loader.bind({...props,source:source(props),loader},node,onSize);
}
export const releaseRetainedRemoteImages=()=>loader.releaseRetained();
export const remoteImageResourceCounts=()=>loader.stats();
export function RemoteImage(props:RemoteImageProps) {
  return <FrameworkRemoteImage {...props} loader={loader} source={source(props)}/>;
}
