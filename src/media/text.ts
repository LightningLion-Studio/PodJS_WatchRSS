import {traceServiceWork} from "@podjs/framework/service-trace";
import {yieldWorkTurn} from '@podjs/framework/text-layout';
import {hasCapability} from '@podjs/framework/watch';
import {delay} from '@podjs/framework/services';
import {processMemoryBudgetBytes} from '@podjs/framework/memory';
import {decodeUtf8Piece,nativeUtf8Decoder,type Utf8Dialect} from '../core/utf8-decode.ts';

// The Android process sampler runs every 750 ms. Allow one fresh sample
// after releasing the pieces before the final local retry.
const DECODE_RECOVERY_DELAY_MS=850;
const DIRECT_DECODE_MAX_BYTES=2*1024*1024;

export interface MediaDecodeProgress {
  step:'piece'|'yield'|'join';
  offset:number;
  portable:boolean;
  recovered?:true;
}

export function isMediaDecodeMemoryPressure(error:unknown):boolean {
  return (error as {message?:unknown}|null)?.message==='out of memory';
}

/** Try the exact-size native allocation without holding decoded pieces. */
async function decodeNativeText(decode:NonNullable<ReturnType<typeof nativeUtf8Decoder>>,bytes:Uint8Array,yieldTurn:(ms?:number)=>Promise<unknown>) {
  try{return decode(bytes);}
  catch(error){
    if(!isMediaDecodeMemoryPressure(error))throw error;
    await yieldTurn(DECODE_RECOVERY_DELAY_MS);
    return decode(bytes);
  }
}

/** A host delay is a fresh main-looper turn. Promise.resolve() only adds another
 * QuickJS job and would let the service pump drain the whole response at once.
 * The chunked path decodes <=16 KiB natively or <=1024 bytes in the portable parser per turn. */
export async function decodeMediaText(bytes:Uint8Array,dialect:Utf8Dialect='douyin',yieldTurn?: (ms?:number)=>Promise<unknown>,progress?:MediaDecodeProgress):Promise<string> {
  const decode=nativeUtf8Decoder();
  const yieldDecode=(ms=1)=>yieldTurn?yieldTurn(ms):hasCapability('runtime.timer')?delay(ms).result:yieldWorkTurn().result;
  // A budgeted runtime can avoid both the retained piece strings and the
  // growing join buffer. Bound the synchronous native pass for longer media.
  if(decode&&bytes.length>16*1024&&bytes.length<=DIRECT_DECODE_MAX_BYTES&&processMemoryBudgetBytes()){
    const text=await decodeNativeText(decode,bytes,yieldDecode);
    if(typeof text==='string')return text;
  }
  const parts:string[]=[];
  let portable=false;
  const onFallback=()=>{portable=true;if(progress)progress.portable=true;};
  for(let i=0;i<bytes.length;){
    if(progress){progress.step='piece';progress.offset=i;}
    const part=decodeUtf8Piece(bytes,i,dialect,onFallback);parts.push(part.text);i=part.next;
    if(i<bytes.length){if(progress)progress.step='yield';await yieldDecode();}
  }
  if(progress){progress.step='join';progress.offset=bytes.length;}
  try {return traceServiceWork("media.text.join",()=>parts.join(''));}
  catch(error){
    if(portable||!decode||!isMediaDecodeMemoryPressure(error))throw error;
    // Native creates one guest string directly from the UTF-8 view. Drop
    // the earlier piece strings before asking for that exact allocation.
    parts.length=0;
    const text=await decodeNativeText(decode,bytes,yieldDecode);
    if(typeof text!=='string')throw error;
    if(progress)progress.recovered=true;
    return text;
  }
}
