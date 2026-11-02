/** Offline differential bench. Real SHA/HKDF/AES with declared simulated host
 * latencies. Neither the latencies nor throughput are Android measurements. */
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {crypto,key,enabled} from '../../tests/cloud/k2-crypto';
import {ReadBatch} from '@podjs/framework/read-batch';
import type {CloudChunk,CloudObject,CloudManifest} from '../../src/cloud/codec';
import {bytesToBase64} from '@podjs/framework/bytes';
const base=process.env.RESTSPEED_BASE??resolve(import.meta.dir,'../../../PodJS_WatchRSS.wt-restspeed-base');
const candidate=resolve(import.meta.dir,'../..');
const encoder=new TextEncoder();
const delay=(n:number)=>new Promise<void>(r=>setTimeout(r,n));
const totalCipherBytes=88647085,unique=1109;
const blobs=new Map<string,Uint8Array>(),chunks:CloudChunk[]=[];
const distribute=(total:number,count:number)=>Array.from({length:count},(_,i)=>Math.floor(total/count)+(i<total%count?1:0));
// Match the published aggregate subset bytes and extrema, without private data.
const sizes=[1048627,...distribute(63867663-1048627,183),533,...distribute(totalCipherBytes-63867663-533,924)];
for(let i=0;i<unique;i++){
 const cipherBytes=sizes[i],plain=new Uint8Array(cipherBytes-51);for(let j=0;j<plain.length;j++)plain[j]=(i*13+j*31+(j>>>8))&255;new DataView(plain.buffer).setUint32(0,i);
 const hash=await crypto.sha256(plain),salt=new Uint8Array(16);new DataView(salt.buffer).setUint32(0,i);
 const derived=await crypto.hkdf(key,salt,encoder.encode('watchrss/cloud/chunk/v1'));
 const sealed=await crypto.encrypt(derived,encoder.encode('watchrss-cloud-chunk-v1:'+hash),plain);derived.fill(0);
 const blob=new Uint8Array(cipherBytes);blob.set(encoder.encode('WRSSCC2'));blob.set(salt,7);blob.set(sealed.nonce,23);blob.set(sealed.ciphertext,35);
 const c={plaintextSha256:hash,ciphertextSha256:await crypto.sha256(blob),plaintextBytes:plain.length,ciphertextBytes:cipherBytes,saltBase64:bytesToBase64(salt),nonceBase64:bytesToBase64(sealed.nonce)};chunks.push(c);blobs.set(c.ciphertextSha256,blob);
}
function object(name:string,cs:CloudChunk[]):CloudObject{const n=cs.reduce((s,c)=>s+c.plaintextBytes,0);return {name,encoding:'identity',originalBytes:n,encodedBytes:n,chunks:cs};}
const manifests:CloudManifest[]=[{format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:'first',sourceDeviceId:'first',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[object('reader/first',chunks.slice(0,184))],settings:{},credentialEnvelopes:{}},{format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:'second',sourceDeviceId:'second',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[object('reader/second-a',chunks.slice(0,555)),object('reader/second-b',chunks.slice(555))],settings:{},credentialEnvelopes:{}}];
const manifestBytes=manifests.map(m=>encoder.encode(JSON.stringify(m)));
const heads=await Promise.all(manifests.map(async(m,i)=>({id:m.snapshotId,sourceDeviceId:m.sourceDeviceId,deviceSequence:1,keyVersion:1,manifestSha256:await crypto.sha256(manifestBytes[i]),manifestSizeBytes:manifestBytes[i].length,parentHeads:{},observedHeads:{}})));
const shape={heads:2,chunkReferences:1293,uniqueChunks:unique,cipherBytes:totalCipherBytes,firstHeadCipherBytes:sizes.slice(0,184).reduce((n,b)=>n+b,0),minCipherBytes:Math.min(...sizes),maxCipherBytes:Math.max(...sizes),manifestBytes:manifestBytes.reduce((n,b)=>n+b.length,0),encoding:'identity',networkDelayMillis:2,sourceDecryptDelayMillis:2,secureReadDelayMillis:1,leaseCallDelayMillis:1,store:'in-memory',crypto:'real SHA256/HKDF/AES-256-GCM'};
async function run(root:string,mode:string){
 const {WatchCloudCodec}=await import(root+'/src/cloud/codec.ts'),{SnapshotRestoreCheckpoint}=await import(root+'/src/cloud/snapshot-checkpoint.ts'),{restoreSnapshots}=await import(root+'/src/cloud/snapshot-restore.ts'),{WatchCloudStateStore}=await import(root+'/src/cloud/state.ts'),{WatchCloudCache}=await import(root+'/src/cloud/cache.ts');
 let secureReads=0,secureWrites=0,networkReads=0,networkBytes=0,sourceDecrypts=0,applies=0,leases=0,activeFetch=0,maxFetch=0;
 const stateStore=new Map<string,string>(),files=new Map<string,Uint8Array>();
 const batch=new ReadBatch<string,boolean>(async()=>{secureReads++;await delay(1);return true;});
 const check=async()=>{await batch.get('account');};
 const state=new WatchCloudStateStore({get:async(k:string)=>stateStore.get(k),set:async(k:string,v:string)=>{secureWrites++;stateStore.set(k,v);},update:async(v:Record<string,string>)=>{await check();secureWrites++;for(const[k,s]of Object.entries(v))stateStore.set(k,s);}},'fixture','watch',enabled);
 const cache=new WatchCloudCache({read:async(p:string)=>files.get(p),writeAtomic:async(p:string,b:Uint8Array)=>{await check();files.set(p,b.slice());}},crypto.sha256,enabled);
 const codec=new WatchCloudCodec({...crypto,decrypt:async(k:Uint8Array,a:Uint8Array,n:Uint8Array,b:Uint8Array)=>{if(new TextDecoder().decode(a).startsWith('watchrss-cloud-chunk-v1:')){sourceDecrypts++;await delay(2);}return crypto.decrypt(k,a,n,b);}},enabled);
 const session:any={userId:'fixture',deviceId:'watch',keys:{currentKeyVersion:async()=>1,accountKey:async()=>key.slice()},state,cache,codec,assertCurrent:check,restoreCheckpoint:{state,cache,codec,assertCurrent:check,readBatch:async(fn:()=>Promise<any>)=>{leases++;await delay(1);try{return await batch.run(fn);}finally{await delay(1);}}},client:{snapshot:async(id:string)=>{const i=manifests.findIndex(m=>m.snapshotId===id);return {manifestUrl:id,chunks:manifests[i].objects.flatMap(o=>o.chunks).map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:c.ciphertextSha256}))};},download:async(id:string)=>{if(blobs.has(id)){networkReads++;networkBytes+=blobs.get(id)!.length;activeFetch++;maxFetch=Math.max(maxFetch,activeFetch);await delay(2);activeFetch--;return blobs.get(id)!.slice();}return manifestBytes[manifests.findIndex(m=>m.snapshotId===id)];},acknowledge:async()=>{}},library:{restorePayloads:async()=>{applies++;return {changed:1,pending:0,abandoned:0};}}};
 const start=performance.now(),cp=await new SnapshotRestoreCheckpoint(session,crypto.sha256,async()=>{},()=>performance.now()).open('epoch','generation');await cp.begin();
 await restoreSnapshots({session,heads,full:true,journal:cp,current:async()=>{},manifest:async(h:any)=>manifests.find(m=>m.snapshotId===h.id),hash:crypto.sha256,supported:()=>true,now:()=>performance.now(),status:()=>{},changed:()=>{}});
 const millis=performance.now()-start,progress=cp.progress;cp.close();
 if(networkReads!==unique||networkBytes!==totalCipherBytes||sourceDecrypts!==1293||applies!==3||maxFetch>1)throw Error('fixture invariant failed '+JSON.stringify({networkReads,networkBytes,sourceDecrypts,applies,maxFetch}));
 if(progress&&(progress.headsDone!==2||progress.download.done!==unique||progress.projection.done!==progress.projection.total))throw Error('progress invariant failed');
 return {mode,millis,MiBPerSecond:totalCipherBytes/1048576/(millis/1000),secureReads,secureWrites,leases,networkReads,networkBytes,sourceDecrypts,applies,maxFetch,progress};
}
const rows=[];for(let round=0;round<3;round++)for(const mode of round%2?['candidate','baseline']:['baseline','candidate']){const row=await run(mode==='baseline'?base:candidate,mode);rows.push(row);console.info('RESTSPEED_RUN',JSON.stringify({round,...row}));}
const median=(xs:number[])=>xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)],before=median(rows.filter(r=>r.mode==='baseline').map(r=>r.millis)),after=median(rows.filter(r=>r.mode==='candidate').map(r=>r.millis));
const result={shape,rows,medianBeforeMillis:before,medianAfterMillis:after,speedup:before/after};console.info('RESTSPEED_SUMMARY',JSON.stringify(result));if(process.env.RESTSPEED_OUTPUT)writeFileSync(process.env.RESTSPEED_OUTPUT,JSON.stringify(result,null,2)+'\n');
