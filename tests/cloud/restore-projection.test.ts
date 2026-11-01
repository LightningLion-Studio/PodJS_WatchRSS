import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {crypto,key} from './k2-crypto';
import {restoreCallsiteTrace} from '../../src/cloud/restore-callsite';
const fw=resolve(dirname(realpathSync(resolve(import.meta.dir,'../../node_modules/@podjs/framework/package.json'))),'../..');
const {buildBackground}=await import(fw+'/packages/cli/src/background-build.ts');
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64'),unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
test('RESTOREPROJ frozen production adapters: count-shaped baseline stall or resumable candidate convergence',async()=>{
 const baseline=process.env.RESTOREPROJ_BASELINE==='1',output=mkdtempSync(join(tmpdir(),'restore-projection-'));
 try{
  const appRoot=process.env.RESTOREPROJ_APP_ROOT??resolve(import.meta.dir,'../..'),artifact=(await buildBackground({path:resolve(appRoot,'tests/cloud/fixtures/restore-projection-entry.ts')},output)).path!,source=readFileSync(join(output,artifact.file),'utf8');
  const files=new Map<string,Uint8Array>(),secure=new Map<string,string>(),writes=new Map<string,number>(),proof:any[]=[];
  let now=Date.now(),deadline=now+300000,serial=0,seeding=true,trace=restoreCallsiteTrace(),methods:Record<string,number>={},receiptCount=0;
  const encrypted=await crypto.encrypt(key,new Uint8Array(),new Uint8Array(1048560));
  const resultFile=async(bytes:Uint8Array,directory='cloud-crypto')=>{const path=directory+'/.pod-write-'+ ++serial+'.part';files.set(path,bytes);return {path,size:bytes.length,sha256:await crypto.sha256(bytes)};};
  const request=async<T>(method:string,a:any):Promise<T>=>{
   if(!seeding){trace.observe(a);methods[method]=(methods[method]??0)+1;now+=method==='file.write'?940:method==='file.commit'?6000:method==='file.compose'?6000:method==='crypto.largeAesGcmDecrypt'?500:method==='crypto.openSealedParts'?500:method==='crypto.aesGcmDecrypt'?100:method.startsWith('secure.')?20:method==='file.read'?20:5;}
   if(now>=deadline)throw Error('NATIVE_HARD_STOP');
   const execute=async():Promise<any>=>{switch(method){
    case 'runtime.delay':return null;
    case 'secure.get':return {exists:secure.has(a.key),value:secure.get(a.key)};
    case 'secure.set':secure.set(a.key,a.value);return {};
    case 'secure.update':for(const[k,v]of Object.entries(a.values)){if(v===null)secure.delete(k);else secure.set(k,String(v));}return {updated:true};
    case 'secure.compareAndSet':if((secure.get(a.key)??null)!==a.expected)return {updated:false};secure.set(a.key,a.value);return {updated:true};
    case 'file.createTemp':return resultFile(new Uint8Array(),a.directory);
    case 'file.delete':files.delete(a.path);return {};
    case 'file.stat':return {exists:files.has(a.path),file:files.has(a.path),size:files.get(a.path)?.length??0};
    case 'file.read':{const b=files.get(a.path)!;return {offset:a.offset,size:b.length,dataBase64:b64(b.subarray(a.offset,a.offset+a.maxBytes))};}
    case 'file.write':{const before=a.append?files.get(a.path)!:new Uint8Array(),part=unb64(a.dataBase64);if(a.append)expect(a.expectedOffset).toBe(before.length);files.set(a.path,new Uint8Array(Buffer.concat([before,part])));return {size:before.length+part.length};}
    case 'file.hash':return {size:files.get(a.path)!.length,sha256:await crypto.sha256(files.get(a.path)!)};
    case 'file.commit':{const b=files.get(a.path)!;expect(b.length).toBe(a.expectedSize);expect(await crypto.sha256(b)).toBe(a.expectedSha256);files.set(a.target,b);files.delete(a.path);writes.set(a.target,(writes.get(a.target)??0)+1);return {path:a.target,size:b.length,sha256:a.expectedSha256};}
    case 'file.compose':{const chunks:Uint8Array[]=[];for(const p of a.parts){const b=files.get(p.path)!;expect(b.length).toBe(p.size);expect(await crypto.sha256(b)).toBe(p.sha256);chunks.push(b);}const body=new Uint8Array(Buffer.concat(chunks));expect(body.length).toBe(a.expectedSize);expect(await crypto.sha256(body)).toBe(a.expectedSha256);files.set(a.target,body);return {path:a.target,size:body.length,sha256:a.expectedSha256};}
    case 'crypto.hkdfSha256':return {keyBase64:b64(await crypto.hkdf(unb64(a.inputBase64),unb64(a.saltBase64),unb64(a.infoBase64)))};
    case 'crypto.hash':return {digestBase64:Buffer.from(await crypto.sha256(unb64(a.dataBase64)),'hex').toString('base64')};
    case 'crypto.aesGcmEncrypt':{const s=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.dataBase64));return {nonceBase64:b64(s.nonce),ciphertextBase64:b64(s.ciphertext)};}
    case 'crypto.aesGcmDecrypt':return {dataBase64:b64(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),unb64(a.ciphertextBase64)))};
    case 'crypto.largeAesGcmEncrypt':{const s=await crypto.encrypt(unb64(a.keyBase64),unb64(a.aadBase64),files.get(a.inputPath)!);return {...await resultFile(s.ciphertext),nonceBase64:b64(s.nonce)};}
    case 'crypto.largeAesGcmDecrypt':return resultFile(await crypto.decrypt(unb64(a.keyBase64),unb64(a.aadBase64),unb64(a.nonceBase64),files.get(a.inputPath)!));
    case 'crypto.openSealedParts':{const parts:Uint8Array[]=[];for(let i=0;i<a.parts.length;i++){const p=a.parts[i],b=files.get(p.path);if(!b||b.length!==p.bytes+28)throw Error('sealed_part_invalid_'+i);try{parts.push(await crypto.decrypt(unb64(a.keyBase64),unb64(p.aadBase64),b.subarray(0,12),b.subarray(12)));}catch{throw Error('sealed_part_invalid_'+i);}}return resultFile(new Uint8Array(Buffer.concat(parts)));}
    default:throw Error('unsupported fixture method '+method);
   }};return await execute() as T;
  };
  function realm(){const r:Record<string,any>={Date:class extends Date{static now(){return now;}}};runInNewContext(source+';globalThis.__Bytes=Uint8Array;',r);const Bytes=r.__Bytes;
   // Same current native hash surface on both sides. Counts/timing are a
   // deterministic admission model; no Android throughput claim is made.
   r.__podByteCodecs={sha256Bytes:(b:Uint8Array)=>b.length<=262144?new Bytes(createHash('sha256').update(b).digest()):null,sha256Create:()=>{const hash=createHash('sha256');return {update:(b:Uint8Array)=>{hash.update(b);return true;},finish:()=>new Bytes(hash.digest())};}};return r;}
  const payload={key,nonce:encrypted.nonce,ciphertext:encrypted.ciphertext};
  const seed=await realm().backgroundHandler({deadlineMs:deadline,isCancelled:()=>false,request,receipt:()=>{},payload:{...payload,seed:true}});expect(seed.status).toBe('seeded');seeding=false;
  let previous=seed.work,done=false;
  for(let window=1;window<=(baseline?3:8)&&!done;window++){
   trace=restoreCallsiteTrace();methods={};receiptCount=0;const began=now;deadline=now+300000;
   const result=await realm().backgroundHandler({deadlineMs:deadline,isCancelled:()=>false,request,receipt:(id:number)=>{trace.receipt(id);receiptCount++;},payload});done=result.status==='success';
   expect(now).toBeLessThan(deadline);expect(result.work).toBeGreaterThanOrEqual(previous);
   proof.push({window,modeledMillis:now-began,writes:methods['file.write']??0,commits:methods['file.commit']??0,compose:methods['file.compose']??0,largeDecrypt:methods['crypto.largeAesGcmDecrypt']??0,smallDecrypt:methods['crypto.aesGcmDecrypt']??0,counts:trace.summary().counts,receipts:receiptCount,newWork:result.work-previous,done,code:result.code});previous=result.work;console.info('RESTOREPROJ_WINDOW',JSON.stringify(proof.at(-1)));
   for(const p of files.keys())if(p.includes('.pod-write-'))files.delete(p);
   if(done){const body=files.get(result.path)!;expect(body.length).toBe(12058624);let at=0;for(let i=0;i<50;i++){const length=i<34?262144:196608;expect(body.subarray(at,at+length).every(v=>v===i+1)).toBe(true);at+=length;}}
  }
  if(baseline){expect(done).toBe(false);for(const p of proof){expect(p.counts.find(([id]:number[])=>id===69)?.[1]).toBe(134);expect(p.counts.find(([id]:number[])=>id===67)?.[1]).toBe(33);expect(p.counts.find(([id]:number[])=>id===74)?.[1]).toBe(2);expect(p.largeDecrypt).toBe(51);expect(p.receipts).toBe(0);expect(p.commits).toBe(0);expect(p.writes).toBeGreaterThanOrEqual(260);expect(p.writes).toBeLessThanOrEqual(280);}expect(proof.at(-1).code).toContain('cloud_snapshot_progress_stalled');}
  else{expect(done).toBe(true);expect(proof.length).toBeGreaterThan(1);expect(proof.filter(p=>!p.done).every(p=>p.receipts>0)).toBe(true);expect(proof.every(p=>!p.counts.some(([id]:number[])=>id===69))).toBe(true);expect([...writes].filter(([path])=>path.startsWith('books/')).every(([,count])=>count===1)).toBe(true);expect(proof.reduce((n,p)=>n+p.compose,0)).toBe(1);}
  console.info('RESTOREPROJ_SUMMARY',JSON.stringify({baseline,sourceShape:{fullParts:34,shortParts:16,smallMetadata:33,largeCallsiteRequests:134,legacyBookWrites:184},proof}));
 }finally{rmSync(output,{recursive:true,force:true});}
},90000);
