import {test,expect} from 'bun:test';
import {encodeBase64} from '@podjs/framework/bytes';
import {D,lp,capabilityDigest,selectionDigest,objectId,planDigest,pageDigest,requestDigest,phaseArgs,descriptor,objectsRoot,appliedReceipt,receiptsRoot,completion} from '../../src/sync/library-resume/digests';
import {strictJson,envelope,hash,CHUNK_BYTES,ResumeError,type Capability,type Selection,type Envelope,type ObjectDescriptor,type AppliedReceipt,type Row,type BeginPayload} from '../../src/sync/library-resume/wire';
import {ResumeStore} from '../../src/sync/library-resume/store';
import {parseWireJson} from '../../src/sync/wire-json';
import {libraryRevision} from '../../src/sync/revision';
import {fixture,vectors,nonce} from '../helpers/library-resume-fixture';
const bodyObject=vectors.objects.find(o=>o.kind==='articleBody')!;
const rssObject=vectors.objects.find(o=>o.kind==='rssSource')!;
test('Python-produced JSON conformance vectors cover every phase and preserve raw byte digests',()=>{
 for(const v of vectors.lp)expect(Buffer.from(lp(v.value)).toString('hex')).toBe(v.hex);
 expect(D('wrss.library-resume.v1/account',Object.values(vectors.account))).toBe(vectors.accountScope);
 expect(capabilityDigest(vectors.capability as Capability)).toBe(vectors.capabilityDigest);
 expect(selectionDigest(vectors.selection as Selection)).toBe(vectors.selectionDigest);
 for(const o of [...vectors.objects,...vectors.readerObjects,...vectors.assetObjects,...vectors.metadataObjects]){expect(objectId(o as ObjectDescriptor)).toBe(o.objectId);expect(descriptor(o,vectors.selection.limits)).toEqual(o as any);}
 for(const v of vectors.requests){const r=envelope(v.frame);expect(phaseArgs(r.phase,r.payload!)).toEqual(v.phaseArgs);expect(requestDigest(r.jobId,r.planDigest,r.phase,r.payload!)).toBe(r.requestDigest);expect(JSON.parse(Buffer.from(v.utf8Base64,'base64').toString())).toEqual(v.frame);}
 const p=vectors.requests.find(v=>v.name==='begin')!.frame.payload as unknown as BeginPayload;
 expect(planDigest(p)).toBe(vectors.planDigest);expect(pageDigest(vectors.planDigest,0,0,vectors.objects as ObjectDescriptor[],'0'.repeat(64))).toBe(vectors.pageDigest);
 for(const r of vectors.receipts){const input=vectors.requests.find(v=>v.frame.requestId===r.applyRequestId)!.frame as unknown as Envelope;expect(appliedReceipt(input,r.objectId,vectors.watchDeviceId,'merged')).toEqual(r as any);}
 expect(receiptsRoot(vectors.receipts as AppliedReceipt[])).toBe(vectors.completion.receiptsRoot);
 expect(completion(vectors.bindings[0]!.jobId,vectors.planDigest,2,vectors.completion.receiptsRoot,0)).toEqual(vectors.completion as any);
 expect(new Set(vectors.requests.map(v=>v.frame.phase)).size).toBe(8);expect(vectors.scenarios).toHaveLength(22);
});
test('C lexical parser rejects duplicate/escaped keys, unsafe integers, floats and invalid Unicode without changing v14 parsing',()=>{
 for(const text of ['{"a":1,"a":2}','{"a":{"x":1,"\\u0078":2}}','{"n":-0}','{"n":1.0}','{"n":1e0}','{"n":9007199254740992}','{"x":"\\ud800"}','{"x":"\\udc00"}','{"x":true} trailing'])expect(()=>strictJson(text)).toThrow();
 expect(strictJson('{"x":"😀","array":[0,true,null]}')).toEqual({x:'😀',array:[0,true,null]});
 expect(()=>parseWireJson('{"action":"syncLibraryResume","x":1,"x":2}')).toThrow();
 expect(parseWireJson('{"action":"syncLibrary","x":1,"x":2}').x).toBe(2);
});
test('lost chunk ACK reconnects to durable missing ranges; apply business/receipt commit once',async()=>{
 const f=await fixture();try{
  let c=f.connect({drop:'putChunk'});await c.phone.prepare();await c.phone.begin();expect((await c.phone.manifest()).success).toBe(true);
  await expect(c.phone.put(0)).rejects.toThrow();await c.running;expect(f.native.stages).toBe(1);
  c=f.connect();await c.phone.prepare('resume');expect((await c.phone.begin('resume')).epoch).toBe(2);
  const missing=await c.phone.missing(),item=(missing.result!.items as Row[]).find(o=>o.objectId===bodyObject.objectId)!;expect(item.missingRanges).toEqual([[1,bodyObject.chunkHashes.length]]);
  for(let i=1;i<bodyObject.chunkHashes.length;i++)expect((await c.phone.put(i)).success).toBe(true);
  const result=await c.phone.apply();expect(result.success).toBe(true);expect(result.result!.state).toBe('APPLIED');
  expect((await c.phone.apply()).result!.receipt).toEqual(result.result!.receipt);
  expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);
  expect(await f.db.query('SELECT COUNT(*) AS n FROM library_resume_objects WHERE receipt IS NOT NULL')).toEqual([{n:1}]);
  expect(f.native.stages).toBe(bodyObject.chunkHashes.length);expect(f.native.objects.size).toBe(0);
  await c.pair.close();await c.running;
 }finally{f.sql.close();}
},30000);
test('business commit before lost APPLIED reply recovers the same receipt without another merge',async()=>{
 const f=await fixture();try{
  let c=f.connect({drop:'apply'});await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.stage();await expect(c.phone.apply()).rejects.toThrow();await c.running;
  const before=await f.db.query('SELECT description,receipt FROM library_resume_objects WHERE receipt IS NOT NULL');expect(before).toHaveLength(1);
  const revision=await libraryRevision(f.db);
  c=f.connect();await c.phone.prepare('resume');await c.phone.begin('resume');const r=await c.phone.apply();expect(r.success).toBe(true);expect(JSON.stringify(r.result!.receipt)).toBe(before[0]!.receipt as string);
  expect(await libraryRevision(f.db)).toEqual(revision);expect(f.native.stages).toBe(bodyObject.chunkHashes.length);
  await c.pair.close();await c.running;
 }finally{f.sql.close();}
},30000);
test('receipt failure rolls actual article SQL back; STAGED is reusable on the next connection',async()=>{
 const f=await fixture();try{
  let c=f.connect();await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.stage();
  await f.db.execute("CREATE TRIGGER resumec_fail_receipt BEFORE UPDATE OF receipt ON library_resume_objects WHEN NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  expect((await c.phone.apply()).error?.code).toBe('LOCAL_IO');await c.running;
  expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:0}]);expect(await f.db.query('SELECT COUNT(*) AS n FROM library_resume_objects WHERE receipt IS NOT NULL')).toEqual([{n:0}]);
  await f.db.execute('DROP TRIGGER resumec_fail_receipt');c=f.connect();await c.phone.prepare('resume');await c.phone.begin('resume');const r=await c.phone.missing();expect((r.result!.items as Row[]).find(v=>v.objectId===bodyObject.objectId)?.missingRanges).toEqual([]);expect((await c.phone.apply()).success).toBe(true);expect(f.native.stages).toBe(bodyObject.chunkHashes.length);
  await c.pair.close();await c.running;
 }finally{f.sql.close();}
},30000);
test('new connection fences an old connection even if it guesses the newest epoch',async()=>{
 const f=await fixture();try{
  const old=f.connect();await old.phone.prepare();await old.phone.begin();await old.phone.manifest();expect((await old.phone.put(0)).success).toBe(true);
  const current=f.connect();await current.phone.prepare('resume');await current.phone.begin('resume');old.phone.epoch=current.phone.epoch;
  expect((await old.phone.put(1)).error?.code).toBe('STALE_EPOCH');await old.running;
  expect((await current.phone.put(1)).success).toBe(true);expect((await current.phone.apply()).success).toBe(true);expect(f.native.stages).toBe(2);
  await current.pair.close();await current.running;
 }finally{f.sql.close();}
},30000);
test('same request ID with altered bytes is checked before historical STAGED or APPLIED adoption',async()=>{
 const f=await fixture();try{
  let c=f.connect();await c.phone.prepare();await c.phone.begin();await c.phone.manifest();const id=nonce();expect((await c.phone.put(0,id)).success).toBe(true);
  const altered=Buffer.from(vectors.bodyBase64,'base64').subarray(0,CHUNK_BYTES);altered[10]^=1;
  expect((await c.phone.put(0,id,altered)).error?.code).toBe('HASH_MISMATCH');await c.running;expect(f.native.stages).toBe(1);
  c=f.connect();await c.phone.prepare('resume');await c.phone.begin('resume');await c.phone.put(1);await c.phone.apply();
  expect((await c.phone.put(0,id,altered)).error?.code).toBe('HASH_MISMATCH');await c.running;expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);
 }finally{f.sql.close();}
},30000);
test('COMPLETE first resume grants a query epoch without reopening the job; missing returns completion',async()=>{
 const f=await fixture();try{
  let c=f.connect({drop:'complete'});await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.stage();const receipts:AppliedReceipt[]=[];
  for(const o of vectors.objects){const result=await c.phone.apply(o.objectId);expect(result.success).toBe(true);receipts.push(result.result!.receipt as unknown as AppliedReceipt);}
  const root=receiptsRoot(receipts);await expect(c.phone.request('complete',{objectCount:2,receiptsRoot:root,ackToInclusive:0})).rejects.toThrow();await c.running;
  c=f.connect();await c.phone.prepare('resume');const began=await c.phone.begin('resume');expect(began.result?.state).toBe('COMPLETE');expect(began.epoch).toBe(2);
  expect((await c.phone.missing(0)).result?.completion).toEqual(began.result!.completion as any);expect(f.native.objects.size).toBe(0);
  expect((await c.phone.request('complete',{objectCount:2,receiptsRoot:root,ackToInclusive:0})).result).toEqual(began.result!.completion as any);await c.running;
  expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);
 }finally{f.sql.close();}
},30000);
test('CANCELLED first resume permits a terminal query and never starts an object',async()=>{
 const f=await fixture();try{
  let c=f.connect();await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.put(0);expect((await c.phone.request('cancel',{reason:'USER_CANCEL'})).result?.state).toBe('CANCELLED');await c.running;
  c=f.connect();await c.phone.prepare('resume');expect((await c.phone.begin('resume')).result?.state).toBe('CANCELLED');expect((await c.phone.missing(0)).result?.state).toBe('CANCELLED');expect((await c.phone.apply()).error?.code).toBe('JOB_CANCELLED');await c.running;expect(f.native.objects.size).toBe(0);
 }finally{f.sql.close();}
},30000);

test('watch source starts only after confirm response and pushes by receiver missing without a v14 ACK',async()=>{
 const f=await fixture();try{
  const bytes=new Uint8Array(Buffer.from(vectors.bodyBase64,'base64')),objects=vectors.objects as ObjectDescriptor[],job=nonce();
  const c=f.connect({source:async()=>({objects,read:async(o,index)=>{expect(o.kind).toBe('articleBody');return bytes.slice(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES);}})});
  await c.phone.prepare('create',[{direction:'watchToPhone',jobId:job,intent:'create',selection:vectors.selection as Selection}]);
  const receipts=new Map<string,AppliedReceipt>(),chunks=new Map<string,number[]>(),phases:string[]=[];let lastPlan='';
  for(;;){
   const r=envelope(await c.pair.phone.readFrame(30000));expect(r.type).toBe('request');expect(r.jobId).toBe(job);expect(r.requestDigest).toBe(requestDigest(r.jobId,r.planDigest,r.phase,r.payload!));phases.push(r.phase);lastPlan=r.planDigest!;
   let result:Row;const p=r.payload!;
   switch(r.phase){
    case 'begin':expect(p.direction).toBe('watchToPhone');expect(planDigest(p as unknown as BeginPayload)).toBe(r.planDigest!);result={disposition:'CREATED',selectionDigest:p.selectionDigest,state:'PLANNING',expiresAtMillis:86401000,nextManifestPage:0,completion:null};break;
    case 'manifestPage':expect(p.entries).toEqual(objects);result={pageIndex:p.pageIndex,pageDigest:p.pageDigest,nextManifestPage:1,manifestVerified:true,state:'READY'};break;
    case 'missing':result={state:'READY',nextManifestPage:1,expiresAtMillis:86401000,items:objects.map(o=>({objectId:o.objectId,state:'PENDING',missingRanges:o.chunkHashes.length?[[0,o.chunkHashes.length]]:[],receipt:null})),next:null,done:true,completion:null};break;
    case 'putChunk':{const o=objects.find(v=>v.objectId===p.objectId)!;const raw=new Uint8Array(Buffer.from(String(p.dataBase64),'base64'));expect(hash(raw)).toBe(o.chunkHashes[Number(p.chunkIndex)]);const indexes=chunks.get(o.objectId)??[];indexes.push(Number(p.chunkIndex));chunks.set(o.objectId,indexes);result={objectId:o.objectId,chunkIndex:p.chunkIndex,chunkState:'STAGED',objectState:'PARTIAL',receipt:null};break;}
    case 'apply':{const o=objects.find(v=>v.objectId===p.objectId)!;expect(chunks.get(o.objectId)??[]).toHaveLength(o.chunkHashes.length);const receipt=appliedReceipt(r,o.objectId,vectors.phoneDeviceId,'merged');receipts.set(o.objectId,receipt);result={state:'APPLIED',receipt};break;}
    case 'complete':{const root=receiptsRoot(objects.map(o=>receipts.get(o.objectId)!));expect(p.receiptsRoot).toBe(root);result=completion(job,r.planDigest!,objects.length,root,0) as unknown as Row;break;}
    default:throw Error('Unexpected source phase '+r.phase);
   }
   const {payload,...header}=r;await c.pair.phone.writeFrame({...header,type:'response',success:true,epoch:7,result});if(r.phase==='complete')break;
  }
  await c.running;expect(c.errors).toEqual([]);expect(phases).toContain('putChunk');expect(phases).not.toContain('getChunk');expect(phases).not.toContain('ack');
  const saved=await f.db.query('SELECT completion FROM library_resume_peer_ack WHERE job_id=?',[job]);expect(saved).toHaveLength(1);expect(JSON.parse(String(saved[0]!.completion)).completionDigest).toBe(completion(job,lastPlan,objects.length,receiptsRoot(objects.map(o=>receipts.get(o.objectId)!)),0).completionDigest);
 }finally{f.sql.close();}
},30000);

test('native error codes retain their protocol classification and malformed error replies fail closed',()=>{
 const request=vectors.requests.find(r=>r.name==='chunk0')!.frame as unknown as Envelope;
 const {payload,...base}=request;
 expect(()=>envelope({...base,type:'response',success:false,result:null,error:{code:'HASH_MISMATCH',class:'STATE',retryable:true,recovery:'WAIT',retryAfterMillis:100}})).toThrow('INVALID_FRAME');
 expect(envelope({...base,type:'response',success:false,result:null,error:new ResumeError('LEASE_EXPIRED').wire()}).error?.recovery).toBe('BEGIN');
});

test('expiry uses elapsed time and GC preserves business data and asset references',async()=>{
 const f=await fixture();try{
  const store=new ResumeStore(f.db);await store.initialize();await store.observeClock(1000);const first=store.now();await store.observeClock(1500);expect(store.now()).toBe(first+500);await store.observeClock(10);expect(store.now()).toBe(first+500);
  const c=f.connect();await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.stage();await c.phone.apply();await c.pair.close();await c.running;
  await f.db.execute("INSERT INTO library_resume_assets VALUES('a.png',?,1,'notes/assets/a.png','merged')",['a'.repeat(64)]);
  const touched=(await f.store.job(c.server.scope,c.phone.jobId))!;await f.db.execute('UPDATE library_resume_jobs SET expires_at=0');let cleaned=0;
  await f.store.exclusive(()=>f.store.collect(c.server.scope,async j=>{expect(j.jobId).toBe(touched.jobId);cleaned++;}));
  expect(cleaned).toBe(1);expect(await f.store.job(c.server.scope,c.phone.jobId)).toBeNull();expect(await f.db.query('SELECT id FROM articles')).toHaveLength(1);expect(await f.db.query('SELECT path FROM library_resume_assets')).toHaveLength(1);
 }finally{f.sql.close();}
});

test('note image publication, conflict retention and APPLIED asset registration use the business transaction',async()=>{
 const {ResumeAssets}=await import('../../src/sync/library-resume/assets');const f=await fixture();try{
  await f.store.initialize();await f.db.execute('CREATE TABLE image_receipt(id INTEGER)');
  const host=async<T>(method:string,args:Row):Promise<T>=>{const bytes=f.native.files.get(String(args.path));if(method==='file.hash')return {size:bytes?.length,sha256:bytes&&hash(bytes)} as T;throw Error('unexpected host method');};
  const assets=new ResumeAssets(host,f.store,f.chunks),d=vectors.assetObjects[0] as ObjectDescriptor,object={id:d.objectId,size:d.size,sha256:d.sha256,chunkHashes:d.chunkHashes},bytes=new Uint8Array(Buffer.from(vectors.assetBase64,'base64'));
  const lease=await f.chunks.acquire('b'.repeat(64),nonce());await f.chunks.stage(lease,object,0,bytes,{id:nonce(),digest:'c'.repeat(64)});
  f.native.files.set('notes/assets/resume.png',new Uint8Array([1,2]));const publication=await assets.publish(lease,object,d);expect(publication.path.startsWith('notes/asset-conflicts/')).toBe(true);expect(f.native.files.get('notes/assets/resume.png')).toEqual(new Uint8Array([1,2]));
  const boundary={before:[],after:()=>[{sql:'INSERT INTO image_receipt VALUES(1)'}]};await f.db.execute("CREATE TRIGGER image_fail BEFORE INSERT ON library_resume_assets BEGIN SELECT RAISE(ABORT,'image rollback'); END");await expect(assets.apply(d,publication.path,boundary)).rejects.toThrow();expect(await f.db.query('SELECT * FROM image_receipt')).toEqual([]);await f.db.execute('DROP TRIGGER image_fail');await assets.apply(d,publication.path,boundary);expect(await f.db.query('SELECT outcome FROM library_resume_assets')).toEqual([{outcome:'retainedLocal'}]);expect(await f.db.query('SELECT * FROM image_receipt')).toHaveLength(1);
  const invalid={...d,metadataBase64:Buffer.from(JSON.stringify({storageKey:'../escape',size:d.size,sha256:d.sha256})).toString('base64')};await expect(assets.publish(lease,object,invalid)).rejects.toThrow('BUSINESS_REJECTED');const oversized={...d,size:6*1024*1024,metadataBase64:Buffer.from(JSON.stringify({storageKey:'resume.png',size:6*1024*1024,sha256:d.sha256})).toString('base64')};await expect(assets.publish(lease,object,oversized)).rejects.toThrow('BUSINESS_REJECTED');
 }finally{f.sql.close();}
});

test('1864-object plan pages stay bounded and missing never occupies the native window',async()=>{
 const f=await fixture();try{
  const c=f.connect();await c.phone.prepare();
  const objects=Array.from({length:1864},(_unused,i)=>{const {objectId:_id,...raw}=rssObject;const o={...raw,businessId:'https://resume.invalid/feed/'+i,contentVersion:String(i)};return {...o,objectId:objectId(o as Omit<ObjectDescriptor,'objectId'>)} as ObjectDescriptor;}).sort((a,b)=>a.objectId<b.objectId?-1:1);
  const base=vectors.requests.find(v=>v.name==='begin')!.frame.payload as unknown as BeginPayload,pageObjectCounts=Array.from({length:Math.ceil(objects.length/16)},(_,i)=>Math.min(16,objects.length-i*16)),payload={...base,objectCount:objects.length,objectsRoot:objectsRoot(objects.map(o=>o.objectId)),pageObjectCounts};c.phone.plan=planDigest(payload);
  let r=await c.phone.request('begin',payload as unknown as Row);expect(r.success).toBe(true);c.phone.epoch=r.epoch!;let previous='0'.repeat(64),peakPage=0;
  for(let at=0,index=0;at<objects.length;at+=16,index++){const entries=objects.slice(at,at+16),digest=pageDigest(c.phone.plan,index,at,entries,previous);const payload={pageIndex:index,startIndex:at,previousPageDigest:previous,pageDigest:digest,entries};peakPage=Math.max(peakPage,Buffer.byteLength(JSON.stringify(payload)));r=await c.phone.request('manifestPage',payload);expect(r.success).toBe(true);previous=digest;}
  r=await c.phone.missing(16);expect((r.result!.items as Row[]).length).toBe(16);expect(r.result!.done).toBe(false);expect(f.native.objects.size).toBe(0);expect(peakPage).toBeLessThan(131072);await c.pair.close();await c.running;
 }finally{f.sql.close();}
},30000);

test('corrupted APPLIED receipts stop replay instead of adopting a historical success',async()=>{const f=await fixture();try{let c=f.connect();await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.stage();await c.phone.apply();await c.pair.close();await c.running;const row=(await f.db.query('SELECT receipt FROM library_resume_objects WHERE receipt IS NOT NULL'))[0]!;const receipt=JSON.parse(String(row.receipt));receipt.resultDigest='0'.repeat(64);await f.db.execute('UPDATE library_resume_objects SET receipt=? WHERE receipt IS NOT NULL',[JSON.stringify(receipt)]);c=f.connect();await c.phone.prepare('resume');await c.phone.begin('resume');const r=await c.phone.apply();expect(r.error?.code).toBe('RECEIPT_CONFLICT');await c.running;}finally{f.sql.close();}});

test('original frozen source bytes are revalidated after a local content change',async()=>{const {sourcePlan,resumeInventoryDigest}=await import('../../src/sync/library-resume/repository');const f=await fixture();try{const c=f.connect();await c.phone.prepare();await c.phone.begin();await c.phone.manifest();await c.phone.stage();await c.phone.apply();await c.pair.close();await c.running;const inventory=await f.repository.resumeFreeze(),w={snapshotId:nonce(),manifestDigest:resumeInventoryDigest(inventory),fromExclusive:0,toInclusive:0};await f.store.saveSnapshot(c.server.scope,w,inventory);const plan=await sourcePlan(f.repository,f.store,c.server.scope,w,vectors.selection as Selection);const d=plan.objects.find(o=>o.kind==='articleBody')!;expect(d).toBeDefined();expect(hash(await plan.read(d,0))).toBe(d.chunkHashes[0]);await f.db.execute("UPDATE articles SET content='Changed source'");await f.db.execute("DELETE FROM article_original_chunks");await f.db.execute("UPDATE article_body_chunks SET body='Changed source'");const recovered=await sourcePlan(f.repository,f.store,c.server.scope,w,vectors.selection as Selection);await expect(recovered.read(d,0)).rejects.toThrow('SOURCE_CHANGED');}finally{f.sql.close();}});

test('actual source scheduler applies metadata before the first four resource hashes for windows 1 and 4',async()=>{
 for(const window of [1,4]){const f=await fixture();try{
  f.cap.kinds.splice(2,0,{kind:'readerMetadata',schemaVersion:1,send:true,receive:true},{kind:'readerResource',schemaVersion:1,send:true,receive:true});f.cap.limits={...f.cap.limits,maxInFlightObjects:window};
  const objects:ObjectDescriptor[]=[];for(let i=0;i<4;i++){
   const rawMetadata={presets:[],fonts:[{id:'font-'+i,sha256:hash(new Uint8Array([120])),displayName:'Font',familyName:'Font',fileName:'font.ttf',mimeType:'font/ttf',metadataJson:'{}',modifiedBy:vectors.phoneDeviceId,byteCount:1,updatedAt:2000,faceCount:1,deleted:false}],backgrounds:[],deletions:[]},mb=Buffer.from(JSON.stringify(rawMetadata)),base={...(vectors.readerObjects.find(o=>o.kind==='readerMetadata')! as ObjectDescriptor),businessId:'font-'+i,metadataBase64:mb.toString('base64'),metadataSha256:hash(mb)};let parent:ObjectDescriptor;for(let salt=0;;salt++){const o={...base,contentVersion:String(salt)};parent={...o,objectId:objectId(o)};if(parent.objectId[0]==='f')break;}objects.push(parent);
   const resource=vectors.readerObjects.find(o=>o.kind==='readerResource')! as ObjectDescriptor;for(let salt=0;;salt++){const o={...resource,businessId:'font-'+i,contentVersion:String(salt),dependsOn:[parent.objectId]},child={...o,objectId:objectId(o)};if(child.objectId[0]==='0'){objects.push(child);break;}}
  }objects.sort((a,b)=>a.objectId<b.objectId?-1:1);expect(objects.slice(0,4).every(o=>o.kind==='readerResource')).toBe(true);
  const c=f.connect({source:async()=>({objects,read:async()=>new Uint8Array([120])})}),job=nonce(),selection={kinds:f.cap.kinds.map(({kind,schemaVersion})=>({kind,schemaVersion})),limits:{...f.cap.limits}};await c.phone.prepare('create',[{direction:'watchToPhone',jobId:job,intent:'create',selection}]);const receipts=new Map<string,AppliedReceipt>(),order:string[]=[],active=new Set<string>();let peak=0;
  for(;;){const r=envelope(await c.pair.phone.readFrame(30000)),p=r.payload!;let result:Row;
   if(r.phase==='begin')result={disposition:'CREATED',selectionDigest:p.selectionDigest,state:'PLANNING',expiresAtMillis:86401000,nextManifestPage:0,completion:null};
   else if(r.phase==='manifestPage')result={pageIndex:p.pageIndex,pageDigest:p.pageDigest,nextManifestPage:1,manifestVerified:true,state:'READY'};
   else if(r.phase==='missing')result={state:'READY',nextManifestPage:1,expiresAtMillis:86401000,items:objects.map(o=>({objectId:o.objectId,state:'PENDING',missingRanges:o.size?[[0,1]]:[],receipt:null})),next:null,done:true,completion:null};
   else if(r.phase==='putChunk'){const o=objects.find(o=>o.objectId===p.objectId)!;expect(o.dependsOn.every(id=>receipts.has(id))).toBe(true);active.add(o.objectId);peak=Math.max(peak,active.size);result={objectId:o.objectId,chunkIndex:0,chunkState:'STAGED',objectState:'STAGED',receipt:null};}
   else if(r.phase==='apply'){const o=objects.find(o=>o.objectId===p.objectId)!;expect(o.dependsOn.every(id=>receipts.has(id))).toBe(true);const receipt=appliedReceipt(r,o.objectId,vectors.phoneDeviceId,'merged');receipts.set(o.objectId,receipt);order.push(o.kind);active.delete(o.objectId);result={state:'APPLIED',receipt};}
   else if(r.phase==='complete')result=completion(job,r.planDigest!,objects.length,receiptsRoot(objects.map(o=>receipts.get(o.objectId)!)),0) as unknown as Row;
   else throw Error('Unexpected scheduler request');const {payload,...base}=r;await c.pair.phone.writeFrame({...base,type:'response',epoch:1,success:true,result} as unknown as Row);if(r.phase==='complete')break;
  }await c.running;expect(order).toEqual([...Array(4).fill('readerMetadata'),...Array(4).fill('readerResource')]);expect(peak).toBeLessThanOrEqual(window);
 }finally{f.sql.close();}}
},30000);

test('source-change cancellation persists the local source tombstone and frees the active job slot',async()=>{const f=await fixture();try{const c=f.connect({source:async()=>({objects:[bodyObject as ObjectDescriptor],read:async()=>{throw Error('SOURCE_CHANGED');}})}),job=nonce();await c.phone.prepare('create',[{direction:'watchToPhone',jobId:job,intent:'create',selection:vectors.selection as Selection}]);let cancelled=false;
 for(;;){const r=envelope(await c.pair.phone.readFrame(30000)),p=r.payload!;let result:Row;if(r.phase==='begin')result={disposition:'CREATED',selectionDigest:p.selectionDigest,state:'PLANNING',expiresAtMillis:86401000,nextManifestPage:0,completion:null};else if(r.phase==='manifestPage')result={pageIndex:0,pageDigest:p.pageDigest,nextManifestPage:1,manifestVerified:true,state:'READY'};else if(r.phase==='missing')result={state:'READY',nextManifestPage:1,expiresAtMillis:86401000,items:[{objectId:bodyObject.objectId,state:'PENDING',missingRanges:[[0,bodyObject.chunkHashes.length]],receipt:null}],next:null,done:true,completion:null};else if(r.phase==='cancel'){expect(p.reason).toBe('SOURCE_CHANGED');cancelled=true;result={state:'CANCELLED',alreadyComplete:false};}else throw Error('Unexpected source phase '+r.phase);const {payload,...base}=r;await c.pair.phone.writeFrame({...base,type:'response',epoch:1,success:true,result} as unknown as Row);if(cancelled)break;}
 await c.running;expect((await f.store.job(c.server.scope,job))?.state).toBe('CANCELLED');expect((await f.db.query("SELECT COUNT(*) AS n FROM library_resume_jobs WHERE state NOT IN ('CANCELLED','COMPLETE')"))[0]!.n).toBe(0);
 }finally{f.sql.close();}});
