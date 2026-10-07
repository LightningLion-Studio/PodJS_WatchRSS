import {expect,test} from 'bun:test';
import {decodeUtf8,type Utf8Dialect} from '../../src/core/utf8-decode.ts';
import {utf8Encode} from '../../src/cloud/types.ts';
// Frozen pre-K14 decoders. The two invalid-byte dialects intentionally differ.
function legacy(bytes:Uint8Array,dialect:Utf8Dialect){let s='',i=0;while(i<bytes.length){const a=bytes[i++];let cp:number;if(a<128)cp=a;else if(dialect==='bili'?a<224:(a&224)===192)cp=(a&31)<<6|bytes[i++]&63;else if(dialect==='bili'?a<240:(a&240)===224)cp=(a&15)<<12|(bytes[i++]&63)<<6|bytes[i++]&63;else cp=(a&7)<<18|(bytes[i++]&63)<<12|(bytes[i++]&63)<<6|bytes[i++]&63;if(cp<=65535)s+=String.fromCharCode(cp);else{cp-=65536;s+=String.fromCharCode(0xd800|(cp>>10),0xdc00|(cp&1023));}}return s;}
test('portable decoder preserves both legacy outputs for malformed, truncated and boundary inputs',()=>{
  for(const dialect of ['douyin','bili'] as const){
    for(let a=0;a<256;a++)for(let b=0;b<256;b++){
      const bytes=new Uint8Array([a,b]);expect(decodeUtf8(bytes,dialect)).toBe(legacy(bytes,dialect));
    }
    let seed=42;
    for(let run=0;run<200;run++){
      const bytes=new Uint8Array(2048+run);for(let i=0;i<bytes.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes[i]=seed>>>24;}
      expect(decodeUtf8(bytes,dialect)).toBe(legacy(bytes,dialect));
    }
    for(const prefix of [1022,1023,1024,16381,16382,16383]){
      const value='a'.repeat(prefix)+'中文🙂\0'.repeat(1025);expect(decodeUtf8(utf8Encode(value),dialect)).toBe(value);
    }
    expect(decodeUtf8(new Uint8Array(),dialect)).toBe('');
  }
});
