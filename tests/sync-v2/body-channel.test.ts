import {test,expect} from 'bun:test';
import {NoteAssetReceiver} from '../../src/sync/note-assets';
import {createNoteAssetReader} from '../../src/notes/cloud-assets';
import {bookId,bookFingerprint,chapterHash} from '../../src/books/protocol';
import {crypto as snapshotCrypto,key} from '../cloud/k2-crypto';
import {crypto as signer,publicBytes} from './p2-fixture';
import {b64} from '../../src/sync-v2/wire';
import {scope} from './fixture';
import {sha256Hex} from '@podjs/framework/crypto';
import {jsonBytes,parseCanonicalJson,canonical,entityKey} from '../../src/sync-v2/protocol';
import {prepareCarrier,openCarrier,carrierBodyRevision,bodyObjectName,validateCarrier,type Carrier} from '../../src/sync-v2/body-channel-codec';
import {BodyChannelHttp} from '../../src/sync-v2/body-channel-http';
import {WatchBodyChannel} from '../../src/sync-v2/body-channel';
import {toWire} from '../../src/sync-v2/business';
import {refreshNoteAssets,NOTE_ASSET_SCHEMA} from '../../src/sync-v2/note-assets';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {SqlFixture,idKey} from './fixture';
import {businessRevision,installBusinessRevision} from '../../src/sync-v2/business-revision';
const anchor={commitOid:'commit:sha256:'+'a'.repeat(64),revision:'1',rollbackGeneration:'0'},author='a'.repeat(32);
async function prepared(kind:'asset'|'book'='asset',raw=new Uint8Array(180000).fill(42),logicalId=kind==='asset'?'image.png':'b'.repeat(64)){
 const entity='c'.repeat(64),binding={kind,logicalId,entityKey:entity,bodyRevision:carrierBodyRevision(kind,entity,sha256Hex(raw))};
 return {...await prepareCarrier({crypto:snapshotCrypto,signer,alias:'key',authorDeviceId:author,scope,anchor,binding,key:key.slice(),keyVersion:1,objects:[{name:bodyObjectName(kind,logicalId),bytes:raw,compress:false}]}),binding,raw};
}
const files=()=>{const map=new Map<string,Uint8Array>();return {map,read:async(p:string)=>map.get(p),writeAtomic:async(p:string,b:Uint8Array)=>{map.set(p,b.slice());},append:async(p:string,b:Uint8Array,at:number)=>{const old=map.get(p)??new Uint8Array();if(old.length!==at)throw Error('offset_conflict');const next=new Uint8Array(at+b.length);next.set(old);next.set(b,at);map.set(p,next);}};};
function v1AssetFiles(){
 const contents=new Map<string,Uint8Array>();
 const read=(path:string)=>{const raw=contents.get(path);if(!raw)throw Error('missing test asset');return raw;};
 const stat=async(path:string)=>({file:contents.has(path),size:contents.get(path)?.length??0});
 const hash=async(path:string)=>{const raw=read(path);return {sha256:sha256Hex(raw),size:raw.length};};
 const receiver=new NoteAssetReceiver({
  stat,hash,readBytes:async(path,at,size)=>{const raw=read(path);return {size:raw.length,bytes:raw.slice(at,at+size)};},remove:async path=>{contents.delete(path);},
  write:async(path,data)=>{const raw=new Uint8Array(Buffer.from(data,'base64'));contents.set(path,raw);return {size:raw.length};},
  append:async(path,data,offset)=>{expect(read(path).length).toBe(offset);const raw=new Uint8Array(Buffer.concat([read(path),Buffer.from(data,'base64')]));contents.set(path,raw);return {size:raw.length};},
  commit:async(path,target,size,digest)=>{
   expect(await hash(path)).toEqual({size,sha256:digest});contents.set(target,read(path));contents.delete(path);
  },
 });
 const readAsset=createNoteAssetReader(async<T>(method:string,args:Record<string,unknown>)=>{
  const path=String(args.path);
  if(method==='file.stat')return await stat(path) as T;
  if(method==='file.hash')return await hash(path) as T;
  const raw=read(path),offset=Number(args.offset);
  if(method==='file.read')return {offset,size:raw.length,dataBase64:Buffer.from(raw.subarray(offset,offset+Number(args.maxBytes))).toString('base64')} as T;
  throw Error('unexpected file request');
 });
 return {contents,receiver,readAsset};
}
function backend(auth={legacyDeviceId:'legacy-test',token:'synthetic'}){
 const descriptors=new Map<string,Carrier>(),objects=new Map<string,Uint8Array>(),ready=new Set<string>(),calls:any[]=[];let failOnce=false,closed=false,failReadOnce=false;
 const json=(v:any,status=200)=>({status,headers:{},body:jsonBytes({version:1,purpose:'p6-body.v1',scope,...v})});
 const transport={async request(r:any){calls.push(r);const u=new URL(r.url),p=u.pathname.replace('/functions/v1/cloud/bodies/v1',''),v=r.body&&r.headers['Content-Type']==='application/json'?parseCanonicalJson(r.body):null;
  expect(u.origin).toBe('http://127.0.0.1:18991');expect(r.headers['x-watchrss-cloud-device-id']).toBe(auth.legacyDeviceId);expect(r.headers.Authorization).toBe('Bearer '+auth.token);
  if(closed&&r.method!=='GET')return {status:503,headers:{},body:jsonBytes({error:{code:'body_channel_write_disabled',retryable:false,retryAfterMillis:null,details:{}}})};
  if(p==='/reserve'){validateCarrier(v,scope);const b=v.body;expect(r.headers['x-watchrss-library-epoch']).toBe('legacy-epoch');descriptors.set(b.carrierId,v);return json({carrierId:b.carrierId,state:ready.has(b.carrierId)?'ready':'reserved',expiresAtMillis:600000,objects:[b.manifest,...b.chunks].map(o=>({...o,offset:objects.get(o.sha256)?.length??0}))});}
  const parts=p.split('/').slice(1),id=parts[1]!;
  if(r.method==='PUT'){
   expect(r.body.length).toBeLessThanOrEqual(65536);expect(r.headers['x-watchrss-sync-part-sha256']).toBe(sha256Hex(r.body));expect(r.headers['x-watchrss-sync-repo-id']).toBe(scope.repoId);
   const hash=parts[3]!,at=Number(parts[5]),old=objects.get(hash)??new Uint8Array();expect(old.length).toBe(at);const out=new Uint8Array(at+r.body.length);out.set(old);out.set(r.body,at);objects.set(hash,out);if(failOnce){failOnce=false;throw Error('lost part response');}return json({});
  }
  if(parts[2]==='complete'){const d=descriptors.get(id)!.body;for(const o of [d.manifest,...d.chunks]){expect(objects.get(o.sha256)?.length).toBe(o.sizeBytes);expect(sha256Hex(objects.get(o.sha256)!)).toBe(o.sha256);}ready.add(id);return json({carrierId:id,state:'ready'});}
  if(p==='/carriers')return json({carriers:[...ready].sort().filter(id=>descriptors.get(id)!.body.entityKey===u.searchParams.get('entityKey')&&descriptors.get(id)!.body.bodyRevision===u.searchParams.get('bodyRevision')).map(id=>({carrierId:id,descriptor:descriptors.get(id)})),nextAfter:null});
  if(parts[2]==='objects'){
   const hash=parts[3]!,at=Number(u.searchParams.get('offset')),raw=objects.get(hash)!;if(failReadOnce&&at>0){failReadOnce=false;throw Error('interrupted download');}
   return {status:200,headers:{'x-watchrss-body-total-bytes':String(raw.length),'x-watchrss-body-offset':String(at)},body:raw.slice(at,at+65536)};
  }throw Error('unexpected path '+p);
 }};
 const http=()=>new BodyChannelHttp({enabled:true,origin:'http://127.0.0.1:18991',policy:{accountBaseUrl:'http://127.0.0.1:18991',allowLoopback:true},scope,transport,session:async()=>({accessToken:'synthetic',legacyDeviceId:'legacy-test',legacyEpoch:'legacy-epoch',legacyGeneration:'1'}),check:async()=>{}});
 return {http,transport,objects,descriptors,ready,calls,open:()=>{closed=false;},losePart:()=>{failOnce=true;},loseRead:()=>{failReadOnce=true;},close:()=>{closed=true;}};
}
for(const kind of ['asset','book'] as const)test('carrier '+kind+' signs and roundtrips exact bytes through v1 ciphertext envelopes',async()=>{
 const p=await prepared(kind),out=await openCarrier({descriptor:p.descriptor,scope,binding:p.binding,crypto:snapshotCrypto,signer,publicKey:b64(publicBytes),key:async()=>key.slice(),read:async h=>p.objects.get(h)!});expect(out.get(bodyObjectName(kind,p.binding.logicalId))).toEqual(p.raw);
});
for(const kind of ['asset','book'] as const)test('matching local '+kind+' uses only the ready carrier list',async()=>{
 const {default:fixture}=await import('../fixtures/cli-single-txt-book.json');
 let book={...fixture};
 if(kind==='book'){
  const [header,line]=fixture.packageUtf8.split('\n'),chapter={...JSON.parse(line!),contentText:''};
  const encode=(value:string)=>new TextEncoder().encode(value),sha=async(raw:Uint8Array)=>sha256Hex(raw);
  const empty=encode(header+'\n'+JSON.stringify(chapter)+'\n').length;
  chapter.contentText='x'.repeat(8*1024*1024-empty);
  const fingerprint=await bookFingerprint([await chapterHash(1,chapter.title,chapter.contentText,sha)],sha);
  book={...fixture,fingerprint,bookId:await bookId(fingerprint,sha),packageUtf8:header+'\n'+JSON.stringify(chapter)+'\n'};
 }
 const p=kind==='book'?await prepared(kind,new TextEncoder().encode(book.packageUtf8),book.bookId):await prepared(kind),b=backend();
 if(kind==='book')expect(p.raw.length).toBe(8*1024*1024);
 await b.http().upload(p.descriptor,async hash=>p.objects.get(hash)!);
 const identity=p.binding.logicalId;
 const assetFiles=v1AssetFiles(),assetPath='notes/assets/'+identity;
 const receiveV1Asset=async()=>{
  expect(await assetFiles.receiver.apply({action:'syncNoteAsset',version:1,storageKey:identity,sha256:sha256Hex(p.raw),chunkIndex:0,chunkCount:1,data:Buffer.from(p.raw).toString('base64')})).toMatchObject({success:true,complete:true});
 };
 if(kind==='asset')await receiveV1Asset();
 const state={updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0};
 const wire=toWire(kind,kind==='asset'?{...state,assetId:identity,mime:'image/png',originalFilename:identity}:{...state,bookId:identity,fingerprint:book.fingerprint,sourceUrl:book.sourceUrl,title:'Book',chapterCount:1,kind:'txt',deletedChapters:[],deletionClock:0});
 const entry={
  row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,deleted:false,recipeOid:null},
  meta:{kind,logicalId:identity,payload:wire.meta},
  state:{payload:wire.state},
 };
 let pendingChoice=false;
 const projection={readState:async()=>({pendingChoice,account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),cloudRow:async()=>entry,cloudRows:async(_root:string,after:string)=>after?[]:[entry]};
 let witnessReads=0,replaceOnRecheck=false;
 const channel=(http=b.http())=>new WatchBodyChannel({http,scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>{throw Error('unexpected upload');},approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async()=>key.slice(),currentKey:async()=>{throw Error('unexpected upload');},files:files(),root:'local-body',repository:{
  ...(kind==='book'?{readBookWitness:async()=>({sha256:++witnessReads===2&&replaceOnRecheck?'f'.repeat(64):sha256Hex(p.raw),size:p.raw.length})}:{}),
  read:async()=>{if(kind==='book')throw Error('unexpected full book read');return assetFiles.contents.has(assetPath)?assetFiles.readAsset(identity):undefined;},
  validate:async()=>{},install:async()=>{throw Error('unexpected install');},
 },check:async()=>{}});
 const before=b.calls.length;
 expect(await channel().sync()).toEqual({pending:0,errors:[]});
 expect(await channel().sync()).toEqual({pending:0,errors:[]});
 const calls=b.calls.slice(before);
 expect(calls).toHaveLength(2);
 for(const call of calls){
  expect(call.method).toBe('GET');
  expect(call.url).toContain('/carriers?');
 }
 const complete=b.calls.length;
 pendingChoice=true;
 expect(await channel().hasWork()).toBe(false);
 expect(await channel().sync()).toEqual({pending:0,errors:[]});
 expect(b.calls).toHaveLength(complete);
 pendingChoice=false;
 if(kind==='book'){
  witnessReads=0;replaceOnRecheck=true;
  expect(await channel().sync()).toEqual({pending:1,errors:['body_revision_changed']});
 }else{
  assetFiles.contents.delete(assetPath);
  const http=b.http(),list=http.list.bind(http);
  http.list=async(...args)=>{const page=await list(...args);await receiveV1Asset();return page;};
  expect(await channel(http).sync()).toEqual({pending:0,errors:[]});
  const {carrierId}=p.descriptor.body;
  b.descriptors.set(carrierId,{...p.descriptor,signature:b64(new Uint8Array(64))});
  expect(await channel().sync()).toEqual({pending:1,errors:['signature_invalid']});
  expect(await assetFiles.readAsset(identity)).toEqual(p.raw);
  const changed=p.raw.slice();changed[0]^=1;
  assetFiles.contents.set(assetPath,changed);
  const beforeMismatch=b.calls.length;
  expect(await channel().sync()).toEqual({pending:1,errors:['signature_invalid']});
  expect(b.calls).toHaveLength(beforeMismatch+1);
  expect(await assetFiles.readAsset(identity)).toEqual(changed);
 }
 expect(b.calls.slice(before).every(call=>call.method==='GET'&&call.url.includes('/carriers?'))).toBe(true);
},30000);
test('upload resumes a lost response from server offsets and does not republish ready carrier',async()=>{
 const p=await prepared(),b=backend();b.losePart();await expect(b.http().upload(p.descriptor,async h=>p.objects.get(h)!)).rejects.toThrow('lost part response');const count=b.calls.filter(c=>c.method==='PUT').length;await b.http().upload(p.descriptor,async h=>p.objects.get(h)!);expect(b.ready.has(p.descriptor.body.carrierId)).toBe(true);expect(b.calls.filter(c=>c.method==='PUT').slice(count).every(c=>!c.url.endsWith('/parts/0')||!c.url.includes(p.descriptor.body.manifest.sha256))).toBe(true);
 const puts=b.calls.filter(c=>c.method==='PUT').length;await b.http().upload(p.descriptor,async h=>p.objects.get(h)!);expect(b.calls.filter(c=>c.method==='PUT')).toHaveLength(puts);
});
test('body_write closed returns its explicit error without uploading any bytes',async()=>{const p=await prepared(),b=backend();b.close();await expect(b.http().upload(p.descriptor,async h=>p.objects.get(h)!)).rejects.toThrow('body_channel_write_disabled');expect(b.objects.size).toBe(0);expect(b.ready.size).toBe(0);});
test('ciphertext download resumes on reopen and verifies complete SHA before decode',async()=>{
 const p=await prepared(),b=backend(),cache=files();await b.http().upload(p.descriptor,async h=>p.objects.get(h)!);const chunk=p.descriptor.body.chunks[0]!;b.loseRead();await expect(b.http().download(p.descriptor.body.carrierId,chunk.sha256,chunk.sizeBytes,cache,'cipher')).rejects.toThrow('interrupted download');
 const at=cache.map.get('cipher.part')!.length,start=b.calls.length;expect(await b.http().download(p.descriptor.body.carrierId,chunk.sha256,chunk.sizeBytes,cache,'cipher')).toEqual(p.objects.get(chunk.sha256)!);expect(b.calls[start]!.url).toContain('offset='+at);
});
test('bad signature, changed identity, missing closure, tampered bytes and unavailable key do not decode a body',async()=>{
 const p=await prepared(),open=(descriptor:Carrier,extra:any={})=>openCarrier({descriptor,scope,binding:p.binding,crypto:snapshotCrypto,signer,publicKey:b64(publicBytes),key:async()=>key.slice(),read:async h=>p.objects.get(h)!,...extra});
 await expect(open({...p.descriptor,signature:b64(new Uint8Array(64))})).rejects.toThrow('signature_invalid');
 await expect(open(p.descriptor,{binding:{...p.binding,logicalId:'other.png'}})).rejects.toThrow('source_identity_missing');
 await expect(open(p.descriptor,{key:async()=>{throw Error('key_unavailable');}})).rejects.toThrow('key_unavailable');
 await expect(open(p.descriptor,{read:async(h:string)=>{const out=p.objects.get(h)!.slice();out[0]^=1;return out;}})).rejects.toThrow('hash_mismatch');
 const {signControl}=await import('../../src/sync-v2/signing');const missing=await signControl(signer,'key','wrss.cloud.body.v1/carrier-sign',{...p.descriptor.body,chunks:[]}) as Carrier;await expect(open(missing)).rejects.toThrow('closure_incomplete');
});
test('frozen legacy bridge selects only required attachment bytes and ignores bundled business state',async()=>{
 const {WatchCloudCodec}=await import('../../src/cloud/codec'),{writeWrss}=await import('../../src/cloud/wrss'),{signControl}=await import('../../src/sync-v2/signing');
 const p=await prepared(),sourceId='11111111-2222-4333-8444-555555555555',codec=new WatchCloudCodec(snapshotCrypto,{require(){}}),zip=writeWrss(new Map([['notes/assets/image.png',p.raw],['notes/foreign.md',new Uint8Array([7])]]));
 const source=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',snapshotId:sourceId,sequence:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'notes-assets.zip',bytes:zip,compress:false},{name:'notes-state.json',bytes:jsonBytes({notes:[{deleted:true}]})}]});
 const selected=source.manifest.objects.find(o=>o.name==='notes-assets.zip')!;
 const descriptor=await signControl(signer,'key','wrss.cloud.body.v1/carrier-sign',{...p.descriptor.body,sourceSnapshotId:sourceId,manifest:{sha256:sha256Hex(source.encryptedManifest),sizeBytes:source.encryptedManifest.length},chunks:selected.chunks.map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes}))}) as Carrier;
 const reads:string[]=[],out=await openCarrier({descriptor,scope,binding:p.binding,crypto:snapshotCrypto,signer,publicKey:b64(publicBytes),key:async()=>key.slice(),read:async h=>{reads.push(h);return h===descriptor.body.manifest.sha256?source.encryptedManifest:source.newChunks.get(h)!;}});
 expect([...out.keys()]).toEqual(['notes/assets/image.png']);expect(out.get('notes/assets/image.png')).toEqual(p.raw);expect(reads).not.toContain(source.manifest.objects.find(o=>o.name==='notes-state.json')!.chunks[0]!.ciphertextSha256);
});
test('current account changes during download prevent native installation and leave original bytes',async()=>{
 const p=await prepared(),b=backend(),cache=files();await b.http().upload(p.descriptor,async h=>p.objects.get(h)!);let changed=false,installed=0;
 const entry={row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,deleted:false},meta:{kind:'asset',logicalId:'image.png',payload:{assetId:'image.png',mime:'image/png',originalFilename:'image.png'}},state:{payload:{updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}}};
 const projection={readState:async()=>({account:{oid:anchor.commitOid,revision:changed?'2':'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),cloudRow:async()=>entry,cloudRows:async(_r:string,after:string)=>after?[]:[entry]};
 const http=b.http(),download=http.download.bind(http);http.download=async(...args)=>{const bytes=await download(...args);changed=true;return bytes;};
 const channel=new WatchBodyChannel({http,scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>({deviceId:author,alias:'key'}),approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async()=>key.slice(),currentKey:async()=>({key:key.slice(),version:1}),files:cache,root:'test',repository:{read:async()=>undefined,validate:async()=>{},install:async()=>{installed++;}},check:async()=>{}});
 expect((await channel.sync()).errors).toContain('choice_stale');expect(installed).toBe(0);
});
test('asset metadata uses the Markdown storage key and survives a missing attachment without blocking others',async()=>{const f=new SqlFixture();try{
 await f.transaction([{sql:NOTE_ASSET_SCHEMA}]);const errors=await refreshNoteAssets(f,{cloudNotes:async()=>({notes:[],assetKeys:['image.png','missing.png']}),cloudNoteAsset:async id=>{if(id==='missing.png')throw Error('cloud_note_asset_missing');return new Uint8Array([1,2,3]);}},'watch',()=>10);expect(errors).toEqual(['cloud_note_asset_missing']);
 const source=await SqlBusinessSource.open(f),rows=[];let after='';for(;;){const page=await source.page(after,32);rows.push(...page.rows);if(page.done)break;after=page.after;}
 expect(rows.find(r=>r.kind==='asset')).toMatchObject({logicalId:'image.png',value:{assetId:'image.png',originalFilename:'image.png',mime:'image/png',deleted:false}});
 }finally{f.close();}});
test('only the exact cloud attachment hash is adopted without a new business revision',async()=>{
 const f=new SqlFixture();
 try{
  await f.transaction([{sql:NOTE_ASSET_SCHEMA},{sql:"INSERT INTO memo_assets VALUES('image.png','image/png','image.png',1,'phone',0,0,'')"}]);
  await installBusinessRevision(f);
  const before=await businessRevision(f),raw=new Uint8Array([1,2,3]);
  const repository={cloudNotes:async()=>({notes:[],assetKeys:['image.png']}),cloudNoteAsset:async()=>raw};
  expect(await refreshNoteAssets(f,repository,'watch',()=>2,async(_id,hash)=>hash===sha256Hex(raw))).toEqual([]);
  expect(await businessRevision(f)).toEqual(before);
  expect(await f.query('SELECT updated_at,source_device_id,local_sha256 FROM memo_assets')).toEqual([{updated_at:1,source_device_id:'phone',local_sha256:sha256Hex(raw)}]);
  raw[0]=9;
  expect(await refreshNoteAssets(f,repository,'watch',()=>2,async()=>false)).toEqual([]);
  expect(await businessRevision(f)).not.toEqual(before);
 }finally{f.close();}
});
test('product publishes authoritative note/asset state despite closed body_write, with an explicit body error',async()=>{
 const {fixture}=await import('./p6-fix-fixture'),{openApplicationSyncV2}=await import('../../src/sync-v2/application-open'),{serviceInfo}=await import('./p2-fixture');

 const f=await fixture(),cache=files();let serial=0;const base=f.options.host;
 f.options.host=async(method:string,a:any)=>{
  if(method==='sql.notify')return {};
  if(method==='crypto.hash')return {digestBase64:Buffer.from(sha256Hex(new Uint8Array(Buffer.from(a.dataBase64,'base64'))),'hex').toString('base64')};
  if(method==='file.stat'){const b=cache.map.get(a.path);return {exists:!!b,file:!!b,size:b?.length??0,usableBytes:512*1024*1024};}
  if(method==='file.read'){const b=cache.map.get(a.path)!;return {offset:a.offset,size:b.length,dataBase64:Buffer.from(b.subarray(a.offset,a.offset+a.maxBytes)).toString('base64')};}
  if(method==='file.createTemp'){const path='watch-cloud-cache/.pod-write-'+(++serial)+'.part';cache.map.set(path,new Uint8Array());return {path};}
  if(method==='file.write'){const part=new Uint8Array(Buffer.from(a.dataBase64,'base64'));await cache.append(a.path,part,a.expectedOffset);return {size:cache.map.get(a.path)!.length};}
  if(method==='file.hash'){const b=cache.map.get(a.path)!;return {sha256:sha256Hex(b),size:b.length};}
  if(method==='file.commit'){const b=cache.map.get(a.path)!;expect(sha256Hex(b)).toBe(a.expectedSha256);cache.map.set(a.target,b);return {};}
  if(method==='file.delete'){cache.map.delete(a.path);return {deleted:true};}
  return base(method,a);
 };
 const source=new Uint8Array([1,2,3]);f.options.repository.cloudNoteAsset=async()=>source;
 await f.db.execute("UPDATE memo_notes SET markdown='![PNG](assets/image.png)' ,content_hash=?",[sha256Hex(new TextEncoder().encode('![PNG](assets/image.png)'))]);
 (f.options as any).allowBodies=async()=>true;
 const oldBootstrap=f.options.bootstrap;(f.options as any).bootstrap=async()=>({...await oldBootstrap(),libraryEpoch:'legacy-epoch',contentGeneration:'1'});
 const transport=f.options.transport;const bodyRequests:any[]=[];const carrierBackend=backend({legacyDeviceId:f.options.legacyDeviceId,token:f.options.account.watchDeviceToken});carrierBackend.close();
 f.options.transport={request:async r=>{if(r.url.includes('/cloud/bodies/v1')){bodyRequests.push(r);return carrierBackend.transport.request(r);}return transport.request(r);}};
 let opened:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;try{
  opened=await openApplicationSyncV2(f.options);expect(opened).not.toBeNull();expect(f.server.account.revision).toBe('1');expect((await f.db.query('SELECT asset_id FROM memo_assets'))[0]!.asset_id).toBe('image.png');expect(opened!.bodyError()).toBe('body_channel_write_disabled');expect((await opened!.ui.snapshot()).errorCode).toBe('body_channel_write_disabled');expect(bodyRequests.filter(r=>r.method==='POST')).toHaveLength(1);expect(bodyRequests.some(r=>r.method==='PUT')).toBe(false);expect(await f.options.repository.cloudNoteAsset('image.png')).toEqual(source);
  carrierBackend.open();await opened!.sync();expect(opened!.bodyError()).toBeNull();expect((await opened!.ui.snapshot()).errorCode).toBeNull();expect(carrierBackend.ready.size).toBe(1);
  const afterBackup=bodyRequests.length;
  await opened!.sync();
  expect(bodyRequests.slice(afterBackup).every(r=>r.method==='GET'&&r.url.includes('/carriers?'))).toBe(true);
  expect(carrierBackend.ready.size).toBe(1);
  const descriptor=[...carrierBackend.descriptors.values()][0]!,binding={kind:'asset' as const,logicalId:'image.png',entityKey:descriptor.body.entityKey,bodyRevision:descriptor.body.bodyRevision};
  const restored=await openCarrier({descriptor,scope,binding,crypto:snapshotCrypto,signer,publicKey:b64(publicBytes),key:async()=>await f.options.keys.accountKey(),read:async h=>carrierBackend.objects.get(h)!});expect(restored.get('notes/assets/image.png')).toEqual(source);
 }finally{await opened?.close();f.db.close();}
});

test('process restart keeps the same signed carrier and resumes durable server bytes',async()=>{
 const p=await prepared(),b=backend(),cache=files();
 const entry={row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,deleted:false,recipeOid:null},meta:{kind:'asset',logicalId:'image.png',payload:{assetId:'image.png',mime:'image/png',originalFilename:'image.png'}},state:{payload:{updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}}};
 const projection={readState:async()=>({account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),cloudRow:async()=>entry,cloudRows:async(_r:string,after:string)=>after?[]:[entry]};
 const ports={http:b.http(),scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>({deviceId:author,alias:'key'}),approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async()=>key.slice(),currentKey:async()=>({key:key.slice(),version:1}),files:cache,root:'test',repository:{read:async()=>p.raw,validate:async()=>{},install:async()=>{throw Error('local original must remain');}},check:async()=>{}};
 b.losePart();expect((await new WatchBodyChannel(ports).sync()).pending).toBe(1);expect(b.descriptors.size).toBe(1);const id=[...b.descriptors.keys()][0];
 expect((await new WatchBodyChannel(ports).sync()).errors).toEqual([]);expect(b.descriptors.size).toBe(1);expect(b.ready.has(id!)).toBe(true);

});

test('book receiver validates the existing producer fingerprint before installing exact JSONL bytes',async()=>{
 const {default:book}=await import('../fixtures/cli-single-txt-book.json'),{bodyChannelRepository}=await import('../../src/sync-v2/body-channel-repository');
 const raw=new TextEncoder().encode(book.packageUtf8);let installed:Uint8Array|undefined;
 const repository=bodyChannelRepository({cloudBookBody:async()=>raw,receiveCloudBook:async(id:string,bytes:Uint8Array)=>{expect(id).toBe(book.bookId);installed=bytes;}} as any);
 const logicalId=book.bookId,entity='d'.repeat(64),binding={kind:'book' as const,logicalId,entityKey:entity,bodyRevision:carrierBodyRevision('book',entity,sha256Hex(raw))};
 const p=await prepareCarrier({crypto:snapshotCrypto,signer,alias:'key',authorDeviceId:author,scope,anchor,binding,key:key.slice(),keyVersion:1,objects:[{name:bodyObjectName('book',logicalId),bytes:raw,compress:false}]});
 const decoded=await openCarrier({descriptor:p.descriptor,scope,binding,crypto:snapshotCrypto,signer,publicKey:b64(publicBytes),key:async()=>key.slice(),read:async h=>p.objects.get(h)!}),out=decoded.get(bodyObjectName('book',logicalId))!;
 await repository.validate('book',logicalId,book,out);await repository.install('book',logicalId,out);expect(installed).toEqual(raw);
 await expect(repository.validate('book',logicalId,{...book,fingerprint:'0'.repeat(64)},out)).rejects.toThrow('book_package_invalid');expect(installed).toEqual(raw);
});

function conditionalAssetHost(race:boolean){
 const map=new Map<string,Uint8Array>();let serial=0,injected=false;
 const host=async<T>(method:string,a:any):Promise<T>=>{
  const get=(p:string)=>{const b=map.get(p);if(!b)throw Error('file_not_found');return b;};
  if(method==='file.stat'){const b=map.get(a.path);return {file:!!b,size:b?.length??0} as T;}
  if(method==='file.hash'){const b=get(a.path);return {sha256:sha256Hex(b),size:b.length} as T;}
  if(method==='file.createTemp'){const path='notes/assets/.pod-write-'+(++serial)+'.part';map.set(path,new Uint8Array());return {path} as T;}
  if(method==='file.write'){const b=new Uint8Array(Buffer.from(a.dataBase64,'base64')),old=a.append?get(a.path):new Uint8Array();if(a.append)expect(old.length).toBe(a.expectedOffset);const next=new Uint8Array(old.length+b.length);next.set(old);next.set(b,old.length);map.set(a.path,next);return {size:next.length} as T;}
  if(method==='file.commit'){
   expect(Object.hasOwn(a,'expectedTargetSha256')).toBe(true);
   if(race&&!injected&&a.target==='notes/assets/image.png'){map.set(a.target,new Uint8Array([9,8,7]));injected=true;}
   const current=map.get(a.target);if(a.expectedTargetSha256===null?!!current:!current||sha256Hex(current)!==a.expectedTargetSha256)throw Error('file_target_changed');
   const b=get(a.path);expect(sha256Hex(b)).toBe(a.expectedSha256);map.set(a.target,b.slice());map.delete(a.path);return {} as T;
  }
  if(method==='file.delete'){map.delete(a.path);return {deleted:true} as T;}throw Error(method);
 };return {host,map,injected:()=>injected};
}
for(const mode of ['cloud','local','existing different original'] as const)test((mode==='existing different original'?'FIX1':'RVPODNOTES-01')+' '+mode+' preserves both attachment versions and records a conflict',async()=>{
 const {createNoteAssetWriter}=await import('../../src/notes/cloud-assets'),{NoteAssetReceiver}=await import('../../src/sync/note-assets');
 const p=await prepared('asset',new Uint8Array([1,2,3])),f=conditionalAssetHost(mode!=='existing different original'),writer=createNoteAssetWriter(f.host);
 if(mode==='existing different original')f.map.set('notes/assets/image.png',new Uint8Array([9,8,7]));
 if(mode==='local'){
  const receiver=new NoteAssetReceiver({stat:path=>f.host('file.stat',{path}),hash:path=>f.host('file.hash',{path}),remove:async path=>{await f.host('file.delete',{path});},write:(path,dataBase64)=>f.host('file.write',{path,dataBase64}),append:(path,dataBase64,expectedOffset)=>f.host('file.write',{path,dataBase64,append:true,expectedOffset}),commit:(path,target,expectedSize,expectedSha256,expectedTargetSha256)=>f.host('file.commit',{path,target,expectedSize,expectedSha256,expectedTargetSha256})});
  await expect(receiver.apply({version:1,storageKey:'image.png',sha256:sha256Hex(p.raw),chunkCount:1,chunkIndex:0,data:Buffer.from(p.raw).toString('base64')})).rejects.toThrow('note_asset_conflict');
 }else{
  const entry={row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,deleted:false,recipeOid:null},meta:{kind:'asset',logicalId:'image.png',payload:{assetId:'image.png',mime:'image/png',originalFilename:'image.png'}},state:{payload:{updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}}};
  const projection={readState:async()=>({account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),cloudRow:async()=>entry,cloudRows:async(_r:string,after:string)=>after?[]:[entry]};
  const channel=new WatchBodyChannel({http:{list:async()=>({carriers:[{descriptor:p.descriptor}],nextAfter:null}),download:async(_id:string,h:string)=>p.objects.get(h)} as any,scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>({deviceId:author,alias:'key'}),approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async()=>key.slice(),currentKey:async()=>({key:key.slice(),version:1}),files:files(),root:'test',repository:{read:async()=>f.map.get('notes/assets/image.png'),validate:async()=>{},install:async(_k,id,raw,expected)=>{await writer(id,raw,expected);}},check:async()=>{}});
  expect(await channel.sync()).toEqual({pending:1,errors:['note_asset_conflict']});
 }
 expect(f.injected()).toBe(mode!=='existing different original');expect(f.map.get('notes/assets/image.png')).toEqual(new Uint8Array([9,8,7]));
 const path='notes/asset-conflicts/'+sha256Hex(new TextEncoder().encode('image.png'))+'-'+sha256Hex(p.raw)+'.bin';expect(f.map.get(path)).toEqual(p.raw);expect(JSON.parse(new TextDecoder().decode(f.map.get(path+'.json')))).toMatchObject({storageKey:'image.png',incomingSha256:sha256Hex(p.raw),retainedPath:path});
});

test('RVPODNOTES-03 backend 507/null builds persistent capped exponential backoff without a sliding deadline',async()=>{
 const p=await prepared(),cache=files();let now=1000,reserves=0;
 const http=new BodyChannelHttp({enabled:true,origin:'http://127.0.0.1:18991',policy:{accountBaseUrl:'http://127.0.0.1:18991',allowLoopback:true},scope,session:async()=>({accessToken:'synthetic',legacyDeviceId:'legacy',legacyEpoch:'epoch',legacyGeneration:'1'}),check:async()=>{},transport:{request:async r=>{
  if(r.method==='POST'){reserves++;return {status:507,headers:{},body:jsonBytes({error:{code:'quota_exceeded',retryable:true,retryAfterMillis:null,details:{}}})};}
  return {status:200,headers:{},body:jsonBytes({version:1,purpose:'p6-body.v1',scope,carriers:[],nextAfter:null})};
 }}});
 const entry={row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,deleted:false,recipeOid:null},meta:{kind:'asset',logicalId:'image.png',payload:{assetId:'image.png',mime:'image/png',originalFilename:'image.png'}},state:{payload:{updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}}};
 const projection={readState:async()=>({account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),cloudRow:async()=>entry,cloudRows:async(_r:string,after:string)=>after?[]:[entry]};
 const ports={http,scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>({deviceId:author,alias:'key'}),approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async()=>key.slice(),currentKey:async()=>({key:key.slice(),version:1}),files:cache,root:'test',repository:{read:async()=>p.raw,validate:async()=>{},install:async()=>{}},check:async()=>{},now:()=>now};
 const retry='test/'+p.binding.entityKey+'/'+p.binding.bodyRevision+'/retry.json';
 for(let attempt=1;attempt<=8;attempt++){
  expect((await new WatchBodyChannel(ports).sync()).errors).toEqual(['quota_exceeded']);const raw=cache.map.get(retry)!,record=parseCanonicalJson(raw);expect(record).toEqual({version:1,code:'quota_exceeded',attempts:attempt,until:now+Math.min(1800000,30000*2**(attempt-1))});expect(reserves).toBe(attempt);
  expect((await new WatchBodyChannel(ports).sync()).errors).toEqual(['quota_exceeded']);expect(reserves).toBe(attempt);expect(cache.map.get(retry)).toEqual(raw);now=record.until;
 }
});

for(const kind of ['book','asset'] as const)for(const explicit of [false,true])test(`RVPODNOTES-02 ${kind} metadata arrives first, offline rename, ${explicit?'explicit':'ordinary'} publish, then download`,async()=>{
 const {publishingFixture,SyntheticIndexBackend,serverPin}=await import('./p2-fixture'),{idKey,binding}=await import('./fixture'),{WatchIndexPublisher}=await import('../../src/sync-v2/publisher'),{WatchCloudIndex}=await import('../../src/sync-v2/cloud-index'),{bodyChannelRepository}=await import('../../src/sync-v2/body-channel-repository'),{independentBodyResolver}=await import('../../src/sync-v2/body-channel'),{SyncV2Http}=await import('../../src/sync-v2/http'),{default:book}=await import('../fixtures/cli-single-txt-book.json');
 const server=new SyntheticIndexBackend(),f=await publishingFixture(server),content=new Uint8Array(32).fill(0x22),keys={id:idKey,content,version:1},id=kind==='book'?book.bookId:'image.png',entity=entityKey(idKey,scope.repoId,kind,id),raw=kind==='book'?new TextEncoder().encode(book.packageUtf8):new Uint8Array([1,2,3]);let present=true;
 const value=kind==='book'?{bookId:id,fingerprint:book.fingerprint,title:'Original',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:book.sourceUrl,kind:'txt'}:{assetId:id,mime:'image/png',originalFilename:id,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0};
 const repository={read:async()=>present?raw:undefined,validate:async(k:any,i:string,v:any,b:Uint8Array)=>{if(k==='book')await bodyChannelRepository({} as any).validate(k,i,v,b);},install:async()=>{}};
 const baseResolver=independentBodyResolver(repository,async()=>null),resolver=async(e:any,prior:any)=>{const body=await baseResolver(e,prior);return body&&!prior?{...body,promiseId:'f'.repeat(32)}:body;},http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin(),false,false,false,true),publisher=new WatchIndexPublisher(f.store,http,signer,keys,()=>100,resolver);
 const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),reader=new WatchCloudIndex(f.store,http,signer,keys,approved,async()=>{},()=>100);
 const scan=async(v:any,name:string)=>{await f.store.beginScan({...binding,schema:name});await f.store.scanPage({page:async()=>({rows:[{kind,logicalId:id,value:v}],after:'done',done:true}),changed:async()=>[]});};
 let target:Awaited<ReturnType<typeof publishingFixture>>|undefined;try{
  await scan(value,'before');await publisher.prepare(author,'key',{commitOid:null,revision:'0'},'c'.repeat(32));await publisher.flush();await reader.pull(server.window());
  const initial=await f.store.readState(),entry=await f.store.cloudRow(initial.cloud.current.treeRoot,entity),old=entry.row.bodyRevision;
  const body=await prepareCarrier({crypto:snapshotCrypto,signer,alias:'key',authorDeviceId:author,scope,anchor:{commitOid:server.account.commitOid,revision:server.account.revision,rollbackGeneration:'0'},binding:{kind,logicalId:id,entityKey:entity,bodyRevision:old},key:content.slice(),keyVersion:1,objects:[{name:bodyObjectName(kind,id),bytes:raw,compress:false}]});
  present=false;await scan({...value,...(kind==='book'?{title:'Offline rename'}:{originalFilename:'Offline rename.png'}),updatedAt:2},'after');
  const candidate=await f.store.readCandidate(entity),own={commitOid:server.device.commitOid,revision:server.device.revision};
  // This is the shape supplied by explicit account choices, not the reader DTO.
  expect(await resolver({entityKey:entity,candidate}, {entityKey:entity,candidate:{meta:entry.meta,state:entry.state},manifest:Object.fromEntries(['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'].map(k=>[k,entry.row[k]]))} as any)).toMatchObject({bodyRevision:old,promiseId:entry.row.promiseId});
  if(explicit){
   const {WatchAccountControl}=await import('../../src/sync-v2/account-control');const state=await f.store.readStableState(),manifest=await resolver({entityKey:entity,candidate},entry),selected={entityKey:entity,rowSequence:'1',candidate,manifest};
   const control=new WatchAccountControl({store:f.store,http,publisher,reader,crypto:signer,approved,business:{prepare:async()=>[],reserve:async()=>async()=>{},verifyBody:async()=>{throw Error('closure_incomplete');}},resolveBody:resolver,trustedNow:()=>100} as any);
   const prepared=await (control as any).prepareApply(state,[selected]);await prepared.release();
   await expect((control as any).prepareApply(state,[{...selected,manifest:{...manifest,bodyRevision:'0'.repeat(32)}}])).rejects.toThrow('closure_incomplete');
   await publisher.prepareExplicit({kind:'resolve-local',expected:await f.store.readStableState(),deviceId:author,alias:'key',own,requestId:'d'.repeat(32),records:[{entityKey:entity,rowSequence:'1',candidate,manifest:null}]});
  }
  else await publisher.prepare(author,'key',own,'d'.repeat(32));
  if(explicit){const pending=(await f.store.readState()).cloud.pendingPublish,staged=await f.store.cloudRow(pending.treeRoot,entity);expect(staged.row.bodyRevision).toBe(old);expect(staged.row.promiseId).toBe(entry.row.promiseId);}await publisher.flush();
  target=await publishingFixture(server);const receiverIndex=new WatchCloudIndex(target.store,target.http,signer,keys,approved,async()=>{},()=>100);await receiverIndex.pull(server.window());
  const got=await target.store.readState();expect((await target.store.cloudRow(got.cloud.current.treeRoot,entity)).row.bodyRevision).toBe(old);let installed:Uint8Array|undefined;
  const channel=new WatchBodyChannel({http:{list:async(_e:string,revision:string)=>({carriers:revision===old?[{descriptor:body.descriptor}]:[],nextAfter:null}),download:async(_id:string,h:string)=>body.objects.get(h)} as any,scope,projection:target.store,crypto:snapshotCrypto,signer,approved,author:async()=>({deviceId:author,alias:'key'}),key:async()=>content.slice(),currentKey:async()=>({key:content.slice(),version:1}),files:files(),root:'receiver',repository:{...repository,read:async()=>installed,install:async(_k,_id,b)=>{installed=b;}},check:async()=>{}});
  expect(await channel.sync()).toEqual({pending:0,errors:[]});expect(installed).toEqual(raw);
 }finally{target?.db.close();f.db.close();}
});

test('RVPODNOTES-02 missing new original holds only that entity and never invents a body revision',async()=>{
 const {publishingFixture,SyntheticIndexBackend}=await import('./p2-fixture'),{idKey,binding,noteValue}=await import('./fixture'),{WatchIndexPublisher}=await import('../../src/sync-v2/publisher'),{WatchCloudIndex}=await import('../../src/sync-v2/cloud-index'),{independentBodyResolver}=await import('../../src/sync-v2/body-channel');
 const server=new SyntheticIndexBackend(),f=await publishingFixture(server),id='missing.png',entity=entityKey(idKey,scope.repoId,'asset',id),keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1},pending:string[]=[];
 try{
  await f.store.beginScan({...binding,schema:'missing-original'});await f.store.scanPage({page:async()=>({rows:[{kind:'asset',logicalId:id,value:{assetId:id,mime:'image/png',originalFilename:id,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}},{kind:'note',logicalId:'n',value:noteValue('n')}],after:'done',done:true}),changed:async()=>[]});
  let original:Uint8Array|undefined;const publisher=new WatchIndexPublisher(f.store,f.http,signer,keys,()=>100,independentBodyResolver({read:async()=>original,validate:async()=>{},install:async()=>{}},async()=>null,code=>pending.push(code)));
  await publisher.prepare(author,'key',{commitOid:null,revision:'0'},'e'.repeat(32));await publisher.flush();const reader=new WatchCloudIndex(f.store,f.http,signer,keys,async deviceId=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100);await reader.pull(server.window());
  const state=await f.store.readState();expect(await f.store.cloudRow(state.cloud.current.treeRoot,entity)).toBeNull();expect(await f.store.readCandidate(entity)).not.toBeNull();expect(state.hasUnsentEdits).toBe(true);expect(pending).toEqual(['body_channel_source_missing']);expect(await f.store.cloudRow(state.cloud.current.treeRoot,entityKey(idKey,scope.repoId,'note','n'))).not.toBeNull();
  original=new Uint8Array([1,2,3]);await publisher.prepare(author,'key',{commitOid:server.device.commitOid,revision:server.device.revision},'b'.repeat(32));await publisher.flush();await reader.pull(server.window());const resumed=await f.store.readState();expect((await f.store.cloudRow(resumed.cloud.current.treeRoot,entity)).row.bodyRevision).toBe(carrierBodyRevision('asset',entity,sha256Hex(original)));expect(resumed.hasUnsentEdits).toBe(false);
 }finally{f.db.close();}
});


for(const expire of [false,true])test('FIX1 final D1 local proof '+(expire?'rechecks the deadline':'detects file replacement after cloud row validation'),async()=>{
 const p=await prepared(),b=backend();
 await b.http().upload(p.descriptor,async hash=>p.objects.get(hash)!);
 const logicalId=p.binding.logicalId;
 const wire=toWire('asset',{assetId:logicalId,mime:'image/png',originalFilename:logicalId,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0});
 const entry={row:{entityKey:p.binding.entityKey,bodyRevision:p.binding.bodyRevision,deleted:false,recipeOid:null},meta:{kind:'asset',logicalId,payload:wire.meta},state:{payload:wire.state}};
 let local=p.raw,reads=0,validation=0,pendingChoice=false,failRead=false,installs=0;let now=1;
 const changed=p.raw.slice();changed[0]^=1;
 const projection={
  readState:async()=>({pendingChoice,account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),
  cloudRows:async(_root:string,after:string)=>after?[]:[entry],
  cloudRow:async()=>{if(++validation===2&&!expire)local=changed;return entry;},
 };
 const channel=()=>new WatchBodyChannel({http:b.http(),scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>{throw Error('unexpected upload');},approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async()=>key.slice(),currentKey:async()=>{throw Error('unexpected upload');},files:files(),root:'local-body',now:()=>now,repository:{
  read:async()=>{if(++reads===2&&expire)now=3;if(failRead)throw Error('file_replaced');return local;},
  validate:async()=>{},install:async()=>{installs++;},
 },check:async()=>{}});
 const start=b.calls.length;
 const first=await channel().sync(2),calls=b.calls.slice(start).map(call=>new URL(call.url).pathname);
 expect(first).toEqual({pending:1,errors:[expire?'window_expired':'body_revision_changed']});
 expect(validation).toBe(2);expect(reads).toBe(2);
 expect(calls).toHaveLength(1);expect(calls[0]).toEndWith('/carriers');expect(installs).toBe(0);
 if(expire)return;
 const beforeFailure=b.calls.length;failRead=true;
 const second=await channel().sync();
 expect(second).toEqual({pending:1,errors:['file_replaced']});
 expect(b.calls.slice(beforeFailure).some(call=>/\/objects\//.test(new URL(call.url).pathname))).toBe(true);
 expect(installs).toBe(0);expect(local).toBe(changed);
});

test('FIX1 rollback v1 attachment archives exact bytes before refusing publication',async()=>{
 const {createApplicationActionHandler}=await import('../../src/sync/application-actions');
 const {bookFixture}=await import('../books/fixture');
 const {localTransferIntakeFixture}=await import('../helpers/local-transfer-intake');
 const f=await bookFixture();
 try{
  const guard=await localTransferIntakeFixture(f.db,{backendBaseUrl:'https://fixture.invalid',userId:'11000000-0000-0000-0000-000000000000'},'22000000-0000-0000-0000-000000000000');
  await guard.rollback();
  const before=await guard.store.readState();
  const asset=v1AssetFiles(),body=new Uint8Array([65,66,67]);
  let notifications=0;
  const handler=createApplicationActionHandler({
   notes:{initialize:async()=>{},merge:async()=>0,allIncludingDeleted:async()=>[]},
   legacyIntake:apply=>guard.intake(guard.account,guard.deviceId,apply),
   deviceId:async()=>guard.deviceId,notesChanged:()=>{notifications++;},noteAssets:asset.receiver,
  });
  const result=await handler({action:'syncNoteAsset',version:1,storageKey:'review.png',sha256:sha256Hex(body),chunkIndex:0,chunkCount:1,data:Buffer.from(body).toString('base64')});
  const after=await guard.store.readState(),target=asset.contents.get('notes/assets/review.png');
  expect(before.account?.generation).not.toBe('0');expect(result).toMatchObject({success:false,message:'BUSINESS_REJECTED'});expect(target).toBeUndefined();
  expect(notifications).toBe(0);expect(after.pendingChoice?.inboxKeys).toHaveLength(1);
  const {entry}=await guard.store.legacyChoiceEntry(after.pendingChoice!.inboxKeys[0]!);
  const restored:number[]=[];
  await guard.store.legacyBodies.verify(entry.transferBody,async bytes=>{restored.push(...bytes);});
  expect(restored).toEqual([...body]);
 }finally{f.sql.close();}
});


test('FIX1 D1 rejects a signed carrier whose keyVersion is unavailable',async()=>{
 const p=await prepared(),b=backend(),body=p.descriptor.body;
 const unsupported=await prepareCarrier({
  crypto:snapshotCrypto,signer,alias:'key',authorDeviceId:author,scope,anchor,
  binding:p.binding,key:key.slice(),keyVersion:2,objects:[{name:bodyObjectName('asset',p.binding.logicalId),bytes:p.raw,compress:false}],
 });
 await b.http().upload(unsupported.descriptor,async hash=>unsupported.objects.get(hash)!);
 const logicalId=p.binding.logicalId;
 const wire=toWire('asset',{assetId:logicalId,mime:'image/png',originalFilename:logicalId,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0});
 const entry={row:{entityKey:p.binding.entityKey,bodyRevision:body.bodyRevision,deleted:false,recipeOid:null},meta:{kind:'asset',logicalId,payload:wire.meta},state:{payload:wire.state}};
 const projection={
  readState:async()=>({pendingChoice:null,account:{oid:anchor.commitOid,revision:'1',generation:'0'},cloud:{current:{commitOid:anchor.commitOid,treeRoot:'root'}}}),
  cloudRows:async(_root:string,after:string)=>after?[]:[entry],cloudRow:async()=>entry,
 };
 let keyChecks=0;
 const channel=new WatchBodyChannel({http:b.http(),scope,projection:projection as any,crypto:snapshotCrypto,signer,author:async()=>{throw Error('unexpected upload');},approved:async()=>({deviceId:author,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),key:async v=>{keyChecks++;if(v!==1)throw Error('key_unavailable');return key.slice();},currentKey:async()=>{throw Error('unexpected upload');},files:files(),root:'local-body',repository:{
  read:async()=>p.raw,validate:async()=>{},install:async()=>{throw Error('unexpected install');},
 },check:async()=>{}});
 const start=b.calls.length;
 const result=await channel.sync(),calls=b.calls.slice(start).map(call=>new URL(call.url).pathname);
 expect(result).toEqual({pending:1,errors:['key_unavailable']});expect(keyChecks).toBe(1);expect(calls.every(path=>path.endsWith('/carriers'))).toBe(true);
});

test('FIX1 legacy inbox archives 64 KiB blocks in bounded transactions',async()=>{
 const {WatchLegacyBody,LEGACY_BODY_SCHEMA}=await import('../../src/sync-v2/legacy-body');
 const sql=new SqlFixture(),raw=new Uint8Array(65536*9+11).fill(13);
 try{
  await sql.transaction([{sql:LEGACY_BODY_SCHEMA}]);
  const batches:number[]=[];
  const archive=new WatchLegacyBody({
   query:sql.query.bind(sql),
   transaction:async statements=>{batches.push(statements.length);await sql.transaction(statements);},
  },{seal:async(_aad,value)=>JSON.stringify(value),open:async(_aad,sealed)=>JSON.parse(sealed)},'test');
  const ref={owner:'c'.repeat(64),size:raw.length,sha256:sha256Hex(raw)};
  await archive.stage(ref,{...ref,read:async(offset,size)=>raw.slice(offset,offset+size)},()=>{});
  expect(batches).toEqual([4,4,2]);
  await archive.verify(ref,async(part,offset)=>{expect(part).toEqual(raw.subarray(offset,offset+part.length));});
 }finally{sql.close();}
});
