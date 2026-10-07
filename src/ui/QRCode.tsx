import {QRCode as FrameworkQRCode} from '@podjs/framework/qr';
import {qrPixels} from './qr-pixels';
export {qrPixels} from './qr-pixels';
export function QRCode(props:{value:string;size?:number;nativeWatch?:boolean;nativeBitmapSize?:number;pixelSize?:number;onError?:(message:string)=>void}) {
 return <FrameworkQRCode {...props} raster={(value,dimension)=>qrPixels(value,dimension,props.nativeWatch,props.nativeBitmapSize)} invalidSizeMessage="二维码像素尺寸无效" uploadErrorMessage="二维码纹理创建失败"/>;
}
