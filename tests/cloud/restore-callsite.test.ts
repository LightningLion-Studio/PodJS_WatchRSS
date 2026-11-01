import {test,expect} from 'bun:test';
import {restoreCallsiteTrace,restoreRequestMetadata,restoreReceiptClass,RESTORE_ROUTES,RESTORE_OPERATIONS} from '../../src/cloud/restore-callsite';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
import {fixture} from './service-fixture';
import {crypto,key} from './k2-crypto';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';

test('production default host ports tag every crypto/write/transcode request with a closed route and size',async()=>{
 const calls:{method:string;args:any}[]=[];
 const p=createCloudHostPorts(async<T>(method:string,args:any)=>{calls.push({method,args});if(method==='crypto.random')return {bytesBase64:'AA=='} as T;if(method==='crypto.hkdfSha256')return {keyBase64:Buffer.alloc(32).toString('base64')} as T;throw Error('stop fixture');},{require(){}});
 await p.crypto.random(1);await p.crypto.atCallsite!('entry-ref').hkdf(new Uint8Array(32),new Uint8Array(16),new Uint8Array(8));
 await expect(p.crypto.atCallsite!('pending').decrypt(new Uint8Array(32),new Uint8Array(),new Uint8Array(12),new Uint8Array(32))).rejects.toThrow('stop fixture');
 expect(calls.map(c=>[c.method,c.args.callsiteId,c.args.sizeBand])).toEqual([['crypto.random',0,0],['crypto.hkdfSha256',49,0],['crypto.aesGcmDecrypt',99,0]]);
 const t=restoreCallsiteTrace();for(const c of calls)t.observe(c.args);expect(t.summary().counts).toEqual([[0,1],[49,1],[99,1]]);
 const m=restoreRequestMetadata('projection');expect(m.args('file.write',{dataBase64:'AAAA'}).callsiteId).toBe(75);expect(m.args('crypto.gunzip',{}).callsiteId).toBe(71);
 expect(RESTORE_ROUTES.length*16).toBeLessThanOrEqual(128);expect(RESTORE_OPERATIONS.length).toBeLessThanOrEqual(16);
});

test('receipt witness follows secure publication; failed writes and diagnostic errors do not invent or revoke durable receipts',async()=>{
 const f=await fixture(),seen:number[]=[];let fail=false;
 f.session.restoreCheckpoint={state:f.state,cache:f.cache,codec:f.session.codec,receipt:id=>{seen.push(id);throw Error('diagnostic failure');}};
 const save=f.state.storeRestoreJournalEntry.bind(f.state);f.state.storeRestoreJournalEntry=async(...args)=>{if(fail)throw Error('disk full');return save(...args);};
 const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('witness-epoch','generation');await cp.begin();expect(seen).toEqual([]);await cp.commit('download:fixture',12);expect(seen).toEqual([6]);expect(cp.has('download:fixture')).toBe(true);
 fail=true;await expect(cp.commit('applied:fixture')).rejects.toThrow('disk full');expect(cp.has('applied:fixture')).toBe(false);expect(seen).toEqual([6]);cp.close();
 expect(restoreReceiptClass('projections','a-chunk-0-p0')).toBe(1);expect(restoreReceiptClass('projections','a-object-p0')).toBe(2);
});

test('bounded gzip EOF receipt survives interruption before shape publication, including empty output',async()=>{
 for(const length of [0,262144,262146]){
 const f=await fixture(),cpToken='a'.repeat(64)+'-object',child='b'.repeat(64)+'-chunk-0',body=new Uint8Array(length).fill(37),hash=await crypto.sha256(body);let interrupt=false,calls=0;
 const codec=f.session.codec;
 codec.streamRestoreGzip=async(_key,parts,input,prefix,aadPrefix,max,offset,receipt,allowShort)=>{expect(allowShort).toBe(true);expect(max).toBe(1048576);calls++;
  for(let at=offset;at<Math.max(1,body.length);at+=262144){const part=body.subarray(at,at+262144),done=at+part.length===body.length;if(part.length)f.blobs.set(prefix+at+'.bin',await codec.sealRestoreProjection(key,aadPrefix+at,part));if(done)interrupt=true;await receipt({offset:at,bytes:part.length,done,...(done?{sha256:hash}:{})});}return hash;
 };
 const open=()=>new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{if(interrupt)throw Error('cloud_sync_deadline_exceeded');},()=>0).open('eof-epoch','generation');
 let cp=await open();await cp.begin();await cp.write(child,new Uint8Array([31,139,8]));
 await expect(cp.gunzip(cpToken,[child],1048576,undefined,true)).rejects.toThrow('cloud_sync_deadline_exceeded');expect(cp.has('decoded:'+cpToken)).toBe(false);interrupt=false;expect(await cp.read(cpToken)).toBeUndefined();cp.close();
 interrupt=false;cp=await open();await cp.gunzip(cpToken,[child],1048576,undefined,true);expect(calls).toBe(1);expect(await cp.read(cpToken)).toEqual(body);expect((await cp.index(cpToken))!.length).toBe(length);if(length){const index=(await cp.index(cpToken))!,path=await f.cache.restoreProjectionPath('user',index.parts[0]);f.blobs.get(path)![15]^=1;expect(await cp.read(cpToken)).toBeUndefined();expect(cp.has('decoded:'+cpToken+'-eof')).toBe(false);}cp.close();
 }
});

test('gzip-chunks resume their authenticated compressed input without decrypting the cloud source again',async()=>{
 const {WatchCloudCodec}=await import('../../src/cloud/codec'),{restoreSnapshots}=await import('../../src/cloud/snapshot-restore');
 const {utf8Decode}=await import('../../src/cloud/types');
 const f=await fixture(),body=new Uint8Array(1024*1024).fill(37);await f.phone({objects:[{name:'reader/chunk.txt',bytes:body}]});
 f.session.client.setEpoch((await f.session.client.bootstrap()).libraryEpoch);f.session.client.setContentGeneration(f.content().contentGeneration);
 let sourceDecrypts=0,stop=true;
 const codec=new WatchCloudCodec({...crypto,gunzipSealedParts:async()=>{throw Error('use fixture stream');},decrypt:async(k,a,n,c)=>{if(utf8Decode(a).startsWith('watchrss-cloud-chunk-v1:'))sourceDecrypts++;return crypto.decrypt(k,a,n,c);}},{require(){}});
 codec.streamRestoreGzip=async(_key,parts,_length,prefix,aadPrefix,max,offset,receipt)=>{
  const encoded:Uint8Array[]=[];for(const p of parts)encoded.push(await codec.openRestoreProjection(key,Buffer.from(p.aadBase64,'base64').toString(),f.blobs.get(p.path)!));
  const decoded=await crypto.gunzip(new Uint8Array(Buffer.concat(encoded)),max);expect(decoded.length).toBe(max);
  for(let at=offset;at<decoded.length;at+=262144){const part=decoded.subarray(at,at+262144);f.blobs.set(prefix+at+'.bin',await codec.sealRestoreProjection(key,aadPrefix+at,part));await receipt({offset:at,bytes:part.length,done:at+part.length===decoded.length});if(stop){stop=false;throw Error('cloud_sync_deadline_exceeded');}}return crypto.sha256(decoded);
 };
 f.session.restoreCheckpoint={codec,state:f.state,cache:f.cache};
 const run=async()=>{const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('gzip-chunk-epoch','generation');if(!cp.active)await cp.begin();try{return await restoreSnapshots({session:f.session,heads:[...f.heads.values()],full:true,journal:cp,current:async()=>{},manifest:(h,b)=>f.session.codec.decryptManifest(key,h.id,b),hash:crypto.sha256,supported:()=>true,now:()=>0,status:()=>{},changed:()=>{}});}finally{cp.close();}};
 await expect(run()).rejects.toThrow('cloud_sync_deadline_exceeded');expect(sourceDecrypts).toBe(1);const result=await run();expect(result.pendingItems).toBe(0);expect(sourceDecrypts).toBe(1);
});

test('detached entryRef projection identity binds the complete backing descriptor across fresh outgoing manifests',async()=>{
 const {WatchCloudCodec}=await import('../../src/cloud/codec'),{restoreSnapshots}=await import('../../src/cloud/snapshot-restore'),{writeWrss}=await import('../../src/cloud/wrss'),{utf8Encode}=await import('../../src/cloud/types');
 const f=await fixture(),codec=new WatchCloudCodec(crypto,{require(){}},{writeV1:()=>true});
 const cp=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('detached-epoch','generation');await cp.begin();
 const restored=await restoreSnapshots({session:f.session,heads:[],full:true,journal:cp,current:async()=>{},manifest:async()=>{throw Error('unused');},hash:crypto.sha256,supported:()=>true,now:()=>0,status:()=>{},changed:()=>{}});
 let firstWork=0,previous:any;
 for(const [i,text]of ['first','other','other'].entries()){
  const made=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:i+1,snapshotId:'detached-'+i,createdAtMillis:i,parentHeads:{},observedHeads:{},objects:[{name:'archive',bytes:writeWrss(new Map([['body',utf8Encode(text)]])),compress:false}]});
  // Keep descriptors identical for the third manifest, changing only its ID.
  const object=i===2?previous:made.manifest.objects[0];
  for(const [hash,bytes]of made.newChunks)await f.cache.storeChunk('user',hash,bytes);
  const ref={name:'reader/ref',features:{incompat:['r48.entry-ref.v1'],roCompat:[]},originalBytes:5,entryRef:{object:'archive',entryPath:'body',encoding:'identity'}} as any;
  const raw={...made.manifest,objects:[object,ref]},salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,utf8Encode('watchrss/cloud/manifest/v2/'+raw.snapshotId)),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:'+raw.snapshotId),utf8Encode(JSON.stringify(raw)));
  const manifest=await codec.decryptManifest(key,raw.snapshotId,new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext])));
  expect(await restored.readObject(manifest,manifest.objects[1],'entry-ref')).toEqual(utf8Encode(text));
  if(i===1){firstWork=cp.work;previous=object;}if(i===2)expect(cp.work).toBe(firstWork);
 }
 cp.close();
});

test('repeated projection small decrypt and sealed-open stop before the third redo; distinct parts and durable receipts reset admission',async()=>{
 const {SnapshotYieldBudget}=await import('../../src/cloud/snapshot-deferral');
 for(const [method,args]of [['crypto.aesGcmDecrypt',{aadBase64:'scope',nonceBase64:'nonce'}],['crypto.openSealedParts',{parts:[{path:'immutable',aadBase64:'scope',bytes:1}],length:1}]] as const){
  const budget=new SnapshotYieldBudget();budget.stalled(true);for(let i=0;i<2;i++){budget.before(method,args);budget.completed(method,args);}expect(()=>budget.before(method,args)).toThrow('cloud_snapshot_work_timeout');
  budget.before(method,method==='crypto.openSealedParts'?{...args,parts:[{path:'other',aadBase64:'scope',bytes:1}]}:{...args,nonceBase64:'other'});
  budget.stalled(false);budget.before(method,args);budget.completed(method,args);budget.stalled(true);budget.before(method,args);
 }
});


test('publication diagnostics distinguish book and article pieces; secure receipts identify published pieces and final files',()=>{
 const metadata=restoreRequestMetadata('projection');expect(metadata.args('file.write',{dataBase64:'AA=='},13).callsiteId).toBe(77);expect(metadata.args('file.compose',{},15).callsiteId).toBe(79);
 expect(restoreReceiptClass('units','rows:current:file:'+'a'.repeat(64)+':262144')).toBe(8);expect(restoreReceiptClass('units','rows:current:file:'+'a'.repeat(64))).toBe(9);
 const trace=restoreCallsiteTrace();trace.observe(metadata.args('file.write',{dataBase64:'AA=='},13));trace.receipt(8);expect(trace.summary()).toMatchObject({counts:[[77,1]],lastReceiptClass:8,receipts:1});
});
