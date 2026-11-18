import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {binaryRuntime,nonce} from '../helpers/library-binary-runtime';
import {attachBinaryBooks,sampleBook} from '../helpers/library-binary-books';
import {BinaryByteTransport} from '../../src/sync/library-binary/transport';
import {BinaryBooks} from '../../src/sync/library-binary/books';
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
 const epoch=began.epoch!,operation=(phase:Envelope['phase'],payload:Row,success=true)=>call(request(phase,payload,job,plan,epoch),success);
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
