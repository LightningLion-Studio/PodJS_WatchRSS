import {fileChunks} from '@podjs/framework/services';
import {bytesToBase64} from '@podjs/framework/bytes';
import {beianQrPng} from './beian-qr-png.ts';

export interface BeianQrFilePorts {
 createTemp(directory:string):Promise<{path:string}>;
 write(path:string,dataBase64:string):Promise<{size:number}>;
 remove(path:string):Promise<unknown>;
}

/** The source belongs to this visible QR instance; it never enters user data.
 * A late allocation/write is drained before cleanup after disposal. */
export function createBeianQrSource(dimension:number,ports:BeianQrFilePorts=fileChunks):{result:Promise<string>;close():void} {
 let closed=false,ready=false,path:string|undefined,removed=false;
 const remove=async()=>{if(path===undefined||removed)return;removed=true;try{await ports.remove(path);}catch{/* Host disposal also owns this allocated temporary file. */}};
 const result=(async()=>{
  try{
   const png=beianQrPng(dimension),temporary=await ports.createTemp('beian-qr');
   if(typeof temporary.path!=='string'||!/^beian-qr\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(temporary.path))throw Error('备案二维码临时路径无效');
   path=temporary.path;if(closed)throw Error('备案二维码已关闭');
   const written=await ports.write(path,bytesToBase64(png));
   if(closed)throw Error('备案二维码已关闭');
   if(written.size!==png.length)throw Error('备案二维码写入不完整');
   ready=true;return path;
  }catch(error){await remove();throw error;}
 })();
 return {result,close(){if(closed)return;closed=true;if(ready)void remove();}};
}
