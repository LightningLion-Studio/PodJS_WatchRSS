const journalTextReaders=new Map<string,{text:string;at:number}>();let journalTextReaderId=0;
import {plainPart,openLocalPart} from './plain-parts-fixture';
import {stateSqlFixture,cloudStateValues} from './state-sql-fixture';
import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {crypto,key} from './k2-crypto';
import {restoreCallsiteTrace} from '../../src/cloud/restore-callsite';
import {utf8Encode} from '../../src/cloud/types';
import type {CloudManifest} from '../../src/cloud/codec';
const fw=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
const {buildBackground}=await import(fw+'/packages/cli/src/background-build.ts');
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
for(const encoding of ['identity','gzip-chunks-v1'] as const)test('RESTORE1197 '+encoding+': completed small-chunk prefix is reused across fresh production guests',async()=>{
 const baseline=process.env.RESTORE1197_BASELINE==='1',output=mkdtempSync(join(tmpdir(),'restore-prefix-'));
 const stateSql=stateSqlFixture();
 try{
  const appRoot=process.env.RESTORE1197_APP_ROOT??resolve(import.meta.dir,'../..'),artifact=(await buildBackground({path:resolve(appRoot,'tests/cloud/fixtures/restore-prefix-entry.ts')},output)).path!,source=readFileSync(join(output,artifact.file),'utf8');
  const files=new Map<string,Uint8Array>(),secure=new Map<string,string>(),writes=new Map<string,number>(),proof:any[]=[];
  const partBytes=131072,seedParts=360,totalParts=400,body=new Uint8Array(totalParts*partBytes),chunks:any[]=[];
  const cache='watch-cloud-cache/'+(await crypto.sha256(utf8Encode(JSON.stringify(['https://backend.invalid','user'])))).slice(0,32);
  for(let i=0;i<totalParts;i++){
   const part=body.subarray(i*partBytes,(i+1)*partBytes);part.fill(i%251+1);const plain=encoding==='gzip-chunks-v1'?new Uint8Array(gzipSync(part)):part,hash=await crypto.sha256(plain),salt=new Uint8Array(16).fill(i%256),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/chunk/v1')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-chunk-v1:'+hash),plain),blob=new Uint8Array(Buffer.concat([Buffer.from('WRSSCC2'),salt,sealed.nonce,sealed.ciphertext])),cipher=await crypto.sha256(blob);
   chunks.push({plaintextSha256:hash,ciphertextSha256:cipher,plaintextBytes:plain.length,ciphertextBytes:blob.length,saltBase64:b64(salt),nonceBase64:b64(sealed.nonce)});files.set(cache+'/chunks/'+cipher.slice(0,2)+'/'+cipher+'.bin',blob);
  }
  const manifest:CloudManifest={format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:'fixture',sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},settings:{},credentialEnvelopes:{},objects:[{name:'reader/fixture.txt',encoding,originalBytes:body.length,encodedBytes:chunks.reduce((n,c)=>n+c.plaintextBytes,0),contentSha256:await crypto.sha256(body),chunks}]};
  let now=Date.now(),deadline=now+300000,serial=0,seeding=true,trace=restoreCallsiteTrace(),methods:Record<string,number>={},receipts=0,sourceDecrypts=0;
  const resultFile=async(bytes:Uint8Array,directory='cloud-crypto')=>{const path=directory+'/.pod-write-'+ ++serial+'.part';files.set(path,bytes);return {path,size:bytes.length,sha256:await crypto.sha256(bytes)};};
  const request=async<T>(method:string,a:any):Promise<T>=>{
   if(!seeding){trace.observe(a);methods[method]=(methods[method]??0)+1;now+=method==='crypto.aesGcmDecrypt'?500:method==='file.read'?80:method==='file.stat'?10:method==='file.write'?800:method==='file.commit'?1000:method==='crypto.openSealedParts'?1000:5;}
   if(now>=deadline)throw Error('NATIVE_HARD_STOP');
   const execute=async():Promise<any>=>{switch(method){
   case 'sql.query':case 'sql.execute':case 'sql.transaction':return stateSql.host(method,a);
    case 'runtime.delay':return null;
    case 'secure.keys':return {keys:[...secure.keys()].filter(k=>a.prefixes.some((p:string)=>k.startsWith(p))&&k>(a.after??'')).sort(),hasMore:false};
   case 'secure.get':return {exists:secure.has(a.key),value:secure.get(a.key)};
    case 'secure.set':secure.set(a.key,a.value);return {};
    case 'secure.compareAndSet':if((secure.get(a.key)??null)!==a.expected)return {updated:false};secure.set(a.key,a.value);return {updated:true};
    case 'secure.update':for(const[k,v]of Object.entries(a.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}return {updated:true};
    case 'file.createTemp':return resultFile(new Uint8Array(),a.directory);
    case 'file.delete':files.delete(a.path);return {};
    case 'file.stat':return {exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0};
    case 'file.openText':{const id='journal-reader-'+(++journalTextReaderId);journalTextReaders.set(id,{text:Buffer.from(files.get(a.path)!).toString('utf8'),at:0});return {id};}
   case 'file.readTextChunk':{const reader=journalTextReaders.get(a.id)!;let end=Math.min(reader.text.length,reader.at+a.maxChars);if(end<reader.text.length&&reader.text.charCodeAt(end-1)>=0xd800&&reader.text.charCodeAt(end-1)<=0xdbff)end++;const text=reader.text.slice(reader.at,end);reader.at=end;return {text,eof:end===reader.text.length};}
   case 'file.closeText':return {closed:journalTextReaders.delete(a.id)};
   case 'file.read':{const b=files.get(a.path)!;return {offset:a.offset,size:b.length,dataBase64:b64(b.subarray(a.offset,a.offset+a.maxBytes))};}
    case 'file.write':{const before=a.append?files.get(a.path)!:new Uint8Array(),part=unb64(a.dataBase64);if(a.append)expect(a.expectedOffset).toBe(before.length);files.set(a.path,new Uint8Array(Buffer.concat([before,part])));return {size:before.length+part.length};}
    case 'file.hash':return {size:files.get(a.path)!.length,sha256:await crypto.sha256(files.get(a.path)!)};
    case 'file.commit':{const b=files.get(a.path)!;expect(b.length).toBe(a.expectedSize);expect(await crypto.sha256(b)).toBe(a.expectedSha256);files.set(a.target,b);files.delete(a.path);writes.set(a.target,(writes.get(a.target)??0)+1);return {path:a.target,size:b.length,sha256:a.expectedSha256};}
    case 'crypto.hkdfSha256':return {keyBase64:b64(await crypto.hkdf(unb64(a.inputBase64),unb64(a.saltBase64),unb64(a.infoBase64)))};
    case 'crypto.hash':return {digestBase64:Buffer.from(await crypto.sha256(unb64(a.dataBase64)),'hex').toString('base64')};
    case 'crypto.aesGcmEncrypt':{const s=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.dataBase64));return {nonceBase64:b64(s.nonce),ciphertextBase64:b64(s.ciphertext)};}
    case 'crypto.aesGcmDecrypt':if(Buffer.from(a.aadBase64,'base64').toString().startsWith('watchrss-cloud-chunk-v1:')){sourceDecrypts++;now+=9000;}return {dataBase64:b64(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),unb64(a.ciphertextBase64)))};
    case 'crypto.largeAesGcmDecrypt':{if(Buffer.from(a.aadBase64,'base64').toString().startsWith('watchrss-cloud-chunk-v1:')){sourceDecrypts++;now+=9000;}return resultFile(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),files.get(a.inputPath)!));}
    case 'crypto.closeSealedGzip':return {};
    case 'crypto.gunzipSealedParts':{const packed:Uint8Array[]=[];for(const p of a.parts){const b=files.get(p.path)!;packed.push(await openLocalPart(unb64(a.keyBase64),unb64(p.aadBase64),b,crypto.decrypt));}const out=new Uint8Array(gunzipSync(Buffer.concat(packed)));expect(out.length).toBeLessThanOrEqual(a.maxOutputBytes);const part=out.subarray(a.offset,a.offset+262144),sealed=await crypto.encrypt(unb64(a.keyBase64),utf8Encode(a.aadPrefix+a.offset),part);files.set(a.outputPrefix+a.offset+'.bin',a.plaintext?plainPart(utf8Encode(a.aadPrefix+a.offset),part):new Uint8Array(Buffer.concat([sealed.nonce,sealed.ciphertext])));const done=a.offset+part.length===out.length;return {offset:a.offset,bytes:part.length,done,...(done?{sha256:await crypto.sha256(out)}:{})};}
    case 'crypto.openSealedParts':{const parts:Uint8Array[]=[];for(let i=0;i<a.parts.length;i++){const p=a.parts[i],b=files.get(p.path);if(!b||b.length!==p.bytes+28)throw Error('sealed_part_invalid_'+i);try{parts.push(await openLocalPart(unb64(a.keyBase64),unb64(p.aadBase64),b,crypto.decrypt));}catch{throw Error('sealed_part_invalid_'+i);}}return resultFile(new Uint8Array(Buffer.concat(parts)));}
    default:throw Error('unsupported fixture method '+method);
   }};return await execute() as T;
  };
  function realm(){const r:Record<string,any>={Date:class extends Date{static now(){return now;}}};runInNewContext(source+';globalThis.__Bytes=Uint8Array;',r);const Bytes=r.__Bytes;
   r.__podByteCodecs={sha256Bytes:(b:Uint8Array)=>b.length<=262144?new Bytes(createHash('sha256').update(b).digest()):null,sha256Create:()=>{const hash=createHash('sha256');return {update:(b:Uint8Array)=>{hash.update(b);return true;},finish:()=>new Bytes(hash.digest())};}};return r;}
  const payload={key,manifest,seedParts,partBytes};
  const seed=await realm().backgroundHandler({deadlineMs:deadline,request,receipt:()=>{},payload:{...payload,seed:true}});expect(seed.status).toBe('seeded');seeding=false;
  let previous=seed.work,done=false;
  for(let window=1;window<=(baseline?3:6)&&!done;window++){
   trace=restoreCallsiteTrace();methods={};receipts=0;const began=now,before=sourceDecrypts;deadline=now+300000;
   const result=await realm().backgroundHandler({deadlineMs:deadline,request,receipt:(id:number)=>{trace.receipt(id);receipts++;},payload});done=result.status==='success';
   expect(now).toBeLessThan(deadline);expect(result.work).toBeGreaterThanOrEqual(previous);
   proof.push({window,modeledMillis:now-began,methods:{...methods},counts:trace.summary().counts,receipts,newWork:result.work-previous,sourceDecrypts:sourceDecrypts-before,done,code:result.code});previous=result.work;console.info('RESTORE1197_WINDOW',JSON.stringify(proof.at(-1)));
   for(const p of files.keys())if(p.includes('.pod-write-'))files.delete(p);
   if(done){expect(result.bytes).toBe(body.length);expect(result.sha256).toBe(manifest.objects[0].contentSha256);}
  }
  if(baseline){expect(done).toBe(false);expect(proof.every(p=>p.receipts===0&&p.sourceDecrypts===0&&(p.methods['file.commit']??0)===0)).toBe(true);expect(new Set(proof.map(p=>p.newWork))).toEqual(new Set([0]));for(const p of proof){const n=p.counts.find(([id]:number[])=>id===67)?.[1];expect(n).toBeGreaterThanOrEqual(470);expect(n).toBeLessThanOrEqual(500);}expect(proof.at(-1).code).toContain('cloud_snapshot_progress_stalled');}
  else{expect(done).toBe(true);expect(proof.length).toBeGreaterThan(1);expect(proof.every(p=>p.receipts>0||p.done)).toBe(true);expect(sourceDecrypts).toBe(totalParts-seedParts);expect([...writes].filter(([path])=>/-p\d+\.bin$/.test(path)).every(([,count])=>count===1)).toBe(true);}
  const summary={baseline,appRoot,framework:fw,sourceShape:{encoding,seedParts,totalParts,partBytes,bytes:body.length},proof};console.info('RESTORE1197_SUMMARY',JSON.stringify(summary));if(process.env.RESTORE1197_PROOF)writeFileSync(process.env.RESTORE1197_PROOF.replace(/\.json$/,encoding==='identity'?'.json':'-gzip-chunks.json'),JSON.stringify(summary,null,2)+'\n');
 }finally{stateSql.db.close();rmSync(output,{recursive:true,force:true});}
},120000);
