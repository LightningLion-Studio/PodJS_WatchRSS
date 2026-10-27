import {test,expect} from 'bun:test';
import {WatchCloudCodec,type CloudManifest,type CloudObject} from '../../src/cloud/codec';
import {cloudRaw,cloudCompatibility,featurePolicy} from '../../src/cloud/compatibility';
import {readWrss,writeWrss} from '../../src/cloud/wrss';
import {PRIVATE_OVERLAY_NAME,PRIVATE_OVERLAY_FEATURE,PrivateOverlayReadSet,decodePrivateOverlay,encodePrivateOverlay} from '../../src/cloud/private-overlay';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {dbFixture} from './library-fixture';
import {crypto,enabled} from './k2-crypto';
import mixed from './fixtures/r48-write-v1/mixed-manifest.json';
import refs from './fixtures/r48-write-v1/entry-ref.json';
import cases from './fixtures/r48-write-v1/overlay-cases.json';
const unhex=(s:string)=>new Uint8Array(Buffer.from(s,'hex'));
const key=unhex(mixed.accountKeyHex),codec=new WatchCloudCodec(crypto,enabled);
const blobs=new Map(mixed.blobs.map(b=>[b.descriptor.chunks[0].ciphertextSha256,unhex(b.blobHex)]));
const read=async(h:string)=>blobs.get(h)!;
async function manifest(){return codec.decryptManifest(key,mixed.snapshotId,unhex(mixed.encryptedManifestHex));}
async function seal(m:CloudManifest){const d=await crypto.hkdf(key,new Uint8Array(16),utf8Encode('watchrss/cloud/manifest/v2/'+m.snapshotId));try{const e=await crypto.encrypt(d,utf8Encode('watchrss-cloud-manifest-v2:'+m.snapshotId),utf8Encode(JSON.stringify(m)));return new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),new Uint8Array(16),e.nonce,e.ciphertext]));}finally{d.fill(0);}}

test('shared WriteV1 exact CM3/CC2 bytes restore overlay HTML, preserve unknown descriptor raw and gate Phase A writer',async()=>{
 const m=await manifest();expect(cloudRaw(m)?.source).toBe(mixed.manifestUtf8);expect(featurePolicy(m.features).opaque).toBe(true);expect(cloudCompatibility(m).opaque).toBe(false);
 const known=m.objects.filter(o=>!cloudCompatibility(o).opaque),payload=await codec.restore(key,m,read,known);expect(utf8Decode(payload.get(PRIVATE_OVERLAY_NAME)!)).toBe(mixed.overlayUtf8);
 const f=await dbFixture();try{expect((await f.adapter.restorePayloads(payload,m.sourceDeviceId,known)).pending).toBe(0);const s=await f.repo.cloudSnapshot(true),articles=s.articles;expect(articles.length).toBe(mixed.expected.activeArticleIds.length);const edited=articles.find(a=>a.title==='合成 article-edit')!;expect(edited.contentText).toBe(mixed.expected.editedTextUtf8);expect(edited.contentHtml).toBe(mixed.expected.editedHtmlUtf8);}finally{f.sql.close();}
 await expect(codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},previous:m,objects:[]})).rejects.toThrow('cloud_format_write_disabled');
});

test('shared WriteV1 missing replacement retains old body, keeps tombstone and retries after restart',async()=>{
 const m=await manifest(),known=m.objects.filter(o=>!cloudCompatibility(o).opaque),payload=await codec.restore(key,m,read,known),entry=cases.index.entries.find(e=>e.object)!;
 payload.delete(entry.object!);
 for(let i=0;i<2;i++){const f=await dbFixture();try{const restored=await f.adapter.restorePayloads(payload,m.sourceDeviceId,known);expect(restored.pending).toBeGreaterThan(0);const a=(await f.repo.cloudSnapshot(true)).articles;expect(a.some(a=>a.title==='合成 article-edit')).toBe(true);expect(a.some(a=>a.title==='合成 article-delete')).toBe(false);}finally{f.sql.close();}}
});

test('shared WriteV1 old backing+modified micro package+unknown tokens survive alternating writers',async()=>{
 const previous=await manifest(),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true});
 const next=await writer.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:1792800000002,parentHeads:{phone:mixed.snapshotId},observedHeads:{phone:1},previous,objects:[{name:'private-library.wrss',bytes:new Uint8Array(Buffer.from(mixed.editedArchiveBase64,'base64')),compress:false}],readPreviousChunk:read,removedPrivateArticleIds:['article-delete']});
 expect(next.newChunks.size).toBe(0);expect(cloudRaw(next.manifest)?.source).toContain(mixed.expected.unknownDescriptorRawUtf8);expect(next.manifest.objects.find(o=>o.name==='private-library.wrss')?.chunks).toEqual(previous.objects.find(o=>o.name==='private-library.wrss')!.chunks);
 const again=await writer.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:3,snapshotId:'again',createdAtMillis:1792800000003,parentHeads:{},observedHeads:{},previous:next.manifest,objects:[],readPreviousChunk:read});expect(again.newChunks.size).toBe(0);expect(again.manifest.objects.map(o=>o.name)).toEqual(next.manifest.objects.map(o=>o.name));
});

test('shared entryRef production writer emits exact descriptor and no new ciphertext for real ZIP entry',async()=>{
 const account=unhex(refs.accountKeyHex),m={...(await manifest()),features:undefined,objects:[refs.archiveDescriptor]} as CloudManifest;m.keyVersion=1;m.snapshotId='ref-head';
 // Seal this authoritative legacy descriptor using the fixture account root.
 const salt=new Uint8Array(16),derived=await crypto.hkdf(account,salt,utf8Encode('watchrss/cloud/manifest/v2/ref-head')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:ref-head'),utf8Encode(JSON.stringify(m)));derived.fill(0);
 const previous=await codec.decryptManifest(account,'ref-head',new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext]))),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true});
 const next=await writer.create({accountKey:account,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'ref-next',createdAtMillis:2,parentHeads:{},observedHeads:{},previous,objects:[],carried:[refs.descriptor as unknown as CloudObject],readPreviousChunk:async()=>unhex(refs.archiveBlobHex)});
 expect(next.newChunks.size).toBe(0);expect(next.manifest.objects.find(o=>o.name===refs.descriptor.name)).toEqual(refs.descriptor as unknown as CloudObject);expect(Buffer.from((await writer.restore(account,next.manifest,async()=>unhex(refs.archiveBlobHex),[next.manifest.objects.find(o=>o.name===refs.descriptor.name)!])).get(refs.descriptor.name)!).toString('hex')).toBe(refs.expectedEntryHex);
});

test('overlay closed index rejects duplicates, unsafe object, rounded integer and capacity violations',async()=>{
 const valid=utf8Encode(JSON.stringify(cases.index));expect((await decodePrivateOverlay(valid,crypto.sha256)).entries.length).toBe(2);
 for(const doc of [{...cases.index,extra:1},{...cases.index,entries:[cases.index.entries[0],cases.index.entries[0]]},{...cases.index,entries:[{...cases.index.entries[0],object:'../x'}]},{...cases.index,entries:[...cases.index.entries].reverse()}])await expect(decodePrivateOverlay(utf8Encode(JSON.stringify(doc)),crypto.sha256)).rejects.toThrow();
 await expect(decodePrivateOverlay(utf8Encode(JSON.stringify(cases.index).replace('1792800000001','9007199254740991.1')),crypto.sha256)).rejects.toThrow();
});

test('all-head overlay LWW: tombstone wins equal clock, missing body and conflicting descriptor keep backing',async()=>{
 const m=await manifest(),known=m.objects.filter(o=>!cloudCompatibility(o).opaque),payload=await codec.restore(key,m,read,known),reader=new PrivateOverlayReadSet(crypto),entry=cases.index.entries.find(e=>e.object)!;
 await reader.observe(payload,'phone',known);expect(reader.allow('article',entry.id,'old')).toBe(false);expect(reader.allow('article',entry.id,'phone',entry.object!)).toBe(true);
 const deleted={...entry,kind:'article' as const,object:null};await reader.observe(new Map([[PRIVATE_OVERLAY_NAME,encodePrivateOverlay([deleted])]]),'watch',known);expect(reader.allow('article',entry.id,'phone',entry.object!)).toBe(false);expect(reader.allow('article',entry.id,'old')).toBe(false);
 const conflict=new PrivateOverlayReadSet(crypto);await conflict.observe(payload,'phone',known);const other=known.map(o=>o.name===entry.object?{...o,contentSha256:'f'.repeat(64)}:o);expect((await conflict.observe(payload,'other',other)).pending).toBeGreaterThan(0);expect(conflict.allow('article',entry.id,'old')).toBe(true);expect(conflict.allow('article',entry.id,'phone',entry.object!)).toBe(false);
});

test('Phase B accepted micro-WRSS under R_out restores through the real service/SQL with both write gates closed',async()=>{
 const {fixture}=await import('./service-fixture'),f=await fixture(),db=await dbFixture();
 try{const original=await manifest(),name=cases.index.entries.find(e=>e.object)!.object!,plain=new Uint8Array(Buffer.from(mixed.editedArchiveBase64,'base64')),root=new Uint8Array(32).fill(93),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true,migrationV1:()=>true});
  const output=await new WatchCloudCodec(crypto,enabled).create({accountKey:root,keyVersion:1,sourceDeviceId:'worker-output',sequence:1,snapshotId:'output',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'worker-output.wrss',bytes:plain,compress:false}]});
  const envelope=await writer.wrapObjectKey(key,root,'11111111-1111-4111-8111-111111111111'),m={...original,objects:original.objects.filter(o=>!cloudCompatibility(o).opaque).map(o=>o.name===name?{...output.manifest.objects[0],name,objectKeyEnvelope:envelope,features:{incompat:['r48.object-key.v1'],roCompat:[]}}:o)},encrypted=await seal(m),hash=await crypto.sha256(encrypted);
  f.objects.set(hash,encrypted);for(const [h,b]of blobs)f.objects.set(h,b);for(const [h,b]of output.newChunks)f.objects.set(h,b);
  f.heads.set(m.sourceDeviceId,{id:m.snapshotId,sourceDeviceId:m.sourceDeviceId,deviceSequence:m.deviceSequence,keyVersion:1,manifestSha256:hash,manifestSizeBytes:encrypted.length,parentHeads:m.parentHeads,observedHeads:m.observedHeads});
  let outputDecrypts=0;f.session.codec=new WatchCloudCodec({...crypto,decrypt:async(k,a,n,b)=>{if(utf8Decode(a)==='watchrss-cloud-chunk-v1:'+output.manifest.objects[0].chunks[0].plaintextSha256)outputDecrypts++;return crypto.decrypt(k,a,n,b);}},enabled);
  f.session.keys.accountKey=async()=>key.slice();f.session.library=db.adapter;f.session.client.snapshot=async()=>({manifestUrl:'https://objects.invalid/'+hash,chunks:m.objects.flatMap(o=>o.chunks??[]).map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:'https://objects.invalid/'+c.ciphertextSha256}))});
  await f.service.syncNow(true);expect(f.service.status.message).toContain('新格式写入暂未开放');expect(f.service.status.phase).toBe('idle');const all=(await db.repo.cloudSnapshot(true)).articles;expect(all.length).toBe(2);expect(all.find(a=>a.title==='合成 article-edit')?.contentHtml).toBe(mixed.expected.editedHtmlUtf8);expect(f.reservations.size).toBe(0);expect(f.calls.some(c=>c.url.endsWith('/ack'))).toBe(true);expect(f.calls.some(c=>c.url.includes('format-migrations'))).toBe(false);
  outputDecrypts=0;await f.service.syncNow(true);expect(outputDecrypts).toBe(0);expect((await db.repo.cloudSnapshot(true)).articles.length).toBe(2);expect(f.reservations.size).toBe(0);
  const local=await db.adapter.exportPayloads(true),next=await writer.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'roundtrip',createdAtMillis:1792800000002,parentHeads:{},observedHeads:{},previous:await codec.decryptManifest(key,m.snapshotId,encrypted),objects:local.objects,removedPrivateArticleIds:local.removedArticleIds,removedPrivateArticleUrls:local.removedArticleUrls,readPreviousChunk:async h=>f.objects.get(h)!});expect(next.newChunks.size).toBe(0);
 }finally{db.sql.close();}
});


test('invalid micro metadata never suppresses a recoverable backing article',async()=>{
 const m=await manifest(),known=m.objects.filter(o=>!cloudCompatibility(o).opaque),payload=await codec.restore(key,m,read,known),entry=cases.index.entries.find(e=>e.object)!;
 const zip=await readWrss(payload.get(entry.object!)!,crypto.gunzip);const rows=JSON.parse(utf8Decode(zip.get('articles.json')!));rows[0].title='';zip.set('articles.json',utf8Encode(JSON.stringify(rows)));payload.set(entry.object!,writeWrss(zip));
 const f=await dbFixture();try{const result=await f.adapter.restorePayloads(payload,m.sourceDeviceId,known);expect(result.pending).toBeGreaterThan(0);expect((await f.repo.cloudSnapshot(true)).articles.some(a=>a.title==='合成 article-edit')).toBe(true);}finally{f.sql.close();}
});

test('first watch edit borrows authenticated phone backing; interrupted complete resumes without mirroring the archive',async()=>{
 const {fixture}=await import('./service-fixture'),{WatchCloudLibraryAdapter}=await import('../../src/cloud/library'),{article,cloudCrypto}=await import('./library-fixture'),f=await fixture({r48WriteV1:true});
 const old=article({articleId:'a',contentText:'large backing '.repeat(10000),contentHtml:'<p>original</p>'});
 const make=(rows:typeof old[])=>new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:rows,stateArticles:rows,sources:[]}),mergeCloud:async()=>0},'watch',cloudCrypto,enabled);
 const before=await make([old]).exportPayloads(true),remote=await f.phone({objects:before.objects});f.session.library=make([{...old,contentText:old.contentText+'edit',contentHtml:'<b>编辑</b>',contentHash:'new'}]);f.session.codec=new WatchCloudCodec(crypto,enabled,{writeV1:()=>f.client.r48WriteEnabled});f.flags({failComplete:true});
 expect(await f.service.syncNow(true)).toBe(false);const pending=await f.cache.pending('user');expect(pending).toBeDefined();const r48Manifest=await f.session.codec.decryptManifest((await import('./k2-crypto')).key,pending!.id,pending!.bytes);expect(r48Manifest.objects.find(o=>o.name==='private-library.wrss')?.chunks).toEqual(remote.snap.manifest.objects[0].chunks);expect(f.reservations.size).toBe(1);
 f.flags({failComplete:false});expect(await f.service.syncNow(true)).toBe(true);expect(f.heads.get('watch')?.id).toBe(pending!.id);expect(await f.cache.pending('user')).toBeUndefined();expect(f.reservations.size).toBe(1);
 const originalHashes=new Set(remote.snap.manifest.objects[0].chunks.map(c=>c.ciphertextSha256));expect(f.calls.filter(c=>c.method==='PUT').some(c=>originalHashes.has(c.url.split('/').at(-1)!))).toBe(false);
});

test('authenticated cross-head chunk reuse is root-scoped and migration roots never enter account-root candidates',async()=>{
 const k=(await import('./k2-crypto')).key,a=new WatchCloudCodec(crypto,enabled),b=new WatchCloudCodec(crypto,enabled),args={keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'a',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'body',bytes:utf8Encode('reusable'),compress:false}]};
 const source=await a.create({...args,accountKey:k}),next=await b.create({...args,accountKey:k,snapshotId:'b',reuseManifests:[source.manifest]});expect(next.newChunks.size).toBe(0);
 await expect(b.create({...args,accountKey:new Uint8Array(32).fill(9),reuseManifests:[source.manifest]})).rejects.toThrow('cloud_format_reuse_scope');
 await expect(b.create({...args,accountKey:new Uint8Array(32).fill(9),previous:source.manifest})).rejects.toThrow('cloud_format_reuse_scope');
});


test('overlay hard limits reject without changing the authenticated old backup',async()=>{
 const bytes=encodePrivateOverlay(Array.from({length:8193},(_,i)=>({kind:'article' as const,id:String(i).padStart(5,'0'),object:null,changedAt:1,sourceDeviceId:'watch'})));await expect(decodePrivateOverlay(bytes,crypto.sha256)).rejects.toThrow();
 const m=await manifest(),descriptor=m.objects.find(o=>o.name==='private-library.wrss')!,full={...m,features:undefined,objects:[descriptor,...Array.from({length:1023},(_,i)=>({...descriptor,name:'immutable-'+i}))]},encrypted=await seal(full),previous=await codec.decryptManifest(key,m.snapshotId,encrypted),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true});
 await expect(writer.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'full',createdAtMillis:2,parentHeads:{},observedHeads:{},previous,objects:[{name:'private-library.wrss',bytes:new Uint8Array(Buffer.from(mixed.editedArchiveBase64,'base64')),compress:false}],readPreviousChunk:read})).rejects.toThrow('cloud_format_capacity');expect(previous.objects.length).toBe(1024);expect(previous.objects[0].chunks).toEqual(descriptor.chunks);
});

test('old reader-only heads stay independent; micro overlay overrides and deletes them without a full archive copy',async()=>{
 const {article,cloudCrypto}=await import('./library-fixture'),{WatchCloudLibraryAdapter}=await import('../../src/cloud/library'),k=(await import('./k2-crypto')).key,rows=[article({articleId:'one',contentHtml:null,contentText:'one'}),article({articleId:'two',url:'https://example.com/two',contentHtml:null,contentText:'two'})],plain=[];
 for(const a of rows){const {contentText,contentHtml,...metadata}=a;plain.push({name:`reader/${(await crypto.sha256(utf8Encode(a.articleId))).slice(0,32)}/${(await crypto.sha256(utf8Encode(a.contentHash))).slice(0,32)}.txt`,bytes:utf8Encode(contentText),compress:false,privateArticle:metadata});}
 const make=(values:typeof rows)=>new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:values,stateArticles:values,sources:[]}),mergeCloud:async()=>0},'watch',cloudCrypto,enabled),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true}),base={accountKey:k,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'readers',createdAtMillis:1,parentHeads:{},observedHeads:{}},first=await codec.create({...base,objects:plain}),read=async(h:string)=>first.newChunks.get(h)!;
 const unchanged=await writer.create({...base,snapshotId:'same',sequence:2,previous:first.manifest,objects:(await make(rows).exportPayloads(true)).objects,readPreviousChunk:read});expect(unchanged.newChunks.size).toBe(0);expect(unchanged.manifest.objects.some(o=>o.name==='private-library.wrss')).toBe(false);
 const changed=[{...rows[0],contentText:'编辑',contentHtml:'<b>编辑</b>',contentHash:'edited'}],next=await writer.create({...base,snapshotId:'edited-readers',sequence:2,createdAtMillis:3,previous:first.manifest,objects:(await make(changed).exportPayloads(true)).objects,removedPrivateArticleIds:['two'],readPreviousChunk:read}),payload=await writer.restore(k,next.manifest,async h=>next.newChunks.get(h)??first.newChunks.get(h)!);
 const projected:typeof rows=[];const receiver=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[],stateArticles:[],sources:[]}),mergeCloud:async(_s,a)=>{projected.push(...a);return a.length;}},'fresh',cloudCrypto,enabled);await receiver.restorePayloads(payload,'watch',next.manifest.objects);expect(projected.map(a=>a.articleId)).toEqual(['one']);expect(projected[0].contentHtml).toBe('<b>编辑</b>');
});

test('cancel last independent save removes archive membership without regenerating its body',async()=>{
 const {article,cloudCrypto}=await import('./library-fixture'),{WatchCloudLibraryAdapter}=await import('../../src/cloud/library'),k=(await import('./k2-crypto')).key,a=article(),make=(value:typeof a)=>new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[value],stateArticles:[value],sources:[]}),mergeCloud:async()=>0},'watch',cloudCrypto,enabled),before=await make(a).exportPayloads(true),after=await make({...a,independentSaved:false,independentChangedAt:10}).exportPayloads(true),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true}),input={accountKey:k,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'saved',createdAtMillis:1,parentHeads:{},observedHeads:{}};
 expect(after.objects).toEqual([]);expect(after.fingerprint).not.toBe(before.fingerprint);const old=await codec.create({...input,objects:before.objects}),next=await writer.create({...input,snapshotId:'unsaved',sequence:2,createdAtMillis:10,previous:old.manifest,objects:after.objects,removedPrivateArticleIds:after.removedArticleIds,readPreviousChunk:async h=>old.newChunks.get(h)!});expect(next.newChunks.size).toBe(1);expect(next.manifest.objects.some(o=>o.name.startsWith('private/articles/'))).toBe(false);const bytes=await writer.restore(k,next.manifest,async h=>next.newChunks.get(h)??old.newChunks.get(h)!);expect((await decodePrivateOverlay(bytes.get(PRIVATE_OVERLAY_NAME)!,crypto.sha256)).entries[0].object).toBeNull();
});
