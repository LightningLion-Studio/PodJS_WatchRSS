import {delay} from '@podjs/framework/services';
import {decodeUtf8Piece,type Utf8Dialect} from '../core/utf8-decode.ts';

/** A host delay is a fresh main-looper turn. Promise.resolve() only adds another
 * QuickJS job and would let the service pump drain the whole response at once.
 * Each turn decodes <=16 KiB natively or <=1024 bytes in the portable parser. */
export async function decodeMediaText(bytes:Uint8Array,dialect:Utf8Dialect='douyin',yieldTurn:()=>Promise<unknown>=()=>delay(1).result):Promise<string> {
  const parts:string[]=[];
  for(let i=0;i<bytes.length;){
    const part=decodeUtf8Piece(bytes,i,dialect);parts.push(part.text);i=part.next;
    if(i<bytes.length)await yieldTurn();
  }
  return parts.join('');
}
