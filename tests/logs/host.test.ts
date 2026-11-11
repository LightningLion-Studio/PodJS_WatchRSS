import {test,expect} from 'bun:test';

test('host crypto bridge uses empty AAD, real RSA method and bounded temporary gzip',()=>{
 const result=Bun.spawnSync(['bun','--eval',`
  import {mock} from 'bun:test';
  import {strict as assert} from 'node:assert';
  import {gzipSync,gunzipSync} from 'node:zlib';
  const calls=[],removed=[];let input=Buffer.alloc(0),zipped=Buffer.alloc(0);
  mock.module('@podjs/framework/watch',()=>({kv:{get(){},set(){}},hasCapability:()=>true}));
  mock.module('@podjs/framework/services',()=>({
   hostOperation(method,args){calls.push({method,args});
    if(method==='crypto.random')return {result:Promise.resolve({bytesBase64:Buffer.alloc(args.bytes,1).toString('base64')})};
    assert.equal(method,'crypto.aesGcmEncrypt');assert.equal(args.aadBase64,'');
    return {result:Promise.resolve({nonceBase64:Buffer.alloc(12).toString('base64'),ciphertextBase64:Buffer.alloc(Buffer.from(args.dataBase64,'base64').length+16).toString('base64')})};
   },
   rsaOaepSha256(pem,key){calls.push({method:'rsa',pem,key});return {result:Promise.resolve({ciphertextBase64:Buffer.alloc(256).toString('base64')})};},
   secureStorage:{get:async()=>null,set:async()=>{},delete:async()=>{}},webSockets:{},bytesToBase64:b=>Buffer.from(b).toString('base64'),base64ToBytes:s=>new Uint8Array(Buffer.from(s,'base64')),
   fileChunks:{
    async gzipBytes(s){return {dataBase64:gzipSync(Buffer.from(s,'base64')).toString('base64')};},
    async createTemp(){input=Buffer.alloc(0);return {path:'log-upload/in'};},
    async append(path,s,offset){assert.equal(offset,input.length);input=Buffer.concat([input,Buffer.from(s,'base64')]);return {size:input.length};},
    async gzip(path){zipped=gzipSync(input);return {path:'log-upload/out',size:zipped.length};},
    async read(path,offset,max){return {offset,size:zipped.length,dataBase64:zipped.subarray(offset,offset+max).toString('base64')};},
    async remove(p){removed.push(p);}
   }
  }));
  const {hostLogCrypto,createHostLogUploadOptions}=await import('./src/logs/host.ts');
  createHostLogUploadOptions();assert.equal(calls.length,0);
  for(const size of [64,700000]){const bytes=new Uint8Array(size).fill(65);const gzip=await hostLogCrypto.gzip(bytes);assert.deepEqual(new Uint8Array(gunzipSync(gzip)),bytes);}
  assert.deepEqual(removed,['log-upload/out','log-upload/in']);
  const key=await hostLogCrypto.random(32);assert.equal(key.length,32);
  const encrypted=await hostLogCrypto.aesGcm(key,new Uint8Array([1,2,3]));assert.equal(encrypted.ciphertext.length,19);
  await hostLogCrypto.rsaOaepSha256('public-key',key);assert.equal(calls.at(-1).pem,'public-key');
  await assert.rejects(hostLogCrypto.aesGcm(key,new Uint8Array(256*1024+1)),/256 KiB/);
 `],{cwd:new URL('../..',import.meta.url).pathname,stdout:'pipe',stderr:'pipe'});
 expect(result.stderr.toString()).toBe('');expect(result.exitCode).toBe(0);
});
