import {fileChunks,bytesToBase64,base64ToBytes} from '@podjs/framework/services';
import {hostArticleBodyCodec} from './article-body-host.ts';
import type {ReaderResourceFiles} from './reader-resources.ts';
async function read(path:string,offset:number,size:number):Promise<Uint8Array>{
 const result=new Uint8Array(size);let at=0;
 while(at<size){const next=await fileChunks.read(path,offset+at,Math.min(65536,size-at)),bytes=base64ToBytes(next.dataBase64);if(!bytes.length) return result.slice(0,at);if(bytes.length>size-at)throw Error('资源读取范围异常');result.set(bytes,at);at+=bytes.length;}
 return result;
}
async function append(path:string,data:Uint8Array,offset:number){for(let at=0;at<data.length;at+=65536){const bytes=data.subarray(at,at+65536);const result=await fileChunks.append(path,bytesToBase64(bytes),offset+at);if(result.size!==offset+at+bytes.length)throw Error('资源写入不完整');}}
export const hostReaderResourceFiles:ReaderResourceFiles={
 stat:fileChunks.stat,read,append,remove:fileChunks.remove,hash:fileChunks.hash,commit:fileChunks.commit,digest:hostArticleBodyCodec.sha256,
 async write(path,data){await fileChunks.write(path,'');await append(path,data,0);},
 /** Interrupted partial-chunk retries need truncation. Preserve the prefix in a
  * bounded stream and atomically replace it, using existing portable file APIs. */
 async truncate(path,size){
  if(size===0){await fileChunks.write(path,'');return;}
  const temp=(await fileChunks.createTemp('reader_assets/staging')).path;
  try{for(let at=0;at<size;at+=65536){const bytes=await read(path,at,Math.min(65536,size-at));if(bytes.length!==Math.min(65536,size-at))throw Error('资源截断读取不完整');await append(temp,bytes,at);}const hash=await fileChunks.hash(temp);await fileChunks.commit(temp,path,size,hash.sha256);}
  finally{await fileChunks.remove(temp);}
 },
};
