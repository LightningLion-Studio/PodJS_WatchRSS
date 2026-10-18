import {test,expect} from 'bun:test';
import {createHmac,createHash} from 'node:crypto';
import {hostIpCrypto} from '../../src/sync/ip-crypto-host.ts';
test('production HMAC uses optional native SHA without a service round trip and preserves padded URL-safe format',async()=>{
 const root=globalThis as any,previous=root.pod;let hashes=0;
 try{
  root.pod={sha256Bytes:(bytes:Uint8Array)=>{hashes++;return new Uint8Array(createHash('sha256').update(bytes).digest());}};
  for(const size of [32,100]){const bytes=Buffer.from(Array.from({length:size},(_,i)=>(i*39)%256)),key=bytes.toString('base64').replace(/\+/g,'-').replace(/\//g,'_'),payload='2|synthetic-phone|123|中文🙂';
   const expected=createHmac('sha256',bytes).update(payload).digest('base64').replace(/\+/g,'-').replace(/\//g,'_');expect(await hostIpCrypto.hmac(key,payload)).toBe(expected);
  }
  expect(hashes).toBe(5);
 }finally{root.pod=previous;}
});
