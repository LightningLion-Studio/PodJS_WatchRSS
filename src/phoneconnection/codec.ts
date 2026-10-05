/** AcousticCodec.kt: 34-tone, four-phase Goertzel, gzip/Base32/CRC32 framing.
 * PCM and symbols are identical to native. Streaming keeps only an overlap
 * window and classified symbols; no repeated reclassification of old audio. */
export const SAMPLE_RATE=22050, SYMBOL_DURATION_MS=90;
export const SYMBOL_SAMPLES=Math.floor(SAMPLE_RATE*SYMBOL_DURATION_MS/1000);
const STEP=Math.floor(SYMBOL_SAMPLES/4), FADE=Math.round(SYMBOL_SAMPLES*.12);
export const MAX_COMPRESSED=4096, MAX_PAYLOAD=65536;
const MAX_SYMBOLS=25+Math.ceil(MAX_COMPRESSED*8/5);
const frequencies=[720,...Array.from({length:32},(_,i)=>1240+i*105),960];
const coefficients=frequencies.map(f=>2*Math.cos(2*Math.PI*f/SAMPLE_RATE));
export interface Compression { gzip(bytes:Uint8Array):Promise<Uint8Array>; gunzip(bytes:Uint8Array,maxBytes:number):Promise<Uint8Array> }
export interface AcousticPacket { symbols:readonly number[]; durationMs:number; compressedBytes:number; encodedChars:number; sampleCount:number }
export function crc32(bytes:Uint8Array):number {let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function fixed(value:number,width:number):number[]{const result=Array<number>(width);for(let i=width-1;i>=0;i--){result[i]=value%32;value=Math.floor(value/32);}if(value)throw Error('声波头溢出');return result;}
function base32(bytes:Uint8Array):number[]{const out:number[]=[];let buffer=0,bits=0;for(const b of bytes){buffer=(buffer<<8)|b;bits+=8;while(bits>=5){out.push((buffer>>>(bits-5))&31);bits-=5;}}if(bits)out.push((buffer<<(5-bits))&31);return out;}
/** Native decodeFixedBase32 narrows CRC to signed Int. If its high bit is
 * set, vary only ignored gzip MTIME bits until the compressed CRC fits Int.
 * Deflate bytes, trailer and uncompressed payload stay unchanged. */
export function nativeCompatibleGzip(input:Uint8Array):Uint8Array {
 if(crc32(input)<0x80000000)return input;
 if(input.length<18||input[0]!==31||input[1]!==139||input[2]!==8||input[3]!==0)throw Error('无效声波 gzip');
 for(let i=4;i<8;i++)for(let bit=0;bit<8;bit++){const candidate=input.slice();candidate[i]^=1<<bit;if(crc32(candidate)<0x80000000)return candidate;}
 throw Error('声波 CRC 无法兼容原生接收器');
}
export function packetFromCompressed(compressed:Uint8Array):AcousticPacket {
 if(!compressed.length||compressed.length>MAX_COMPRESSED)throw Error('声波数据过大，请使用引导 WiFi');
 const body=base32(compressed),symbols=[...Array(8).fill(32),...fixed(compressed.length,6),...fixed(crc32(compressed),7),...body,...Array(4).fill(33)];
 return {symbols,durationMs:symbols.length*90,compressedBytes:compressed.length,encodedChars:body.length,sampleCount:symbols.length*SYMBOL_SAMPLES};
}
export function synthesizeChunk(packet:AcousticPacket,start:number,count=4096):Int16Array {
 if(!Number.isInteger(start)||start<0||!Number.isInteger(count)||count<1||count>8192)throw Error('无效 PCM 分块');
 const out=new Int16Array(Math.min(count,Math.max(0,packet.sampleCount-start)));
 for(let i=0;i<out.length;i++){const absolute=start+i,symbol=packet.symbols[Math.floor(absolute/SYMBOL_SAMPLES)],sample=absolute%SYMBOL_SAMPLES;
  const frequency=symbol===32?720:symbol===33?960:1240+symbol*105;
  const ramp=sample<FADE?sample/FADE:sample>SYMBOL_SAMPLES-FADE?(SYMBOL_SAMPLES-sample)/FADE:1;
  out[i]=Math.round(Math.sin(2*Math.PI*frequency*sample/SAMPLE_RATE)*32767*.62*ramp);
 }return out;
}
function classify(samples:Int16Array,start:number):number {
 let squares=0;for(let i=0;i<SYMBOL_SAMPLES;i++)squares+=samples[start+i]**2;
 if(Math.sqrt(squares/SYMBOL_SAMPLES)<320)return -1;
 let best=-1,max=-Infinity,second=-Infinity;
 for(let f=0;f<coefficients.length;f++){const coefficient=coefficients[f];let q1=0,q2=0;
  for(let i=0;i<SYMBOL_SAMPLES;i++){const q0=coefficient*q1-q2+samples[start+i];q2=q1;q1=q0;}
  const power=q1*q1+q2*q2-coefficient*q1*q2;
  if(power>max){second=max;max=power;best=f;}else if(power>second)second=power;
 }
 if(best<0||max<second*1.18)return -1;return best===0?32:best===33?33:best-1;
}
export function decodeSymbols(symbols:readonly number[]):Uint8Array|null {
 let index=0;
 while(index<=symbols.length-6){if(symbols[index]!==32){index++;continue;}let end=index;while(symbols[end]===32)end++;
  if(end-index<6){index=end;continue;}if(end+13>symbols.length)return null;
  const header=symbols.slice(end,end+13);if(header.some(v=>v<0||v>31)){index=end;continue;}
  const number=(a:readonly number[])=>a.reduce((v,n)=>v*32+n,0),length=number(header.slice(0,6)),crc=number(header.slice(6));
  if(length<=0||length>MAX_COMPRESSED){index=end;continue;}const bodyEnd=end+13+Math.ceil(length*8/5);
  if(bodyEnd+4>symbols.length){index=end;continue;}
  const body=symbols.slice(end+13,bodyEnd);if(body.some(v=>v<0||v>31)||symbols.slice(bodyEnd,bodyEnd+4).some(v=>v!==33)){index=end;continue;}
  const bytes=new Uint8Array(length);let buffer=0,bits=0,offset=0;
  for(const symbol of body){buffer=(buffer<<5)|symbol;bits+=5;while(bits>=8&&offset<length){bytes[offset++]=(buffer>>>(bits-8))&255;bits-=8;}}
  // Keep CRC unsigned. Native Kotlin narrows it to Int when reading the header;
  // accepting the unsigned value also handles that native decoder's high-bit bug.
  if(crc32(bytes)===crc)return bytes;index=end;
 }return null;
}
export class AcousticStreamDecoder {
 private tail=new Int16Array(0);private offset=0;private next=[0,STEP,2*STEP,3*STEP];private phases:number[][]=[[],[],[],[]];
 private total=0;
 push(chunk:Int16Array):Uint8Array|null {
  if(chunk.length>8192)throw Error('PCM 分块过大');this.total+=chunk.length;if(this.total>SAMPLE_RATE*120)throw Error('未收到有效的声波数据');
  const samples=new Int16Array(this.tail.length+chunk.length);samples.set(this.tail);samples.set(chunk,this.tail.length);
  for(let phase=0;phase<4;phase++){while(this.next[phase]+SYMBOL_SAMPLES<=this.offset+samples.length){this.phases[phase].push(classify(samples,this.next[phase]-this.offset));this.next[phase]+=SYMBOL_SAMPLES;if(this.phases[phase].length>MAX_SYMBOLS)this.phases[phase].shift();}
   const decoded=decodeSymbols(this.phases[phase]);if(decoded)return decoded;
  }
  const consumed=Math.min(...this.next)-this.offset;this.tail=samples.slice(consumed);this.offset+=consumed;return null;
 }
}
export class AcousticCodec {
 constructor(private readonly compression:Compression){}
 async encode(payload:Uint8Array):Promise<AcousticPacket>{if(payload.length>MAX_PAYLOAD)throw Error('声波数据过大');return packetFromCompressed(nativeCompatibleGzip(await this.compression.gzip(payload)));}
 async decompress(bytes:Uint8Array){const value=await this.compression.gunzip(bytes,MAX_PAYLOAD);if(value.length>MAX_PAYLOAD)throw Error('声波数据过大');return value;}
 async decode(samples:Int16Array):Promise<Uint8Array|null>{const decoder=new AcousticStreamDecoder();for(let i=0;i<samples.length;i+=4096){const compressed=decoder.push(samples.subarray(i,i+4096));if(compressed)return this.decompress(compressed);}return null;}
}
