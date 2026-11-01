import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync,deflateRawSync} from 'node:zlib';
import {crypto,key} from './k2-crypto';
import {crc32} from '../../src/cloud/wrss';
import {utf8Encode} from '../../src/cloud/types';
import type {CloudManifest} from '../../src/cloud/codec';
const fw=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
const {buildBackground}=await import(fw+'/packages/cli/src/background-build.ts');
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));

function zipEntry(entries:{name:string;bytes:Uint8Array;deflate?:boolean}[]){
 const locals:Uint8Array[]=[],directory:Uint8Array[]=[];let offset=0;
 for(const e of entries){const name=utf8Encode(e.name),packed=e.deflate?new Uint8Array(deflateRawSync(e.bytes)):e.bytes,crc=crc32(e.bytes),method=e.deflate?8:0;
  const l=new Uint8Array(30+name.length),v=new DataView(l.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(8,method,true);v.setUint32(14,crc,true);v.setUint32(18,packed.length,true);v.setUint32(22,e.bytes.length,true);v.setUint16(26,name.length,true);l.set(name,30);
  const c=new Uint8Array(46+name.length),d=new DataView(c.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(10,method,true);d.setUint32(16,crc,true);d.setUint32(20,packed.length,true);d.setUint32(24,e.bytes.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);c.set(name,46);locals.push(l,packed);directory.push(c);offset+=l.length+packed.length;
 }
 const cd=Buffer.concat(directory),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,cd.length,true);v.setUint32(16,offset,true);return new Uint8Array(Buffer.concat([...locals,cd,end]));
}
for(const mode of ['entry-ref','pending'])test('RESTOREPATH production bundle '+mode+': baseline signature or durable convergence',async()=>{
 const baseline=process.env.RESTOREPATH_BASELINE==='1',output=mkdtempSync(join(tmpdir(),'restore-path-'));
 try{
 const entry=resolve(process.env.RESTOREPATH_APP_ROOT??resolve(import.meta.dir,'../..'),'tests/cloud/fixtures/restore-path-entry.ts');
 const artifact=(await buildBackground({path:entry},output)).path!;
 const source=readFileSync(join(output,artifact.file),'utf8');
 const body=new Uint8Array(63*1024*1024).fill(37),noise=new Uint8Array(12*1024*1024);let seed=0x713ef12;
 for(let i=0;i<noise.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;noise[i]=seed&255;}
 const path='books/'+ 'a'.repeat(64)+'.jsonl',archive=zipEntry([{name:'noise.bin',bytes:noise},{name:path,bytes:body,deflate:true}]);
 const packed=new Uint8Array(gzipSync(archive)),chunks:any[]=[],files=new Map<string,Uint8Array>(),secure=new Map<string,string>();
 const root='watch-cloud-cache/'+(await crypto.sha256(utf8Encode(JSON.stringify(['https://backend.invalid','user'])))).slice(0,32);
 for(let i=0;i<51;i++){
  const plain=packed.slice(Math.floor(i*packed.length/51),Math.floor((i+1)*packed.length/51)),hash=await crypto.sha256(plain),salt=new Uint8Array(16).fill(i),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/chunk/v1')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-chunk-v1:'+hash),plain),blob=new Uint8Array(Buffer.concat([Buffer.from('WRSSCC2'),salt,sealed.nonce,sealed.ciphertext])),cipherHash=await crypto.sha256(blob);
  chunks.push({plaintextSha256:hash,ciphertextSha256:cipherHash,plaintextBytes:plain.length,ciphertextBytes:blob.length,saltBase64:b64(salt),nonceBase64:b64(sealed.nonce)});files.set(root+'/chunks/'+cipherHash.slice(0,2)+'/'+cipherHash+'.bin',blob);
 }
 const manifest:CloudManifest={format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:'fixture-prior',sourceDeviceId:'fixture-watch',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},settings:{},credentialEnvelopes:{},objects:[{name:'archive.wrss',encoding:'gzip',originalBytes:archive.length,encodedBytes:packed.length,chunks}]};
 const wrapSalt=new Uint8Array(16),wrapKey=await crypto.hkdf(key,wrapSalt,utf8Encode('watchrss/cloud/reader-key/v1')),wrapped=await crypto.encrypt(wrapKey,utf8Encode('watchrss-reader-key-v1:reader/fixture.txt'),key);manifest.objects[0].readerKeyEnvelope={version:1,scope:'reader/fixture.txt',saltBase64:b64(wrapSalt),nonceBase64:b64(wrapped.nonce),ciphertextBase64:b64(wrapped.ciphertext)};
 const ref={name:'reader/'+(await crypto.sha256(utf8Encode('fixture-id'))).slice(0,32)+'/'+(await crypto.sha256(utf8Encode('fixture-hash'))).slice(0,32)+'.txt',features:{incompat:['r48.entry-ref.v1'],roCompat:[]},originalBytes:body.length,entryRef:{object:'archive.wrss',entryPath:path,encoding:'identity'},privateArticle:{articleId:'fixture-id',url:'https://fixture.invalid/article',title:'Fixture',contentHash:'fixture-hash'}};
 if(mode==='pending')manifest.objects.push(ref as any);
 const logicalArchive=zipEntry([{name:'manifest.json',bytes:utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3}))},{name:'articles.json',bytes:utf8Encode('[]')}]);
 const salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/manifest/v2/fixture-prior')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:fixture-prior'),utf8Encode(JSON.stringify(manifest))),encrypted=new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext]));
 files.set(root+'/manifests/fixture-prior.bin',encrypted);
 const head={id:manifest.snapshotId,sourceDeviceId:manifest.sourceDeviceId,deviceSequence:1,keyVersion:1,manifestSha256:await crypto.sha256(encrypted),manifestSizeBytes:encrypted.length,parentHeads:{},observedHeads:{}};

 let now=Date.now(),deadline=now+300000,id=0,inflated=false,sourceDecrypts=0,gzipCalls=0,firstDecrypt=true;
 const calls:string[]=[],written=new Map<string,number>(),proof:any[]=[];const streams=new Map<string,Uint8Array>();
 const resultFile=async(bytes:Uint8Array,directory='cloud-crypto')=>{const path=directory+'/.pod-write-'+ ++id+'.part';files.set(path,bytes);return {path,size:bytes.length,sha256:await crypto.sha256(bytes)};};
 const request=async<T>(method:string,a:any):Promise<T>=>{
  if(!baseline&&(method==='file.write'||method==='file.gzip'||method==='file.gunzip'||method.startsWith('crypto.'))){expect(Number.isInteger(a.callsiteId)).toBe(true);expect(a.callsiteId).toBeGreaterThanOrEqual(0);expect(a.callsiteId).toBeLessThan(112);expect(a.sizeBand).toBeGreaterThanOrEqual(0);expect(a.sizeBand).toBeLessThanOrEqual(5);}
  calls.push(method);now+=method==='file.write'?(inflated?550:300):method.startsWith('secure.')?100:method==='file.read'?20:5;if(now>=deadline)throw Error('NATIVE_HARD_STOP');
  const execute=async():Promise<any>=>{switch(method){
   case 'runtime.delay':return null;
   case 'secure.get':return {exists:secure.has(a.key),value:secure.get(a.key)};
   case 'secure.set':secure.set(a.key,a.value);return {};
   case 'secure.update':for(const [k,v]of Object.entries(a.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}return {updated:true};
   case 'secure.compareAndSet':if((secure.get(a.key)??null)!==a.expected)return {updated:false};secure.set(a.key,a.value);return {updated:true};
   case 'file.createTemp':return resultFile(new Uint8Array(),a.directory);
   case 'file.delete':files.delete(a.path);return {};
   case 'file.stat':return {exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0};
   case 'file.read':{const b=files.get(a.path)!;return {offset:a.offset,size:b.length,dataBase64:b64(b.subarray(a.offset,a.offset+a.maxBytes))};}
   case 'file.write':{const before=a.append?files.get(a.path)!:new Uint8Array(),part=unb64(a.dataBase64);if(a.append)expect(a.expectedOffset).toBe(before.length);files.set(a.path,new Uint8Array(Buffer.concat([before,part])));return {size:before.length+part.length};}
   case 'file.hash':return {sha256:await crypto.sha256(files.get(a.path)!)};
   case 'file.commit':{const b=files.get(a.path)!;expect(b.length).toBe(a.expectedSize);expect(await crypto.sha256(b)).toBe(a.expectedSha256);files.set(a.target,b);files.delete(a.path);written.set(a.target,(written.get(a.target)??0)+1);return {path:a.target,size:b.length};}
   case 'crypto.random':return {bytesBase64:b64(await crypto.random(a.bytes))};
   case 'crypto.hash':return {digestBase64:Buffer.from(await crypto.sha256(unb64(a.dataBase64)),'hex').toString('base64')};
   case 'crypto.hkdfSha256':return {keyBase64:b64(await crypto.hkdf(unb64(a.inputBase64),unb64(a.saltBase64),unb64(a.infoBase64)))};
   case 'crypto.aesGcmEncrypt':{const r=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.dataBase64));return {nonceBase64:b64(r.nonce),ciphertextBase64:b64(r.ciphertext)};}
   case 'crypto.aesGcmDecrypt':return {dataBase64:b64(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),unb64(a.ciphertextBase64)))};
   case 'crypto.largeAesGcmDecrypt':if(Buffer.from(a.aadBase64,'base64').toString().startsWith('watchrss-cloud-chunk-v1:'))sourceDecrypts++;now+=500;firstDecrypt=false;return resultFile(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),files.get(a.inputPath)!));
   case 'crypto.largeAesGcmEncrypt':{const r=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),files.get(a.inputPath)!);return {...await resultFile(r.ciphertext),nonceBase64:b64(r.nonce)};}
   case 'file.gunzip':now+=50000;gzipCalls++;inflated=true;return resultFile(new Uint8Array(gunzipSync(files.get(a.path)!)));
   case 'crypto.closeSealedGzip':streams.delete(a.outputPrefix);return {};
   case 'crypto.gunzipSealedParts':{
    let body=streams.get(a.outputPrefix);if(!body){const parts:Uint8Array[]=[];for(const p of a.parts){const b=files.get(p.path)!;parts.push(await crypto.decrypt(unb64(a.keyBase64),unb64(p.aadBase64),b.subarray(0,12),b.subarray(12)));}body=new Uint8Array(gunzipSync(Buffer.concat(parts)));if(body.length>a.maxOutputBytes||!a.allowShortOutput&&body.length!==a.maxOutputBytes)throw Error('invalid_gzip_length');streams.set(a.outputPrefix,body);now+=50000;gzipCalls++;inflated=true;}now+=500;
    const part=body.subarray(a.offset,a.offset+262144),r=await crypto.encrypt(unb64(a.keyBase64),utf8Encode(a.aadPrefix+a.offset),part),path=a.outputPrefix+a.offset+'.bin';files.set(path,new Uint8Array(Buffer.concat([r.nonce,r.ciphertext])));written.set(path,(written.get(path)??0)+1);const done=a.offset+part.length===body.length;return {offset:a.offset,bytes:part.length,done,...(done?{sha256:await crypto.sha256(body)}:{})};
   }
   case 'crypto.openSealedParts':{const out:Uint8Array[]=[];for(const p of a.parts){const b=files.get(p.path)!;out.push(await crypto.decrypt(unb64(a.keyBase64),unb64(p.aadBase64),b.subarray(0,12),b.subarray(12)));}return resultFile(new Uint8Array(Buffer.concat(out)));}
   default:throw Error('unsupported fixture method '+method);
  }};return await execute() as T;
 };
 let done=false,lastWork=0;
 for(let window=0;window<(baseline?3:15)&&!done;window++){
  calls.length=0;const before=sourceDecrypts,beforeGzip=gzipCalls,at=now;deadline=now+300000;inflated=false;firstDecrypt=true;streams.clear();const realm:Record<string,any>={Date:class extends Date{static now(){return now;}}};runInNewContext(source+';globalThis.__bytesCtor=Uint8Array;',realm);
  // Match the old and new pure native capability surfaces, without exposing UI.
  const Bytes=realm.__bytesCtor;realm.__podByteCodecs={sha256Bytes:(b:Uint8Array)=>b.length<=262144?new Bytes(createHash('sha256').update(b).digest()):null};
  let receipts=0,lastReceiptClass=0;const result=await realm.backgroundHandler({deadlineMs:deadline,isCancelled:()=>false,request,receipt:(id:number)=>{receipts++;lastReceiptClass=id;},payload:{mode,window,head,encrypted,key,logicalArchive,ref}});done=result.status==='success';expect(now).toBeLessThan(deadline);expect(result.work).toBeGreaterThanOrEqual(lastWork);
  proof.push({window:window+1,modeledMillis:now-at,sourceDecryptions:sourceDecrypts-before,gunzipCalls:gzipCalls-beforeGzip,writes:calls.filter(x=>x==='file.write').length,commits:calls.filter(x=>x==='file.commit').length,work:result.work,newWork:result.work-lastWork,done,receipts,lastReceiptClass,code:result.code,streamedCalls:calls.filter(x=>x==='crypto.gunzipSealedParts').length,hashes:calls.filter(x=>x==='file.hash').length});lastWork=result.work;
  console.info('RESTOREPATH_WINDOW',JSON.stringify(proof.at(-1)));
  // Native temporary files are disposable on process teardown, not receipts.
  for(const p of files.keys())if(p.includes('.pod-write-'))files.delete(p);
 }
 console.info('RESTOREPATH_SUMMARY',JSON.stringify({baseline,mode,capabilities:'bounded-native-sha256Bytes; no sha256Create in both baseline and candidate',sourceParts:51,archiveBytes:archive.length,entryBytes:body.length,proof}));
 if(baseline){expect(done).toBe(false);expect(proof.every(p=>p.commits===0&&p.sourceDecryptions===51&&p.streamedCalls===0)).toBe(true);expect(new Set(proof.map(p=>p.work)).size).toBe(1);expect(proof.every(p=>p.gunzipCalls===2&&p.hashes===1&&p.writes>=309&&p.writes<=326)).toBe(true);}
 else{expect(done).toBe(true);expect(proof.length).toBeGreaterThan(1);expect(sourceDecrypts).toBe(51);expect(proof.some(p=>p.streamedCalls>0)).toBe(true);expect(proof.every(p=>p.receipts>0||p.done)).toBe(true);expect([...written].filter(([p])=>/-p\d+\.bin$/.test(p)).every(([,n])=>n===1)).toBe(true);}
 }finally{rmSync(output,{recursive:true,force:true});}
},240000);
