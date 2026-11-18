import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {binaryRuntime,nonce} from '../helpers/library-binary-runtime';
import {BinaryAssets} from '../../src/sync/library-binary/assets';
import {s2Capability,negotiate} from '../../src/sync/library-binary/routing';
import {HARD_LIMITS,hash,utf8,type Row,type ObjectDescriptor,type BeginPayload} from '../../src/sync/library-binary/wire';
import {objectId,objectsRoot,selectionDigest,planDigest,requestDigest,appliedReceipt} from '../../src/sync/library-binary/digests';
function object(key:string,bytes:Uint8Array):ObjectDescriptor{const metadataUtf8=JSON.stringify({storageKey:key,sha256:hash(bytes),size:bytes.length});const d:ObjectDescriptor={objectId:'',kind:'noteAsset',schemaVersion:1,businessId:key,contentVersion:hash(bytes),encoding:'raw',size:bytes.length,sha256:hash(bytes),chunkBytes:65536,chunkHashes:Array.from({length:Math.ceil(bytes.length/65536)},(_,i)=>hash(bytes.subarray(i*65536,(i+1)*65536))),metadataUtf8,metadataSha256:hash(utf8(metadataUtf8)),dependsOn:[]};d.objectId=objectId(d);return d;}
const limits={...HARD_LIMITS,maxObjectBytes:5242880,maxInFlightChunks:1,maxInFlightBytes:65536,maxManifestBytes:262144,maxPlanObjects:512,maxMetadataBytes:1024,maxJournalBytes:33554432,maxStagingBytes:134217728};

test('5MiB asset freezes durably and reads bounded blocks after the original disappears',async()=>{
 const f=await binaryRuntime();try{await f.store.initialize();const original=new Uint8Array(5*1024*1024);for(let i=0;i<original.length;i++)original[i]=i&255;await f.files.writeBytes('notes/assets/large.png',original);
  let maximum=0;const files={...f.files,readBytes:async(p:string,at:number,max:number)=>{maximum=Math.max(maximum,max);return f.files.readBytes(p,at,max);}};const assets=new BinaryAssets(files,f.store,f.chunks),cap=s2Capability([{kind:'noteAsset',schemaVersion:1,send:true,receive:true}],limits),selection=negotiate(cap,cap)!;
  const frozen=await assets.freeze('scope',nonce(),selection.limits);await f.store.saveSnapshot('scope',frozen.witness,frozen.inventory);await f.files.remove('notes/assets/large.png');const source=await assets.source('scope',{toInclusive:frozen.witness.toInclusive,fromExclusive:frozen.witness.fromExclusive,manifestDigest:frozen.witness.manifestDigest,snapshotId:frozen.witness.snapshotId},selection);expect(source.objects.length).toBe(1);expect(source.objects[0]!.chunkHashes.length).toBe(80);
  const digest=createHash('sha256');for(let i=0;i<80;i++)digest.update(await source.read(source.objects[0]!,i));expect(digest.digest('hex')).toBe(hash(original));expect(maximum).toBe(65536);
  const spool=Object.values((frozen.inventory as {paths:Record<string,string>}).paths)[0]!;const streamed=createHash('sha256');for await(const b of createReadStream(f.root+'/'+spool))streamed.update(b);expect(streamed.digest('hex')).toBe(hash(original));
 }finally{await f.dispose();}
},15000);

test('asset conflict preserves canonical bytes and shares the APPLIED business transaction',async()=>{
 const f=await binaryRuntime();try{await f.store.initialize();const assets=new BinaryAssets(f.files,f.store,f.chunks),incoming=new Uint8Array([1,2,3]),d=object('picture.png',incoming);await f.files.writeBytes('notes/assets/picture.png',new Uint8Array([9]));const cap=s2Capability([{kind:'noteAsset',schemaVersion:1,send:true,receive:true}],limits),selection=negotiate(cap,cap)!,snap={snapshotId:'s',manifestDigest:'a'.repeat(64),fromExclusive:0,toInclusive:0},job=nonce(),connection=nonce();const p:BeginPayload={intent:'create',accountScope:f.accountScope,phoneDeviceId:'phone',watchDeviceId:'watch',direction:'phoneToWatch',phoneSnapshot:snap,watchSnapshot:snap,selection,selectionDigest:selectionDigest(selection),objectCount:1,objectsRoot:objectsRoot([d.objectId]),pageObjectCounts:[1]},plan=planDigest(p);
  await f.store.openConnection(connection);const lease=await f.chunks.acquire('a'.repeat(64),connection),r={action:'syncLibraryBinary',version:2,phase:'begin',type:'request',jobId:job,planDigest:plan,epoch:null,requestId:nonce(),requestDigest:requestDigest(job,plan,'begin',p as unknown as Row),payload:p} as any,j=await f.store.begin('scope',r,p,connection,lease.epoch,lease as unknown as Row);await f.store.db.execute('INSERT INTO library_binary_objects VALUES(?,?,?,?,?,NULL)',['scope',job,d.objectId,0,JSON.stringify(d)]);
  await f.chunks.stage(lease,{id:d.objectId,...d},0,incoming,{id:nonce(),digest:'b'.repeat(64)});const published=await assets.publish(lease,{id:d.objectId,...d},d);const apply={...r,phase:'apply',epoch:lease.epoch,requestId:nonce(),payload:{objectId:d.objectId},requestDigest:requestDigest(job,plan,'apply',{objectId:d.objectId})};const boundary=f.store.boundary(j,apply,'phone',d.objectId,'watch');await assets.apply(d,published.path,boundary);
  expect((await f.files.hash('notes/assets/picture.png')).sha256).toBe(hash(new Uint8Array([9])));const saved=await f.store.object(j,d.objectId);expect(saved.receipt).toEqual(appliedReceipt(apply,d.objectId,'watch','retainedLocal'));expect((await f.db.query('SELECT path,outcome FROM library_binary_assets'))[0]).toEqual({path:published.path,outcome:'retainedLocal'});
  // A fenced/cancelled job cannot commit either half of another business transaction.
  await f.store.cancel(j);await expect(assets.apply(d,published.path,{...boundary,after:()=>[{sql:"INSERT INTO library_binary_assets VALUES('forbidden','x',1,'x','merged')"}]})).rejects.toThrow();expect((await f.db.query("SELECT * FROM library_binary_assets WHERE storage_key='forbidden'")).length).toBe(0);
 }finally{await f.dispose();}
});

test('frozen content is reused across snapshots and collected only after the 24h references expire',async()=>{
 const f=await binaryRuntime();try{let now=0;const {BinaryStore}=await import('../../src/sync/library-binary/store');const store=new BinaryStore(f.db,()=>now);await store.initialize();await f.files.writeBytes('notes/assets/icon.png',new Uint8Array([1,2,3]));const assets=new BinaryAssets(f.files,store,f.chunks),selection=negotiate(s2Capability([{kind:'noteAsset',schemaVersion:1,send:true,receive:true}],limits),s2Capability([{kind:'noteAsset',schemaVersion:1,send:true,receive:true}],limits))!;
  const first=await assets.freeze('scope',nonce(),selection.limits);await store.saveSnapshot('scope',first.witness,first.inventory);const second=await assets.freeze('scope',nonce(),selection.limits);await store.saveSnapshot('scope',second.witness,second.inventory);expect((await f.db.query('SELECT * FROM library_binary_source_files')).length).toBe(1);const path=Object.values((first.inventory as {paths:Record<string,string>}).paths)[0]!;expect(Object.values((second.inventory as {paths:Record<string,string>}).paths)).toEqual([path]);
  now=86400000-1;await store.collect('scope',async()=>{});await assets.collect();expect((await f.files.stat(path)).file).toBe(true);now=86400001;await store.collect('scope',async()=>{});await assets.collect();expect((await f.files.stat(path)).file).toBe(false);expect((await f.files.stat('notes/assets/icon.png')).file).toBe(true);expect((await f.db.query('SELECT * FROM library_binary_source_files')).length).toBe(0);
 }finally{await f.dispose();}
});

test('abandoned native scratch is charged until collection succeeds',async()=>{
 const f=await binaryRuntime();
 try {
  await f.store.initialize();
  let abandoned=20,canCollect=false;
  const calls:boolean[]=[];
  const assets=new BinaryAssets({...f.files,async orphanScratch(collect){
   calls.push(collect);
   if(collect&&canCollect)abandoned=0;
   return abandoned;
  }},f.store,f.chunks);
  const limits={...HARD_LIMITS,maxStagingBytes:25};
  await expect(assets.peak(limits,6)).rejects.toThrow('STORAGE_PRESSURE');
  await assets.collect();
  await expect(assets.peak(limits,6)).rejects.toThrow('STORAGE_PRESSURE');
  canCollect=true;
  await assets.collect();
  await assets.peak(limits,6);
  expect(calls).toEqual([false,true,false,true,false]);
 }finally{await f.dispose();}
});
