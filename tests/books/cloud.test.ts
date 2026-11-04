import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import vectors from '../fixtures/book-fingerprint.json';
import cliSingle from '../fixtures/cli-single-txt-book.json';
import {bookFixture,seedChapters} from './fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {CloudRecordCodec,canonical} from '../../src/cloud/records';
import {crypto,key} from '../cloud/k2-crypto';
import {writeWrss} from '../../src/cloud/wrss';
import {utf8Encode} from '../../src/cloud/types';
const v=vectors.cases[0]!,source='https://watchrss.local/import-epub/test';
const guard={require(){}};
const c={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
const state={bookId:v.bookId,fingerprint:v.fingerprint,title:'Book',chapterCount:2,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:100,sourceDeviceId:'phone',sourceUrl:source,kind:'epub'};
function repo(f:Awaited<ReturnType<typeof bookFixture>>){return new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});}
function adapter(r:ReturnType<typeof repo>){return new WatchCloudLibraryAdapter(r,'watch',{...crypto,stableId:async url=>crypto.sha256(utf8Encode(url))},guard);}
test('CLI single-file cloud book record and direct object complete the real SQL reader without duplicate chapters',async()=>{
 const f=await bookFixture();try{
  const a=adapter(repo(f)),book={...state,bookId:cliSingle.bookId,fingerprint:cliSingle.fingerprint,chapterCount:1,sourceUrl:cliSingle.sourceUrl,kind:'txt'};
  await a.applyRecords([{kind:'book',value:book}]);
  const name='books/'+book.bookId+'.jsonl',bytes=utf8Encode(cliSingle.packageUtf8);
  const descriptor={name,encoding:'identity' as const,originalBytes:bytes.length,encodedBytes:bytes.length,chunks:[],privateBook:{bookId:book.bookId,fingerprint:book.fingerprint,title:book.title,chapterCount:1,sourceUrl:book.sourceUrl,kind:book.kind,packagePath:name}};
  const payload=new Map([[name,bytes]]),first=await a.restorePayloads(payload,'cli',[descriptor]);
  expect(first.pending).toBe(0);expect(first.abandoned).toBe(0);expect(first.changed).toBeGreaterThan(0);
  expect(await f.db.query('SELECT content FROM articles')).toEqual([{content:cliSingle.chapter.contentText}]);
  expect(await f.db.query('SELECT registration_complete FROM sync_books')).toEqual([{registration_complete:1}]);
  expect((await a.restorePayloads(payload,'cli',[descriptor])).changed).toBe(0);
  expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);
 }finally{f.sql.close();}
});
test('R44 cloud book HMAC/hash retain provenance, validate identity and never accept retired indexes as user deletions',async()=>{
 const codec=new CloudRecordCodec(c),doc={kind:'book',value:state};const derived=await c.hkdf(key,utf8Encode('u'),utf8Encode('watchrss/cloud/record-id/v1'));
 expect(await codec.id(key,'u',doc)).toBe(await c.hmac(derived,utf8Encode('book:'+state.bookId)));expect(await codec.hash(doc)).toBe(await c.sha256(utf8Encode('book:'+canonical(state))));expect(await codec.hash({...doc,value:{...state,sourceDeviceId:'other'}})).not.toBe(await codec.hash(doc));
 const id=await codec.id(key,'u',doc),envelope=await codec.encode(key,'u',id,1,doc);expect((await codec.decode(key,key,'u',{recordId:id,revision:'1',tombstone:false,envelope})).doc).toEqual(doc);await expect(codec.encode(key,'u',id,1,{...doc,value:{...state,fingerprint:'a'.repeat(64)}})).rejects.toThrow();
});
test('real repository cloud export collapses registered chapters, immutable body fingerprint ignores chapter deletion/reading; direct and WRSS restore preserve tombstones',async()=>{
 const f=await bookFixture(),g=await bookFixture(),h=await bookFixture();try{
  await seedChapters(f,source,v.chapters);const r=repo(f),a=adapter(r);const records=await a.exportRecords();expect(records.filter(d=>d.kind==='book')).toHaveLength(1);expect(records.filter(d=>d.kind==='article')).toHaveLength(0);expect((await r.cloudSnapshot(false)).stateArticles).toHaveLength(0);
  const full=await a.exportPayloads(true);expect(full.bookIds).toEqual([v.bookId]);expect(full.objects.map(o=>o.name)).toEqual(['books/'+v.bookId+'.jsonl']);const bytes=full.objects[0]!.bytes;expect(full.objects[0]!.privateBook?.fingerprint).toBe(v.fingerprint);
  await f.db.execute('DELETE FROM articles WHERE link=?',[source+'/chapter/1']);await r.mergeCloudBooks([], [{bookId:v.bookId,chapterIndex:2,isRead:true,readingProgress:.5,readingPositionBytes:4,readingPositionContentHash:'p',readingPositionChangedAt:900,sourceDeviceId:'watch'}]);expect((await a.exportPayloads(true)).fingerprint).toBe(full.fingerprint);
  const latest=(await a.exportRecords()).filter(d=>d.kind==='book'||d.kind==='book-reading'),gr=repo(g),ga=adapter(gr);await ga.applyRecords(latest);const restored=await ga.restorePayloads(new Map(full.objects.map(o=>[o.name,o.bytes])),'phone',full.objects.map(o=>({...o,encoding:'identity' as const,originalBytes:o.bytes.length,encodedBytes:o.bytes.length,chunks:[]})));expect(restored.pending).toBe(0);expect(await g.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);expect((await gr.cloudBooks()).books[0]?.deletedChapters).toEqual([1]);
  const archive=new Map<string,Uint8Array>([['manifest.json',utf8Encode(canonical({format:'watchrss-library-backup',version:3}))],['articles.json',utf8Encode('[]')],['books.json',utf8Encode(canonical([full.objects[0]!.privateBook]))],['books/'+v.bookId+'.jsonl',bytes]]);const ha=adapter(repo(h));await ha.applyRecords(latest);expect((await ha.restorePayloads(new Map([['private-library.wrss',writeWrss(archive)]]),'phone')).pending).toBe(0);expect(await h.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);
  const before=g.changes();await ga.applyRecords([{kind:'article',value:{articleId:'legacy',url:source+'/chapter/2',deleted:true,deletedAt:999,bookIndexRetired:true}}]);expect(g.changes()).toBe(before);
 }finally{f.sql.close();g.sql.close();h.sql.close();}
});

test('retirement lookup snapshots chapter mappings once per export and late legacy replay cannot resurrect a book deletion',async()=>{const f=await bookFixture();try{await seedChapters(f,source,v.chapters);const r=repo(f),a=adapter(r);let snapshots=0;const read=r.cloudBooks.bind(r);r.cloudBooks=()=>{snapshots++;return read();};await a.exportRecords();for(let i=0;i<50;i++)expect(await a.bookReplacement({kind:'article',value:{articleId:'old',url:source+'/chapter/1'}})).toBeDefined();expect(snapshots).toBe(1);await f.db.execute('DELETE FROM articles WHERE link=?',[source+'/chapter/1']);const old=f.packet;const {article}=await import('../sync/ble-v2-fixture');await r.receiveArticle(await old(article({articleId:await crypto.sha256(utf8Encode(source+'/chapter/1')),url:source+'/chapter/1',rssSourceUrl:source,contentText:'old body'})),'legacy-phone',false);expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);}finally{f.sql.close();}});

test('restore adapter forwards the immutable checkpoint through repository book staging without changing saved reading state',async()=>{
 const f=await bookFixture();try{
  let received:unknown,bookId:unknown;const files={...f.files,writeBytes:async(bytes:Uint8Array,checkpoint?:unknown,id?:string)=>{received=checkpoint;bookId=id;return f.files.writeBytes(bytes);}};
  const r=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:files}),a=adapter(r),checkpoint={scope:async()=> 'current-scope',has:()=>false,commit:async()=>{},result:()=>0,check:async()=>{}};
  const book={...state,bookId:cliSingle.bookId,fingerprint:cliSingle.fingerprint,chapterCount:1,sourceUrl:cliSingle.sourceUrl,kind:'txt'};await a.applyRecords([{kind:'book',value:book}]);
  const bytes=utf8Encode(cliSingle.packageUtf8),name='books/'+book.bookId+'.jsonl',descriptor={name,encoding:'identity' as const,originalBytes:bytes.length,encodedBytes:bytes.length,chunks:[],privateBook:{...book,packagePath:name}};
  expect((await a.restorePayloads(new Map([[name,bytes]]),'cli',[descriptor],{checkpoint})).pending).toBe(0);expect(received).toBe(checkpoint);expect(bookId).toBe(book.bookId);expect(await f.db.query('SELECT content FROM articles')).toEqual([{content:cliSingle.chapter.contentText}]);
 }finally{f.sql.close();}
});

test('lifecycle-only restore updates the snapshot fingerprint while retaining exact package bytes',async()=>{
 const f=await bookFixture();try{await seedChapters(f,source,v.chapters);const r=repo(f),a=adapter(r);await a.exportRecords();const before=await a.exportPayloads(true),original=before.objects[0]!.bytes,book=(await r.cloudBooks()).books[0]!;
 const next={...book,lifecycle:{generation:1,operationId:'a'.repeat(32),startedAt:200},updatedAt:200};await r.mergeCloudBooks([next],[]);await r.receiveCloudBook(book.bookId,original);const first=await a.exportPayloads(true);expect(first.fingerprint).not.toBe(before.fingerprint);expect(first.objects[0]!.bytes).toEqual(original);expect(first.objects[0]!.privateBook?.lifecycle).toEqual(next.lifecycle);
 const restored={...next,lifecycle:{generation:2,operationId:'b'.repeat(32),startedAt:300},updatedAt:300};await r.mergeCloudBooks([restored],[]);await r.receiveCloudBook(book.bookId,original);const second=await a.exportPayloads(true);expect(second.fingerprint).not.toBe(first.fingerprint);expect(second.objects[0]!.bytes).toEqual(original);
 }finally{f.sql.close();}
});
