import {createSyncV2Crypto,unhex} from '@podjs/framework/crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import {encodeBase64} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';
import {jsonBytes} from '../../../src/sync-v2/protocol';
import {WatchContentStore} from '../../../src/sync-v2/content-store';
import {WatchContentEngine} from '../../../src/sync-v2/content-engine';
import {WatchContentHttp} from '../../../src/sync-v2/content-http';
import {WatchServiceKeyPin} from '../../../src/sync-v2/service-key';
import {SyncV2Http} from '../../../src/sync-v2/http';
import {localProjectionCipher,projectionSql} from '../../../src/sync-v2/host';
import {b64} from '../../../src/sync-v2/wire';
import {SyntheticContentBackend} from '../p3-backend-fixture';
const g=globalThis as any;
let host:<T>(method:string,args:Record<string,unknown>)=>Promise<T>;
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
let lastMethod="start",decryptFailure="";
const handler=async(ctx:any)=>{
 host=(method,args)=>{lastMethod=method;return ctx.request('cloud.host',{method,args});};
 const scope={repoId:'01'.repeat(16),libraryEpoch:'1',contentGeneration:'2'},crypto=createSyncV2Crypto(host),alias='9'.repeat(64),publicKey=await crypto.signingKey(alias,true),spki=new Uint8Array(91);spki.set(unhex('3059301306072a8648ce3d020106082a8648ce3d030107034200'));spki.set(publicKey,26);
 const signCrypto={...crypto,sign:(_:string,b:Uint8Array)=>crypto.sign(alias,b)},backend=new SyntheticContentBackend(signCrypto,b64(spki)),servicePin=new WatchServiceKeyPin({get:async key=>host<string|null>('secure.get',{key}),compareAndSet:async(key,expected,value)=>(await host<{updated:boolean}>('secure.compareAndSet',{key,expected,value})).updated},'a'.repeat(32),async()=>({accountId:'a'.repeat(32),syncV2:{receiptKeyId:'e'.repeat(32),receiptSigningPublicKey:b64(spki),algorithm:'ES256'}})),http=new SyncV2Http(backend,'http://127.0.0.1:18942',scope,async()=>({userId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',accessToken:'synthetic',legacyDeviceId:'synthetic',scope}),false,servicePin,true),remote=new WatchContentHttp(http,signCrypto,()=>backend.clock),keys={id:new Uint8Array(32).fill(17),content:new Uint8Array(32).fill(34),version:1};
 const testKey=new Uint8Array(32).fill(3),testNonce=new Uint8Array(12).fill(4),testAad=new Uint8Array([1,2,3]),encrypted=await crypto.encrypt(testKey,testNonce,new Uint8Array([5]),testAad);await crypto.decrypt(testKey,testNonce,encrypted,testAad);
 const plain=new Uint8Array(1048579);for(let i=0;i<plain.length;i++)plain[i]=(i*17+(i>>>8)*31)&255;
 let reads=0,authentications=0,yields=0,maxGap=0,last=Date.now();const countedCrypto={...signCrypto,decrypt:async(...a:Parameters<typeof crypto.decrypt>)=>{authentications++;try{return await crypto.decrypt(...a);}catch(e){decryptFailure=JSON.stringify(e);throw e;}}};
 const options={alias,source:async(binding:string)=>({binding,size:plain.length,ranges:[],assertCurrent:async()=>{},read:async(offset:number,length:number)=>{reads++;return plain.subarray(offset,offset+length);}}),approved:async()=>({deviceId:'a'.repeat(32),keyId:'b'.repeat(32),publicKey:b64(publicKey)}) as any,assertCurrent:async()=>{},signals:async()=>({charging:true,wifi:false,bluetooth:false,cellular:true,internet:true,localRoute:false}),yieldControl:async()=>{maxGap=Math.max(maxGap,Date.now()-last);last=Date.now();yields++;await host('runtime.delay',{milliseconds:1});},now:()=>backend.clock};
 const sql=projectionSql(host),files=new ContentFiles(host),store=new WatchContentStore(sql,localProjectionCipher(host,'p3-send'),files,{scope,auth:'synthetic-send'});await store.init();let sender=new WatchContentEngine(store,remote,countedCrypto,keys,options),item={entityKey:'e'.repeat(64),bodyRevision:'f'.repeat(32),sourceBinding:'immutable',kind:'file' as const,addedAtMillis:1,importedFile:true};await sender.enqueue(item,'upload');
 const windows=[];for(let i=0;i<4;i++){const before=backend.uploaded,r=await sender.runWindow({maxBytes:524288});windows.push({...r,persistedBytes:backend.uploaded-before});if(r.status==='complete')break;sender=new WatchContentEngine(store,remote,countedCrypto,keys,options);}
 check(windows.length>=3&&windows.at(-1)!.status==='complete','windows');check(windows.slice(0,3).every(w=>w.persistedBytes>0),'progress');const manifest=await sender.manifest(item.entityKey,item.bodyRevision);check(manifest,'manifest');const before=reads;await sender.runWindow();check(reads===before,'cache-source-reread');
 const recvStore=new WatchContentStore(sql,localProjectionCipher(host,'p3-recv'),files,{scope,auth:'synthetic-recv'});await recvStore.init();let receiver=new WatchContentEngine(recvStore,remote,countedCrypto,keys,options);const {sourceBinding,...receive}=item;await receiver.enqueue({...receive,...manifest!},'download');for(let i=0;i<4;i++){const r=await receiver.runWindow({maxBytes:524288});if(r.status==='complete')break;receiver=new WatchContentEngine(recvStore,remote,countedCrypto,keys,options);}
 const sample=await receiver.readRange(item.entityKey,item.bodyRevision,260000,200000);check(sample.every((b,i)=>b===plain[260000+i]),'roundtrip');const frame=plain.subarray(0,65536),cp=jsonBytes({durableOffset:65536,checkpoint:'batch-proof'});
 await host('file.write',{path:'p3-baseline/prefix.bin',atomicReplace:true,dataBase64:encodeBase64(frame)});await host('file.publishBytes',{target:'p3-baseline/prefix.checkpoint',dataBase64:encodeBase64(cp),expectedSize:cp.length,expectedSha256:sha256Hex(cp)});
 await files.frame('0'.repeat(64)+'/'+'1'.repeat(64)+'.data',0,frame,'batch-proof');
 const result={bridgeComparison:{baselineCalls:2,batchedCalls:1,dataBytes:65536,checkpointBytes:cp.length},windows,sourceReads:reads,cacheSourceReads:reads-before,authentications,yields,maxYieldGapMillis:maxGap,sampleBytes:sample.length,syntheticOnly:true};await host('result',result);return 'success';
};

g.backgroundHandler=async(ctx:any)=>{try{return await handler(ctx);}catch(e){await ctx.request('cloud.host',{method:'result',args:{failure:String((e as Error).message??e).slice(0,200),lastMethod,decryptFailure}});throw Error('p3_test_failed');}};
