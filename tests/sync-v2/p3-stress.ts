/** Bounded synthetic host evidence. Does not measure device/network throughput. */
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {engine,ContentBackend,crypt} from './p3-fixture';
import {ContentFiles} from '@podjs/framework/content-files';
import {strict as assert} from 'node:assert';
const output=process.argv[2];if(!output)throw Error('evidence path required');
const root=mkdtempSync(join(tmpdir(),'wrss-p3-stress-')),report:any={scope:'synthetic host; virtual network time; real codec/file/SQL IO',windows:[],stages:{},legacy:{},cache:{},batch:{},control:{}};
let database:any;
function stage(m:any){const s=report.stages[m.stage]??={bytes:0,objects:0};s.bytes+=m.bytes;s.objects+=m.objects;}
const bytes=(n:number)=>Uint8Array.from({length:n},(_,i)=>(i*17+(i>>>8)*31+(i>>>16)*7)&255);
try{
 // Exactly 19,408,275 logical bytes / 297 independently authenticated gzip units.
 const oldSize=19408275,old=bytes(oldSize),oldPath=join(root,'old');mkdirSync(oldPath);let input=0,encoded=0,ioCalls=0,networkMs=0,authenticateMs=0,decompressMs=0,writeMs=0,checkpointMs=0;
 for(let i=0;i<297;i++){const end=Math.floor((i+1)*oldSize/297),plain=old.subarray(input,end),compressed=gzipSync(plain),nonce=Buffer.alloc(12);nonce.writeUInt32BE(i,8);const c=createCipheriv('aes-256-gcm',Buffer.alloc(32,9),nonce),wire=Buffer.concat([c.update(compressed),c.final(),c.getAuthTag()]);encoded+=wire.length;
  let at=performance.now();const received=Buffer.from(wire);networkMs+=performance.now()-at;at=performance.now();const d=createDecipheriv('aes-256-gcm',Buffer.alloc(32,9),nonce);d.setAuthTag(received.subarray(-16));const compressedRead=Buffer.concat([d.update(received.subarray(0,-16)),d.final()]);authenticateMs+=performance.now()-at;
  at=performance.now();const actual=gunzipSync(compressedRead);decompressMs+=performance.now()-at;assert.deepEqual(actual,Buffer.from(plain));
  at=performance.now();writeFileSync(join(oldPath,String(i)),actual);ioCalls++;writeMs+=performance.now()-at;at=performance.now();writeFileSync(join(oldPath,'checkpoint'),String(end));ioCalls++;checkpointMs+=performance.now()-at;input=end;
 }
 report.legacy={logicalBytes:oldSize,gzipChunks:297,wireBytes:encoded,networkCopyMillis:networkMs,authenticateMillis:authenticateMs,decompressMillis:decompressMs,fileMillis:writeMs,checkpointMillis:checkpointMs,fileCalls:ioCalls,semantics:'cost-only harness; file writes here are not a durable legacy ACK proof'};
 // Real production P3 engine across >=3 explicit 300s/8MiB windows and restarts.
 const transforms:any={encrypt:{calls:0,millis:0},decrypt:{calls:0,millis:0},decompress:{calls:0,millis:0}};
 const timed=<T extends keyof typeof crypt>(method:T,stage:string)=>async(...args:any[])=>{const at=performance.now();try{return await (crypt[method] as any)(...args);}finally{transforms[stage].calls++;transforms[stage].millis+=performance.now()-at;}};
 const countedCrypto={...crypt,encrypt:timed('encrypt','encrypt'),decrypt:timed('decrypt','decrypt'),gunzip:timed('gunzip','decompress')};
 const backend=new ContentBackend();backend.requestCost=Number(process.argv[3]??200);if(!Number.isSafeInteger(backend.requestCost)||backend.requestCost<0||backend.requestCost>3000)throw Error('invalid virtual request cost');report.virtualRequestCostMillis=backend.requestCost;
 const counter={reads:0,bytes:0},small:any[]=[];let polls=0,maxGap=0,last=performance.now(),f:any;
 const yieldControl=async()=>{const at=performance.now();maxGap=Math.max(maxGap,at-last);last=at;if(f&&polls++%16===0){const started=performance.now();await f.db.query('SELECT 1 AS authorized');await f.db.transaction([{sql:'CREATE TABLE IF NOT EXISTS synthetic_small_state (id INTEGER PRIMARY KEY, value INTEGER)'},{sql:'INSERT OR REPLACE INTO synthetic_small_state(id,value) VALUES (1,?)',params:[polls]}]);small.push(performance.now()-started);}await new Promise(r=>setTimeout(r,0));};
 const item={entityKey:'e'.repeat(64),bodyRevision:'f'.repeat(32),sourceBinding:'source-19408275',kind:'file' as const,importedFile:true,addedAtMillis:1};
 f=engine(root,backend,old,{crypto:countedCrypto,sourceCounter:counter,metric:stage,yieldControl,assertCurrent:async()=>{polls++;}});database=f.db;await f.store.init();await f.e.enqueue(item,'upload');
 for(let i=0;i<8;i++){const before=backend.uploaded,started=performance.now(),result=await f.e.runWindow(),bytes=backend.uploaded-before;report.windows.push({index:i+1,...result,persistedBytes:bytes,wallMillis:performance.now()-started,virtualMillis:backend.clock,sourceBytes:counter.bytes});if(i<3)assert(bytes>0);if(result.status==='complete')break;f.db.close();f=engine(root,backend,old,{crypto:countedCrypto,sourceCounter:counter,metric:stage,yieldControl,assertCurrent:async()=>{polls++;}});database=f.db;await f.store.init();}
 assert(report.windows.length>=3);assert.equal(report.windows.at(-1).status,'complete');const before={source:counter.bytes,read:f.host.readBytes,uploaded:backend.uploaded,seal:report.stages.seal.bytes};
 f.db.close();f=engine(root,backend,old,{crypto:countedCrypto,sourceCounter:counter,metric:stage,yieldControl});database=f.db;await f.store.init();const reads=f.host.readBytes;await f.db.transaction([{sql:'UPDATE synthetic_small_state SET value=value+1 WHERE id=1'}]);await f.e.enqueue(item,'upload');await f.e.runWindow();await f.e.manifest(item.entityKey,item.bodyRevision);
 report.cache={singleBody:{sourceBytes:counter.bytes-before.source,cacheReadBytes:f.host.readBytes-reads,uploadedBytes:backend.uploaded-before.uploaded,resealedBytes:report.stages.seal.bytes-before.seal}};assert.deepEqual(report.cache.singleBody,{sourceBytes:0,cacheReadBytes:0,uploadedBytes:0,resealedBytes:0});
 // Receive the same authenticated 19.4MB recipe/blob graph in bounded windows.
 mkdirSync(join(root,'receiver'));let receiver=engine(join(root,'receiver'),backend,new Uint8Array(),{crypto:countedCrypto,metric:stage,yieldControl});database=receiver.db;await receiver.store.init();const manifest=await f.e.manifest(item.entityKey,item.bodyRevision),{sourceBinding,...receiveItem}=item;await receiver.e.enqueue({...receiveItem,...manifest!},'download');report.receiveWindows=[];
 for(let i=0;i<8;i++){const beforeBytes=backend.downloaded,r=await receiver.e.runWindow();report.receiveWindows.push({...r,persistedBytes:backend.downloaded-beforeBytes});if(i<3)assert(backend.downloaded>beforeBytes);if(r.status==='complete')break;receiver.db.close();receiver=engine(join(root,'receiver'),backend,new Uint8Array(),{crypto:countedCrypto,metric:stage,yieldControl});database=receiver.db;await receiver.store.init();}
 assert.equal(report.receiveWindows.at(-1).status,'complete');assert.deepEqual(await receiver.e.readRange(item.entityKey,item.bodyRevision,0,262144),old.subarray(0,262144));report.v2Transforms=transforms;report.v2IdentityDecompressions=transforms.decompress.calls;report.receiveFileTimings=receiver.host.timings;receiver.db.close();database=f.db;
 // 34 objects with exact total 194,527,459, reusing a bounded source buffer.
 f.db.close();mkdirSync(join(root,'large-cache'));const largeRoot=join(root,'large-cache'),total=194527459,part=Math.ceil(total/34),large=bytes(part),sourceCounter={reads:0,bytes:0},largeBackend=new ContentBackend();let largeFixture=engine(largeRoot,largeBackend,large,{sourceCounter,sourceLength:binding=>binding==='source-33'?total-part*33:part,metric:stage,yieldControl,assertCurrent:async()=>{polls++;}});database=largeFixture.db;f=largeFixture;await largeFixture.store.init();
 for(let i=0;i<34;i++)await largeFixture.e.enqueue({...item,entityKey:i.toString(16).padStart(64,'0'),sourceBinding:'source-'+i},'upload');
 let largeWindows=0;for(;largeWindows<30;largeWindows++){const r=await largeFixture.e.runWindow();if(r.status==='complete'){largeWindows++;break;}}
 assert.equal(sourceCounter.bytes,total);assert(largeWindows<30);const uploaded=largeBackend.uploaded;largeFixture.db.close();largeFixture=engine(largeRoot,largeBackend,large,{sourceCounter,sourceLength:binding=>binding==='source-33'?total-part*33:part,metric:stage,yieldControl,assertCurrent:async()=>{polls++;}});database=largeFixture.db;f=largeFixture;await largeFixture.store.init();const sourceBefore=sourceCounter.bytes,hostBefore=largeFixture.host.readBytes,at=performance.now();await largeFixture.e.runWindow();
 report.cache.fullExport={objects:34,logicalBytes:total,initialWindows:largeWindows,cacheSourceReadBytes:sourceCounter.bytes-sourceBefore,cacheFileReadBytes:largeFixture.host.readBytes-hostBefore,reuploadedBytes:largeBackend.uploaded-uploaded,cacheWallMillis:performance.now()-at,metadataMaxPageRows:largeFixture.db.maxRows};assert.equal(report.cache.fullExport.cacheFileReadBytes,0);assert.equal(report.cache.fullExport.cacheSourceReadBytes,0);
 // Same persisted files, same stat semantics. Only invocation grouping differs.
 const plans=await largeFixture.store.page('',32,'body:'),paths=plans.map(p=>largeFixture.store.path(p.value.recipeObject.cache)),calls=largeFixture.host.calls;let atBatch=performance.now();const baseline=[];for(const p of paths)baseline.push(...await largeFixture.store.files.stat([p]));const baselineMs=performance.now()-atBatch,baselineCalls=largeFixture.host.calls-calls;
 const calls2=largeFixture.host.calls;atBatch=performance.now();const batched=await largeFixture.store.files.stat(paths);assert.deepEqual(batched,baseline);report.batch={entries:paths.length,byteLimit:262144,itemLimit:32,baselineCalls,batchedCalls:largeFixture.host.calls-calls2,baselineMillis:baselineMs,batchedMillis:performance.now()-atBatch,metadataDataBytes:0};assert(report.batch.batchedCalls<baselineCalls);
 report.control={authorizationPolls:polls,smallChanges:small.length,maxSmallChangeMillis:Math.max(0,...small),maxYieldGapMillis:maxGap,scope:'host yield callbacks + actual synthetic SQLite short writes; not emulator UI latency'};assert(maxGap<1000);assert(report.control.maxSmallChangeMillis<1000);
 report.transmitFileTimings=largeFixture.host.timings;report.memory=process.memoryUsage();report.peakRssBytes=process.resourceUsage().maxRSS*1024;report.completed=true;writeFileSync(output,JSON.stringify(report,null,2)+'\n');
}finally{database?.close();rmSync(root,{recursive:true,force:true});}
