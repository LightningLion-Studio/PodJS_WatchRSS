import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {binaryRuntime,nonce} from '../helpers/library-binary-runtime';
import {attachBinaryBooks,sampleBook} from '../helpers/library-binary-books';
import {BinaryByteTransport} from '../../src/sync/library-binary/transport';
import {BinaryBooks} from '../../src/sync/library-binary/books';
import {LibraryBinaryConnection} from '../../src/sync/library-binary/coordinator';
import {ReceiveIndex} from '../../src/sync/library-binary/receive-index';
import {pagedBookBoundary} from '../../src/sync/library-binary/book-metadata';
import {bookFileWork} from '../../src/sync/library-binary/book-import';
import type {Job} from '../../src/sync/library-binary/store';
import {BinaryAssets} from '../../src/sync/library-binary/assets';
import {BOOK_SEGMENT_BYTES,bookObject,validateBookPlan} from '../../src/sync/library-binary/book-plan';
import {capabilityDigest,pageDigest,objectsRoot,planDigest,preparationDigest,receiptsRoot,requestDigest,selectionDigest} from '../../src/sync/library-binary/digests';
import {decodeFrame,encodeFrame} from '../../src/sync/library-binary/codec';
import {negotiate} from '../../src/sync/library-binary/routing';
import {BOOK_KINDS,CHUNK_BYTES,HARD_LIMITS,hash,type AppliedReceipt,type BeginPayload,type Binding,type Capability,type Envelope,type ObjectDescriptor,type Row,type Snapshot} from '../../src/sync/library-binary/wire';

type Fixture=Awaited<ReturnType<typeof binaryRuntime>>;
const request=(phase:Envelope['phase'],payload:Row,jobId:string|null=null,planDigest:string|null=null,epoch:number|null=null):Envelope=>({
 action:'syncLibraryBinary',version:2,type:'request',phase,jobId,planDigest,epoch,requestId:nonce(),requestDigest:requestDigest(jobId,planDigest,phase,payload),payload,
});
async function connect(f:Fixture){
 const session=f.session();
 const legacy=async(value:Row)=>{
  await session.connection.writeFrame(value);
  const reply=await session.connection.readFrame(3000);
  await session.connection.writeFrame({action:'ack',success:true,applied:true});
  return reply;
 };
 const probe=await legacy({action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportedLibraryBinaryVersions:[2],supportsPersistentSession:true,requestPersistentSession:true,supportsBookSyncV1:true,supportsBookReadingDeltaV1:true});
 await legacy({action:'syncAccount',version:1,deviceId:'phone',account:{userId:'b2-host'}});
 const cap=probe.libraryBinary as unknown as Capability;
 return {session,cap,switch:async()=>{
  await session.connection.writeFrame({action:'syncLibraryBinary',version:2,type:'request',phase:'switch',requestId:nonce(),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}});
  expect((await session.connection.readFrame(3000)).success).toBe(true);
  return new BinaryByteTransport(session.connection.detachStream());
 }};
}

async function receiver(f:Fixture,objects:ObjectDescriptor[],prior?:{binding:Binding;description:BeginPayload}){
 const {session,cap,switch:select}=await connect(f);
 const io=await select();
 const call=async(r:Envelope,success=true)=>{
  await io.writeFrame(encodeFrame({kind:'control',envelope:r}));
  const response=decodeFrame(await io.readFrame());
  if(response.kind!=='control'||response.envelope.phase!==r.phase)throw Error('Unexpected response');
  expect(response.envelope.success).toBe(success);return response.envelope;
 };
 const phoneCap={...cap,kinds:cap.kinds.filter(k=>BOOK_KINDS.some(kind=>k.kind===kind))};
 const selection=negotiate(phoneCap,cap)!;
 expect(selection.limits.maxInFlightChunks).toBe(8);
 const phoneSnapshot=prior?.description.phoneSnapshot??{snapshotId:'phone',manifestDigest:'1'.repeat(64),fromExclusive:0,toInclusive:0};
 const offer=request('prepare',{step:'offer',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',phoneCapabilities:phoneCap,phoneSnapshot,watchSnapshot:prior?.description.watchSnapshot??null});
 const offered=(await call(offer)).result!;
 const binding:Binding={jobId:prior?.binding.jobId??nonce(),direction:'phoneToWatch',intent:prior?'resume':'create',selection};
 await call(request('prepare',{step:'confirm',offerRequestId:offer.requestId,bindings:[binding],preparationDigest:preparationDigest(String(offered.offerDigest),[binding])}));
 const description:BeginPayload={intent:binding.intent,direction:binding.direction,accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',phoneSnapshot,watchSnapshot:offered.watchSnapshot as Snapshot,
  selection,selectionDigest:selectionDigest(selection),objectCount:objects.length,objectsRoot:objectsRoot(objects.map(d=>d.objectId)),pageObjectCounts:[objects.length]};
 const job=binding.jobId,plan=planDigest(description);
 const began=await call(request('begin',description as unknown as Row,job,plan));
 const epoch=began.epoch!,operation=(phase:Envelope['phase'],payload:Row,success=true,id?:string)=>{
  const frame=request(phase,payload,job,plan,epoch);
  if(id)frame.requestId=id;
  return call(frame,success);
 };
 let seq=0;
 return {binding,description,epoch,session,operation,io,
  manifest:()=>operation('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(plan,0,0,objects,'0'.repeat(64)),entries:objects}),
  send:async(d:ObjectDescriptor,index:number,payload:Uint8Array)=>{
   const digest=requestDigest(job,plan,'putChunk',{objectId:d.objectId,chunkIndex:index});
   await io.writeFrame(encodeFrame({kind:'data',streamId:1,objectSlot:objects.indexOf(d),epoch,txSeq:++seq,chunkIndex:index,requestId:digest.slice(0,32),requestDigest:digest,payload}));
  },
 };
}

async function transfer(peer:Awaited<ReturnType<typeof receiver>>,d:ObjectDescriptor,read:(d:ObjectDescriptor,index:number)=>Promise<Uint8Array>,from=0,to=d.chunkHashes.length){
 let batches=0;
 for(let start=from;start<to;start+=8){
  const end=Math.min(start+8,to);
  for(let i=start;i<end;i++)await peer.send(d,i,await read(d,i));
  let n=0;
  while(n<end-start){
   const ack=decodeFrame(await peer.io.readFrame());
   if(ack.kind!=='ack')throw Error(JSON.stringify(ack));
   n+=ack.entries.length;batches++;
  }
  expect(n).toBe(end-start);
 }
 return batches;
}

test('book groups admit the 512 MiB limit and reject incorrect segment ordering and missing kinds',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {repository,files}=await attachBinaryBooks(f);
  const {session,cap}=await connect(f);
  await session.pair.close();await session.running.catch(()=>{});
  const selection=negotiate(cap,cap)!;
  expect(selection.kinds.filter(k=>k.kind.startsWith('book'))).toHaveLength(4);
  const partial={...cap,kinds:cap.kinds.filter(k=>k.kind!=='bookReading')};
  expect(negotiate(partial,cap)?.kinds.some(k=>k.kind.startsWith('book'))).toBe(false);
  const books=new BinaryBooks(f.store,async()=>repository.books,files,f.chunks,()=>{});
  const id='1'.repeat(64),h='2'.repeat(64),state=bookObject('bookState',id,{bookId:id},[],{size:1,sha256:h,chunkHashes:[h]},HARD_LIMITS);
  const make=(size:number,reverse=false)=>{
   const key={bookId:id,fingerprint:h,packageSha256:h,packageBytes:size};
   const count=Math.ceil(size/BOOK_SEGMENT_BYTES);
   const segments=Array.from({length:count},(_,segmentIndex)=>{
    const segmentOffset=segmentIndex*BOOK_SEGMENT_BYTES,n=Math.min(BOOK_SEGMENT_BYTES,size-segmentOffset);
    return bookObject('bookPackageSegment',[id,h,segmentIndex].join(':'),{...key,segmentIndex,segmentCount:count,segmentOffset},[state.objectId],
     {size:n,sha256:h,chunkHashes:Array(Math.ceil(n/CHUNK_BYTES)).fill(h)},HARD_LIMITS);
   });
   const ids=segments.map(d=>d.objectId);if(reverse)ids.reverse();
   const commit=bookObject('bookPackageCommit',id,{...key,segmentObjectIds:ids},[state.objectId,...ids],{size:0,sha256:hash(new Uint8Array()),chunkHashes:[]},HARD_LIMITS);
   return [state,...segments,commit];
  };
  const largest=make(HARD_LIMITS.maxPackageBytes);
  expect(largest.at(-1)?.dependsOn).toHaveLength(33);
  expect(books.peak(largest,HARD_LIMITS)).toBeLessThan(HARD_LIMITS.maxStagingBytes);
  expect(()=>validateBookPlan(largest,HARD_LIMITS)).not.toThrow();
  // Match the Android SQL reply cap even though Bun SQLite has no such limit.
  const query=f.store.db.query;
  f.store.db.query=async(...args)=>{
   const rows=await query(...args);
   if(JSON.stringify(rows).length>512*1024)throw Error('SQL reply cap');
   return rows;
  };
  const inventory={objects:largest,paths:{}};
  const witness={snapshotId:'512-mib',manifestDigest:'f'.repeat(64),fromExclusive:0,toInclusive:0};
  expect(JSON.stringify(inventory).length).toBeGreaterThan(512*1024);
  await f.store.saveSnapshot('scope',witness,inventory);
  expect((await f.store.snapshot('scope',witness.snapshotId))?.inventory).toEqual(inventory);
  expect(()=>validateBookPlan(make(BOOK_SEGMENT_BYTES+1,true),HARD_LIMITS)).toThrow();
  expect(()=>make(HARD_LIMITS.maxPackageBytes+1)).toThrow();
 }finally{await f.dispose();}
});

test('book FileRefs survive reconnect and two segments commit with the existing reading clocks',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {repository,files}=await attachBinaryBooks(f);
  const book=await sampleBook(f,files,BOOK_SEGMENT_BYTES+CHUNK_BYTES+7);
  let peer=await receiver(f,book.objects);
  await peer.manifest();
  const receipts=new Map<string,AppliedReceipt>();
  const apply=async(d:ObjectDescriptor)=>{
   const result=await peer.operation('apply',{objectId:d.objectId});
   receipts.set(d.objectId,result.result!.receipt as AppliedReceipt);
  };
  await transfer(peer,book.stateObject,book.read);await apply(book.stateObject);
  await transfer(peer,book.reading,book.read);await apply(book.reading);
  expect(book.segments).toHaveLength(2);
  await transfer(peer,book.segments[0]!,book.read,0,8);
  const firstEpoch=peer.epoch;
  await peer.session.pair.close();await peer.session.running.catch(()=>{});
  peer=await receiver(f,book.objects,peer);
  expect(peer.epoch).toBeGreaterThan(firstEpoch);
  const missing=await peer.operation('missing',{afterObjectId:null,afterChunkIndex:null,limit:16});
  expect((missing.result!.items as Row[]).find(d=>d.objectId===book.segments[0]!.objectId)?.missingRanges).toEqual([[8,256]]);
  await transfer(peer,book.segments[0]!,book.read,8);await apply(book.segments[0]!);
  await transfer(peer,book.segments[1]!,book.read);await apply(book.segments[1]!);
  expect(await repository.books!.package(book.state.bookId)).toBeUndefined();
  expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
  await apply(book.commit);
  const published=await repository.books!.package(book.state.bookId);
  expect(published).toMatchObject(book.info);
  expect(await f.files.hash(published!.path)).toEqual(book.info);
  expect(await f.db.query('SELECT chapter_index FROM sync_book_chapters')).toEqual([{chapter_index:1}]);
  expect((await repository.books!.readingStates(false))[0]).toMatchObject({readingPositionChangedAt:21,favoriteSaved:true});
  await peer.operation('complete',{objectCount:book.objects.length,receiptsRoot:receiptsRoot(book.objects.map(d=>receipts.get(d.objectId)!)),ackToInclusive:0});
  await peer.session.running;
  expect((await files.stat(published!.path)).file).toBe(true);
  expect(f.refStats().readRefs).toBe(book.objects.reduce((n,d)=>n+d.chunkHashes.length,0));
  expect(f.refStats().maxRefs).toBeLessThanOrEqual(8);
  expect(await f.db.query('SELECT * FROM library_binary_book_files')).toEqual([]);
  const books=new BinaryBooks(f.store,async()=>repository.books,files,f.chunks,()=>{});
  const assets=new BinaryAssets(files,f.store,f.chunks,()=>{},()=>{},undefined,books);
  const snapshot=await assets.freeze('scope','book-frozen',HARD_LIMITS,new Set(BOOK_KINDS));
  await f.store.saveSnapshot('scope',snapshot.witness,snapshot.inventory);
  const source=await assets.source('scope',snapshot.witness,peer.description.selection);
  const second=source.objects.find(d=>d.kind==='bookPackageSegment'&&JSON.parse(d.metadataUtf8).segmentIndex===1)!;
  expect(source.range?.(second,0)).toMatchObject({offset:BOOK_SEGMENT_BYTES,size:CHUNK_BYTES});
 }finally{await f.dispose();}
},60000);

test('insufficient peak stops at manifest before accepting book DATA',async()=>{
 const f=await binaryRuntime({fileRefs:true,usableBytes:70*1024*1024});
 try{
  const {files}=await attachBinaryBooks(f);
  const book=await sampleBook(f,files,1048576);
  const peer=await receiver(f,book.objects);
  const failure=await peer.operation('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),
   pageDigest:pageDigest(planDigest(peer.description),0,0,book.objects,'0'.repeat(64)),entries:book.objects},false);
  expect(failure.error).toMatchObject({code:'STORAGE_PRESSURE',recovery:'STOP'});
  expect(f.refStats().readRefs).toBe(0);
  expect(await f.db.query('SELECT * FROM library_binary_peaks')).toEqual([]);
  await peer.session.running.catch(()=>{});
 }finally{await f.dispose();}
},10000);

test('book cancellation preserves hidden segment and never publishes a readable package',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {repository,files}=await attachBinaryBooks(f);
  const book=await sampleBook(f,files,CHUNK_BYTES+5);
  const peer=await receiver(f,book.objects);
  await peer.manifest();
  await transfer(peer,book.stateObject,book.read);await peer.operation('apply',{objectId:book.stateObject.objectId});
  const part=book.segments[0]!;
  await transfer(peer,part,book.read);await peer.operation('apply',{objectId:part.objectId});
  const cancelled=await peer.operation('cancel',{reason:'LOCAL_ABORT'});
  expect(cancelled.result).toEqual({state:'CANCELLED',alreadyComplete:false});
  await peer.session.running.catch(()=>{});
  expect(await repository.books!.package(book.state.bookId)).toBeUndefined();
  expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
  expect(await f.db.query('SELECT ready FROM library_binary_book_files')).toEqual([{ready:1}]);
  expect(await f.db.query('SELECT bytes FROM library_binary_peaks')).toHaveLength(1);
 }finally{await f.dispose();}
},10000);

test('expired book apply collects an unreferenced final package after rename',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {files,repository}=await attachBinaryBooks(f);
  const book=await sampleBook(f,files,CHUNK_BYTES+5);
  const peer=await receiver(f,book.objects);
  await peer.manifest();
  for(const d of [book.stateObject,...book.segments]){
   await transfer(peer,d,book.read);
   await peer.operation('apply',{objectId:d.objectId});
  }
  const commit=files.durableCommit;
  const final='books/'+book.state.bookId+'-'+book.info.sha256+'.jsonl';
  files.durableCommit=async(...args)=>{
   const result=await commit(...args);
   if(args[1]===final)throw Error('LOCAL_IO');
   return result;
  };
  await peer.operation('apply',{objectId:book.commit.objectId},false);
  await peer.session.running.catch(()=>{});
  expect(await repository.books!.package(book.state.bookId)).toBeUndefined();
  expect((await files.stat(final)).file).toBe(true);
  expect(await f.db.query('SELECT path,size FROM library_binary_book_publications')).toEqual([{path:final,size:book.info.size}]);
  const books=new BinaryBooks(f.store,async()=>repository.books,files,f.chunks,()=>{});
  const assets=new BinaryAssets(files,f.store,f.chunks,()=>{},()=>{},undefined,books);
  const [row]=await f.db.query('SELECT scope,job_id FROM library_binary_jobs');
  const job=await f.store.job(String(row!.scope),String(row!.job_id));
  expect(job).not.toBeNull();
  await f.db.execute('DELETE FROM library_binary_peaks');
  await expect(assets.peak({...HARD_LIMITS,maxStagingBytes:book.info.size-1},0)).rejects.toThrow('STORAGE_PRESSURE');
  await books.collect(job!);
  expect((await files.stat(final)).file).toBe(false);
  expect(await f.db.query('SELECT path FROM library_binary_book_publications')).toEqual([]);
  expect(await f.db.query('SELECT path FROM library_binary_book_files')).toEqual([]);
 }finally{await f.dispose();}
},10000);

test('the foreground factory applies the release B2 switch to books',()=>{
 const source=readFileSync(new URL('../../src/sync/application-host.ts',import.meta.url),'utf8');
 expect(source).toMatch(/new BinaryApplicationService\(\{[^\n]*\bb2BooksEnabled:RELEASE_B2_ENABLED\b/);
});

test('book host work advances only on completed bytes and stops in-flight calls',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {files}=await attachBinaryBooks(f);
  let progress:((value:unknown)=>void)|undefined,units=0,cancels=0;
  const work=bookFileWork(files,<T>(_method:string,args:Record<string,unknown>,observe?:(value:unknown)=>void)=>{
   expect(args.trackProgress).toBe(true);
   progress=observe;
   let reject!:(e:Error)=>void;
   const result=new Promise<T>((_,fail)=>{reject=fail;});
   return {result,cancel:()=>{cancels++;reject(Error('operation cancelled'));}};
  },()=>{units++;});
  const pending=work.files.hash('books/test');
  const settled=pending.then(()=>{throw Error('expected cancellation');},error=>{expect(error.message).toBe('operation cancelled');});
  for(const bytes of [0,65536,65536,5,131072])progress?.({bytes});
  expect(units).toBe(2);
  work.stop();work.stop();
  progress?.({bytes:196608});
  await settled;
  expect(cancels).toBe(1);
  expect(units).toBe(2);
  expect(()=>work.files.hash('books/late')).toThrow('AUTH_REVOKED');
 }finally{await f.dispose();}
});

const META_BYTES=1024*1024,FIELD_BYTES=256*1024;
const metadataDigest=(data:Uint8Array)=>{
 const sha=(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
 return {size:data.length,sha256:sha(data),chunkHashes:Array.from({length:Math.ceil(data.length/CHUNK_BYTES)},(_,i)=>sha(data.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)))};
};

for(const kind of ['bookState','bookReading'] as const)test(kind+' applies the body and UTF-8 field boundary through paged SQLite',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {files,repository}=await attachBinaryBooks(f),sample=await sampleBook(f,files,512);
  await f.store.initialize();
  await f.db.execute('CREATE TABLE metadata_receipt(outcome TEXT NOT NULL)');
  const {bookId:id}=sample.state,isState=kind==='bookState';
  if(!isState)await repository.books!.merge(sample.state);
  const query=f.db.query,transaction=f.db.transaction;
  f.db.query=async(...args)=>{
   const rows=await query(...args);
   if(Buffer.byteLength(JSON.stringify(rows))>512*1024)throw Error('Query result too large');
   return rows;
  };
  f.db.transaction=async statements=>{
   if(Buffer.byteLength(JSON.stringify(statements))>512*1024)throw Error('Oversized transaction');
   return transaction(statements);
  };
  const title='😀'.repeat(FIELD_BYTES/4),value=isState?{...sample.state,title}:[{
   bookId:id,chapterIndex:1,isRead:true,readingProgress:0.5,readingPositionBytes:1,
   readingPositionChangedAt:99,readingPositionContentHash:title,sourceDeviceId:'fixture',
  }];
  const json=Buffer.from(JSON.stringify(value)),body=Buffer.alloc(META_BYTES,0x20);
  // Keep the JSON first so the field and the trailing whitespace are both scanned.
  json.copy(body);
  const metadata=isState?{bookId:id}:{bookId:id,pageIndex:0},dependencies=isState?[]:[sample.stateObject.objectId];
  const descriptor=bookObject(kind,isState?id:id+':0',metadata,dependencies,metadataDigest(body),HARD_LIMITS);
  const books=new BinaryBooks(f.store,async()=>repository.books,files,f.chunks,()=>{});
  const path='books/received-metadata';
  await files.writeBytes(path,body);
  const job={scope:'test',jobId:'boundary-book',description:{selection:{limits:HARD_LIMITS}}} as Job;
  await books.apply(job,descriptor,path,{before:[],after:outcome=>[{sql:'INSERT INTO metadata_receipt VALUES(?)',params:[outcome]}]});
  const table=isState?'sync_books':'sync_book_reading',field=isState?'title':'readingPositionContentHash';
  expect(await f.db.query(`SELECT length(CAST(json_extract(state_json,'$.${field}') AS BLOB)) AS size FROM ${table}`)).toEqual([{size:FIELD_BYTES}]);
  expect(await f.db.query('SELECT outcome FROM metadata_receipt')).toEqual([{outcome:'merged'}]);
  expect(await f.db.query('SELECT count(*) AS n FROM library_binary_book_text')).toEqual([{n:0}]);
  const descriptors:ObjectDescriptor[]=[];
  await books.freeze('test','frozen',HARD_LIMITS,new Set(['bookState','bookReading']),d=>descriptors.push(d),async()=>{});
  expect(descriptors.find(d=>d.kind===kind)?.size).toBe(json.length);
 }finally{await f.dispose();}
},20000);

for(const shape of ['body','field'] as const)test('book '+shape+' exceeds business limit and replays terminal rejection',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {files}=await attachBinaryBooks(f),sample=await sampleBook(f,files,512);
  const id=sample.state.bookId,isState=shape==='body',kind=isState?'bookState':'bookReading';
  const value=isState?sample.state:[{
   bookId:id,chapterIndex:1,isRead:true,readingProgress:0.5,readingPositionBytes:1,
   readingPositionChangedAt:99,readingPositionContentHash:'😀'.repeat(FIELD_BYTES/4)+'x',sourceDeviceId:'fixture',
  }];
  const json=Buffer.from(JSON.stringify(value)),body=isState?Buffer.alloc(META_BYTES+1,0x20):json;
  if(isState)json.copy(body);
  const metadata=isState?{bookId:id}:{bookId:id,pageIndex:0},dependencies=isState?[]:[sample.stateObject.objectId];
  const descriptor=bookObject(kind,isState?id:id+':0',metadata,dependencies,metadataDigest(body),HARD_LIMITS);
  const objects=isState?[descriptor]:[sample.stateObject,descriptor].sort((a,b)=>a.objectId.localeCompare(b.objectId));
  const wireDigest={size:16*META_BYTES,sha256:descriptor.sha256,chunkHashes:Array<string>(256).fill(descriptor.sha256)};
  expect(bookObject(kind,descriptor.businessId,metadata,dependencies,wireDigest,HARD_LIMITS).size).toBe(16*META_BYTES);
  expect(()=>bookObject(kind,descriptor.businessId,metadata,dependencies,
   {...wireDigest,size:16*META_BYTES+1,chunkHashes:[...wireDigest.chunkHashes,descriptor.sha256]},HARD_LIMITS)).toThrow('INVALID_FRAME');
  const read=(d:ObjectDescriptor,i:number)=>d.objectId===descriptor.objectId?Promise.resolve(body.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)):sample.read(d,i);
  const peer=await receiver(f,objects);
  await peer.manifest();
  expect(peer.description.selection.limits.maxObjectBytes).toBe(16*1024*1024);
  if(!isState){
   await transfer(peer,sample.stateObject,read);
   await peer.operation('apply',{objectId:sample.stateObject.objectId});
  }
  const open=files.openText;
  let opened=0,reads=0;
  files.openText=(...args)=>{opened++;return open(...args);};
  const readText=files.readTextChunk;
  files.readTextChunk=(...args)=>{reads++;return readText(...args);};
  const requestId=nonce(),args={objectId:descriptor.objectId};
  await transfer(peer,descriptor,read);
  const rejected=await peer.operation('apply',args,false,requestId);
  expect(rejected).toMatchObject({result:null,error:{code:'BUSINESS_REJECTED',class:'BUSINESS',recovery:'STOP',retryable:false,retryAfterMillis:0}});
  await peer.session.running.catch(()=>{});
  expect(opened).toBe(isState?0:1);
  if(!isState)expect(reads).toBeGreaterThan(1);
  expect(await f.db.query('SELECT receipt FROM library_binary_objects WHERE object_id=?',[descriptor.objectId])).toEqual([{receipt:null}]);
  const journal=await f.db.query('SELECT result FROM library_binary_requests WHERE request_id=?',[requestId]);
  expect(JSON.parse(String(journal[0]?.result))).toEqual({errorCode:'BUSINESS_REJECTED'});
  expect(await f.db.query(isState?'SELECT book_id FROM sync_books':'SELECT book_id FROM sync_book_reading')).toEqual([]);

  // Re-authenticate and resume after losing a response. A persisted result makes
  // rereading the rejected object unnecessary even when its file is unavailable.
  files.openText=async()=>{throw Error('unexpected replay read');};
  const resumed=await receiver(f,objects,peer);
  expect(resumed.epoch).toBe(peer.epoch+1);
  const again=await resumed.operation('apply',args,false,requestId);
  expect(again.error).toEqual(rejected.error);
  await resumed.session.running.catch(()=>{});
 }finally{await f.dispose();}
},20000);

test('the books gate keeps syncBooks available when opted out independently',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  delete f.ports.b2BooksEnabled;
  await attachBinaryBooks(f);
  const {session,cap}=await connect(f);
  expect(cap.kinds.map(k=>k.kind)).toContain('noteAsset');
  expect(cap.kinds.some(k=>k.kind.startsWith('book'))).toBe(false);
  await session.connection.writeFrame({action:'syncBooks',phase:'reading',version:1,deviceId:'phone',states:[],after:0});
  expect(await session.connection.readFrame(3000)).toMatchObject({action:'syncBooks',version:1,success:true});
  await session.connection.writeFrame({action:'ack',success:true,applied:true});
  await session.pair.close();await session.running.catch(()=>{});
 }finally{await f.dispose();}
});

test('unregistered legacy originals keep the books domain on syncBooks',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  await attachBinaryBooks(f);
  const source='https://watchrss.local/import-txt-novel/unregistered';
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,'book',1,0)",[source]);
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'chapter','body',?,'chapter',1)",[source+'/chapter/1']);
  const {session,cap}=await connect(f);
  expect(cap.kinds.some(k=>k.kind.startsWith('book'))).toBe(false);
  await session.connection.writeFrame({action:'syncBooks',phase:'reading',version:1,deviceId:'phone',states:[],after:0});
  expect(await session.connection.readFrame(3000)).toMatchObject({action:'syncBooks',version:1,success:true});
  await session.connection.writeFrame({action:'ack',success:true,applied:true});
  await session.pair.close();await session.running.catch(()=>{});
 }finally{await f.dispose();}
});

test('freeze omits oversized state dependencies and reading rows and repages valid readings',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {files,repository}=await attachBinaryBooks(f);
  await f.store.initialize();
  const bad=await sampleBook(f,files,512,'excluded book'),good=await sampleBook(f,files,512,'eligible book');
  await repository.books!.merge({...bad.state,title:'😀'.repeat(65536)+'x'});
  await repository.books!.merge({...good.state,chapterCount:7});
  await f.db.execute('UPDATE sync_books SET registration_complete=1,package_path=?,package_sha256=?,package_bytes=? WHERE book_id=?',
   [bad.path,bad.info.sha256,bad.info.size,bad.state.bookId]);
  for(let chapter=1;chapter<=7;chapter++){
   const field=chapter===1?256*1024+1:chapter===2?1024*1024:208*1024;
   const row={bookId:good.state.bookId,chapterIndex:chapter,isRead:true,readingProgress:1,
    readingPositionBytes:0,readingPositionChangedAt:27,readingPositionContentHash:'x'.repeat(field),sourceDeviceId:'watch'};
   await f.db.execute('INSERT INTO sync_book_reading(book_id,chapter_index,state_json,is_read,progress,clock,position,hash,source) VALUES(?,?,?,?,?,?,?,?,?)',
    [row.bookId,chapter,JSON.stringify(row),1,1,27,0,'','watch']);
  }
  const skipped:string[]=[],objects:ObjectDescriptor[]=[];
  const books=new BinaryBooks(f.store,async()=>repository.books,files,f.chunks,()=>{},(kind,limit)=>skipped.push(kind+':'+limit));
  await books.freeze('test','filtered',HARD_LIMITS,new Set(BOOK_KINDS),d=>objects.push(d),async()=>{});
  expect(skipped.sort()).toEqual(['bookReading:body','bookReading:string','bookState:string']);
  expect(objects.map(d=>d.kind)).toEqual(['bookState','bookReading','bookReading']);
  expect(objects[0]!.businessId).toBe(good.state.bookId);
  const pages=objects.slice(1);
  expect(pages.map(d=>JSON.parse(d.metadataUtf8).pageIndex)).toEqual([0,1]);
  expect(pages.every(d=>d.size<=1024*1024)).toBe(true);
  expect(pages.every(d=>d.dependsOn[0]===objects[0]!.objectId)).toBe(true);
 }finally{await f.dispose();}
},15000);

test('paged book SQL follows ordinal order under reverse SQLite scans',async()=>{
 const f=await binaryRuntime();
 try{
  await f.store.initialize();
  await f.db.execute('PRAGMA reverse_unordered_selects=ON');
  await f.db.execute('CREATE TABLE assembled (first TEXT, second TEXT)');
  const first=Array.from({length:18},(_,i)=>('page-'+i+'😀').repeat(400)).join(''),second=first.slice(50)+'\0';
  const book=pagedBookBoundary(f.store.db,['scope','job','object'],{before:[],after:()=>[]});
  await book.transaction!([{sql:'INSERT INTO assembled VALUES(?,?)',params:[first,second]}]);
  expect(await f.db.query('SELECT first,second FROM assembled')).toEqual([{first,second}]);
  expect(await f.db.query('SELECT count(*) AS parts FROM library_binary_book_text')).toEqual([{parts:0}]);
 }finally{await f.dispose();}
});

test('a durable book receipt replays after pending native DATA settles',async()=>{
 const f=await binaryRuntime({fileRefs:true});
 try{
  const {files,repository}=await attachBinaryBooks(f);
  const book=await sampleBook(f,files,512),d=book.stateObject;
  const peer=await receiver(f,[d]);
  await peer.manifest();await transfer(peer,d,book.read);
  const row=(await f.db.query('SELECT scope,job_id FROM library_binary_jobs'))[0]!;
  const job=(await f.store.job(String(row.scope),String(row.job_id)))!;
  const envelope=request('apply',{objectId:d.objectId},job.jobId,job.planDigest,job.epoch);
  const books=new BinaryBooks(f.store,async()=>repository.books,files,f.chunks,()=>{});
  const index=new ReceiveIndex([d],[]),activeReceive=new Set<string>();
  let pending=true,nativeApplied=false,notified=0,commits=0,attempts=0;
  const owner=Object.create(LibraryBinaryConnection.prototype) as LibraryBinaryConnection;
  Object.assign(owner,{
   nativeReceive:true,activeReceive,bindings:[peer.binding],receive:{job,index},io:{native:{id:'fixture',markApplied:async(slot:number)=>{
    expect(slot).toBe(0);attempts++;
    if(pending)throw Error('BUSY');
    nativeApplied=true;
   }}},ports:{
    store:f.store,chunks:f.chunks,check:()=>{},phoneDeviceId:'phone',watchDeviceId:'watch',applied:()=>{notified++;},
    apply:async(...args:Parameters<BinaryBooks['apply']>)=>{commits++;await books.apply(...args);},
   },
  });
  await expect(owner['apply'](job,envelope)).rejects.toThrow('BUSY');
  const receipt=(await f.store.object(job,d.objectId)).receipt;
  expect(receipt).toMatchObject({applyRequestId:envelope.requestId,outcome:'merged'});
  expect(index.isApplied(d.objectId)).toBe(false);
  expect(activeReceive.has(d.objectId)).toBe(true);
  pending=false;
  expect(await owner['apply'](job,envelope)).toEqual({state:'APPLIED',receipt});
  expect({nativeApplied,notified,commits,attempts}).toEqual({nativeApplied:true,notified:1,commits:1,attempts:2});
  expect(index.isApplied(d.objectId)).toBe(true);
  expect(activeReceive.has(d.objectId)).toBe(false);
  await peer.session.pair.close();await peer.session.running.catch(()=>{});
 }finally{await f.dispose();}
},10000);
