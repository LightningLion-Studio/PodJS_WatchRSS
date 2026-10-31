import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {parseRawJson,rawJsonProperty,rawJsonText,jsonUtf8Bytes} from '@podjs/framework/json-raw';
import extensions from './fixtures/r48-extensions.json';
import wrapped from './fixtures/r48-object-key-envelope.json';
import reuse from './fixtures/r48-object-reuse.json';
import lazy from './fixtures/r48-lazy-migration.json';
import {crypto,enabled,key} from './k2-crypto';
import {WatchCloudCodec,type CloudManifest,type CloudObject} from '../../src/cloud/codec';
import {CloudRecordCodec,WatchCloudRecords,type RecordDocument,type RecordRow,type RecordPorts} from '../../src/cloud/records';
import {featurePolicy,cloudCompatibility,cloudRaw,cloudFormatCapabilities} from '../../src/cloud/compatibility';
import {mergeCloudArchive} from '../../src/cloud/archive-compat';
import {writeWrss,readWrss} from '../../src/cloud/wrss';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
const unhex=(s:string)=>new Uint8Array(Buffer.from(s,'hex'));
const rc=new CloudRecordCodec({...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')});
const codec=new WatchCloudCodec(crypto,enabled);
async function record(text:string,revision='1'):Promise<RecordRow>{const d=JSON.parse(text),recordId=await rc.id(key,'user',{kind:d.kind,value:d.value}),derived=await crypto.hkdf(key,utf8Encode('user'),utf8Encode('watchrss/cloud/record/v1'));try{const sealed=await crypto.encrypt(derived,utf8Encode(`watchrss-cloud-record-v1:user:${recordId}:1`),utf8Encode(text));return {recordId,revision,tombstone:false,envelope:{algorithm:'A256GCM',keyVersion:1,nonceBase64:Buffer.from(sealed.nonce).toString('base64'),ciphertextBase64:Buffer.from(sealed.ciphertext).toString('base64')}};}finally{derived.fill(0);}}
async function plaintext(row:RecordRow){const k=await crypto.hkdf(key,utf8Encode('user'),utf8Encode('watchrss/cloud/record/v1'));try{return utf8Decode(await crypto.decrypt(k,utf8Encode(`watchrss-cloud-record-v1:user:${row.recordId}:1`),new Uint8Array(Buffer.from(row.envelope.nonceBase64,'base64')),new Uint8Array(Buffer.from(row.envelope.ciphertextBase64,'base64'))));}finally{k.fill(0);}}
const manifest=(objects:CloudObject[]):CloudManifest=>({format:'watchrss-cloud-snapshot',schemaVersion:2,snapshotId:'head',sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects,settings:{},credentialEnvelopes:{}});
async function sealed(text:string,account=key,magic='WRSSCM3'){const salt=new Uint8Array(16).fill(9),k=await crypto.hkdf(account,salt,utf8Encode(magic==='WRSSCM3'?'watchrss/cloud/manifest/v2/head':'watchrss/cloud/manifest/v1'));try{const p=await crypto.encrypt(k,utf8Encode('watchrss-cloud-manifest-v2:head'),utf8Encode(text));return new Uint8Array(Buffer.concat([Buffer.from(magic),salt,p.nonce,p.ciphertext]));}finally{k.fill(0);}}
test('R48 shared three-level feature vectors, exact unknown spans and bounded policy',()=>{
 for(const c of extensions.cases){const p=featurePolicy(c.features,c.known);if(c.withinLimits===false)continue;expect(p.opaque).toBe(c.expected.read==='opaque');expect(p.readOnly).toBe(c.expected.write==='blocked'||c.expected.write==='pending-upgrade');}
 for(const v of extensions.invalidFeatures)expect(featurePolicy(v).opaque).toBe(true);
 expect(cloudFormatCapabilities).toEqual({cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:false,cloudFormatMigrationR48V1:false,cloudArticleProvenanceReadV1:true,cloudArticleProvenanceWriteV1:false});
});
test('R48 production record AEAD edits known fields and retains every original unknown token',async()=>{
 const row=await record(extensions.implicitCompat.originalUtf8),decoded=await rc.decode(key,key,'user',row);
 const envelope=await rc.encode(key,'user',row.recordId,1,{kind:decoded.doc.kind,value:{...decoded.doc.value,title:'new'}},decoded.doc);
 const text=await plaintext({...row,envelope});expect(text).toContain(extensions.implicitCompat.unknownPropertyRawUtf8);
 expect(rawJsonText(rawJsonProperty(rawJsonProperty(parseRawJson(text),'value')!,'x-extension')!)).toBe(rawJsonText(rawJsonProperty(rawJsonProperty(parseRawJson(extensions.implicitCompat.expectedUtf8),'value')!,'x-extension')!));
 expect(JSON.parse(text).value.title).toBe('new');
});
test('R48 unknown roCompat is readable but blocks production record mutation; incompat stays opaque',async()=>{
 for(const [features,opaque]of [[{incompat:[],roCompat:['future.title-bound.v1']},false],[{incompat:['future.codec.v1'],roCompat:[]},true]] as const){const text=extensions.implicitCompat.originalUtf8.replace('"features":{"incompat":[],"roCompat":[]}',`"features":${JSON.stringify(features)}`),row=await record(text),doc=(await rc.decode(key,key,'user',row)).doc;expect(cloudCompatibility(doc).opaque).toBe(opaque);expect(cloudCompatibility(doc).readOnly).toBe(true);await expect(rc.encode(key,'user',row.recordId,1,doc)).rejects.toThrow('cloud_format_read_only');}
});
test('R48 unknown fields work for every known record kind without weakening known identity/body checks',async()=>{
 const book=(await import('../fixtures/book-fingerprint.json')).default.cases[0]!;
 const values:RecordDocument[]=[{kind:'source',value:{url:'https://example.test/rss',title:'x'}},{kind:'rss-state',value:{sourceId:'s',articleIdHash:'a'.repeat(64),isRead:true}},{kind:'book',value:{bookId:book.bookId,fingerprint:book.fingerprint,title:'B',chapterCount:2,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch'}},{kind:'book-reading',value:{bookId:book.bookId,chapterIndex:1,isRead:false,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:1,sourceDeviceId:'watch'}}];
 for(const d of values){const id=await rc.id(key,'user',d),envelope=await rc.encode(key,'user',id,1,{...d,value:{...d.value,'futureAt':9007199254740992}}),row={recordId:id,revision:'1',tombstone:false,envelope};const decoded=await rc.decode(key,key,'user',row);expect(cloudCompatibility(decoded.doc).readOnly).toBe(false);expect(cloudRaw(decoded.doc)?.source).toContain('futureAt');}
 await expect(rc.encode(key,'user','a'.repeat(64),1,{kind:'book',value:{...values[2].value,body:'not allowed'}})).rejects.toThrow();
});
test('R48 records keep pending edits across restart, fresh CAS patch and unsupported tombstone replay',async()=>{
 let original=await record(extensions.implicitCompat.originalUtf8.replace('"roCompat":[]','"roCompat":["future.title-bound.v1"]')),state:string|undefined;let local:RecordDocument={kind:'article',value:{articleId:'synthetic-a',title:'edited'}},posts=0;const applied:RecordDocument[]=[];
 const ports:RecordPorts={userId:'user',epoch:'epoch',anchorVersion:1,version:1,key:async()=>key.slice(),crypto:{...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')},current:async()=>{},assertUpload:async()=>{},readState:async()=>state,writeState:async s=>{state=s;},get:async after=>({libraryEpoch:'epoch',keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:after==='0'?[original]:[],cursor:'1',headRevision:'1',hasMore:false}),push:async items=>{posts+=items.length;return {formatVersion:1,items:items.map(r=>({recordId:r.recordId,revision:'2'}))};},apply:async docs=>{applied.push(...docs);return 0;},export:async()=>[local]};
 let records=new WatchCloudRecords(ports);await records.pull();await records.flush();expect(posts).toBe(0);expect(records.compatibility.editPending).toBe(1);expect(JSON.parse(state!).rows[original.recordId].envelope).toEqual(original.envelope);
 records=new WatchCloudRecords(ports);await records.pull();await records.flush();expect(records.compatibility.editPending).toBe(1);expect(posts).toBe(0);expect(applied.length).toBeGreaterThan(0);
 // A newer authenticated compat revision releases the edit, using its raw baseline.
 original=await record(extensions.implicitCompat.originalUtf8,'2');ports.get=async()=>({libraryEpoch:'epoch',keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:[original],cursor:'2',headRevision:'2',hasMore:false});ports.push=async items=>{posts+=items.length;expect(items[0].expectedRevision).toBe('2');expect(await plaintext({...original,envelope:items[0].envelope})).toContain(extensions.implicitCompat.unknownPropertyRawUtf8);return {formatVersion:1,items:items.map(r=>({recordId:r.recordId,revision:'3'}))};};await records.pull();await records.flush();expect(records.compatibility.editPending).toBe(0);expect(posts).toBe(1);
});
test('R48 production objectKeyEnvelope unwraps the shared exact bytes and refuses wrong scope/root and dual envelopes',async()=>{
 const account=unhex(wrapped.accountKeyHex),obj=wrapped.descriptor as CloudObject,m=manifest([obj]),decoded=await codec.decryptManifest(account,'head',await sealed(JSON.stringify(m),account));
 const restored=await codec.restore(account,decoded,async()=>unhex(wrapped.outputChunkBlobHex));expect(Buffer.from(restored.get(obj.name)!).toString('hex')).toBe(wrapped.outputPlaintextHex);
 const changed={...m,objects:[{...obj,objectKeyEnvelope:{...obj.objectKeyEnvelope!,scope:'migration:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}]};const wrong=await codec.decryptManifest(account,'head',await sealed(JSON.stringify(changed),account));await expect(codec.restore(account,wrong,async()=>unhex(wrapped.outputChunkBlobHex))).rejects.toThrow();
 await expect(codec.decryptManifest(account,'head',await sealed(JSON.stringify({...m,objects:[{...obj,readerKeyEnvelope:{version:1,saltBase64:'',nonceBase64:'',ciphertextBase64:''}}]}),account))).rejects.toThrow();
 const input={accountKey:account,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},previous:decoded,objects:[{name:obj.name,bytes:unhex(wrapped.outputPlaintextHex),compress:false}]};const next=await codec.create(input);expect(next.newChunks.size).toBe(1);expect(next.manifest.objects[0].objectKeyEnvelope).toBeUndefined();expect(next.manifest.objects[0].features?.incompat??[]).not.toContain('r48.object-key.v1');expect((await codec.restore(account,next.manifest,async h=>next.newChunks.get(h)!)).get(obj.name)).toEqual(unhex(wrapped.outputPlaintextHex));
});
test('R48 entryRef uses authenticated complete archive dependency, CRC and safe paths without a new-write gate',async()=>{
 const bytes=utf8Encode('中文 body'),archive=writeWrss(new Map([['body.txt',bytes]])),base=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'private-library.wrss',bytes:archive,compress:false}]});
 const ref={name:'reader/ref.txt',features:{incompat:['r48.entry-ref.v1'],roCompat:[]},originalBytes:bytes.length,entryRef:{object:'private-library.wrss',entryPath:'body.txt',encoding:'identity'}} as unknown as CloudObject; // entryRef wire deliberately has no legacy chunks/encoding fields

 const m=await codec.decryptManifest(key,'head',await sealed(JSON.stringify({...base.manifest,objects:[...base.manifest.objects,ref]})));const output=await codec.restore(key,m,async h=>base.newChunks.get(h)!,[m.objects[1]]);expect(output.get(ref.name)).toEqual(bytes);
 for(const entryPath of ['../body.txt','/body.txt','body\\x','body//txt'])await expect(codec.decryptManifest(key,'head',await sealed(JSON.stringify({...m,objects:[m.objects[0],{...ref,entryRef:{...ref.entryRef!,entryPath}}]})))).rejects.toThrow();
 await expect(codec.decryptManifest(key,'head',await sealed(JSON.stringify({...m,objects:[{...ref,entryRef:{...ref.entryRef!,object:ref.name}}]})))).rejects.toThrow();
});
test('R48 manifest/root/descriptor unknown tokens persist across ordinary publication, reader roots never enter account reuse',async()=>{
 const d=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'future.bin',bytes:utf8Encode('unchanged'),compress:false}]});
 const raw=JSON.stringify(d.manifest).replace('"objects":[{','"x-root": {"n":9007199254740993,"s":"\\u4e2d"},"objects":[{"x-object": [3,  2,1],');
 const previous=await codec.decryptManifest(key,'head',await sealed(raw));const next=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[{name:'known.txt',bytes:utf8Encode('new')}],previous});expect(next.manifest.objects.some(o=>o.name==='future.bin')).toBe(true);expect(cloudRaw(next.manifest)?.source).toContain('"x-root": {"n":9007199254740993,"s":"\\u4e2d"}');expect(cloudRaw(next.manifest)?.source).toContain('"x-object": [3,  2,1]');expect(next.manifest.allChunks).toContainEqual(previous.objects[0].chunks[0]);expect(next.newChunks.size).toBe(1);
 const blocked=await codec.decryptManifest(key,'head',await sealed(raw.replace('"schemaVersion":2','"schemaVersion":2,"features":{"incompat":["future.manifest"],"roCompat":[]}')));expect(cloudCompatibility(blocked).opaque).toBe(true);await expect(codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[],previous:blocked})).rejects.toThrow('cloud_format_read_only');
});
test('R48 exact unknown byte bounds isolate without truncation; corrupt authentication never becomes a compat bypass',async()=>{
 const prefix='{"format":"watchrss-rss-record","version":1,"kind":"article","value":{"articleId":"a","x":';
 for(const [n,opaque]of [[16384,false],[16385,true]] as const){const token='"'+'a'.repeat(n-jsonUtf8Bytes('"x":')-2)+'"',row=await record(prefix+token+'}}'),d=(await rc.decode(key,key,'user',row)).doc;expect(cloudCompatibility(d).opaque).toBe(opaque);}
 const row=await record(extensions.implicitCompat.originalUtf8);row.envelope.ciphertextBase64=Buffer.from('tamper').toString('base64');await expect(rc.decode(key,key,'user',row)).rejects.toThrow('cloud_record_invalid');
});
test('R48 legacy archive write preserves unknown metadata and reader/settings files, unchanged bodies carry original bytes',async()=>{
 const make=(text:string,title='old')=>writeWrss(new Map([['manifest.json',utf8Encode('{"format":"watchrss-library-backup","version":3,"articleCount":1,"readerFontCount":1,"future": {"big":9007199254740993}}')],['articles.json',utf8Encode('[{"articleId":"a","url":"https://a","title":"'+title+'","contentHash":"'+text+'","contentTextEntry":"bodies/a.txt","contentHtmlEntry":null,"x": {"n":9007199254740993}}]')],['bodies/a.txt',utf8Encode(text)],['app_meta.json',utf8Encode('[{"key":"reader-setting","value":"safe"}]')],['reader/fonts/font.bin',utf8Encode('font')]]));
 const before=make('one'),same=await mergeCloudArchive(before,make('one'),crypto.gunzip);expect(same.unchanged).toBe(true);expect(same.bytes).toBe(before);
 const newer=writeWrss(new Map([['manifest.json',utf8Encode('{"format":"watchrss-library-backup","version":3,"articleCount":1,"readerFontCount":0}')],['articles.json',utf8Encode('[{"articleId":"a","url":"https://a","title":"new","contentHash":"two","contentTextEntry":"bodies/a.txt","contentHtmlEntry":null}]')],['bodies/a.txt',utf8Encode('two')],['app_meta.json',utf8Encode('[]')]]));
 const merged=await mergeCloudArchive(before,newer,crypto.gunzip),zip=await readWrss(merged.bytes,crypto.gunzip);expect(utf8Decode(zip.get('articles.json')!)).toContain('"x": {"n":9007199254740993}');expect(utf8Decode(zip.get('manifest.json')!)).toContain('"future": {"big":9007199254740993}');expect(utf8Decode(zip.get('reader/fonts/font.bin')!)).toBe('font');expect(utf8Decode(zip.get('app_meta.json')!)).toContain('reader-setting');
});
test('R48 synthetic 16-version unchanged body profile reuses actual production ciphertext through cache re-fetch',async()=>{
 const root=unhex(reuse.baselineRootHex),descriptor=reuse.inputDescriptor as CloudObject,bytes=unhex(reuse.inputChunkBlobHex);let previous=await codec.decryptManifest(root,'head',await sealed(JSON.stringify(manifest([descriptor])),root));
 const plaintext=(await codec.restore(root,previous,async()=>bytes)).get(descriptor.name)!;
 for(const v of reuse.legacyHistory){const next=await codec.create({accountKey:root,keyVersion:1,sourceDeviceId:'watch',sequence:v.sequence+1,snapshotId:'next-'+v.sequence,createdAtMillis:v.sequence+1,parentHeads:{},observedHeads:{},previous,objects:[{name:descriptor.name,bytes:plaintext,compress:false}]});expect(next.newChunks.size).toBe(0);previous=await codec.decryptManifest(root,next.manifest.snapshotId,next.encryptedManifest);}
 expect(lazy.zeroMigrationEvents).toContain('local-schema-version');
});
test('R48 descriptor and total manifest raw byte limits are exact; unknown root does not inspect future children',async()=>{
 const d=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'reader/a',bytes:utf8Encode('a')}]});
 for(const [bytes,opaque]of [[4096,false],[4097,true]] as const){const text=JSON.stringify(d.manifest).replace('"objects":[{','"objects":[{"x":"'+'a'.repeat(bytes-6)+'",');const m=await codec.decryptManifest(key,'head',await sealed(text));expect(cloudCompatibility(m.objects[0]).opaque).toBe(opaque);expect(cloudRaw(m)?.source).toBe(text);}
 for(const [bytes,opaque]of [[1048576,false],[1048577,true]] as const){const text=JSON.stringify(manifest([])).replace('"objects":[]','"x":"'+'a'.repeat(bytes-6)+'","objects":[]');expect(cloudCompatibility(await codec.decryptManifest(key,'head',await sealed(text))).opaque).toBe(opaque);}
 const future={...manifest([]),features:{incompat:['future.root'],roCompat:[]},objects:{future:'different descriptor layout'}};expect(cloudCompatibility(await codec.decryptManifest(key,'head',await sealed(JSON.stringify(future)))).opaque).toBe(true);
});
test('R48 authenticated opaque records and readonly tombstones survive replay without applying or retiring',async()=>{
 const row=await record(extensions.implicitCompat.originalUtf8.replace('"incompat":[]','"incompat":["future.codec"]'));row.tombstone=true;let state:string|undefined,applied=0;
 const p:RecordPorts={userId:'user',epoch:'epoch',anchorVersion:1,version:1,key:async()=>key.slice(),crypto:{...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')},current:async()=>{},assertUpload:async()=>{},readState:async()=>state,writeState:async s=>{state=s;},get:async after=>({libraryEpoch:'epoch',keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:after==='0'?[row]:[],cursor:'1',headRevision:'1',hasMore:false}),push:async()=>{throw Error('unexpected push');},apply:async docs=>{applied+=docs.length;return 0;},export:async()=>[]};
 for(let i=0;i<2;i++){const records=new WatchCloudRecords(p);await records.pull();await records.flush();expect(records.compatibility.opaque).toBe(1);expect(JSON.parse(state!).rows[row.recordId]).toEqual(row);}expect(applied).toBe(0);
});
test('R48 sync preserves unknown head without ACK, exposes upgrade state and blocks incompatible root publication',async()=>{
 const {fixture}=await import('./service-fixture');const f=await fixture();await f.phone({objects:[{name:'notes-state.json',bytes:utf8Encode('{"future":1}')},{name:'rss-state.json',bytes:utf8Encode('{}')}]});
 expect(await f.service.syncNow()).toBe(false);expect(f.service.status.formatCompatibility?.opaque).toBe(1);expect(f.service.status.retryable).toBe(false);expect(f.merged).toContain('rss-state.json');expect(f.calls.some(c=>c.url.endsWith('/ack'))).toBe(false);expect(f.heads.has('phone')).toBe(true);
 const g=await fixture(),source=await g.phone({snapshotId:'head'});const raw=JSON.stringify(source.snap.manifest).replace('"schemaVersion":2','"schemaVersion":2,"features":{"incompat":["future.root"],"roCompat":[]}'),blob=await sealed(raw),hash=await crypto.sha256(blob);g.objects.set(hash,blob);g.heads.set('phone',{...source.head,manifestSha256:hash,manifestSizeBytes:blob.length});
 expect(await g.service.syncNow()).toBe(false);expect(g.reservations.size).toBe(0);expect(g.merged).toEqual([]);expect(g.service.status.formatCompatibility?.upgradeRequired).toBe(true);expect(await g.cache.manifest('user','head')).toEqual(blob);
});
test('R48 authenticated body hash carries legacy encoding/root verbatim when only encoder/schema changed',async()=>{
 const body=utf8Encode('stable book bytes'),hash=await crypto.sha256(body),first=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'reader/book',bytes:body,contentSha256:hash,compress:false}]});
 const next=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},previous:first.manifest,objects:[{name:'reader/book',bytes:body,contentSha256:hash,compress:true}]});expect(next.newChunks.size).toBe(0);expect(next.manifest.objects[0].encoding).toBe('identity');expect(next.manifest.objects[0].chunks).toEqual(first.manifest.objects[0].chunks);
});
test('R48 own unknown content survives account key rotation by retaining head and delaying publication',async()=>{
 const {fixture}=await import('./service-fixture'),f=await fixture();await f.phone({sourceDeviceId:'watch',objects:[{name:'notes/future',bytes:utf8Encode('opaque')}]});f.flags({version:2});expect(await f.service.syncNow(true)).toBe(false);expect(f.reservations.size).toBe(0);expect(f.heads.get('watch')?.keyVersion).toBe(1);expect(f.service.status.formatCompatibility?.editPending).toBe(1);
});
test('R48 readonly manifest reads known objects without ACK or publication; authenticated over-depth head stays encrypted',async()=>{
 const {fixture}=await import('./service-fixture');
 for(const depth of [false,true]){const f=await fixture(),remote=await f.phone({snapshotId:'head'});const extension=depth?'"future":'+ '['.repeat(33)+'0'+']'.repeat(33):'"features":{"incompat":[],"roCompat":["future.root"]}';const blob=await sealed(JSON.stringify(remote.snap.manifest).replace('"schemaVersion":2','"schemaVersion":2,'+extension)),hash=await crypto.sha256(blob);f.objects.set(hash,blob);f.heads.set('phone',{...remote.head,manifestSha256:hash,manifestSizeBytes:blob.length});f.session.client.snapshot=async()=>({manifestUrl:'https://objects.invalid/'+hash,chunks:remote.snap.manifest.allChunks.map(c=>({sha256:c.ciphertextSha256,sizeBytes:c.ciphertextBytes,signedUrl:'https://objects.invalid/'+c.ciphertextSha256}))});expect(await f.service.syncNow()).toBe(false);expect(await f.cache.manifest('user','head')).toEqual(blob);expect(f.reservations.size).toBe(0);expect(f.calls.some(c=>c.url.endsWith('/ack'))).toBe(false);if(!depth)expect(f.merged).toContain('rss-state.json');expect(f.service.status.retryable).toBe(false);}
});
test('R48 legacy reader root stays readable but is excluded from fresh account-root encryption reuse',async()=>{
 const account=unhex(wrapped.accountKeyHex),root=unhex(wrapped.outputRootHex),salt=new Uint8Array(16).fill(1),derived=await crypto.hkdf(account,salt,utf8Encode('watchrss/cloud/reader-key/v1')),name='reader/legacy.txt',sealedRoot=await crypto.encrypt(derived,utf8Encode('watchrss-reader-key-v1:'+name),root);derived.fill(0);
 const object={...wrapped.descriptor,name,features:undefined,objectKeyEnvelope:undefined,readerKeyEnvelope:{version:1,saltBase64:Buffer.from(salt).toString('base64'),nonceBase64:Buffer.from(sealedRoot.nonce).toString('base64'),ciphertextBase64:Buffer.from(sealedRoot.ciphertext).toString('base64')}} as CloudObject,previous=await codec.decryptManifest(account,'head',await sealed(JSON.stringify(manifest([object])),account));
 expect(Buffer.from((await codec.restore(account,previous,async()=>unhex(wrapped.outputChunkBlobHex))).get(name)!).toString('hex')).toBe(wrapped.outputPlaintextHex);
 const next=await codec.create({accountKey:account,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},previous,objects:[{name,bytes:unhex(wrapped.outputPlaintextHex),compress:false}]});expect(next.newChunks.size).toBe(1);expect(next.manifest.objects[0].readerKeyEnvelope).toBeUndefined();
});
test('R48 production entryRef rejects authenticated archive with invalid CRC rather than empty/restored content',async()=>{
 const zip=writeWrss(new Map([['body.txt',utf8Encode('body')]]));zip[30+'body.txt'.length]^=1;
 const base=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'archive',bytes:zip,compress:false}]}),ref={name:'reader/ref',features:{incompat:['r48.entry-ref.v1'],roCompat:[]},originalBytes:4,entryRef:{object:'archive',entryPath:'body.txt',encoding:'identity'}} as unknown as CloudObject;
 const m=await codec.decryptManifest(key,'head',await sealed(JSON.stringify({...base.manifest,objects:[...base.manifest.objects,ref]})));await expect(codec.restore(key,m,async h=>base.newChunks.get(h)!,[m.objects[1]])).rejects.toThrow('cloud_archive_invalid');
});
test('R48 cancelling the last known archive item retains unread resources/raw metadata; absent books are retained until explicit deletion',async()=>{
 const archive=writeWrss(new Map([['manifest.json',utf8Encode('{"format":"watchrss-library-backup","version":3,"articleCount":1,"future":9007199254740993}')],['articles.json',utf8Encode('[{"articleId":"a","contentTextEntry":"bodies/a.txt"}]')],['bodies/a.txt',utf8Encode('private')],['reader/fonts/old.ttf',utf8Encode('font')]]));const book='books/'+'a'.repeat(64)+'.jsonl';
 const first=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'private-library.wrss',bytes:archive,compress:false},{name:book,bytes:utf8Encode('book')}]});
 const next=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[],previous:first.manifest,removedPrivateArticleIds:['a'],readPreviousChunk:async h=>first.newChunks.get(h)!});
 expect(next.manifest.objects.some(o=>o.name===book)).toBe(true);const restored=await codec.restore(key,next.manifest,async h=>next.newChunks.get(h)??first.newChunks.get(h)!);const zip=await readWrss(restored.get('private-library.wrss')!,crypto.gunzip);expect(utf8Decode(zip.get('articles.json')!)).toBe('[]');expect(zip.has('bodies/a.txt')).toBe(false);expect(utf8Decode(zip.get('reader/fonts/old.ttf')!)).toBe('font');expect(utf8Decode(zip.get('manifest.json')!)).toContain('9007199254740993');
 const removed=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:3,snapshotId:'last',createdAtMillis:3,parentHeads:{},observedHeads:{},objects:[],previous:next.manifest,removedObjectNames:[book]});expect(removed.manifest.objects.some(o=>o.name===book)).toBe(false);
});
test('R48 production host parser uses fenced runtime.delay rather than a QuickJS microtask timer',async()=>{
 const {createCloudHostPorts}=await import('../../src/cloud/host-ports');const calls:{method:string;args:Record<string,unknown>}[]=[];
 const host=createCloudHostPorts((async(method:string,args:Record<string,unknown>)=>{calls.push({method,args});}) as any,enabled);await host.crypto.yieldTurn!();expect(calls).toEqual([{method:'runtime.delay',args:{milliseconds:1}}]);
 let turns=0;const yielding=new WatchCloudCodec({...crypto,yieldTurn:async()=>{turns++;}},enabled),m=manifest([]),text=JSON.stringify({...m,unknown:'x'.repeat(400000)});await yielding.decryptManifest(key,'head',await sealed(text));expect(turns).toBeGreaterThan(1);
});
test('R48 64 KiB record ciphertext boundary and unknown kinds cannot bypass authentication or known identity checks',async()=>{
 const prefix='{"format":"watchrss-rss-record","version":1,"kind":"article","value":{"articleId":"a","title":"',suffix='"}}',size=65536-16-utf8Encode(prefix+suffix).length;
 const limit=await record(prefix+'x'.repeat(size)+suffix);expect((await rc.decode(key,key,'user',limit)).doc.value.articleId).toBe('a');await expect(rc.decode(key,key,'user',await record(prefix+'x'.repeat(size+1)+suffix))).rejects.toThrow('cloud_record_invalid');
 const future=await record('{"format":"watchrss-rss-record","version":1,"kind":"constructor","value":{"url":"future"}}');expect(cloudCompatibility((await rc.decode(key,key,'user',future)).doc).opaque).toBe(true);
});
test('R48 closed writer gate cannot author a new reference through the legacy carried API',async()=>{
 const previous=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'phone',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'archive',bytes:writeWrss(new Map([['body',utf8Encode('body')]]))}]});const ref={name:'reader/new',features:{incompat:['r48.entry-ref.v1'],roCompat:[]},originalBytes:4,entryRef:{object:'archive',entryPath:'body',encoding:'identity'}} as unknown as CloudObject;
 await expect(codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[],previous:previous.manifest,carried:[ref]})).rejects.toThrow('cloud_format_write_disabled');
});
test('R48 known-only legacy records release raw syntax trees instead of retaining one per migrated RSS index',async()=>{
 const row=await record('{"format":"watchrss-rss-record","version":1,"kind":"article","value":{"articleId":"a","title":"known"}}');expect(cloudRaw((await rc.decode(key,key,'user',row)).doc)).toBeUndefined();expect(cloudRaw((await rc.decode(key,key,'user',await record(extensions.implicitCompat.originalUtf8))).doc)).toBeDefined();
});
test('R48 real SQL restart, ADD COLUMN and R47 definition/encoding invalidation do not version unchanged cloud bodies',async()=>{
 const {dbFixture,article,cloudCrypto}=await import('./library-fixture'),{SqlLibrarySessionRepository}=await import('../../src/sync/library-repository'),{WatchCloudLibraryAdapter}=await import('../../src/cloud/library'),{encodeBodyJson}=await import('../../src/sync/article-body');
 const f=await dbFixture();try{
  const a=article({articleId:await cloudCrypto.stableId('https://example.com/r48-restart'),url:'https://example.com/r48-restart'});await f.repo.mergeCloud([], [a],'phone');const before=await f.adapter.exportPayloads(true);
  const first=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{},objects:before.objects});
  await f.db.execute('ALTER TABLE articles ADD COLUMN r48_optional_local_only TEXT');await f.db.execute("UPDATE sync_fast_definitions SET encoder=0,definition='old-local-definition',generation='old-local-generation',seeded=0 WHERE domain='library'");await f.db.execute('DELETE FROM sync_fast_encoded_cache');await f.db.execute('DELETE FROM article_native_sync_hash');
  const parseUri=async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};};
  const repo=new SqlLibrarySessionRepository(f.db,{codec:{sha256:crypto.sha256,encode:async body=>{const b=await crypto.gzip(utf8Encode(encodeBodyJson(body)));b[9]=255;return b;},decode:async b=>utf8Decode(await crypto.gunzip(b,32*1024*1024))},text:{parseUri,htmlText:async v=>v.replace(/<[^>]*>/g,'')},uri:{parseUri,parseAndroid:parseUri},files:{storeText:async(_k,v)=>v,hydrate:async v=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:()=>100});
  const after=await new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled).exportPayloads(true);const beforeZip=await readWrss(before.objects[0].bytes,crypto.gunzip),afterZip=await readWrss(after.objects[0].bytes,crypto.gunzip);expect(utf8Decode(afterZip.get('articles.json')!)).toBe(utf8Decode(beforeZip.get('articles.json')!));expect(after.fingerprint).toBe(before.fingerprint);expect(after.objects).toEqual(before.objects);
  const next=await codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:2,snapshotId:'next',createdAtMillis:2,parentHeads:{},observedHeads:{},objects:after.objects,previous:first.manifest,readPreviousChunk:async h=>first.newChunks.get(h)!});expect(next.newChunks.size).toBe(0);expect(next.manifest.objects[0].chunks).toEqual(first.manifest.objects[0].chunks);
 }finally{f.sql.close();}
});
