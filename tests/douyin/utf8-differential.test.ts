import {expect,test} from 'bun:test';
import {decodeUtf8,decodeUtf8Piece} from '../../src/core/utf8-decode.ts';
import {stringToUtf8} from '@podjs/framework/bytes';
test('application dialect wiring preserves malformed bytes and fallback chunk boundaries',()=>{
 const root=globalThis as any,previous=root.pod;
 try{root.pod={};
  expect(decodeUtf8(new Uint8Array([128,65]),'bili')).toBe(String.fromCharCode(1));
  expect(decodeUtf8(new Uint8Array([128,65]),'douyin')).toBe(String.fromCharCode(4096));
  expect(decodeUtf8Piece(new Uint8Array([240]),0,'douyin').next).toBe(4);
  const value='a'.repeat(1023)+'🙂中\0';for(const dialect of ['bili','douyin'] as const)expect(decodeUtf8(stringToUtf8(value),dialect)).toBe(value);
  root.pod={decodeUtf8:(b:Uint8Array)=>new TextDecoder().decode(b)};
  expect(decodeUtf8Piece(stringToUtf8('a'.repeat(20000)),0,'bili').next).toBe(16384);
 }finally{root.pod=previous;}
});
