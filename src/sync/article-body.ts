import {matchGzipHash} from '@podjs/framework/crypto';
import {quoteAndroidJsonString as javaJsonQuote} from '@podjs/framework/json-string';
/** Port of the validation/reconstruction contract in native ArticleSyncBody. */
export interface SyncArticleBody {contentHtml:string|null;contentText:string}
export interface SyncBodyChunk {index:number;hash:string;bytes:Uint8Array}
export interface SyncBodyPayload {articleId:string;bodyHash:string;bodyByteCount:number;chunkSize:number;chunkHashes:readonly string[];chunks:readonly SyncBodyChunk[];metadataOnly?:boolean}
export interface SyncBodyCodec {
  sha256(bytes:Uint8Array):Promise<string>;
  encode(body:SyncArticleBody):Promise<Uint8Array>;
  /** Gzip, with plain JSON fallback only when the gzip header cannot be opened. */
  decode(bytes:Uint8Array):Promise<string>;
}
export const MAX_BODY_JSON_BYTES=32*1024*1024;
export function validateBodyShape(payload:SyncBodyPayload):void {
  if(!payload.bodyHash.trim())throw new Error("同步正文元数据缺少整体哈希");
  if(!Number.isInteger(payload.bodyByteCount)||payload.bodyByteCount<0||payload.bodyByteCount>0x7fffffff)throw new Error("同步正文元数据大小无效");
  if(!Number.isInteger(payload.chunkSize)||payload.chunkSize<=0||payload.chunkSize>0x7fffffff)throw new Error("同步正文元数据分块大小无效");
  if(payload.chunkHashes.length!==Math.max(1,Math.ceil(payload.bodyByteCount/payload.chunkSize)))throw new Error("同步正文元数据分块数不匹配");
  if(payload.chunkHashes.some(h=>typeof h!=="string"||!h.trim()))throw new Error("同步正文元数据包含空分块哈希");
  if(payload.chunks.some(c=>!Number.isInteger(c.index)||c.index<0||c.index>=payload.chunkHashes.length))throw new Error("同步正文元数据包含越界分块");
}
export async function rebuildArticleBody(payload:SyncBodyPayload,local:SyncArticleBody|null,codec:SyncBodyCodec):Promise<SyncArticleBody> {
  validateBodyShape(payload);
  let localBytes=local?await codec.encode(local):null;
  if(localBytes&&localBytes.length===payload.bodyByteCount)localBytes=await matchGzipHash(localBytes,payload.bodyHash,codec.sha256)??localBytes;
  if(local&&localBytes&&localBytes.length===payload.bodyByteCount&&await codec.sha256(localBytes)===payload.bodyHash)return local;
  // Native LibrarySyncPayload rejects conflicting duplicates before rebuildBody.
  const sent=new Map<number,SyncBodyChunk>();
  for(const chunk of payload.chunks){
    const old=sent.get(chunk.index);
    if(old&&(old.hash!==chunk.hash||old.bytes.length!==chunk.bytes.length||old.bytes.some((b,i)=>b!==chunk.bytes[i])))throw new Error("同步正文重复分块冲突");
    sent.set(chunk.index,chunk);
  }
  const parts:Uint8Array[]=[];
  for(let index=0;index<payload.chunkHashes.length;index++){
    const offset=index*payload.chunkSize,count=Math.min(payload.chunkSize,payload.bodyByteCount-offset),chunk=sent.get(index),expectedHash=payload.chunkHashes[index]!;
    let bytes:Uint8Array;
    if(chunk){
      bytes=chunk.bytes;
      if(bytes.length!==count)throw new Error("同步正文分块长度不匹配");
      if(chunk.hash!==expectedHash||await codec.sha256(bytes)!==expectedHash)throw new Error("同步正文分块校验失败");
    }else if(localBytes&&index<Math.max(1,Math.ceil(localBytes.length/payload.chunkSize))){
      bytes=localBytes.subarray(offset,Math.min(offset+payload.chunkSize,localBytes.length));
      if(bytes.length!==count)throw new Error("同步正文分块长度不匹配");
      if(await codec.sha256(bytes)!==expectedHash)throw new Error("同步正文缺少分块");
    }else throw new Error("同步正文缺少分块");
    parts.push(bytes);
  }
  const bytes=new Uint8Array(payload.bodyByteCount);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(offset!==payload.bodyByteCount)throw new Error("同步正文长度不匹配");
  if(await codec.sha256(bytes)!==payload.bodyHash)throw new Error("同步正文整体校验失败");
  return parseBodyJson(await codec.decode(bytes));
}

/** Native writer escapes every slash and omits contentHtml when it is null. */
export function encodeBodyJson(body:SyncArticleBody):string {
  return `{${body.contentHtml===null?"":`"contentHtml":${javaJsonQuote(body.contentHtml)},`}"contentText":${javaJsonQuote(body.contentText)}}`;
}
export {quoteAndroidJsonString as javaJsonQuote} from '@podjs/framework/json-string';

const whitespace=(c:string)=>/[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(c);
/** Reject duplicate body fields, type mismatches, malformed unknown values and trailing data. */
export function parseBodyJson(text:string):SyncArticleBody {
  let at=0;
  const fail=(reason="格式错误"):never=>{throw new Error(`同步正文JSON${reason}`);};
  const ws=()=>{while(at<text.length&&whitespace(text[at]!))at++;};
  const expect=(c:string)=>{ws();if(text[at++]!==c)fail();};
  const string=():string=>{
    expect('"');const pieces:string[]=[];let start=at;
    while(at<text.length){
      const c=text[at++]!;
      if(c==='"'){pieces.push(text.slice(start,at-1));return pieces.join("");}
      if(c==="\\"){
        pieces.push(text.slice(start,at-1));const escaped=text[at++];
        const values:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
        if(escaped==="u"){
          const hex=text.slice(at,at+4);if(!/^[0-9a-fA-F]{4}$/.test(hex))fail("Unicode转义格式错误");
          pieces.push(String.fromCharCode(parseInt(hex,16)));at+=4;
        }else if(escaped&&Object.hasOwn(values,escaped))pieces.push(values[escaped]!);
        else fail("转义格式错误");
        start=at;
      }else if(c.charCodeAt(0)<32)fail("字符串包含控制字符");
    }
    return fail("字符串未结束");
  };
  const literal=(s:string)=>{if(text.slice(at,at+s.length)!==s)fail("字面量格式错误");at+=s.length;};
  const nullable=():string|null=>{ws();if(text[at]==='"')return string();if(text[at]==="n"){literal("null");return null;}return fail("值格式错误");};
  const skip=(depth=0):void=>{
    if(depth>128)fail("嵌套过深");ws();const c=text[at];
    if(c==='"'){string();return;}
    if(c==="{"||c==="["){
      at++;const end=c==="{"?"}":"]";ws();if(text[at]===end){at++;return;}
      while(true){if(c==="{"){string();expect(":");}skip(depth+1);ws();if(text[at]===end){at++;return;}expect(",");}
    }
    if(c==="t"){literal("true");return;}if(c==="f"){literal("false");return;}if(c==="n"){literal("null");return;}
    const start=at;while(at<text.length&&!whitespace(text[at]!)&&![",","}","]"].includes(text[at]!))at++;
    if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text.slice(start,at)))fail("数字格式错误");
  };
  expect("{");let contentHtml:string|null=null,contentText="",html=false,body=false;ws();
  if(text[at]!=="}")while(true){
    const name=string();expect(":");
    if(name==="contentHtml"){if(html)fail("字段重复：contentHtml");html=true;contentHtml=nullable();}
    else if(name==="contentText"){if(body)fail("字段重复：contentText");body=true;contentText=nullable()??"";}
    else skip();
    ws();if(text[at]==="}")break;expect(",");
  }
  expect("}");if(!body)fail("缺少字段：contentText");ws();if(at!==text.length)fail("包含尾随数据");
  return {contentHtml,contentText};
}

/** Repository metadata-only mode additionally requires a real, reusable stored body. */
export async function requireMetadataOnlyBody(payload:SyncBodyPayload,local:SyncArticleBody|null,available:boolean,stored:boolean,codec:SyncBodyCodec):Promise<SyncArticleBody>{
 if(!payload.metadataOnly)throw new Error("同步正文请求不是仅元数据模式");
 if(payload.chunks.length)throw new Error("仅元数据同步包含正文分块");
 if(!available||!stored||!local)throw new Error("仅元数据同步缺少可复用的本地正文");
 const encoded=await codec.encode(local),bytes=await matchGzipHash(encoded,payload.bodyHash,codec.sha256)??encoded;
 if(await codec.sha256(bytes)!==payload.bodyHash)throw new Error("同步正文总校验失败");
 if(bytes.length!==payload.bodyByteCount)throw new Error("同步正文长度不匹配");
 const hashes:string[]=[];
 for(let offset=0;offset<bytes.length;offset+=128*1024)hashes.push(await codec.sha256(bytes.subarray(offset,offset+128*1024)));
 if(payload.chunkSize!==128*1024||payload.chunkHashes.length!==hashes.length||hashes.some((h,i)=>payload.chunkHashes[i]!==h))throw new Error("同步正文分块清单不匹配");
 return local;
}
