import {stringToUtf8} from "@podjs/framework/bytes";
import qrcode from "qrcode-generator";

/** Single GPU texture: QR modules never become hundreds of layout nodes. */
export function qrPixels(value: string, dimension = 256, nativeWatch = false, nativeBitmapSize = 400): Uint8Array {
  if (!value || value.length > 2048) throw new Error("二维码内容为空或过长");
  if (nativeWatch && (!Number.isInteger(nativeBitmapSize) || nativeBitmapSize < 1)) throw new Error("二维码栅格尺寸无效");
  const qr = qrcode(0, nativeWatch ? "L" : "M");
  const bytes=nativeWatch?Array.from(stringToUtf8(value),byte=>String.fromCharCode(byte)).join(""):value;
  qr.addData(bytes, "Byte"); qr.make();
  const modules = qr.getModuleCount(), margin=nativeWatch?0:1, total = modules + margin*2;
  const cell = Math.floor(dimension / total);
  if (cell < 1) throw new Error("二维码内容超过显示容量");
  const nativeCell=Math.floor(nativeBitmapSize/modules),nativePadding=Math.floor((nativeBitmapSize-nativeCell*modules)/2);
  if (nativeWatch && nativeCell < 1) throw new Error("二维码内容超过显示容量");
  const boundary=(index:number)=>nativeWatch?Math.round((nativePadding+index*nativeCell)*dimension/nativeBitmapSize):Math.round((index+margin)*dimension/total);
  const data = new Uint8Array(dimension * dimension * 4).fill(255);
  for (let row = 0; row < modules; row++) for (let col = 0; col < modules; col++) {
    if (!qr.isDark(row, col)) continue;
    // Map module boundaries to the power-of-two texture without surplus padding.
    for (let y = boundary(row); y < boundary(row+1); y++)
      for (let x = boundary(col); x < boundary(col+1); x++) {
        const i = (y * dimension + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  }
  if(nativeWatch)for(let i=0;i<data.length;i+=4)data[i]=data[i+1]=data[i+2]=255-data[i];
  return data;
}
