import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {CloudRecordCodec,WatchCloudRecords,type RecordPorts,type RecordRow} from '../../src/cloud/records';
import {WatchCloudClient,CloudRequestError} from '../../src/cloud/client';
import {cloudCompatibility,cloudRaw} from '../../src/cloud/compatibility';
import {ARTICLE_REGISTER_FEATURE,articleKnownCanonical} from '../../src/cloud/article-register';
import {utf8Encode} from '../../src/cloud/types';
import {dbFixture} from './library-fixture';
import {fixture} from './service-fixture';
import {crypto,key,enabled} from './k2-crypto';
import vectors from './fixtures/article-provenance-v1/vectors.json';
const c={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')},codec=new CloudRecordCodec(c);
async function row(raw:string,revision='1',version=1):Promise<RecordRow>{
 const value=vectors.mergeCases[0]!.inputs[0]!,id=await codec.id(key,'user',{kind:'article',value:value.value,features:value.features}),derived=await crypto.hkdf(key,utf8Encode('user'),utf8Encode('watchrss/cloud/record/v1'));
 try{const e=await crypto.encrypt(derived,utf8Encode(`watchrss-cloud-record-v1:user:${id}:${version}`),utf8Encode(raw));return {recordId:id,revision,tombstone:false,envelope:{algorithm:'A256GCM',keyVersion:version,nonceBase64:Buffer.from(e.nonce).toString('base64'),ciphertextBase64:Buffer.from(e.ciphertext).toString('base64')}};}finally{derived.fill(0);}
}
test('production adapter and SQLite repository merge provenance without old RSS conversion or a legacy writer',async()=>{
 const f=await dbFixture();try{
  const v=vectors.mergeCases.find(v=>v.id==='favorite-associativity-visible')!;
  for(const d of v.inputs)await f.adapter.applyRecords([codec.readPlaintext(JSON.stringify(d))]);
  const docs=await f.adapter.exportRecords(),a=docs.find(d=>d.kind==='article'&&d.value.articleId===v.expected.record.value.articleId)!;
  expect(articleKnownCanonical(a)).toBe(v.expected.canonicalUtf8);expect(cloudCompatibility(a).readOnly).toBe(true);expect(docs.filter(d=>d.kind==='rss-state')).toHaveLength(0);
  const state=f.sql.query('SELECT state_json FROM article_register_state').get() as any;
  const {registerSources,...oldValue}=a.value;await f.adapter.applyRecords([{kind:'article',value:{...oldValue,title:'old metadata-only',updatedAt:999999,isRead:false,readingPositionChangedAt:0}}]);
  expect((f.sql.query('SELECT state_json FROM article_register_state').get() as any).state_json).toBe(state.state_json);
  await f.repo.clearLibrary();expect(await f.repo.cloudArticleRegisters()).toHaveLength(0);
 }finally{f.sql.close();}
});
test('real records -> adapter -> SQL -> export holds read-only edits, exact ciphertext and upgrade status through repeated runs',async()=>{
 const db=await dbFixture(),f=await fixture();let state:string|undefined;
 try{
  const original=await row(JSON.stringify(vectors.mergeCases[0]!.inputs[0]!));f.seedRecords(new Map([[original.recordId,original]]));
  const p:RecordPorts={userId:'user',epoch:'9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',anchorVersion:1,version:1,crypto:c,key:async()=>key.slice(),readState:async()=>state,writeState:async s=>{state=s;},current:async()=>{},assertUpload:async()=>{},get:after=>f.client.records(after,'watch'),push:items=>f.client.pushRecords(items),apply:docs=>db.adapter.applyRecords(docs),export:()=>db.adapter.exportRecords()};
  f.session.library=db.adapter;f.session.records=async()=>new WatchCloudRecords(p);
  expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.formatCompatibility?.readOnly).toBe(1);expect(f.service.status.formatCompatibility?.upgradeRequired).toBe(true);expect(f.service.status.retryable).toBe(false);expect(f.reservations.size).toBe(0);
  db.sql.exec("UPDATE articles SET title='held local edit'");
  expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.formatCompatibility?.editPending).toBeGreaterThan(0);
  expect((db.sql.query('SELECT title FROM articles').get() as any).title).toBe('held local edit');expect(JSON.parse(state!).rows[original.recordId]).toEqual(original);
  const pending=JSON.parse(state!).pendingEdits;expect(pending[original.recordId]).toBe(true);
  await f.service.syncNow(true);expect(JSON.parse(state!).pendingEdits).toEqual(pending);expect(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/records')).flatMap(c=>JSON.parse(Buffer.from(c.body!).toString()).items).some((i:any)=>i.recordId===original.recordId)).toBe(false);
 }finally{db.sql.close();}
});
test('unknown roCompat article versions retain authenticated ciphertexts and raw conflicts across cache restart',async()=>{
 const f=await dbFixture();let state:string|undefined,current:RecordRow|undefined;
 try{
  const base=JSON.stringify(vectors.mergeCases[0]!.inputs[0]!).replace('"value":{','"value":{"future": {"n":9007199254740993},').replace('"roCompat":[','"roCompat":["future.readonly",');
  const a=await row(base),b=await row(base.replace('9007199254740993','9007199254740994'),'2');current=a;
  const p:RecordPorts={userId:'user',epoch:'e',anchorVersion:1,version:1,crypto:c,key:async()=>key.slice(),readState:async()=>state,writeState:async s=>{state=s;},current:async()=>{},assertUpload:async()=>{},get:async after=>({libraryEpoch:'e',keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:after===current!.revision?[]:[current!],cursor:current!.revision,headRevision:current!.revision,hasMore:false}),push:async()=>{throw Error('unreachable writer');},apply:docs=>f.adapter.applyRecords(docs),export:async()=>(await f.adapter.exportRecords()).filter(d=>d.kind==='article')};
  await new WatchCloudRecords(p).pull();current=b;let records=new WatchCloudRecords(p);await records.pull();await records.flush();records=new WatchCloudRecords(p);await records.pull();
  expect(JSON.parse(state!).protectedVersions[a.recordId]).toEqual([a,b]);expect(JSON.parse(state!).rows[a.recordId]).toEqual(b);expect((await f.repo.cloudArticleRegisters())[0]!.pendingEdit).toBe(true);expect(f.sql.query('SELECT raw_json FROM article_register_conflicts').all()).toHaveLength(2);
  expect(cloudRaw((await codec.decode(key,key,'user',b)).doc)?.source).toBe(base.replace('9007199254740993','9007199254740994'));
 }finally{f.sql.close();}
});
test('requiredFeatures freezes this reader writer while reads and durable-consumption ACK remain usable; scope reset is authoritative',async()=>{
 const epoch='e',generation='55555555-5555-4555-8555-555555555555',calls:any[]=[];let features=[ARTICLE_REGISTER_FEATURE],nextEpoch=epoch;
 const client=new WatchCloudClient({request:async r=>{calls.push(r);return {status:200,headers:{},body:utf8Encode(JSON.stringify({libraryEpoch:nextEpoch,contentGeneration:generation,contentClearedAt:null,contentEmpty:false,requiredFeatures:features,member:{},devices:[],keyEnvelopes:[],heads:[],formatVersion:1,items:[],cursor:'0',headRevision:'0',hasMore:false}))};}},{baseUrl:'https://fixture.invalid',accessToken:'synthetic'},crypto,enabled);
 client.setEpoch(epoch);client.setContentGeneration(generation);await client.bootstrap();expect(client.requiredFeatures).toEqual(features);
 await expect(client.pushRecords([])).rejects.toMatchObject({status:426,code:'cloud_format_upgrade_required'});
 await client.records('0','watch');await client.snapshotHeads();await client.acknowledge('head','watch');
 expect(calls.filter(r=>r.method==='POST'&&r.url.endsWith('/records'))).toHaveLength(0);expect(calls.every(r=>!r.headers['x-watchrss-r48-features'])).toBe(true);
 features=[];await client.bootstrap();expect(client.requiredFeatures).toEqual([ARTICLE_REGISTER_FEATURE]);nextEpoch='new-epoch';await client.bootstrap();expect(client.requiredFeatures).toEqual([]);
});
test('426 records rejection persists pending without a fake ACK, and the service exposes the existing upgrade hook',async()=>{
 let state:string|undefined;const original={kind:'article',value:{articleId:'local',url:'https://private.example/local',updatedAt:1}};
 const p:RecordPorts={userId:'user',epoch:'e',anchorVersion:1,version:1,crypto:c,key:async()=>key.slice(),readState:async()=>state,writeState:async s=>{state=s;},current:async()=>{},assertUpload:async()=>{},get:async()=>({libraryEpoch:'e',keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:[],cursor:'0',headRevision:'0',hasMore:false}),push:async()=>{throw new CloudRequestError(426,'cloud_format_upgrade_required');},apply:async()=>0,export:async()=>[original]};
 const records=new WatchCloudRecords(p);await records.pull();await expect(records.flush()).rejects.toMatchObject({status:426});expect(Object.keys(JSON.parse(state!).pendingEdits)).toHaveLength(1);expect(JSON.parse(state!).records).toEqual({});
 const f=await fixture();f.session.records=async()=>({pull:async()=>{throw new CloudRequestError(426,'cloud_format_upgrade_required');}} as any);
 expect(await f.service.syncNow()).toBe(false);expect(f.service.status.errorCode).toBe('cloud_format_upgrade_required');expect(f.service.status.message).toBe('请升级到最新版本以继续同步');expect(f.service.status.retryable).toBe(false);
});
test('an authenticated requiredFeatures floor immediately exposes upgrade state without trying a snapshot write',async()=>{
 const f=await fixture(),request=f.transport.request;
 f.transport.request=async q=>{const r=await request(q);if(!q.url.endsWith('/bootstrap'))return r;return {...r,body:utf8Encode(JSON.stringify({...JSON.parse(Buffer.from(r.body).toString()),requiredFeatures:[ARTICLE_REGISTER_FEATURE]}))};};
 expect(await f.service.syncNow(true)).toBe(false);expect(f.reservations.size).toBe(0);expect(f.service.status.errorCode).toBe('cloud_format_upgrade_required');expect(f.service.status.formatCompatibility?.requiredFeatures).toEqual([ARTICLE_REGISTER_FEATURE]);expect(f.service.status.formatCompatibility?.upgradeRequired).toBe(true);expect(f.service.status.retryable).toBe(false);
});
test('a temporarily unavailable old content key cannot remove the already accepted read-only protection',async()=>{
 const f=await dbFixture();let state:string|undefined,missing=false;
 try{
  const original=await row(JSON.stringify(vectors.mergeCases[0]!.inputs[0]!),'1',2);
  const p:RecordPorts={userId:'user',epoch:'e',anchorVersion:1,version:1,crypto:c,key:async version=>missing&&version===2?undefined:key.slice(),readState:async()=>state,writeState:async s=>{state=s;},current:async()=>{},assertUpload:async()=>{},get:async after=>({libraryEpoch:'e',keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:after==='0'?[original]:[],cursor:'1',headRevision:'1',hasMore:false}),push:async()=>{throw Error('protected writer');},apply:docs=>f.adapter.applyRecords(docs),export:async()=>(await f.adapter.exportRecords()).filter(d=>d.kind==='article')};
  await new WatchCloudRecords(p).pull();missing=true;const read=new WatchCloudRecords(p);await read.pull();await read.flush();
  expect(read.compatibility.readOnly).toBe(1);expect(read.compatibility.upgradeRequired).toBe(true);expect(JSON.parse(state!).rows[original.recordId]).toEqual(original);expect((await f.repo.cloudArticleRegisters())[0]!.value.articleId).toBe(vectors.mergeCases[0]!.inputs[0]!.value.articleId);
 }finally{f.sql.close();}
});
