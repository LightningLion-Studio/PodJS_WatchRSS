import {qrPixels as raster} from '@podjs/framework/qr';
export function qrPixels(value:string,dimension=256,nativeWatch=false,nativeBitmapSize=400,quietZone?:number):Uint8Array {
 return raster(value,dimension,{encoding:nativeWatch||quietZone!==undefined?'utf8':'byte',bitmapSize:nativeWatch?nativeBitmapSize:undefined,errorCorrection:nativeWatch||quietZone!==undefined?'L':'M',margin:quietZone??(nativeWatch?0:1),invert:nativeWatch,messages:{content:'二维码内容为空或过长',raster:'二维码栅格尺寸无效',capacity:'二维码内容超过显示容量'}});
}
