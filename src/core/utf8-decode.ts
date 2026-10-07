/** Preserve both existing permissive decoders, including malformed/truncated
 * input. Valid UTF-8 may use the optional compiled host path. */
export type Utf8Dialect = 'douyin' | 'bili';
export function nativeUtf8Decoder():((bytes:Uint8Array)=>string|null|undefined)|undefined {
  return (globalThis as {pod?:{decodeUtf8?:(bytes:Uint8Array)=>string|null|undefined}}).pod?.decodeUtf8;
}
export function decodeUtf8Piece(bytes:Uint8Array,start:number,dialect:Utf8Dialect) {
  const native=nativeUtf8Decoder();
  if(native){
    let end=Math.min(bytes.length,start+16384);
    // Avoid cutting a valid sequence. On malformed data the host returns null,
    // and the legacy parser below determines the exact next byte instead.
    if(end<bytes.length)for(let back=0;back<3&&end>start&&(bytes[end]&0xc0)===0x80;back++)end--;
    if(end>start){const text=native(bytes.subarray(start,end));if(typeof text==='string')return {text,next:end};}
  }
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
export function decodeUtf8(bytes:Uint8Array,dialect:Utf8Dialect):string {
  const parts:string[]=[];
  for(let i=0;i<bytes.length;){const part=decodeUtf8Piece(bytes,i,dialect);parts.push(part.text);i=part.next;}
  return parts.join('');
}
