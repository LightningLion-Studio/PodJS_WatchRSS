/** Opt-in local joint runner. Real HTTP + production codecs/SQLite projection.
 * Run only after backend AND phone atomically publish ready metadata. No devices,
 * production endpoints, migration initiation or successful content writes. */
import {readFile,writeFile,mkdir,rename,stat,rm,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,createHmac,randomBytes,randomUUID,hkdfSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {WatchCloudClient,CloudRequestError} from '../../src/cloud/client';
import {WatchCloudCodec,type SnapshotCrypto} from '../../src/cloud/codec';
import {CloudRecordCodec,type RecordDocument} from '../../src/cloud/records';
import {WatchCloudCache} from '../../src/cloud/cache';
import {cloudCompatibility} from '../../src/cloud/compatibility';
import {readWrss} from '../../src/cloud/wrss';
import {utf8Encode,type HttpTransport} from '../../src/cloud/types';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {splitBookLines,parseBookChapter,validateBookPackage} from '../../src/books/package';
import type {BookFiles} from '../../src/books/files';
import {dbFixture,article,cloudCrypto} from '../../tests/cloud/library-fixture';

const joint=resolve(process.argv[2]??'/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/joint');
const proof:any={version:1,localOnly:true,status:'RUNNING',objects:[],requests:[]};let stage='prerequisites';
function assert(value:unknown,label:string):asserts value{if(!value)throw Error(label);}
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const crypto:SnapshotCrypto={
 random:async n=>new Uint8Array(randomBytes(n)),sha256:async b=>digest(b),
 hkdf:async(k,s,i)=>new Uint8Array(hkdfSync('sha256',k,s,i,32)),
 encrypt:async(k,a,p)=>{const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(p),c.final(),c.getAuthTag()]))};},
 decrypt:async(k,a,n,b)=>{const c=createDecipheriv('aes-256-gcm',k,n);c.setAAD(a);c.setAuthTag(b.slice(-16));return new Uint8Array(Buffer.concat([c.update(b.slice(0,-16)),c.final()]));},
 gzip:async b=>new Uint8Array(gzipSync(b)),gunzip:async(b,max)=>new Uint8Array(gunzipSync(b,{maxOutputLength:Math.max(1,max)})),
};
let accountKey:Uint8Array|undefined,outputRoot:Uint8Array|undefined;
try{
 const env=await json(resolve(joint,'r48-env.json')),phone=await json(resolve(joint,'r48-phone.json'));
 assert(env.ready===true&&env.localOnly===true,'backend_not_ready');
 assert(phone.ready===true,'phone_not_ready');
 assert(phone.runId===env.runId,'joint_run_mismatch');
 const origin=new URL(env.baseUrl);
 assert(origin.protocol==='http:'&&['127.0.0.1','localhost','172.17.0.1','[::1]'].includes(origin.hostname),'nonlocal_endpoint_forbidden');
 const seedPath=resolve(env.seedFile);assert(seedPath.startsWith(joint+'/'),'nonlocal_seed_forbidden');
 assert(((await stat(seedPath)).mode&0o077)===0,'seed_permissions');
 const seeds=await json(seedPath),seed=seeds.clients.watch;
 accountKey=new Uint8Array(Buffer.from(seeds.rootKeyBase64,'base64'));assert(accountKey.length===32,'invalid_synthetic_key');
 proof.runId=env.runId;proof.acceptedSnapshotId=phone.acceptedSnapshotId;
 const rootPath=resolve(phone.outputRootFile);assert(rootPath.startsWith(joint+'/phone-private/')&&((await stat(rootPath)).mode&0o077)===0,'output_root_permissions');
 const rootFile=await readFile(rootPath);assert(digest(rootFile)===phone.outputRootFileSha256,'output_root_file_mismatch');
 const rootDoc=JSON.parse(rootFile.toString('utf8'));assert(rootDoc.planId===phone.planId,'output_root_scope');outputRoot=new Uint8Array(Buffer.from(rootDoc.outputRootBase64,'base64'));assert(outputRoot.length===32,'output_root_size');
 const http:HttpTransport={request:async request=>{
  const url=new URL(request.url);assert(url.origin===origin.origin&&url.pathname.startsWith('/functions/v1/'),'unexpected_api_origin');
  const response=await fetch(url,{method:request.method,headers:{...request.headers,'x-watchrss-cloud-device-id':seed.deviceId},body:request.body?new Uint8Array(request.body).buffer:undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  const body=new Uint8Array(await response.arrayBuffer());assert(body.length<=8*1024*1024,'api_response_limit');
  proof.requests.push({method:request.method,operation:url.pathname.endsWith('/heads')?'heads':url.pathname.endsWith('/reserve')?'reserve':url.pathname.endsWith('/records')?'records':url.pathname.includes('/snapshots/')?'snapshot':'other',status:response.status,requestBytes:request.body?.length??0,responseBytes:body.length});
  return {status:response.status,headers:Object.fromEntries(response.headers.entries()),body};
 }};
 const client=new WatchCloudClient(http,{baseUrl:env.baseUrl,accessToken:seed.accessToken,apikey:env.supabaseAnonKey,appVersion:'1129'},crypto,{require(){}});
 client.setEpoch(env.libraryEpoch);client.setContentGeneration(env.contentGeneration);
 stage='accepted-head';const heads=await client.snapshotHeads(),head=heads.find(h=>h.id===phone.acceptedSnapshotId);assert(head,'accepted_head_not_visible');
 const remote=await client.snapshot(head.id);
 // Storage is an explicitly HTTP RAM fixture. Keep production HTTPS download
 // policy untouched; this bounded local transport checks the actual bytes/hash.
 const download=async(url:string,size:number,hash:string)=>{
  const u=new URL(url);assert(u.protocol==='http:'&&['127.0.0.1','localhost','172.17.0.1','[::1]'].includes(u.hostname),'nonlocal_storage_forbidden');
  assert(size>=0&&size<=8*1024*1024,'storage_size_limit');
  const r=await fetch(u,{headers:{},redirect:'error',signal:AbortSignal.timeout(30000)});assert(r.ok,'storage_http_failure');
  const reader=r.body!.getReader(),parts:Uint8Array[]=[];let total=0;
  try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;assert(total<=size,'storage_overflow');parts.push(next.value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(total);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  assert(bytes.length===size&&digest(bytes)===hash,'storage_integrity_failure');proof.storageReads=(proof.storageReads??0)+1;proof.storageBytes=(proof.storageBytes??0)+bytes.length;return bytes;
 };
 const encoded=await download(remote.manifestUrl,head.manifestSizeBytes,head.manifestSha256);
 const codec=new WatchCloudCodec(crypto,{require(){}}),manifest=await codec.decryptManifest(accountKey,head.id,encoded);
 assert(manifest.sourceDeviceId===head.sourceDeviceId&&manifest.deviceSequence===head.deviceSequence&&manifest.keyVersion===head.keyVersion,'head_identity');
 assert(!cloudCompatibility(manifest).opaque,'unsupported_root_feature');
 for(const field of ['parentHeads','observedHeads'] as const)assert(Object.keys(manifest[field]).length===Object.keys(head[field]).length&&Object.entries(manifest[field]).every(([k,v])=>head[field][k]===v),'head_scope_mismatch');
 const cache=new Map<string,Uint8Array>();
 const read=async(hash:string)=>{let bytes=cache.get(hash);if(!bytes){const d=remote.chunks.find(c=>c.sha256===hash);assert(d,'missing_chunk_reference');bytes=await download(d.signedUrl,d.sizeBytes,hash);cache.set(hash,bytes);}return bytes;};
 const payload=await codec.restore(accountKey,manifest,read);
 stage='object-comparison';const rawArticles=new Map<string,any>();const expected=new Map<string,any>(phone.expectedObjects.map((o:any)=>[o.name,o]));
 assert(expected.size===manifest.objects.length,'object_count');
 for(const object of manifest.objects){const bytes=payload.get(object.name),e=expected.get(object.name);assert(bytes&&e,'unexpected_object');
  assert(bytes.length===e.sizeBytes&&digest(bytes)===e.sha256,'plaintext_byte_mismatch');
  const originalPath=resolve(e.plaintextFile);assert(originalPath.startsWith(joint+'/phone-private/')&&((await stat(originalPath)).mode&0o077)===0,'original_permissions');
  const original=await readFile(originalPath);assert(original.length===bytes.length&&original.every((v,i)=>v===bytes[i]),'original_byte_mismatch');
  if(object.objectKeyEnvelope){const e=object.objectKeyEnvelope;assert(e.scope==='migration:'+phone.planId,'output_scope_mismatch');const k=await crypto.hkdf(accountKey,new Uint8Array(Buffer.from(e.saltBase64,'base64')),utf8Encode('watchrss/cloud/object-key/v1'));try{const root=await crypto.decrypt(k,utf8Encode('watchrss-object-key-v1:'+e.scope),new Uint8Array(Buffer.from(e.nonceBase64,'base64')),new Uint8Array(Buffer.from(e.ciphertextBase64,'base64')));try{assert(root.length===32&&root.every((v,i)=>v===outputRoot![i]),'output_root_mismatch');proof.outputRootsVerified=(proof.outputRootsVerified??0)+1;}finally{root.fill(0);}}finally{k.fill(0);}}
  const result:any={name:object.name,bytes:bytes.length,sha256:digest(bytes),objectKeyEnvelope:!!object.objectKeyEnvelope};
  if(object.name.endsWith('.wrss')){const files=await readWrss(bytes,crypto.gunzip);const articles=files.get('articles.json');if(articles)for(const a of JSON.parse(new TextDecoder().decode(articles)))rawArticles.set(a.url,a);result.archiveEntries=Object.fromEntries([...files].map(([name,value])=>[name,{bytes:value.length,sha256:digest(value)}]));}
  proof.objects.push(result);
 }
 assert(manifest.objects.some(o=>!!o.objectKeyEnvelope),'accepted_output_not_wrapped');
 stage='sqlite-projection';const db=await dbFixture();
 const bookRoot=resolve(joint,'podjs-private/books');await mkdir(bookRoot,{recursive:true,mode:0o700});
 const safe=(p:string)=>{const path=resolve(p);assert(path.startsWith(bookRoot+'/'),'book_path');return path;};
 const bookFiles:BookFiles={
  write:async(parts,max)=>{const chunks:Uint8Array[]=[];let size=0;for await(const part of parts){const b=utf8Encode(part);size+=b.length;assert(size<=max,'book_size');chunks.push(b);}const b=new Uint8Array(size);let at=0;for(const part of chunks){b.set(part,at);at+=part.length;}return bookFiles.writeBytes(b);},
  writeBytes:async bytes=>{const path=resolve(bookRoot,'temp-'+randomUUID());await writeFile(path,bytes,{mode:0o600});return {path,size:bytes.length,sha256:digest(bytes)};},
  publish:async(info,id)=>{const bytes=await readFile(safe(info.path));assert(bytes.length===info.size&&digest(bytes)===info.sha256,'book_changed');assert(/^[a-f0-9]{64}$/.test(id),'book_id');const path=resolve(bookRoot,id+'-'+info.sha256+'.jsonl');await copyFile(info.path,path+'.tmp');await rename(path+'.tmp',path);return {...info,path};},
  stat:async path=>{try{const s=await stat(safe(path));return {exists:true,size:s.size};}catch(e){if((e as any).code==='ENOENT')return {exists:false,size:0};throw e;}},
  hash:async path=>{const b=await readFile(safe(path));return {size:b.length,sha256:digest(b)};},
  read:async(path,offset,max)=>{const b=await readFile(safe(path));return {size:b.length,bytes:new Uint8Array(b.subarray(offset,offset+max))};},
  lines:path=>splitBookLines((async function*(){yield new TextDecoder('utf-8',{fatal:true}).decode(await readFile(safe(path)));})()),
  combine:async(paths,max)=>{const b=Buffer.concat(await Promise.all(paths.map(p=>readFile(safe(p)))));assert(b.length<=max,'book_size');return bookFiles.writeBytes(b);},
  remove:async path=>{await rm(safe(path),{force:true});},
 };
 const repo=new SqlLibrarySessionRepository(db.db,{...db.ports,bookFiles}),adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,{require(){}});
 try{
  if(adapter.observePrivateOverlay)await adapter.observePrivateOverlay(payload,manifest.sourceDeviceId,manifest.objects);
  const restored=await adapter.restorePayloads(payload,manifest.sourceDeviceId,manifest.objects);
  assert(typeof restored==='object'&&restored.pending===0&&restored.abandoned===0,'projection_incomplete');
  const actual=await repo.cloudSnapshot(true);proof.projectedArticles=actual.articles.length;
  for(const e of phone.expectedArticles){const a=actual.articles.find(a=>a.url===e.url);assert(a,'projected_article_missing');
   for(const field of ['title','independentSaved','favoriteSaved','watchLaterSaved','isRead','readingProgress','favoriteChangedAt','watchLaterChangedAt'] as const)if(field in e)assert(a[field]===e[field],'projected_metadata_mismatch');
   assert(digest(utf8Encode(a.contentText??''))===e.textSha256,'projected_text_mismatch');
   assert(digest(utf8Encode(a.contentHtml??''))===e.htmlSha256,'projected_html_mismatch');
   const raw=rawArticles.get(e.url);assert(raw,'expected_article_metadata_missing');
   for(const field of ['title','siteName','excerpt','independentSaved','favoriteSaved','watchLaterSaved','isRead','readingProgress','favoriteChangedAt','watchLaterChangedAt','independentChangedAt','readingPositionChangedAt','readingPositionBytes','readingPositionContentHash'] as const)if(field in raw){assert(a[field]===raw[field],'projected_clock_or_saved_metadata_mismatch');proof.articleMetadataFields=(proof.articleMetadataFields??0)+1;}

  }
  const books=await repo.cloudBooks();proof.projectedBooks=books.books.length;
  for(const expectedBook of phone.expectedBooks){const b=books.books.find(b=>b.bookId===expectedBook.bookId);assert(b&&b.fingerprint===expectedBook.fingerprint&&b.chapterCount===expectedBook.chapterCount,'projected_book_mismatch');const bytes=await repo.cloudBookBody(b.bookId);assert(bytes,'book_package_missing');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),lines=text.trimEnd().split('\n');await validateBookPackage((async function*(){yield*lines;})(),crypto.sha256,expectedBook);const chapter=parseBookChapter(lines[1]!,1);assert(digest(utf8Encode(chapter.contentText))===expectedBook.chapterTextSha256,'book_text_mismatch');}
  const pending=article({articleId:'podjs-joint-local-pending',url:'https://joint.invalid/pending',title:'Synthetic pending edit'});await repo.mergeCloud([],[pending],'watch');
  const pendingBefore=JSON.stringify((await repo.cloudSnapshot(true)).articles.find(a=>a.url===pending.url));
  stage='old-pin-floor';const snapshot=await codec.create({accountKey,keyVersion:env.keyVersion,snapshotId:randomUUID(),sourceDeviceId:seed.deviceId,sequence:seed.nextDeviceSequence,createdAtMillis:Date.now(),parentHeads:Object.fromEntries(heads.map(h=>[h.sourceDeviceId,h.id])),observedHeads:{},objects:[{name:'reader/pending.txt',bytes:utf8Encode('Synthetic retained edit')}],settings:{libraryEpoch:env.libraryEpoch,contentGeneration:env.contentGeneration,snapshotContentLayout:3}});
  const root=resolve(joint,'podjs-private');await mkdir(root,{mode:0o700,recursive:true});
  const cloudCache=new WatchCloudCache({read:async p=>{try{return new Uint8Array(await readFile(resolve(root,p)));}catch(e){if((e as any).code==='ENOENT')return;throw e;}},writeAtomic:async(p,b)=>{const path=resolve(root,p);assert(path.startsWith(root+'/'),'cache_path');await mkdir(dirname(path),{recursive:true});const temp=path+'.tmp';await writeFile(temp,b,{mode:0o600});await rename(temp,path);}},async b=>digest(b),{require(){}},env.baseUrl);
  await cloudCache.storePending(seeds.userId,snapshot.manifest.snapshotId,snapshot.encryptedManifest);
  let status=0;try{await client.reserveSnapshot(snapshot);}catch(e){assert(e instanceof CloudRequestError&&e.code==='cloud_format_upgrade_required','wrong_floor_error');status=e.status;}
  assert(status===426,'old_pin_write_not_rejected');
  const recordCrypto={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')},recordCodec=new CloudRecordCodec(recordCrypto);
  const doc:RecordDocument={kind:'article',value:{articleId:pending.articleId,url:pending.url,title:pending.title,updatedAt:1,deleted:false}},recordId=await recordCodec.id(accountKey,seeds.userId,doc),envelope=await recordCodec.encode(accountKey,seeds.userId,recordId,env.keyVersion,doc);
  let recordStatus=0;try{await client.pushRecords([{recordId,expectedRevision:'0',envelope,tombstone:false}]);}catch(e){assert(e instanceof CloudRequestError&&e.code==='cloud_format_upgrade_required','wrong_records_floor_error');recordStatus=e.status;}
  assert(recordStatus===426,'old_pin_records_not_rejected');
  const retained=await cloudCache.pending(seeds.userId);assert(retained?.id===snapshot.manifest.snapshotId&&digest(retained.bytes)===digest(snapshot.encryptedManifest),'pending_snapshot_lost');
  assert(pendingBefore===JSON.stringify((await repo.cloudSnapshot(true)).articles.find(a=>a.url===pending.url)),'pending_local_edit_lost');
  assert((await client.snapshotHeads()).some(h=>h.id===head.id),'accepted_head_lost');
  proof.floor={snapshotStatus:status,recordsStatus:recordStatus,pendingPlanRetained:true,localEditRetained:true,acceptedHeadStillVisible:true};
 }finally{db.sql.close();}
 stage='complete';proof.status='PASS';
}catch(error){proof.status='FAIL';proof.failedStage=stage;const message=error instanceof Error?error.message:'';if(/^[a-z][a-z0-9_]{1,79}$/.test(message))proof.failedInvariant=message;process.exitCode=1;}
finally{accountKey?.fill(0);outputRoot?.fill(0);proof.ready=proof.status==='PASS';const result=resolve(joint,'r48-podjs.json');await writeFile(result+'.tmp',JSON.stringify(proof,null,2)+'\n',{mode:0o600});await rename(result+'.tmp',result);console.info(JSON.stringify({status:proof.status,stage,objects:proof.objects.length}));}
