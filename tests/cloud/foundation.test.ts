import {contentFixture} from './content-fixture';
import {test,expect} from 'bun:test';
import {createHash,randomBytes,hkdfSync,createCipheriv,createDecipheriv,generateKeyPairSync,diffieHellman,createPublicKey,type KeyObject} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import fixture from './native-fixture.json';
import {WatchCloudCodec,CLOUD_CHUNK_BYTES,type SnapshotCrypto,type SnapshotInput} from '../../src/cloud/codec';
import {WatchCloudKeyManager,type CloudStringStore,type DeviceKeyHost} from '../../src/cloud/keys';
import {WatchCloudStateStore,cloudMergeNeeded} from '../../src/cloud/state';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudClient} from '../../src/cloud/client';
import {SupabaseTusUploader} from '../../src/cloud/tus';
import {utf8Encode,utf8Decode,type HttpRequest,type CloudSnapshotHead} from '../../src/cloud/types';
const guard={require(){}};
const crypto:SnapshotCrypto={
 random:async n=>new Uint8Array(randomBytes(n)),sha256:async b=>createHash('sha256').update(b).digest('hex'),
 hkdf:async(k,s,i)=>new Uint8Array(hkdfSync('sha256',k,s,i,32)),
 encrypt:async(k,a,p)=>{const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(p),c.final(),c.getAuthTag()]))};},
 decrypt:async(k,a,n,c)=>{const d=createDecipheriv('aes-256-gcm',k,n);d.setAAD(a);d.setAuthTag(c.slice(-16));return new Uint8Array(Buffer.concat([d.update(c.slice(0,-16)),d.final()]));},
 gzip:async b=>new Uint8Array(gzipSync(b)),gunzip:async(b,max)=>{const out=new Uint8Array(gunzipSync(b,{maxOutputLength:Math.max(1,max)}));if(out.length>max)throw Error('oversize');return out;},
};
const key=new Uint8Array(32).fill(42);
const input=(overrides:Partial<SnapshotInput>={}):SnapshotInput=>({accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'fixture-1',createdAtMillis:123,objects:[{name:'rss-state.json',bytes:utf8Encode('测试 state')}],parentHeads:{},observedHeads:{},...overrides});
class Store implements CloudStringStore {values=new Map<string,string>();async get(k:string){return this.values.get(k);}async set(k:string,v:string){this.values.set(k,v);}}
test('JVM native manifest/chunk fixture decrypts and restores in app',async()=>{
 const codec=new WatchCloudCodec(crypto,guard),key=new Uint8Array(Buffer.from(fixture.key,'base64'));
 const manifest=await codec.decryptManifest(key,'jvm-fixture',new Uint8Array(Buffer.from(fixture.manifest,'base64')));
 expect(manifest).toMatchObject({keyVersion:2,deviceSequence:7,sourceDeviceId:'phone'});
 expect((await codec.restore(key,manifest,async()=>new Uint8Array(Buffer.from(fixture.chunk,'base64')))).get('rss-state.json')).toEqual(new Uint8Array(Buffer.from(fixture.plaintext,'base64')));
});
test('content-defined boundaries, empty input, identity, gzip, reuse and key rotation',async()=>{
 const codec=new WatchCloudCodec(crypto,guard),large=new Uint8Array(CLOUD_CHUNK_BYTES+1).fill(13);
 const snap=await codec.create(input({objects:[{name:'large',bytes:large},{name:'empty',bytes:new Uint8Array()},{name:'identity',bytes:utf8Encode('raw'),compress:false}]}));
 expect(snap.manifest.objects[0].chunks.length).toBe(5);
 const restored=await codec.restore(key,snap.manifest,async h=>snap.newChunks.get(h)!);expect(restored.get('large')).toEqual(large);expect(restored.get('empty')!.length).toBe(0);expect(utf8Decode(restored.get('identity')!)).toBe('raw');
 const same=await codec.create(input({previous:snap.manifest,objects:[{name:'large',bytes:large}]}));expect(same.newChunks.size).toBe(0);
 const rotate=await codec.create(input({accountKey:new Uint8Array(32).fill(9),keyVersion:2,previous:snap.manifest,objects:[{name:'large',bytes:large}]}));expect(rotate.newChunks.size).toBe(2);
 await expect(codec.create(input({keyVersion:2,previous:snap.manifest,carried:[snap.manifest.objects[0]]}))).rejects.toThrow('轮换');
});
test('manifest AAD, chunk hash/length, nonce, plaintext hash, encoding and inflate limits fail closed',async()=>{
 const codec=new WatchCloudCodec(crypto,guard),snap=await codec.create(input());
 await expect(codec.decryptManifest(key,'wrong-id',snap.encryptedManifest)).rejects.toThrow();
 await expect(codec.decryptManifest(new Uint8Array(32),'fixture-1',snap.encryptedManifest)).rejects.toThrow();
 const blob=snap.newChunks.values().next().value!;
 await expect(codec.restore(key,snap.manifest,async()=>blob.slice(1))).rejects.toThrow();
 for(const mutate of [(m:any)=>m.objects[0].chunks[0].nonceBase64=Buffer.alloc(12).toString('base64'),(m:any)=>m.objects[0].chunks[0].plaintextSha256='0'.repeat(64),(m:any)=>m.objects[0].encoding='unknown',(m:any)=>m.objects[0].originalBytes=1]){
  const copy=JSON.parse(JSON.stringify(snap.manifest));mutate(copy);await expect(codec.restore(key,copy,async()=>blob)).rejects.toThrow();
 }
});
test('legacy gzip encoding is supported',async()=>{
 const zipped=await crypto.gzip(utf8Encode('legacy')),codec=new WatchCloudCodec(crypto,guard);
 const snap=await codec.create(input({objects:[{name:'legacy',bytes:zipped,compress:false}]}));snap.manifest.objects[0].encoding='gzip';snap.manifest.objects[0].originalBytes=6;
 expect(utf8Decode((await codec.restore(key,snap.manifest,async h=>snap.newChunks.get(h)!)).get('legacy')!)).toBe('legacy');
});
function deviceHost():DeviceKeyHost {
 const keys=new Map<string,{publicKey:KeyObject;privateKey:KeyObject}>();
 return {sha256:crypto.sha256,async publicKey(id){if(!keys.has(id))keys.set(id,generateKeyPairSync('ec',{namedCurve:'prime256v1'}));return (keys.get(id)!.publicKey.export({type:'spki',format:'der'}) as Buffer).toString('base64');},async unwrap(a){const pair=keys.get(a.keyId);if(!pair)throw Error('missing');const secret=diffieHellman({privateKey:pair.privateKey,publicKey:createPublicKey({key:Buffer.from(a.publicKeySpki,'base64'),type:'spki',format:'der'})});return crypto.decrypt(await crypto.hkdf(secret,Buffer.from(a.saltBase64,'base64'),Buffer.from(a.infoBase64,'base64')),Buffer.from(a.aadBase64,'base64'),Buffer.from(a.nonceBase64,'base64'),Buffer.from(a.ciphertextBase64,'base64'));}};
}
async function envelope(publicKey:string,user:string,device:string,version:number){
 const phone=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),secret=diffieHellman({privateKey:phone.privateKey,publicKey:createPublicKey({key:Buffer.from(publicKey,'base64'),format:'der',type:'spki'})});
 const derived=await crypto.hkdf(secret,Buffer.from(await crypto.sha256(utf8Encode(user)),'hex'),utf8Encode(`watchrss/device-envelope/v${version}/${device}`));const sealed=await crypto.encrypt(derived,utf8Encode(`watchrss-account-key:${user}:${version}:${device}`),key);
 return {algorithm:'P-256+HKDF-SHA256+A256GCM',keyVersion:version,wrappedKeyBase64:Buffer.from(sealed.ciphertext).toString('base64'),nonceBase64:Buffer.from(sealed.nonce).toString('base64'),ephemeralPublicKeySpki:(phone.publicKey.export({format:'der',type:'spki'}) as Buffer).toString('base64')};
}
test('legacy unauthenticated envelope API fails closed',async()=>{
 const manager=new WatchCloudKeyManager(deviceHost(),new Store(),guard);await expect(manager.acceptEnvelope('u','w',{} as any)).rejects.toThrow('client_upgrade_required');
});
test('durable monotonic sequence, separate full/state applied hashes, write failure and account isolation',async()=>{
 const store=new Store(),state=new WatchCloudStateStore(store,'u','w',guard);
 expect(await Promise.all([state.nextSequence(9),state.nextSequence(0),state.nextSequence(2)])).toEqual([10,11,12]);
 await state.markApplied('p',8,false);await state.markApplied('p',2,false);expect(await state.applied('p',false)).toBe(8);expect(await state.applied('p',true)).toBe(0);
 await state.markUploaded('a'.repeat(64),false);expect(await state.lastContentHash(true)).toBeUndefined();
 expect(await new WatchCloudStateStore(store,'u','w',guard).nextSequence(0)).toBe(13);expect(await new WatchCloudStateStore(store,'other','w',guard).nextSequence(0)).toBe(1);
 const failed=new WatchCloudStateStore({get:async()=>undefined,set:async()=>{throw Error('disk full');}},'u','w',guard);await expect(failed.nextSequence(0)).rejects.toThrow('disk full');
 const head=(sourceDeviceId:string,deviceSequence:number,observedHeads:Record<string,number>={}):CloudSnapshotHead=>({id:sourceDeviceId,sourceDeviceId,deviceSequence,observedHeads,parentHeads:{},manifestSha256:'a'.repeat(64),manifestSizeBytes:1,keyVersion:1});
 expect(cloudMergeNeeded([head('a',2),head('b',3)])).toBe(true);expect(cloudMergeNeeded([head('a',2),head('b',3,{a:2})])).toBe(false);
});
test('encrypted cache rejects corruption and invalid paths, updates latest after successful manifest write',async()=>{
 const blobs=new Map<string,Uint8Array>(),files={read:async(p:string)=>blobs.get(p),writeAtomic:async(p:string,b:Uint8Array)=>{blobs.set(p,b.slice());}},cache=new WatchCloudCache(files,crypto.sha256,guard),value=utf8Encode('encrypted'),hash=await crypto.sha256(value);
 await cache.storeChunk('u',hash,value);expect(await cache.chunk('u',hash)).toEqual(value);expect(await cache.chunk('other',hash)).toBeUndefined();
 blobs.set([...blobs.keys()][0],new Uint8Array([1]));expect(await cache.chunk('u',hash)).toBeUndefined();
 await expect(cache.storeChunk('u',hash,new Uint8Array())).rejects.toThrow();await expect(cache.manifest('u','../bad')).rejects.toThrow();
 await cache.storeManifest('u','s1',value,true);expect(await cache.latest('u')).toEqual({id:'s1',bytes:value});
});
test('release/unknown defaults reject every public side-effect entry before I/O',async()=>{
 let calls=0;const fail=async():Promise<any>=>{calls++;throw Error('unexpected I/O');};const store={get:fail,set:fail};
 const codec=new WatchCloudCodec(crypto),keys=new WatchCloudKeyManager({sha256:fail,publicKey:fail,unwrap:fail},store),state=new WatchCloudStateStore(store,'u','w'),cache=new WatchCloudCache({read:fail,writeAtomic:fail},fail),client=new WatchCloudClient({request:fail},{baseUrl:'https://fixture.invalid',accessToken:'x'},{sha256:fail});
 for(const action of [()=>codec.create(input()),()=>codec.decryptManifest(key,'x',key),()=>codec.restore(key,{} as any,fail),()=>keys.publicKeySpki('u','w'),()=>keys.keyVersions('u'),()=>keys.currentKeyVersion('u'),()=>keys.accountKey('u'),()=>keys.acceptBootstrap('u','w',[]),()=>keys.acceptEnvelope('u','w',{} as any),()=>state.nextSequence(0),()=>state.applied('p',true),()=>state.markApplied('p',1,true),()=>state.lastContentHash(true),()=>state.markUploaded('a',true),()=>cache.chunk('u','a'),()=>cache.storeChunk('u','a',key),()=>cache.manifest('u','a'),()=>cache.storeManifest('u','a',key),()=>cache.latest('u'),()=>client.bootstrap(),()=>client.registerDevice('w','w','spki',1),()=>client.snapshotHeads(),()=>client.snapshot('x'),()=>client.download('https://fixture.invalid',0,'a'.repeat(64)),()=>client.reserveSnapshot({} as any),()=>client.completeSnapshot('x',[]),()=>client.acknowledge('x','w'),()=>client.resolveRssSource('x'),()=>new SupabaseTusUploader({request:fail},{sha256:fail}).upload({} as any,key)]){
  try{await action();throw Error('expected disabled');}catch(e){expect(String(e)).toContain('Cloud sync unavailable');}
 }expect(calls).toBe(0);
});
test('watch registration and signed downloads preserve credentials boundary and integrity',async()=>{
 const requests:HttpRequest[]=[],body=utf8Encode('snapshot');let bad=false;
 const client=new WatchCloudClient({async request(r){requests.push(r);return {status:200,headers:{},body:r.url.includes('/register')?utf8Encode('{}'):bad?new Uint8Array():body};}},{baseUrl:'https://fixture.invalid',accessToken:'secret'},crypto,guard);
 client.setEpoch('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff');await client.registerDevice('w','Watch','spki',1);expect(JSON.parse(utf8Decode(requests[0].body!))).toMatchObject({platform:'watch',capabilities:{rtosProtocolReserved:true}});expect(JSON.parse(utf8Decode(requests[0].body!)).capabilities).not.toHaveProperty('rssRecordsVersion');
 expect(await client.download('https://objects.invalid/signed',body.length,await crypto.sha256(body))).toEqual(body);expect(requests[1].headers).toEqual({});bad=true;await expect(client.download('https://objects.invalid/signed',body.length,await crypto.sha256(body))).rejects.toMatchObject({code:'cloud_snapshot_object_integrity'});
});
test('TUS 409 reconciles offset and cannot falsely mark partial upload complete',async()=>{
 const requests:HttpRequest[]=[],responses:{status:number;headers:Record<string,string>}[]=[{status:201,headers:{Location:'/u'}},{status:200,headers:{'Upload-Offset':'0'}},{status:409,headers:{}},{status:200,headers:{'Upload-Offset':'1'}},{status:204,headers:{'Upload-Offset':'2'}}];
 const source=new Uint8Array([1,2]),hash=await crypto.sha256(source);
 await new SupabaseTusUploader({async request(r){requests.push(r);return {...responses.shift()!,body:new Uint8Array()};}},crypto,{guard}).upload({kind:'chunk',sha256:hash,sizeBytes:2,objectPath:'x',signedUrl:'',token:'sig',tusEndpoint:'https://fixture.invalid/tus',bucketName:'b'},source);
 expect(requests.map(r=>r.method)).toEqual(['POST','HEAD','PATCH','HEAD','PATCH']);expect(requests.at(-1)!.body).toEqual(new Uint8Array([2]));
});

test('authenticated P-256 device envelope batch validates native context, restart and isolation',async()=>{
 const {createHmac}=await import('node:crypto');const {commit,rotation,attest}=await import('../../src/cloud/v2');
 const hmac=async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex');const host={...deviceHost(),hmac},store=new Store();
 const atomic={get:store.get.bind(store),set:store.set.bind(store),update:async(values:Record<string,string|null>)=>{for(const [k,v] of Object.entries(values))if(v===null)store.values.delete(k);else store.values.set(k,v);}};
 const manager=new WatchCloudKeyManager(host,atomic,guard,'https://backend.invalid'),publicKey=await manager.publicKeySpki('u','w');
 const epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',c={...crypto,hmac},one=await envelope(publicKey,'u','w',1),two=await envelope(publicKey,'u','w',2),first=await commit(c,key,'u',epoch,1),second=await commit(c,key,'u',epoch,2);
 const trust={libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[{keyVersion:1,commitment:first,rotationProof:null},{keyVersion:2,commitment:second,rotationProof:await rotation(c,key,'u',epoch,2,second)}]},attestation={keyVersion:2,mac:await attest(c,key,'u',epoch,'w',publicKey)};
 expect(await manager.acceptDelivery('u','w',[two,one],trust,attestation)).toBe('ready');expect(await manager.accountKey('u',2)).toEqual(key);
 const reopened=new WatchCloudKeyManager(host,atomic,guard,'https://backend.invalid');expect(await reopened.accountKey('u')).toBeUndefined();await reopened.acceptBootstrap('u','w',[],trust,attestation);expect(await reopened.accountKey('u',1)).toEqual(key);expect(await reopened.accountKey('other')).toBeUndefined();
 await expect(reopened.acceptDelivery('other','w',[one,two],trust,attestation)).rejects.toThrow();
});

test('R4 deterministic manifest-v3 vector writes exact bytes, reads v2/v3 and binds snapshotId in HKDF',async()=>{
 const vector=(await import('./fixtures/manifest-v3.json')).default,key=new Uint8Array(Buffer.from(vector.accountKeyHex,'hex'));
 const fixed:SnapshotCrypto={...crypto,random:async()=>new Uint8Array(Buffer.from(vector.saltHex,'hex')),encrypt:async(k,aad,p)=>{const nonce=Buffer.from(vector.nonceHex,'hex'),c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(aad);return{nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([c.update(p),c.final(),c.getAuthTag()]))};}};
 const codec=new WatchCloudCodec(fixed,guard),m=vector.manifest,snapshot=await codec.create({accountKey:key,keyVersion:m.keyVersion,sourceDeviceId:m.sourceDeviceId,sequence:m.deviceSequence,snapshotId:m.snapshotId,createdAtMillis:m.createdAtMillis,objects:[],parentHeads:{},observedHeads:{}});
 expect(Buffer.from(snapshot.encryptedManifest).toString('hex')).toBe(vector.encryptedManifestHex);expect(await codec.decryptManifest(key,m.snapshotId,snapshot.encryptedManifest)).toEqual({...m,format:'watchrss-cloud-snapshot' as const,schemaVersion:2 as const});await expect(codec.decryptManifest(key,'00000000-0000-4000-8000-000000000004',snapshot.encryptedManifest)).rejects.toThrow();
});
