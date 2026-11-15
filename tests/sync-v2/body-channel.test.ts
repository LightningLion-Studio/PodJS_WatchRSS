import {test,expect} from 'bun:test';
import {crypto as snapshotCrypto,key} from '../cloud/k2-crypto';
import {crypto as signer,publicBytes} from './p2-fixture';
import {b64} from '../../src/sync-v2/wire';
import {scope} from './fixture';
import {sha256Hex} from '@podjs/framework/crypto';
import {jsonBytes,parseCanonicalJson,canonical,entityKey} from '../../src/sync-v2/protocol';
import {prepareCarrier,openCarrier,carrierBodyRevision,bodyObjectName,validateCarrier,type Carrier} from '../../src/sync-v2/body-channel-codec';
import {BodyChannelHttp} from '../../src/sync-v2/body-channel-http';
import {WatchBodyChannel} from '../../src/sync-v2/body-channel';
import {refreshNoteAssets,NOTE_ASSET_SCHEMA} from '../../src/sync-v2/note-assets';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {SqlFixture,idKey} from './fixture';
const anchor={commitOid:'commit:sha256:'+'a'.repeat(64),revision:'1',rollbackGeneration:'0'},author='a'.repeat(32);
async function prepared(kind:'asset'|'book'='asset',raw=new Uint8Array(180000).fill(42)){
 const logicalId=kind==='asset'?'image.png':'b'.repeat(64),entity='c'.repeat(64),binding={kind,logicalId,entityKey:entity,bodyRevision:carrierBodyRevision(kind,entity,sha256Hex(raw))};
 return {...await prepareCarrier({crypto:snapshotCrypto,signer,alias:'key',authorDeviceId:author,scope,anchor,binding,key:key.slice(),keyVersion:1,objects:[{name:bodyObjectName(kind,logicalId),bytes:raw,compress:false}]}),binding,raw};
}
const files=()=>{const map=new Map<string,Uint8Array>();return {map,read:async(p:string)=>map.get(p),writeAtomic:async(p:string,b:Uint8Array)=>{map.set(p,b.slice());},append:async(p:string,b:Uint8Array,at:number)=>{const old=map.get(p)??new Uint8Array();if(old.length!==at)throw Error('offset_conflict');const next=new Uint8Array(at+b.length);next.set(old);next.set(b,at);map.set(p,next);}};};
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
 const {SyncV2Error}=await import('../../src/sync-v2/http');let attempts=0;const throttled={...ports,http:Object.assign(Object.create(ports.http),{upload:async()=>{attempts++;throw new SyncV2Error('quota_exceeded',true,60000);},list:async()=>({carriers:[],nextAfter:null})})};
 expect((await new WatchBodyChannel(throttled).sync()).errors).toEqual(['quota_exceeded']);expect((await new WatchBodyChannel(throttled).sync()).errors).toEqual(['quota_exceeded']);expect(attempts).toBe(1);expect(await ports.repository.read()).toEqual(p.raw);
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
