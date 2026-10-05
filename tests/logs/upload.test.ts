import {describe,test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {webcrypto} from 'node:crypto';
import {encryptLog,type LogCrypto} from '../../src/logs/encryption.ts';
import {LOG_PUBLIC_KEY,LOG_APP_ID,LOG_API} from '../../src/logs/constants.ts';
import {LogUploadController,diagnosticLogSource,parsePickupCode,shanghaiLogTime,type LogUploadOptions,type LogUploadState} from '../../src/logs/upload.ts';
import {createInstantLogBackend,type LogSocket} from '../../src/logs/instant.ts';
import {SyncDiagnosticLog} from '../../src/sync/diagnostic-log.ts';

const subtle=webcrypto.subtle;
const buffer=(b:Uint8Array)=>Uint8Array.from(b).buffer;
const keyBytes=Uint8Array.from({length:32},(_,i)=>i);
const nonce=Uint8Array.from({length:12},(_,i)=>i+32);
const fixture=readFileSync(new URL('./native-uploader.fixture.js',import.meta.url),'utf8');
const pair=await subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
const pem=`-----BEGIN PUBLIC KEY-----\n${Buffer.from(await subtle.exportKey('spki',pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
const cryptoPort:LogCrypto={
 async gzip(bytes){return new Uint8Array(gzipSync(bytes));},async random(){return keyBytes.slice();},
 async aesGcm(key,input){const k=await subtle.importKey('raw',buffer(key),'AES-GCM',false,['encrypt']);return {nonce:nonce.slice(),ciphertext:new Uint8Array(await subtle.encrypt({name:'AES-GCM',iv:buffer(nonce)},k,buffer(input)))};},
 async rsaOaepSha256(publicKey,key){expect(publicKey).toBe(LOG_PUBLIC_KEY);return new Uint8Array(await subtle.encrypt({name:'RSA-OAEP'},pair.publicKey,buffer(key)));},
};
async function decode(bytes:Uint8Array,wrapped:string){
 const key=await subtle.decrypt({name:'RSA-OAEP'},pair.privateKey,Buffer.from(wrapped,'base64'));
 const k=await subtle.importKey('raw',key,'AES-GCM',false,['decrypt']);
 const zipped=await subtle.decrypt({name:'AES-GCM',iv:buffer(bytes.slice(1,1+bytes[0]))},k,buffer(bytes.slice(1+bytes[0])));
 return gunzipSync(new Uint8Array(zipped)).toString('utf8');
}
function options(overrides:Partial<LogUploadOptions>={}):LogUploadOptions{return {source:async()=> '日志 😀\nline 2',crypto:cryptoPort,uuid:async()=> 'record-id',now:()=>Date.UTC(2026,9,4),random:()=>0.5,backend:{upload:async()=> 'file-id',save:async()=>{}},...overrides};}

describe('native log encryption compatibility',()=>{
 test('original native Jw and PodJS envelopes decrypt identically, including Unicode',async()=>{
  const native=new Function('Kw',fixture+';return Jw;')(pem);
  const text='诊断 😀\\\r\n"敏感字段不进入本源"';
  const original=await native(text);
  const migrated=await encryptLog(text,cryptoPort);
  expect(await decode(new Uint8Array(await original.encryptedBlob.arrayBuffer()),original.encryptedAesKey)).toBe(text);
  expect(await decode(migrated.bytes,migrated.encryptedAesKey)).toBe(text);
  expect(migrated.bytes[0]).toBe(12);
  expect([...migrated.bytes.slice(1,13)]).toEqual([...nonce]);
  const tampered=migrated.bytes.slice();tampered[tampered.length-1]^=1;
  await expect(decode(tampered,migrated.encryptedAesKey)).rejects.toThrow();
 });
 test('invalid crypto outputs fail before upload',async()=>{
  await expect(encryptLog('x',{...cryptoPort,random:async()=>new Uint8Array(16)})).rejects.toThrow('密钥长度');
  await expect(encryptLog('x',{...cryptoPort,aesGcm:async()=>({nonce:new Uint8Array(16),ciphertext:new Uint8Array(16)})})).rejects.toThrow('加密格式');
 });
});
describe('collection and lifecycle',()=>{
 test('collects persistent safe timeline without payloads',async()=>{
  const map=new Map<string,string>();const log=new SyncDiagnosticLog({get:k=>map.get(k),set:(k,v)=>{map.set(k,v);}},()=>new Date(0));
  expect(await diagnosticLogSource({readLogs:async()=>log.pull(700_000).log||null})()).toBeNull();log.action('password=secret',false);log.failure('ip');
  const text=await diagnosticLogSource({readLogs:async()=>log.pull(700_000).log||null})();expect(text).toContain('action=unknown');expect(text).not.toContain('secret');expect(text).toContain('ip failure');
 });
 test('empty/load failure/whitespace never upload',async()=>{
  for(const source of [async()=>null,async()=>'',async()=>{throw Error('read');},async()=> '  ']){
   const states:LogUploadState[]=[];const c=new LogUploadController(options({source,backend:{upload:async()=>{throw Error('unexpected upload');},save:async()=>{throw Error('unexpected save');}}}),s=>states.push(s));await c.start();
   expect(['empty','load-error','upload-error']).toContain(states.at(-1)!.phase);expect(states.at(-1)!.message).not.toContain('unexpected');
  }
 });
 test('metadata and six-digit code only delivered after save; duplicate start ignored',async()=>{
  let uploads=0,saves=0;const states:LogUploadState[]=[];
  const controller=new LogUploadController(options({backend:{async upload(path,bytes){uploads++;expect(path).toStartWith('test-user-1791072000000/log_');expect(bytes[0]).toBe(12);return 'file';},async save(id,record,file){saves++;expect(id).toBe('record-id');expect(file).toBe('file');expect(record.charCount).toBe('日志 😀\nline 2'.length);expect(record.code).toBe('550000');expect(states.at(-1)!.phase).toBe('saving');}}}),s=>states.push(s));
  await Promise.all([controller.start(),controller.start()]);await controller.start();
  expect(uploads).toBe(1);expect(saves).toBe(1);expect(states.map(s=>s.phase)).toEqual(['loading','encrypting','uploading','saving','success']);
 });
 test('upload/save failure cannot produce success',async()=>{
  for(const stage of ['upload','save']){
   const states:LogUploadState[]=[];await new LogUploadController(options({backend:{upload:async()=>{if(stage==='upload')throw Error('offline');return 'f';},save:async()=>{throw Error('denied');}}}),s=>states.push(s)).start();
   expect(states.at(-1)!.phase).toBe('upload-error');expect(states.some(s=>s.phase==='success')).toBe(false);
  }
 });
 test('disposal during collection prevents all downstream work',async()=>{
  let resolve!:(s:string)=>void,calls=0;const source=()=>new Promise<string>(r=>resolve=r);
  const c=new LogUploadController(options({source,crypto:{...cryptoPort,random:async()=>{calls++;return keyBytes.slice();}}}),()=>{});
  const work=c.start();c.dispose();resolve('x');await work;expect(calls).toBe(0);
 });
 test('disposal during upload prevents save and late state',async()=>{
  let finish!:(s:string)=>void,entered! :()=>void;const enteredPromise=new Promise<void>(r=>entered=r);let saves=0;const states:LogUploadState[]=[];
  const c=new LogUploadController(options({backend:{upload:()=>{entered();return new Promise(r=>finish=r);},save:async()=>{saves++;}}}),s=>states.push(s));
  const work=c.start();await enteredPromise;c.dispose();finish('f');await work;expect(saves).toBe(0);expect(states.at(-1)!.phase).toBe('uploading');
 });
 test('code parser and Shanghai day rollover',()=>{
  expect(parsePickupCode('上传成功！取件码：123456')).toBe('123456');
  for(const value of ['012345','1234567','x123456',123456,'上传失败：123456'])expect(parsePickupCode(value)).toBeNull();
  expect(shanghaiLogTime(Date.UTC(2026,0,1,16))).toBe('2026/01/02 00:00:00');
 });
});

describe('InstantDB fixture transport (no real network)',()=>{
 test('PUT headers and body match extracted native SDK lv, including guest auth',async()=>{
  for(const auth of [undefined,{id:'user',refreshToken:'fixture-token'}]){
   const bytes=new Uint8Array([12,1,2]);let nativeRequest:any;
   const native=new Function('dt',fixture+';return lv;')(async(url:string,r:any)=>{nativeRequest={url,...r};return {data:{id:'fixture'}};});
   await native({apiURI:LOG_API,appId:LOG_APP_ID,path:'guest/log.enc',file:new Blob([bytes],{type:'application/octet-stream'}),refreshToken:auth?.refreshToken});
   const backend=createInstantLogBackend({uuid:async()=> 'id',connect:async()=>{throw Error('unexpected');},http:{async request(r){expect(r.url).toBe(nativeRequest.url);expect(r.method).toBe(nativeRequest.method);expect(r.headers).toEqual(nativeRequest.headers);expect(r.body).toEqual(new Uint8Array(await nativeRequest.body.arrayBuffer()));return {status:200,headers:{},body:Buffer.from('{"data":{"id":"fixture"}}')};}}},auth);
   expect(await backend.upload('guest/log.enc',bytes)).toBe('fixture');
  }
 });
 test('schema fields + link, matching ACK, batches and cleanup',async()=>{
  for(const reverse of [false,true]){
   const record={code:'123456',encryptedAesKey:'wrapped',fileSize:40,charCount:3,createdAt:'time',userId:'guest'};
   const attrs:any[]=['id',...Object.keys(record)].map(name=>({id:'attr-'+name,'forward-identity':['identity','logs',name]}));
   attrs.push(reverse?{id:'link','forward-identity':['i','$files','log'],'reverse-identity':['r','logs','encryptedFile']}:{id:'link','forward-identity':['i','logs','encryptedFile'],'reverse-identity':['r','$files','log']});
   const sent:any[]=[];let closed=false,n=0;
   const socket:LogSocket={async send(m){sent.push(m);},async read(){const last=sent.at(-1);return last.op==='init'?{op:'init-ok',attrs,'client-event-id':last['client-event-id']}:[{op:'transact-ok','client-event-id':'wrong'},{op:'transact-ok','client-event-id':last['client-event-id']}];},async close(){closed=true;}};
   const backend=createInstantLogBackend({uuid:async()=>String(++n),http:{request:async()=>{throw Error('unexpected');}},connect:async(url)=>{expect(url).toContain(`app_id=${LOG_APP_ID}`);return socket;}});
   await backend.save('record',record,'file');expect(closed).toBe(true);
   expect(sent[1]['tx-steps']).toEqual([['add-triple','record','attr-id','record'],...Object.entries(record).map(([k,v])=>['add-triple','record','attr-'+k,v]),reverse?['add-triple','file','link','record']:['add-triple','record','link','file']]);
  }
 });
 test('server rejection or mismatched ACK closes without success',async()=>{
  for(const frame of [{op:'error'}, {op:'init-ok','client-event-id':'wrong'}]){
   let closed=false;
   const backend=createInstantLogBackend({uuid:async()=> 'id',http:{request:async()=>{throw Error('unexpected');}},connect:async()=>({send:async()=>{},read:async()=>frame,close:async()=>{closed=true;}})});
   await expect(backend.save('id',{} as any,'file')).rejects.toThrow();expect(closed).toBe(true);
  }
 });
 test('HTTP and malformed upload replies fail',async()=>{
  for(const [status,body] of [[403,'{}'],[200,'{}'],[200,'invalid']] as const){
   const backend=createInstantLogBackend({uuid:async()=>'',connect:async()=>{throw Error('unexpected');},http:{request:async()=>({status,body:Buffer.from(body),headers:{}})}});
   await expect(backend.upload('path',new Uint8Array())).rejects.toThrow();
  }
 });
});

test('fresh schema creates attrs before triples, with native field types and link',async()=>{
 const sent:any[]=[];let n=0;
 const backend=createInstantLogBackend({uuid:async()=>`uuid-${++n}`,http:{request:async()=>{throw Error('unexpected');}},connect:async()=>({
  async send(m){sent.push(m);},async read(){const last=sent.at(-1);return {op:last.op==='init'?'init-ok':'transact-ok',attrs:[],'client-event-id':last['client-event-id']};},async close(){}
 })});
 await backend.save('record',{code:'123456',encryptedAesKey:'wrapped',fileSize:42,charCount:4,createdAt:'time',userId:'guest'},'file');
 const steps=sent[1]['tx-steps'];
 const attrs=steps.filter((s:any)=>s[0]==='add-attr').map((s:any)=>s[1]);
 expect(attrs.map((a:any)=>a['forward-identity'][2])).toEqual(['id','code','encryptedAesKey','fileSize','charCount','createdAt','userId','encryptedFile']);
 expect(steps.slice(0,attrs.length).every((s:any)=>s[0]==='add-attr')).toBe(true);
 expect(attrs.find((a:any)=>a['forward-identity'][2]==='fileSize')['checked-data-type']).toBe('number');
 expect(attrs.find((a:any)=>a['forward-identity'][2]==='code')['index?']).toBe(true);
 expect(attrs.find((a:any)=>a['forward-identity'][2]==='encryptedFile')['reverse-identity'].slice(1)).toEqual(['$files','log']);
});
