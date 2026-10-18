import {decodeSyncUtf8} from './protocol.ts';
import {encodeUtf8Async,sha256Bytes,gunzipBytes} from '@podjs/framework/bytes';
import {fileChunks,uri,hostOperation,bytesToBase64,base64ToBytes} from "@podjs/framework/services";
import {encodeBodyJson,MAX_BODY_JSON_BYTES,type SyncBodyCodec} from "./article-body.ts";

async function temporary(chunks:Iterable<Uint8Array>):Promise<string>{
 const {path}=await fileChunks.createTemp("sync_body");
 try{
  let offset=0;
  for(const chunk of chunks){
   for(let at=0;at<chunk.length;at+=65536){
    const bytes=chunk.subarray(at,at+65536),result=await fileChunks.append(path,bytesToBase64(bytes),offset);
    offset+=bytes.length;if(result.size!==offset)throw new Error("同步正文临时文件写入失败");
   }
  }
  return path;
 }catch(error){await fileChunks.remove(path);throw error;}
}
async function readBytes(path:string,size:number):Promise<Uint8Array>{
 if(!Number.isSafeInteger(size)||size<0||size>MAX_BODY_JSON_BYTES)throw new Error("同步正文压缩文件过大");
 const bytes=new Uint8Array(size);
 for(let offset=0;offset<size;){
  const result=await fileChunks.read(path,offset,Math.min(65536,size-offset)),part=base64ToBytes(result.dataBase64);
  if(result.size!==size||part.length===0||part.length>size-offset)throw new Error("同步正文文件读取不完整");
  bytes.set(part,offset);offset+=part.length;
 }
 return bytes;
}
export const hostArticleBodyCodec:SyncBodyCodec={
 async sha256(bytes){
  if(bytes.length<=256*1024){
   const digest=sha256Bytes(bytes)??base64ToBytes((await hostOperation<{digestBase64:string}>("crypto.hash",{dataBase64:bytesToBase64(bytes),algorithm:"SHA-256"}).result).digestBase64);if(digest.length!==32)throw new Error("同步正文哈希服务返回无效结果");
   return Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
  }
  const path=await temporary([bytes]);try{return (await fileChunks.hash(path)).sha256;}finally{await fileChunks.remove(path);}
 },
 async encode(body){
  const encoded=await encodeUtf8Async(encodeBodyJson(body),'question'),chunks=[encoded],size=encoded.length;
  if(size<=64*1024){
   const bytes=encoded;
   try{return base64ToBytes((await fileChunks.gzipBytes(bytesToBase64(bytes))).dataBase64);}
   catch(error){if(!/unsupported|unknown method/i.test(String(error)))throw error;}
  }
  const input=await temporary(chunks);let output:string|undefined;
  try{const result=await fileChunks.gzip(input,MAX_BODY_JSON_BYTES);output=result.path;return await readBytes(output,result.size);}
  finally{if(output)await fileChunks.remove(output);await fileChunks.remove(input);}
 },
 async decode(bytes){
  const plain=gunzipBytes(bytes);if(plain)return decodeSyncUtf8(plain);
  const input=await temporary([bytes]);let output:string|undefined,reader:string|undefined;
  try{
   const result=await fileChunks.gunzip(input,MAX_BODY_JSON_BYTES,true);output=result.path;
   reader=(await fileChunks.openText(output)).id;const parts:string[]=[];
   while(true){const part=await fileChunks.readTextChunk(reader);parts.push(part.text);if(part.eof)break;if(!part.text)throw new Error("同步正文文本读取未前进");}
   return parts.join("");
  }finally{if(reader)await fileChunks.closeText(reader);if(output)await fileChunks.remove(output);await fileChunks.remove(input);}
 },
};

/** Generic host services retain Android URI and Jsoup text semantics. */
export const hostSyncText={
 parseUri:uri.parse,
 async htmlText(html:string):Promise<string>{
  const input=await temporary([await encodeUtf8Async(html,'question')]);let output:string|undefined,reader:string|undefined;
  try{
   output=(await fileChunks.htmlText(input,MAX_BODY_JSON_BYTES)).path;
   reader=(await fileChunks.openText(output)).id;const pieces:string[]=[];
   while(true){const part=await fileChunks.readTextChunk(reader);pieces.push(part.text);if(part.eof)break;if(!part.text)throw new Error("HTML text read stalled");}
   return pieces.join("");
  }finally{if(reader)await fileChunks.closeText(reader);if(output)await fileChunks.remove(output);await fileChunks.remove(input);}
 },
};
