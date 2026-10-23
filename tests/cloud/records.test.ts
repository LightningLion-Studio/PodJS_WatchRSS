import {test,expect} from 'bun:test';
import {createHmac,createCipheriv} from 'node:crypto';
import vectors from './fixtures/records-v1.json';
import {crypto,key} from './k2-crypto';
import {CloudRecordCodec,WatchCloudRecords,revision,validateRecord,type RecordDocument,type RecordPorts,type RecordRow} from '../../src/cloud/records';
import {rssSourceKey,rssArticleId} from '../../src/cloud/rss-identity';
import {utf8Encode} from '../../src/cloud/types';
const c={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
test('unavailable or paused host crypto stops at the first record without ACK, and a repaired host can retry',async()=>{for(const code of ['cloud_host_capability_unavailable','cloud_sync_suspended']){
 const f=env();for(let i=0;i<3;i++)await f.put(doc('host-repair-'+i));const original=f.ports.crypto;let attempts=0;
 f.ports.crypto={...original,decrypt:async()=>{attempts++;throw Error(code);}};
 await expect(f.records().pull()).rejects.toThrow(code);expect(attempts).toBe(1);expect(f.applied).toHaveLength(0);expect(f.state()).toBeUndefined();
 f.ports.crypto=original;expect(await f.records().pull()).toBe(3);expect(f.state().cursor).toBe('3');
}});
const codec=new CloudRecordCodec(c),epoch='epoch-fixture';
const doc=(id:string):RecordDocument=>({kind:'article',value:{articleId:id,url:'https://private.example/'+id,title:id,updatedAt:1,deleted:false}});
function env(){
 let stored:string|undefined,head=0,current=true,failApply=false,failPush='',exported:RecordDocument[]=[],missing=false;
 const rows=new Map<string,RecordRow>(),applied:RecordDocument[]=[],posts:any[]=[];
 const ports:RecordPorts={userId:'user',epoch,anchorVersion:1,version:1,crypto:c,key:async()=>missing?undefined:key.slice(),readState:async()=>stored,writeState:async v=>{stored=v;},current:async()=>{if(!current)throw Error('账号已变更');},assertUpload:async()=>{},apply:async docs=>{if(failApply)throw Error('db failure');applied.push(...docs);return docs.length;},export:async()=>exported,
  get:async after=>{const items=[...rows.values()].filter(r=>Number(r.revision)>Number(after)).sort((a,b)=>Number(a.revision)-Number(b.revision)).slice(0,50);return {libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items,cursor:items.at(-1)?.revision??String(head),headRevision:String(head),hasMore:items.length===50&&Number(items.at(-1)!.revision)<head};},
  push:async items=>{if(failPush)throw Error(failPush);posts.push(...items);if(items.some(r=>r.expectedRevision!==(rows.get(r.recordId)?.revision??'0')))throw Error('cloud_record_conflict');return {formatVersion:1,items:items.map(r=>{const revision=String(++head);rows.set(r.recordId,{recordId:r.recordId,revision,envelope:r.envelope,tombstone:r.tombstone});return {recordId:r.recordId,revision};})};},
 };
 const records=()=>new WatchCloudRecords(ports);
 return {ports,rows,applied,posts,records,state:()=>stored?JSON.parse(stored):undefined,export:(docs:RecordDocument[])=>{exported=docs;},failApply:(v:boolean)=>{failApply=v;},failPush:(v:string)=>{failPush=v;},missing:(v:boolean)=>{missing=v;},invalidate:()=>{current=false;},async put(d:RecordDocument,options:{bad?:boolean;tombstone?:boolean;contentKey?:Uint8Array;version?:number;anchor?:Uint8Array}={}){const k=options.contentKey??key,id=await codec.id(options.anchor??k,'user',d),envelope=await codec.encode(k,'user',id,options.version??1,d);if(options.bad)envelope.ciphertextBase64=Buffer.alloc(32).toString('base64');const row={recordId:id,revision:String(++head),envelope,tombstone:options.tombstone??false};rows.set(id,row);return row;}};
}
test('R41 uncomputable legacy index identity skips only that retirement while healthy records commit',async()=>{
 const f=env(),bad=await f.put({kind:'article',value:{...doc('bad-identity').value,rssSourceUrl:'https://feed.example/rss',guid:'identity-hash-fault'}}),good=await f.put({kind:'article',value:{...doc('healthy-old-index').value,rssSourceUrl:'https://feed.example/rss'}});
 const sha=f.ports.crypto.sha256;f.ports.crypto={...f.ports.crypto,sha256:async bytes=>{if(new TextDecoder().decode(bytes)==='identity-hash-fault')throw Error('entry hash fault');return sha(bytes);}};
 f.export([doc('healthy-private')]);const records=f.records();await records.pull();expect(await records.flush()).toBe(2);expect(f.rows.get(bad.recordId)!.tombstone).toBe(false);expect(f.rows.get(good.recordId)!.tombstone).toBe(true);
});
test('cross-client JSON vectors bind anchor IDs, HKDF, canonical plaintext, nonce and AAD for article/source/rss-state',async()=>{
 const vectorKey=new Uint8Array(Buffer.from(vectors.keyBase64,'base64')),nonce=Buffer.from(vectors.nonceBase64,'base64');
 const fixed=new CloudRecordCodec({...c,encrypt:async(k,a,b)=>{const cipher=createCipheriv('aes-256-gcm',k,nonce);cipher.setAAD(a);return {nonce:new Uint8Array(nonce),ciphertext:new Uint8Array(Buffer.concat([cipher.update(b),cipher.final(),cipher.getAuthTag()]))};}});
 for(const v of vectors.vectors){const d={kind:v.doc.kind,value:v.doc.value} as RecordDocument;expect(await fixed.id(vectorKey,vectors.userId,d)).toBe(v.recordId);const decoded=await fixed.decode(vectorKey,vectorKey,vectors.userId,{recordId:v.recordId,envelope:v.envelope as any,revision:'1',tombstone:false});expect(decoded.doc).toEqual(d);expect(await fixed.encode(vectorKey,vectors.userId,v.recordId,3,d)).toEqual(v.envelope as any);}
});
test('no body or RSS index metadata can enter interaction records; 64-bit revision strings stay exact',()=>{
 expect(revision('9223372036854775807')).toBe('9223372036854775807');for(const v of ['9223372036854775808','01','-1','1e3'])expect(()=>revision(v)).toThrow();
 expect(()=>validateRecord({kind:'article',value:{articleId:'a',contentText:'secret'}})).toThrow();expect(()=>validateRecord({kind:'rss-state',value:{sourceId:'pool',articleIdHash:'a'.repeat(64),title:'index'}})).toThrow();
});
test('healthy rows commit beyond corrupt rows; original ciphertext replays after a key/cipher repair; failed merge never advances cursor',async()=>{
 const f=env(),bad=await f.put(doc('bad'),{bad:true});await f.put(doc('healthy'));let r=f.records();expect(await r.pull()).toBe(1);expect(f.state().cursor).toBe('2');expect(f.state().rows[bad.recordId]).toEqual(bad);expect(f.applied.map(d=>d.value.articleId)).toEqual(['healthy']);
 await f.put(doc('bad'));await f.put(doc('next'));r=f.records();await r.pull();expect(f.applied.some(d=>d.value.articleId==='bad')).toBe(true);
 const g=env();await g.put(doc('rollback'));g.failApply(true);await expect(g.records().pull()).rejects.toThrow('db failure');expect(g.state()).toBeUndefined();g.failApply(false);await g.records().pull();expect(g.state().cursor).toBe('1');
});
test('stable mergeable-field hashes suppress provenance echoes, persist per-batch ACKs, CAS errors and quota failures do not acknowledge pending writes',async()=>{
 const f=env(),d=doc('a');f.export([d]);let r=f.records();await r.pull();expect(await r.flush()).toBe(1);expect(f.state().cursor).toBe('0');f.export([{...d,value:{...d.value,sourceDeviceId:'another'}}]);expect(await r.flush()).toBe(0);
 f.export([{...d,value:{...d.value,updatedAt:2}}]);f.failPush('cloud_quota_exceeded');await expect(r.flush()).rejects.toThrow('cloud_quota_exceeded');expect(f.state().records[f.posts[0].recordId].revision).toBe('1');f.failPush('cloud_record_conflict');await expect(r.flush()).rejects.toThrow('cloud_record_conflict');f.failPush('');r=f.records();await r.pull();expect(await r.flush()).toBe(1);
});
test('S8 old public index becomes encrypted entity tombstone after new keyed interaction commits; no cached article deletion projection',async()=>{
 const f=env(),a={kind:'article',value:{...doc('old').value,rssSourceUrl:'https://feed.example/rss',isRead:true,readingPositionChangedAt:4}};const old=await f.put({...a,value:{...a.value,excerpt:'old index summary '.repeat(100)}});
 const source={kind:'source',value:{url:'https://feed.example/rss',sourceId:'pool',title:'User',updatedAt:1}},state={kind:'rss-state',value:{sourceId:await rssSourceKey('https://feed.example/rss',crypto.sha256),articleIdHash:await crypto.sha256(utf8Encode(await rssArticleId('https://private.example/old',crypto.sha256))),isRead:true,readingPositionChangedAt:4}};
 f.export([source,state]);const r=f.records();await r.pull();await r.flush();expect(f.posts.at(-1).recordId).toBe(old.recordId);expect(f.posts.at(-1).tombstone).toBe(true);const retired=await codec.decode(key,key,'user',{...f.posts.at(-1),revision:'4'});expect(retired.doc.value.deleted).toBe(true);expect(f.posts.at(-1).envelope.ciphertextBase64.length).toBeLessThan(old.envelope.ciphertextBase64.length);expect('excerpt'in retired.doc.value).toBe(false);expect(f.posts.findIndex(v=>v.recordId!==old.recordId)).toBeLessThan(f.posts.findIndex(v=>v.recordId===old.recordId));
});
test('R3 rotated legacy alias retires without deleting its live entity, and retired alias is never projected',async()=>{
 const f=env(),newKey=new Uint8Array(32).fill(42),d=doc('rotated'),old=await f.put(d,{contentKey:newKey,version:2});f.ports.version=2;f.ports.key=async version=>(version===1?key:newKey).slice();f.export([d]);let r=f.records();await r.pull();await r.flush();expect(f.posts).toHaveLength(2);expect(f.posts[1]).toMatchObject({recordId:old.recordId,tombstone:true,envelope:old.envelope});
 f.applied.length=0;r=f.records();await r.pull();expect(f.applied.every(v=>!v.value.deleted)).toBe(true);expect(f.applied).toHaveLength(0);
});
test('unknown authenticated kinds survive replay; epoch mismatch, account switch and malformed pagination cannot advance cursors',async()=>{
 const f=env();const future={kind:'future-kind',value:{opaque:'future'}};await f.put(future);await f.records().pull();expect(f.applied).toEqual([]);expect(Object.keys(f.state().rows)).toHaveLength(1);
 for(const mode of ['epoch','pagination','account']){const g=env();await g.put(doc('a'));const get=g.ports.get;g.ports.get=async after=>{const page=await get(after);if(mode==='epoch')page.libraryEpoch='new';if(mode==='pagination')page.hasMore=true;if(mode==='account')g.invalidate();return page;};await expect(g.records().pull()).rejects.toThrow();expect(g.state()).toBeUndefined();}
});
test('missing content version refreshes verified bootstrap once then replays; corrupt projection restarts at cursor zero',async()=>{
 const f=env();await f.put(doc('a'));let calls=0,missing=true;f.ports.key=async version=>version===1&&missing&&calls>0?undefined:key.slice();
 // First key request is the anchor, following requests are row content keys.
 const original=f.ports.key;let keys=0;f.ports.key=async v=>++keys===1?key.slice():missing?undefined:original(v);
 f.ports.refreshKeys=async()=>{calls++;missing=false;};await f.records().pull();expect(calls).toBe(1);expect(f.applied.map(d=>d.value.articleId)).toEqual(['a']);
 const afters:string[]=[];const get=f.ports.get;f.ports.get=async after=>{afters.push(after);return get(after);};f.ports.readState=async()=>'{"epoch":"epoch-fixture","cursor":"9","records":{"invalid":{}},"rows":{}}';await f.records().pull();expect(afters[0]).toBe('0');
});
test('R34 saved legacy indexes wait for server-completed originals; clock-only interactions commit before batched tombstones',async()=>{
 const f=env(),sourceUrl='https://feed.example/rss',sourceId=await rssSourceKey(sourceUrl,crypto.sha256),ids:string[]=[],states:RecordDocument[]=[],oldRows:RecordRow[]=[];let requests=0;const push=f.ports.push;f.ports.push=async items=>{requests++;expect(items.length).toBeLessThanOrEqual(50);return push(items);};
 for(let i=0;i<61;i++){const id='saved-'+i;ids.push(id);oldRows.push(await f.put({kind:'article',value:{...doc(id).value,rssSourceUrl:sourceUrl,isRead:false,readingPositionChangedAt:0,favoriteSaved:true,favoriteChangedAt:40,watchLaterSaved:false,watchLaterChangedAt:50}}));states.push({kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(await rssArticleId('https://private.example/'+id,crypto.sha256))),isRead:false,readingPositionChangedAt:0,favoriteSaved:true,favoriteChangedAt:40,watchLaterSaved:false,watchLaterChangedAt:50}});}
 f.export(states);let r=f.records();await r.pull();await r.flush();expect(oldRows.every(row=>!f.rows.get(row.recordId)!.tombstone)).toBe(true);expect(requests).toBe(2);
 requests=0;await r.flush(ids);expect(requests).toBe(2);for(const row of oldRows){const deleted=f.rows.get(row.recordId)!;expect(deleted.tombstone).toBe(true);expect((await codec.decode(key,key,'user',deleted)).doc.value.deletedAt).toBeGreaterThan(50);}
});
test('old unsaved indexes with favorite/watchLater-only clocks cannot retire before those exact state clocks commit',async()=>{
 const f=env(),sourceId=await rssSourceKey('https://feed.example/rss',crypto.sha256),old=await f.put({kind:'article',value:{...doc('cancelled').value,rssSourceUrl:'https://feed.example/rss',isRead:false,favoriteSaved:false,favoriteChangedAt:70,watchLaterSaved:false,watchLaterChangedAt:90}}),state={kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(await rssArticleId('https://private.example/cancelled',crypto.sha256))),favoriteSaved:false,favoriteChangedAt:70,watchLaterSaved:false,watchLaterChangedAt:80}};
 f.export([state]);const r=f.records();await r.pull();await r.flush();expect(f.rows.get(old.recordId)!.tombstone).toBe(false);state.value.watchLaterChangedAt=90;await r.flush();expect(f.rows.get(old.recordId)!.tombstone).toBe(true);
});
test('R34 newer saved interaction also protects an old index whose stale flags were unsaved until original completes',async()=>{
 const f=env(),url='https://feed.example/rss',sourceId=await rssSourceKey(url,crypto.sha256),old=await f.put({kind:'article',value:{...doc('newly-saved').value,rssSourceUrl:url,favoriteSaved:false,favoriteChangedAt:10}});f.export([{kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(await rssArticleId('https://private.example/newly-saved',crypto.sha256))),favoriteSaved:true,favoriteChangedAt:20}}]);const r=f.records();await r.pull();await r.flush();expect(f.rows.get(old.recordId)!.tombstone).toBe(false);await r.flush(['newly-saved']);expect(f.rows.get(old.recordId)!.tombstone).toBe(true);
});
test('R36 local-only legacy RSS index cannot block healthy record writes or leak new interaction rows',async()=>{
 const f=env();await f.put({kind:'article',value:{...doc('local').value,rssSourceUrl:'http://192.168.1.10/rss',isRead:true,readingPositionChangedAt:8}});f.export([doc('healthy')]);const r=f.records();await r.pull();expect(await r.flush()).toBe(1);expect(f.posts).toHaveLength(1);
});
test('R39 unread EPUB/TXT imported sources are private article records and never public-index tombstones',async()=>{
 for(const rssSourceUrl of ['https://watchrss.local/import-content','https://watchrss.local/import-epub/book','https://watchrss.local/import-txt-novel/book']){const f=env(),d={kind:'article',value:{...doc('import').value,rssSourceUrl,independentSaved:true,independentChangedAt:1,isRead:false,readingPositionChangedAt:0}};const old=await f.put(d);f.export([d]);const r=f.records();await r.pull();await r.flush();expect(f.rows.get(old.recordId)!.tombstone).toBe(false);expect(f.posts).toHaveLength(0);}
});
test('R44 old chapter retirement requires exact current book/reading ACK and completed package, marker never becomes an entity deletion',async()=>{const vectors=(await import('../fixtures/book-fingerprint.json')).default,v=vectors.cases[0]!,f=env(),book:RecordDocument={kind:'book',value:{bookId:v.bookId,fingerprint:v.fingerprint,title:'Book',chapterCount:2,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:100,sourceDeviceId:'watch'}},reading:RecordDocument={kind:'book-reading',value:{bookId:v.bookId,chapterIndex:1,isRead:true,readingProgress:.5,readingPositionBytes:42,readingPositionContentHash:'p',readingPositionChangedAt:30,sourceDeviceId:'watch'}};const old=await f.put({kind:'article',value:{...doc('legacy-book-chapter').value,url:'https://watchrss.local/import-epub/x/chapter/1',readingPositionChangedAt:30,isRead:true}});f.ports.bookReplacement=async d=>d.kind==='article'?{book,reading}:undefined;f.export([book]);const records=f.records();await records.pull();await records.flush([],[v.bookId]);expect(f.rows.get(old.recordId)?.tombstone).toBe(false);f.export([book,reading]);await records.flush();expect(f.rows.get(old.recordId)?.tombstone).toBe(false);const changed={...reading,value:{...reading.value,readingPositionChangedAt:40}};f.ports.bookReplacement=async()=>({book,reading:changed});await records.flush([],[v.bookId]);expect(f.rows.get(old.recordId)?.tombstone).toBe(false);f.export([book,changed]);await records.flush([],[v.bookId]);expect(f.rows.get(old.recordId)?.tombstone).toBe(true);const decoded=await codec.decode(key,key,'user',f.rows.get(old.recordId)!);expect(decoded.doc.value.bookIndexRetired).toBe(true);expect(decoded.doc.value.deletedAt).toBe(31);f.applied.length=0;await f.records().pull();expect(f.applied.some(d=>d.value.bookIndexRetired)).toBe(false);});

test('applied tombstones retain CAS metadata without retaining ciphertext or decrypting the same revision again',async()=>{
 const f=env();for(let i=0;i<256;i++)await f.put({kind:'article',value:{articleId:'retired-'+i,url:'https://feed.example/'+i,deleted:true,deletedAt:1}},{tombstone:true});
 let decrypts=0;const decrypt=f.ports.crypto.decrypt;f.ports.crypto={...f.ports.crypto,decrypt:async(...args)=>{decrypts++;return decrypt(...args);}};
 await f.records().pull();expect(decrypts).toBe(256);expect(f.applied).toHaveLength(256);expect(Object.keys(f.state().rows)).toHaveLength(0);expect(Object.keys(f.state().records)).toHaveLength(256);expect(f.state().cursor).toBe('256');
 f.applied.length=0;await f.records().pull();expect(decrypts).toBe(256);expect(f.applied).toHaveLength(0);
 // A newly issued deletion revision still authenticates and applies once.
 const changed=await f.put({kind:'article',value:{articleId:'retired-0',url:'https://feed.example/0',deleted:true,deletedAt:2}},{tombstone:true});await f.records().pull();expect(decrypts).toBe(257);expect(f.state().records[changed.recordId].revision).toBe('257');
});
test('a suspended key read is control flow, never swallowed as a quarantined bad row',async()=>{
 const f=env();await f.put(doc('not-poisoned'));let calls=0;f.ports.key=async()=>{if(++calls>1)throw Error('cloud_sync_suspended');return key.slice();};
 await expect(f.records().pull()).rejects.toThrow('cloud_sync_suspended');expect(f.state()).toBeUndefined();expect(f.applied).toHaveLength(0);
});

test('large retained replay merges at most fifty at a time and persists completed compaction before suspension',async()=>{
 const f=env();for(let i=0;i<151;i++)await f.put({kind:'article',value:{articleId:'replay-'+i,url:'https://feed.example/'+i,deleted:true,deletedAt:1}},{tombstone:true,bad:true});
 await f.records().pull(); // Retain invalid ciphertext rather than losing a quarantined row.
 const cached=f.state();for(const [id,row]of f.rows){const d={kind:'article',value:{articleId:'replay-'+(Number(row.revision)-1),url:'https://feed.example/'+(Number(row.revision)-1),deleted:true,deletedAt:1}};cached.rows[id].envelope=await codec.encode(key,'user',id,1,d);}
 f.ports.readState=async()=>JSON.stringify(cached);let checkpoints=0,maxBatch=0,merges=0,suspended=false;
 f.ports.current=async()=>{if(suspended)throw Error('cloud_sync_suspended');};
 f.ports.apply=async docs=>{maxBatch=Math.max(maxBatch,docs.length);merges++;if(merges===2)suspended=true;return docs.length;};
 f.ports.checkpoint=async value=>{checkpoints++;const stored=JSON.parse(value);expect(stored.cursor).toBe('151');expect(Object.keys(stored.rows)).toHaveLength(101);};
 await expect(f.records().pull()).rejects.toThrow('cloud_sync_suspended');expect(maxBatch).toBe(50);expect(checkpoints).toBe(1);
});

test('an old-version cache of acknowledged tombstones compacts without any cryptographic or per-entry account IO',async()=>{
 const f=env();for(let i=0;i<256;i++)await f.put({kind:'article',value:{articleId:'old-cache-'+i,url:'https://feed.example/'+i,deleted:true,deletedAt:1}},{tombstone:true});
 await f.records().pull();const old=f.state();old.rows=Object.fromEntries(f.rows);f.ports.readState=async()=>JSON.stringify(old);
 f.ports.crypto={...f.ports.crypto,decrypt:async()=>{throw Error('old acknowledged tombstone must not decrypt');}};
 let reads=0;f.ports.current=async()=>{reads++;};await f.records().pull();expect(Object.keys(f.state().rows)).toHaveLength(0);expect(Object.keys(f.state().records)).toHaveLength(256);expect(reads).toBeLessThan(30);
});

test('pull reports actual decrypt attempts and diagnostic failures cannot alter synchronization',async()=>{
 const f=env(),metrics:any[]=[];await f.put(doc('metric'));f.ports.report=m=>metrics.push(m);await f.records().pull();
 expect(metrics).toHaveLength(1);expect(metrics[0]).toMatchObject({decryptions:1,retired:0,outcome:'complete'});expect(metrics[0].elapsedMillis).toBeGreaterThanOrEqual(0);
 expect(Object.keys(metrics[0]).sort()).toEqual(['decryptions','elapsedMillis','outcome','retired']);
 f.ports.report=()=>{throw Error('diagnostic sink failed');};await expect(f.records().pull()).resolves.toBeGreaterThanOrEqual(0);
});

test('metrics prove acknowledged tombstones skip decrypt while a new row still authenticates',async()=>{
 const f=env(),row=await f.put({kind:'article',value:{...doc('retired-metric').value,deleted:true,deletedAt:2}},{tombstone:true});await f.records().pull();const metrics:any[]=[];f.ports.report=m=>metrics.push(m);
 const cached=f.state()!;cached.rows[row.recordId]=row;f.ports.readState=async()=>JSON.stringify(cached);
 await f.records().pull();expect(metrics[0]).toMatchObject({decryptions:0,retired:1,outcome:'complete'});
});
