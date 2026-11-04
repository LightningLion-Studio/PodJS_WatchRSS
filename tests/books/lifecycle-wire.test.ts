import {externalFixture} from '../helpers/external-fixtures';
import {bookId} from '../../src/books/protocol';
import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
import {CloudRecordCodec,canonical} from '../../src/cloud/records';
import {cloudCompatibility,cloudRawSource} from '../../src/cloud/compatibility';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {crypto,key,enabled} from '../cloud/k2-crypto';
const miniBooksPath=externalFixture('WATCHRSS_WECHAT_ROOT','miniprogram/lib/books.js'),miniRecordsPath=externalFixture('WATCHRSS_WECHAT_ROOT','miniprogram/lib/cloud-records.js');
const miniRequire=createRequire(import.meta.url),mini=miniBooksPath?miniRequire(miniBooksPath):undefined,miniRecords=miniBooksPath&&miniRecordsPath?miniRequire(miniRecordsPath):undefined;
const miniTest=miniBooksPath&&miniRecordsPath?test:test.skip;
const codec=new CloudRecordCodec({...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')});
const fp='a'.repeat(64),value={bookId:await bookId(fp,crypto.sha256),fingerprint:fp,title:'Book',chapterCount:2,sourceDeviceId:'mini',updatedAt:100,deleted:false,deletedAt:0,deletionClock:0,deletedChapters:[],lifecycle:{generation:1,operationId:'a'.repeat(32),startedAt:100}};
test('record codec emits incompatible lifecycle marker and preserves local serialization',async()=>{
 const id=await codec.id(key,'user',{kind:'book',value}),env=await codec.encode(key,'user',id,1,{kind:'book',value});
 const {doc}=await codec.decode(key,key,'user',{recordId:id,revision:'1',tombstone:false,envelope:env});expect(doc.value).toEqual(value);expect(doc.features).toEqual({incompat:['book-lifecycle.v1'],roCompat:[]});expect(cloudCompatibility(doc).readOnly).toBe(false);
 const text=canonical({format:'watchrss-rss-record',version:1,kind:'book',features:doc.features,value:doc.value});expect(canonical(codec.readPlaintext(text))).toBe(canonical(doc));
 const derived=await crypto.hkdf(key,new TextEncoder().encode('user'),new TextEncoder().encode('watchrss/cloud/record/v1'));const plain=await crypto.decrypt(derived,new TextEncoder().encode('watchrss-cloud-record-v1:user:'+id+':1'),new Uint8Array(Buffer.from(env.nonceBase64,'base64')),new Uint8Array(Buffer.from(env.ciphertextBase64,'base64')));expect(new TextDecoder().decode(plain)).toBe(text);
 expect(()=>codec.readPlaintext(canonical({format:'watchrss-rss-record',version:1,kind:'book',value}))).toThrow();
 const unknown=codec.readPlaintext(canonical({format:'watchrss-rss-record',version:1,kind:'book',features:{incompat:['book-lifecycle.v1','future.v2'],roCompat:[]},value}));expect(cloudCompatibility(unknown).opaque).toBe(true);await expect(codec.encode(key,'user',id,1,unknown)).rejects.toThrow('cloud_format_read_only');
});
miniTest('mini differential: book record state and canonical serialization',async()=>{
 const id=await codec.id(key,'user',{kind:'book',value}),env=await codec.encode(key,'user',id,1,{kind:'book',value});
 const {doc}=await codec.decode(key,key,'user',{recordId:id,revision:'1',tombstone:false,envelope:env});expect(value.bookId).toBe(mini.id(fp));expect(doc.value).toEqual(mini.state(value));
 const text=canonical({format:'watchrss-rss-record',version:1,kind:'book',features:doc.features,value:doc.value});expect(text).toBe(JSON.stringify(miniRecords.canonical('book',value)));
});
test('snapshot emits lifecycle marker on new and reused body descriptors',async()=>{
 const c=new WatchCloudCodec(crypto,enabled),body=new TextEncoder().encode('immutable-original');
 const make=(id:string,privateBook:any,previous?:any)=>c.create({accountKey:key,keyVersion:1,snapshotId:id,sourceDeviceId:'watch',sequence:1,createdAtMillis:100,parentHeads:{},observedHeads:{},objects:[{name:'books/'+value.bookId+'.jsonl',bytes:body,privateBook,contentSha256:awaitHash}],previous});
 const awaitHash=await crypto.sha256(body),old={...value};delete (old as any).lifecycle;
 const a=await make('first',old),b=await make('second',value,a.manifest);expect(b.newChunks.size).toBe(0);expect(b.manifest.objects[0]?.features).toEqual({incompat:['book-lifecycle.v1'],roCompat:[]});expect(cloudCompatibility(b.manifest.objects[0]! as any).opaque).toBe(false);expect(b.manifest.objects[0]?.privateBook).toEqual(value);
});

test('authenticated catalogs from multiple heads retain exact descriptors and chunks',async()=>{
 const c=new WatchCloudCodec(crypto,enabled),parents=[];for(let i=0;i<2;i++){const a=await c.create({accountKey:key,keyVersion:1,snapshotId:'parent-'+i,sourceDeviceId:'mini-'+i,sequence:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'book-catalogs/'+String(i).repeat(64)+'.json',bytes:new TextEncoder().encode('{"immutable":'+i+'}')}]});parents.push(await c.decryptManifest(key,a.manifest.snapshotId,a.encryptedManifest));}
 const next=await c.create({accountKey:key,keyVersion:1,snapshotId:'child',sourceDeviceId:'watch',sequence:1,createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[],reuseManifests:parents});expect(next.newChunks.size).toBe(0);expect(next.manifest.objects).toEqual(parents.flatMap(m=>m.objects));
 const conflict=await c.create({accountKey:key,keyVersion:1,snapshotId:'conflict',sourceDeviceId:'other',sequence:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:parents[0]!.objects[0]!.name,bytes:new TextEncoder().encode('different')}]});const conflicting=await c.decryptManifest(key,'conflict',conflict.encryptedManifest);await expect(c.create({accountKey:key,keyVersion:1,snapshotId:'blocked',sourceDeviceId:'watch',sequence:2,createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[],reuseManifests:[parents[0]!,conflicting]})).rejects.toThrow('cloud_book_companion_conflict');
});

test('catalog preservation retains unknown authenticated number tokens and rejects conflicting extensions',async()=>{
 const c=new WatchCloudCodec(crypto,enabled),first=await c.create({accountKey:key,keyVersion:1,snapshotId:'raw-parent',sourceDeviceId:'mini',sequence:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[{name:'book-catalogs/'+fp+'.json',bytes:new TextEncoder().encode('{}')}]});
 async function parent(id:string,number:string){const value={...first.manifest,snapshotId:id,objects:first.manifest.objects.map(o=>({...o,extension:123}))};const text=canonical(value).replace('"extension":123','"extension":'+number),salt=new Uint8Array(16),derived=await crypto.hkdf(key,salt,new TextEncoder().encode('watchrss/cloud/manifest/v2/'+id)),sealed=await crypto.encrypt(derived,new TextEncoder().encode('watchrss-cloud-manifest-v2:'+id),new TextEncoder().encode(text));return c.decryptManifest(key,id,new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext])));}
 const a=await parent('raw-a','9007199254740993'),b=await parent('raw-b','9007199254740992'),input={accountKey:key,keyVersion:1,snapshotId:'raw-child',sourceDeviceId:'watch',sequence:1,createdAtMillis:2,parentHeads:{},observedHeads:{},objects:[]};
 const kept=await c.create({...input,reuseManifests:[a]});expect(cloudRawSource(kept.manifest.objects[0]!)).toContain('9007199254740993');await expect(c.create({...input,reuseManifests:[a,b]})).rejects.toThrow('cloud_book_companion_conflict');
});
