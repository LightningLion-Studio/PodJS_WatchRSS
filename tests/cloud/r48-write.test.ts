import {test,expect} from 'bun:test';
import {createCipheriv} from 'node:crypto';
import {canonicalIntegerJson} from '@podjs/framework/json-raw';
import {WatchCloudCodec,type CloudObject} from '../../src/cloud/codec';
import {WatchCloudClient} from '../../src/cloud/client';
import {writeWrss} from '../../src/cloud/wrss';
import {utf8Encode} from '../../src/cloud/types';
import {crypto,enabled,key} from './k2-crypto';
import wrapped from './fixtures/r48-object-key-envelope.json';
const unhex=(s:string)=>new Uint8Array(Buffer.from(s,'hex'));
const base={accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'head',createdAtMillis:1,parentHeads:{},observedHeads:{}};

test('WriteV1 authoring an archive reference verifies actual ZIP bytes, hashes and dependency',async()=>{
 const codec=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true}),body=utf8Encode('中文 HTML <p>body</p>');
 const first=await codec.create({...base,objects:[{name:'private-library.wrss',bytes:writeWrss(new Map([['bodies/a.html',body]])),compress:false}]});
 const ref={name:'ref',originalBytes:body.length,features:{incompat:['r48.entry-ref.v1'],roCompat:[]},contentSha256:await crypto.sha256(body),entryRef:{object:'private-library.wrss',entryPath:'bodies/a.html',encoding:'identity'}} as unknown as CloudObject;
 const input={...base,snapshotId:'next',sequence:2,objects:[],previous:first.manifest,carried:[ref],readPreviousChunk:async(h:string)=>first.newChunks.get(h)!};
 const next=await codec.create(input);expect(next.newChunks.size).toBe(0);expect(next.manifest.objects.find(o=>o.name==='private-library.wrss')?.chunks).toEqual(first.manifest.objects[0].chunks);expect((await codec.restore(key,next.manifest,input.readPreviousChunk,[next.manifest.objects.find(o=>o.name==='ref')!])).get('ref')).toEqual(body);
 await expect(codec.create({...input,readPreviousChunk:undefined})).rejects.toThrow('cloud_entry_ref_unverified');
 for(const bad of [{...ref,originalBytes:1},{...ref,contentSha256:'f'.repeat(64)},{...ref,entryRef:{...ref.entryRef!,entryPath:'absent'}}])await expect(codec.create({...input,carried:[bad]})).rejects.toThrow();
 const chain={...ref,name:'chain',entryRef:{...ref.entryRef!,object:'ref'}};await expect(codec.create({...input,carried:[ref,chain]})).rejects.toThrow();
});

test('WriteV1 object-key wrapping matches shared Phase B bytes, defaults closed and zeroes derived keys',async()=>{
 const salt=unhex(wrapped.saltHex),nonce=unhex(wrapped.nonceHex);let derived:Uint8Array|undefined;
 const deterministic={...crypto,random:async()=>salt.slice(),hkdf:async(k:Uint8Array,s:Uint8Array,i:Uint8Array)=>derived=await crypto.hkdf(k,s,i),encrypt:async(k:Uint8Array,a:Uint8Array,p:Uint8Array)=>{const c=createCipheriv('aes-256-gcm',k,nonce);c.setAAD(a);return {nonce:nonce.slice(),ciphertext:new Uint8Array(Buffer.concat([c.update(p),c.final(),c.getAuthTag()]))};}};
 const account=unhex(wrapped.accountKeyHex),root=unhex(wrapped.outputRootHex),planId=wrapped.envelope.scope.slice(10);
 const codec=new WatchCloudCodec(deterministic,enabled,{writeV1:()=>true,migrationV1:()=>true});
 expect(await codec.wrapObjectKey(account,root,planId)).toEqual({...wrapped.envelope,version:1 as const});expect(derived?.every(v=>v===0)).toBe(true);expect(root).toEqual(unhex(wrapped.outputRootHex));
 await expect(new WatchCloudCodec(deterministic,enabled).wrapObjectKey(account,root,planId)).rejects.toThrow('cloud_format_write_disabled');
 await expect(new WatchCloudCodec(deterministic,enabled,{writeV1:()=>true}).wrapObjectKey(account,root,planId)).rejects.toThrow('cloud_format_migration_disabled');
});

test('WriteV1 release opt-in AND fresh server authorization are required; kill switch and offline fail closed',async()=>{
 let now=1000,server=true,offline=false,requests=0;
 const http={request:async()=>{requests++;if(offline)throw Error('offline');return {status:200,headers:{},body:utf8Encode(JSON.stringify({protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:server}}))};}};
 const closed=new WatchCloudClient(http,{baseUrl:'https://fixture.test',accessToken:'synthetic'},crypto,enabled);expect(await closed.refreshR48WriteGate()).toBe(false);expect(requests).toBe(0);
 const client=new WatchCloudClient(http,{baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true,now:()=>now},crypto,enabled);
 expect(client.r48WriteEnabled).toBe(false);expect(await client.refreshR48WriteGate()).toBe(true);now+=30000;expect(client.r48WriteEnabled).toBe(false);
 expect(await client.refreshR48WriteGate()).toBe(true);server=false;expect(await client.refreshR48WriteGate()).toBe(false);server=true;await client.refreshR48WriteGate();offline=true;await expect(client.refreshR48WriteGate()).rejects.toThrow('offline');expect(client.r48WriteEnabled).toBe(false);
});

test('production JCS helper rejects rounded fractional plans rather than hashing lossy JSON',()=>{
 expect(canonicalIntegerJson('{"v":1e0,"n":-0}')).toBe('{"n":0,"v":1}');expect(()=>canonicalIntegerJson('{"budget":9007199254740991.1}')).toThrow();
});

test('reserve and complete carry R48 admission header; server-off between them preserves pending publication',async()=>{
 const calls:{url:string;headers:Record<string,string>}[]=[],server={enabled:true};
 const http={request:async(r:any)=>{calls.push(r);let body:any={};if(r.url.endsWith('/format-capabilities'))body={protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:server.enabled}};if(r.url.endsWith('/reserve'))body={snapshotId:'synthetic-head',reservedBytes:1,missingObjects:[]};return {status:200,headers:{},body:utf8Encode(JSON.stringify(body))};}};
 const client=new WatchCloudClient(http,{baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true},crypto,enabled);client.setEpoch('synthetic-epoch');client.setContentGeneration('55555555-5555-4555-8555-555555555555');
 const snapshot={manifest:{features:{incompat:['r48.private-overlay.v1'],roCompat:[]},snapshotId:'synthetic-head',sourceDeviceId:'watch',deviceSequence:1,keyVersion:1,parentHeads:{},observedHeads:{},allChunks:[]},encryptedManifest:utf8Encode('synthetic-cipher')};
 await client.reserveSnapshot(snapshot);expect(calls.find(c=>c.url.endsWith('/reserve'))?.headers['x-watchrss-r48-write-v1']).toBe('1');server.enabled=false;await expect(client.completeSnapshot('synthetic-head',[])).rejects.toThrow('cloud_format_write_disabled');expect(calls.some(c=>c.url.endsWith('/complete'))).toBe(false);
 server.enabled=true;await client.completeSnapshot('synthetic-head',[]);expect(calls.find(c=>c.url.endsWith('/complete'))?.headers['x-watchrss-r48-write-v1']).toBe('1');
});

test('late capability response cannot reopen a newer disabled gate; rollback clock also closes authorization',async()=>{
 let now=1000,release:((v:any)=>void)|undefined,requests=0;
 const response=(allow:boolean)=>({status:200,headers:{},body:utf8Encode(JSON.stringify({protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:allow}}))});
 const client=new WatchCloudClient({request:async()=>++requests===1?new Promise<any>(resolve=>release=resolve):response(false)},{baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true,now:()=>now},crypto,enabled);
 const slow=client.refreshR48WriteGate();await Promise.resolve();expect(await client.refreshR48WriteGate()).toBe(false);release!(response(true));await slow;expect(client.r48WriteEnabled).toBe(false);
 const clocked=new WatchCloudClient({request:async()=>response(true)},{baseUrl:'https://fixture.test',accessToken:'synthetic',r48WriteV1:true,now:()=>now},crypto,enabled);expect(await clocked.refreshR48WriteGate()).toBe(true);now=999;expect(clocked.r48WriteEnabled).toBe(false);
});

test('framework production JCS byte-matches independent shared R48 planHash and every JCS vector',async()=>{
 const jcs=(await import('./fixtures/r48-jcs.json')).default;
 const plan=canonicalIntegerJson(JSON.stringify(jcs.plan));expect(plan).toBe(jcs.canonicalPlanUtf8);expect(await crypto.sha256(utf8Encode('watchrss/r48/plan/v1\n'+plan))).toBe(jcs.planHash);
 for(const sample of jcs.jcsSamples)expect(canonicalIntegerJson(JSON.stringify(sample.value))).toBe(sample.canonicalUtf8);
 for(const rejected of jcs.rejectedJcsJson)expect(()=>canonicalIntegerJson(rejected)).toThrow();
});

test('WriteV1 verified unchanged migration-root bytes remain sealed; actual edit uses a fresh account root',async()=>{
 const account=unhex(wrapped.accountKeyHex),codec=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true}),o=wrapped.descriptor as unknown as CloudObject,m={format:'watchrss-cloud-snapshot' as const,schemaVersion:2 as const,snapshotId:'root',sourceDeviceId:'phone',deviceSequence:1,keyVersion:1,createdAtMillis:1,parentHeads:{},observedHeads:{},objects:[o],settings:{},credentialEnvelopes:{}};
 const salt=new Uint8Array(16),derived=await crypto.hkdf(account,salt,utf8Encode('watchrss/cloud/manifest/v2/root')),sealed=await crypto.encrypt(derived,utf8Encode('watchrss-cloud-manifest-v2:root'),utf8Encode(JSON.stringify(m)));derived.fill(0);const previous=await codec.decryptManifest(account,'root',new Uint8Array(Buffer.concat([Buffer.from('WRSSCM3'),salt,sealed.nonce,sealed.ciphertext]))),plain=unhex(wrapped.outputPlaintextHex),input={...base,accountKey:account,snapshotId:'unchanged-root',sequence:2,previous,objects:[{name:o.name,bytes:plain,compress:false}],readPreviousChunk:async()=>unhex(wrapped.outputChunkBlobHex)};
 const same=await codec.create(input);expect(same.newChunks.size).toBe(0);expect(same.manifest.objects[0].objectKeyEnvelope).toEqual({...wrapped.envelope,version:1 as const});
 const edited=await codec.create({...input,snapshotId:'edited-root',objects:[{name:o.name,bytes:utf8Encode('edited new bytes'),compress:false}]});expect(edited.newChunks.size).toBe(1);expect(edited.manifest.objects[0].objectKeyEnvelope).toBeUndefined();expect((await codec.restore(account,edited.manifest,async h=>edited.newChunks.get(h)!)).get(o.name)).toEqual(utf8Encode('edited new bytes'));
});
