// Frozen 599d9d7 byte loops for RS1 result/error differential checks.
export function utf8Encode(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!Number.isFinite(low) || low < 0xdc00 || low > 0xdfff) throw new Error("invalid UTF-16 surrogate");
      code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid UTF-16 surrogate");
    if (code <= 0x7f) out.push(code);
    else if (code <= 0x7ff) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(out);
}

export function decodeSyncUtf8(bytes: Uint8Array): string {
  const parts:string[]=[],units:number[]=[];
  const flush=()=>{if(units.length){parts.push(String.fromCharCode(...units));units.length=0;}};
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]; let code: number; let count: number;
    if (first <= 0x7f) { code = first; count = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { code = first & 0x1f; count = 1; }
    else if (first >= 0xe0 && first <= 0xef) { code = first & 0x0f; count = 2; }
    else if (first >= 0xf0 && first <= 0xf4) { code = first & 0x07; count = 3; }
    else throw new Error("invalid UTF-8");
    for (let j = 0; j < count; j++) { const next = bytes[i++]; if ((next & 0xc0) !== 0x80) throw new Error("invalid UTF-8"); code = (code << 6) | (next & 0x3f); }
    if ((count === 1 && code < 0x80) || (count === 2 && code < 0x800) || (count === 3 && code < 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("invalid UTF-8");
    if (code <= 0xffff) units.push(code); else { const n = code - 0x10000; units.push(0xd800 + (n >> 10), 0xdc00 + (n & 0x3ff)); }
    if(units.length>=2048)flush();
  }
  flush();return parts.join("");
}

export function decodeChunkData(data:string):Uint8Array {
  // java.util.Base64 basic decoder accepts unpadded groups of two or three,
  // rejects whitespace, misplaced padding and one-character trailing groups.
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(data))throw new Error("invalid base64 chunk data");
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",raw=data.replace(/=+$/,"");
  const out=new Uint8Array(Math.floor(raw.length*6/8));let accumulator=0,bits=0,index=0;
  for(const c of raw){accumulator=(accumulator<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;out[index++]=(accumulator>>bits)&255;}}
  return out;
}

export function encodeChunkData(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const groups=new Array<string>(Math.ceil(bytes.length/3));
  for(let i=0,group=0;i<bytes.length;i+=3,group++){
    const a=bytes[i]!,b=i+1<bytes.length?bytes[i+1]!:0,c=i+2<bytes.length?bytes[i+2]!:0;
    groups[group]=alphabet[a>>2]!+alphabet[((a&3)<<4)|(b>>4)]!+
      (i+1<bytes.length?alphabet[((b&15)<<2)|(c>>6)]!:'=')+
      (i+2<bytes.length?alphabet[c&63]!:'=');
  }
  return groups.join('');
}


const MAX_CHARS=32768;
export function* javaUtf8Chunks(text:string):Generator<Uint8Array> {
  for(let start=0;start<text.length;){
    let end=Math.min(start+MAX_CHARS,text.length);
    if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
    const bytes:number[]=[];
    for(let i=start;i<end;i++){
      let code=text.charCodeAt(i);
      if(code>=0xd800&&code<=0xdbff){
        const low=text.charCodeAt(i+1);
        if(low>=0xdc00&&low<=0xdfff){code=0x10000+((code-0xd800)<<10)+low-0xdc00;i++;}
        else code=63;
      }else if(code>=0xdc00&&code<=0xdfff)code=63;
      if(code<0x80)bytes.push(code);
      else if(code<0x800)bytes.push(0xc0|(code>>6),0x80|(code&63));
      else if(code<0x10000)bytes.push(0xe0|(code>>12),0x80|((code>>6)&63),0x80|(code&63));
      else bytes.push(0xf0|(code>>18),0x80|((code>>12)&63),0x80|((code>>6)&63),0x80|(code&63));
    }
    yield new Uint8Array(bytes);start=end;
  }
}
