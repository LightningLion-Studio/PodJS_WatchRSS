import {beianQrPixels} from './beian-qr.ts';

const crcTable = Uint32Array.from({length:256}, (_,value) => {
 for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;
 return value>>>0;
});
function crc32(bytes:Uint8Array):number {
 let value=0xffffffff;
 for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);
 return (value^0xffffffff)>>>0;
}
function concat(parts:Uint8Array[]):Uint8Array {
 const output=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;
 for(const part of parts){output.set(part,offset);offset+=part.length;}
 return output;
}
function chunk(type:string,data:Uint8Array):Uint8Array {
 const output=new Uint8Array(12+data.length),view=new DataView(output.buffer);
 view.setUint32(0,data.length);for(let i=0;i<4;i++)output[4+i]=type.charCodeAt(i);
 output.set(data,8);view.setUint32(8+data.length,crc32(output.subarray(4,8+data.length)));
 return output;
}

/** PNG grayscale/1-bit is lossless for the native binary QR. Stored DEFLATE
 * blocks need no platform codec and keep a 240px source below 8 KiB. */
export function beianQrPng(dimension:number):Uint8Array {
 if(!Number.isInteger(dimension)||dimension<1||dimension>1024)throw Error('备案二维码像素尺寸无效');
 const rgba=beianQrPixels(dimension),stride=Math.ceil(dimension/8)+1;
 const scanlines=new Uint8Array(stride*dimension);
 for(let y=0;y<dimension;y++)for(let x=0;x<dimension;x++){
  if(rgba[(y*dimension+x)*4]!==0)scanlines[y*stride+1+(x>>>3)]|=1<<(7-(x&7));
 }
 const blocks:Uint8Array[]=[new Uint8Array([0x78,0x01])];
 for(let start=0;start<scanlines.length;start+=65535){
  const length=Math.min(65535,scanlines.length-start),block=new Uint8Array(5+length);
  block[0]=start+length===scanlines.length?1:0;
  const view=new DataView(block.buffer);view.setUint16(1,length,true);view.setUint16(3,length^0xffff,true);
  block.set(scanlines.subarray(start,start+length),5);blocks.push(block);
 }
 let sum1=1,sum2=0;for(const byte of scanlines){sum1=(sum1+byte)%65521;sum2=(sum2+sum1)%65521;}
 const checksum=new Uint8Array(4);new DataView(checksum.buffer).setUint32(0,(sum2<<16)|sum1);blocks.push(checksum);
 const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,dimension);view.setUint32(4,dimension);header[8]=1;
 return concat([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',concat(blocks)),chunk('IEND',new Uint8Array())]);
}
