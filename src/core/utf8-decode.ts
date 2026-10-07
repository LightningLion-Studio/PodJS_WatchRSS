import {decodeUtf8Chunk, nativeUtf8Decoder} from "@podjs/framework/bytes";
export {nativeUtf8Decoder};
export type Utf8Dialect = "douyin" | "bili";

/** Historical malformed-byte semantics remain application policy. */
function legacyPiece(bytes:Uint8Array,start:number,dialect:Utf8Dialect) {
  const units:number[]=[];
  let i=start;
  const limit=Math.min(bytes.length,start+1024);
  while(i<limit){
    const first=bytes[i++];let cp:number;
    if(first<0x80)cp=first;
    else if(dialect==='bili'?first<0xe0:(first&0xe0)===0xc0)cp=((first&31)<<6)|(bytes[i++]&63);
    else if(dialect==='bili'?first<0xf0:(first&0xf0)===0xe0)cp=((first&15)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63);
    else cp=((first&7)<<18)|((bytes[i++]&63)<<12)|((bytes[i++]&63)<<6)|(bytes[i++]&63);
    if(cp<=0xffff)units.push(cp);
    else{cp-=0x10000;units.push(0xd800|(cp>>10),0xdc00|(cp&0x3ff));}
  }
  return {text:String.fromCharCode(...units),next:i};
}
export function decodeUtf8Piece(bytes:Uint8Array,start:number,dialect:Utf8Dialect) {
  return decodeUtf8Chunk(bytes,start,{fallback:(value,offset)=>legacyPiece(value,offset,dialect)});
}
export function decodeUtf8(bytes:Uint8Array,dialect:Utf8Dialect):string {
  const parts:string[]=[];
  for(let i=0;i<bytes.length;){const part=decodeUtf8Piece(bytes,i,dialect);parts.push(part.text);i=part.next;}
  return parts.join('');
}
