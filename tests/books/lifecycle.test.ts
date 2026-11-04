import {externalFixture} from '../helpers/external-fixtures';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {bookId,mergeBook,validateBook,type BookState} from '../../src/books/protocol';
import {nextLifecycleToken} from '@podjs/framework/lifecycle-token';
import {bookPackageLines,validateBookPackage} from '../../src/books/package';
import {bookFixture} from './fixture';
import vectors from '../fixtures/book-fingerprint.json';
const miniPath=externalFixture('WATCHRSS_WECHAT_ROOT','miniprogram/lib/books.js');
const mini=miniPath?createRequire(import.meta.url)(miniPath):undefined;
const miniTest=miniPath?test:test.skip;
const sha=async(b:Uint8Array)=>new Bun.CryptoHasher('sha256').update(b).digest('hex');
const v=vectors.cases[0]!,source='https://watchrss.local/import-epub/lifecycle';
const base:BookState={bookId:v.bookId,fingerprint:v.fingerprint,title:'Book',chapterCount:2,sourceDeviceId:'mini',updatedAt:10,deleted:false,deletedAt:0,deletionClock:0,deletedChapters:[],sourceUrl:source,kind:'epub'};
const life=(generation=1,operationId='a'.repeat(32),startedAt=100)=>({generation,operationId,startedAt});
miniTest('mini differential: lifecycle numeric order, concurrent tokens, deletion union and legacy bytes',async()=>{
 const states=[base,{...base,deleted:true,deletedChapters:[1,2],deletedAt:90,deletionClock:90},...Array.from({length:4},(_,i)=>({...base,lifecycle:life(i===3?10:1,i===2?'b'.repeat(32):'a'.repeat(32)),deletedChapters:i===1?[1]:i===2?[2]:[],updatedAt:100+i,deletionClock:i===1?120:0}))];
 for(const a of states)for(const b of states){expect(mergeBook(a,b)).toEqual(mini.merge(a,b));expect(JSON.stringify(mini.state(mergeBook(a,b)))).toBe(JSON.stringify(mini.merge(a,b)));}
 for(const instanceId of [undefined,'1'.repeat(32),'f'.repeat(32)]){expect(await bookId(v.fingerprint,sha,instanceId)).toBe(mini.id(v.fingerprint,instanceId));const s={...base,...(instanceId?{instanceId,bookId:mini.id(v.fingerprint,instanceId)}:{})};expect(await validateBook(s,sha)).toEqual(mini.state(s));}
});
async function packageCase(instanceId?:string){
 const url=instanceId?'watchrss://import/instance-v1/'+instanceId:source,head={format:'watchrss-book' as const,version:1 as const,title:'Book',chapterCount:2,sourceUrl:url,kind:'epub' as const,...(instanceId?{instanceId}:{})},chapters=v.chapters.map((c,i)=>({...c,chapterIndex:i+1,url:url+'/chapter/'+(i+1)}));
 let text='';for await(const line of bookPackageLines(head,chapters))text+=line;
 const expected={bookId:await bookId(v.fingerprint,sha,instanceId),fingerprint:v.fingerprint,chapterCount:2,...(instanceId?{instanceId}:{})};
 const lines=()=> (async function*(){yield*text.trimEnd().split('\n');})();return {head,chapters,text,expected,lines};
}
miniTest('mini differential: package bytes and cold identity binding, including copies',async()=>{
 for(const instanceId of [undefined,'1'.repeat(32)]){
  const {text,head,chapters,expected,lines}=await packageCase(instanceId);
  expect(text).toBe(mini.pack(chapters,head));expect(expected.bookId).toBe(mini.id(v.fingerprint,instanceId));
  expect((await validateBookPackage(lines(),sha,expected)).bookId).toBe(mini.unpack(text,expected).bookId);
  expect(()=>mini.unpack(text,{...expected,instanceId:'2'.repeat(32)})).toThrow();
 }
});
test('watch package bytes retain cold identity binding, including copies',async()=>{
 for(const instanceId of [undefined,'1'.repeat(32)]){
  const {text,expected,lines}=await packageCase(instanceId);
  expect((await validateBookPackage(lines(),sha,expected)).bookId).toBe(expected.bookId);
  await expect(validateBookPackage(lines(),sha,{...expected,instanceId:'2'.repeat(32)})).rejects.toThrow();
  const f=await bookFixture();try{await f.store.merge({...base,...expected});await f.store.installPackage(await f.files.writeBytes(new TextEncoder().encode(text)),expected.bookId);expect((await f.store.states())[0]?.instanceId).toBe(instanceId);}finally{f.sql.close();}
 }
});
miniTest('mini differential: exhausted generation rejects restoration',()=>{const old={...base,deleted:true,lifecycle:life(Number.MAX_SAFE_INTEGER)},prepared={book:old};expect(()=>mini.importCandidate(prepared,'restore',old)).toThrow();});
test('watch exhausted generation and clock reject restoration',()=>{const old={...base,deleted:true,lifecycle:life(Number.MAX_SAFE_INTEGER)};expect(()=>nextLifecycleToken(old.lifecycle,'b'.repeat(32),200,[100])).toThrow();expect(()=>nextLifecycleToken(undefined,'b'.repeat(32),200,[Number.MAX_SAFE_INTEGER])).toThrow();});
test('native projection: restore revives chapters, retains tombstones and ignores stale captures',async()=>{
 const f=await bookFixture();try{
  const packageFor=()=>f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:2,sourceUrl:source,kind:'epub'},v.chapters.map((c,i)=>({...c,chapterIndex:i+1,url:source+'/chapter/'+(i+1)}))),1e7);
  await f.store.merge(base);await f.store.installPackage(await packageFor(),base.bookId);await f.store.merge({...base,deletedChapters:[1],deletionClock:90});
  expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);const tombstones=await f.db.query('SELECT * FROM sync_article_deletions');
  const restored={...base,lifecycle:life(),updatedAt:100};await f.store.merge(restored);await f.store.installPackage(await packageFor(),base.bookId);
  expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:2}]);expect(await f.db.query('SELECT * FROM sync_article_deletions')).toEqual(tombstones);
  await f.db.execute('INSERT INTO sync_book_events VALUES(?,?,?)',[base.bookId,1,99]);expect((await f.store.states())[0]?.deletedChapters).toEqual([]);
  await f.store.merge({...base,deleted:true,deletedChapters:[1,2],deletionClock:999});expect((await f.store.states())[0]).toEqual(restored);
  await f.db.execute('INSERT INTO sync_book_events VALUES(?,?,?)',[base.bookId,2,101]);expect((await f.store.states())[0]?.deletedChapters).toEqual([2]);
 }finally{f.sql.close();}
});
test('native user deletion after future-skewed restoration uses a newer clock',async()=>{
 const f=await bookFixture();try{const future=Date.now()+86400000,restored={...base,lifecycle:life(1,'c'.repeat(32),future),updatedAt:future};await f.store.merge(restored);
 const pkg=()=>f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:2,sourceUrl:source,kind:'epub'},v.chapters.map((c,i)=>({...c,chapterIndex:i+1,url:source+'/chapter/'+(i+1)}))),1e7);await f.store.installPackage(await pkg(),base.bookId);
 await f.db.execute('DELETE FROM articles WHERE link=?',[source+'/chapter/1']);expect((await f.store.states())[0]?.deletedChapters).toEqual([1]);expect((await f.store.states())[0]!.deletionClock).toBeGreaterThan(future);
 await f.db.execute('DELETE FROM channels WHERE url=?',[source]);expect((await f.store.states())[0]?.deleted).toBe(true);expect((await f.store.states())[0]!.deletedAt).toBeGreaterThan(future);
 }finally{f.sql.close();}
});

function sameLifecycleDeletions(){return {left:{...base,lifecycle:life(),deletedChapters:[1],deletionClock:110},right:{...base,lifecycle:life(),deletedChapters:[2],deleted:true,deletedAt:120,deletionClock:120}};}
test('same lifecycle unions chapter deletions and whole-book deletion',()=>{
 const {left,right}=sameLifecycleDeletions();expect(mergeBook(left,right).deletedChapters).toEqual([1,2]);expect(mergeBook(left,right).deleted).toBe(true);
});
miniTest('mini differential: same lifecycle deletion union',()=>{
 const {left,right}=sameLifecycleDeletions();expect(mergeBook(left,right)).toEqual(mini.merge(left,right));expect(mergeBook(right,left)).toEqual(mini.merge(right,left));
});
test('lifecycle deletion masks the projection without cancelling durable saved reading',async()=>{
 const f=await bookFixture();try{const current={...base,lifecycle:life(),updatedAt:100};await f.store.merge(current);const pkg=()=>f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:2,sourceUrl:source,kind:'epub'},v.chapters.map((c,i)=>({...c,chapterIndex:i+1,url:source+'/chapter/'+(i+1)}))),1e7);await f.store.installPackage(await pkg(),base.bookId);
 const reading={bookId:base.bookId,chapterIndex:1,isRead:true,readingProgress:.5,readingPositionBytes:2,readingPositionContentHash:'position',readingPositionChangedAt:101,sourceDeviceId:'mini',favoriteSaved:true,favoriteChangedAt:102,favoriteSortOrder:1};await f.store.mergeReading(reading);await f.store.merge({...current,deleted:true,deletedAt:120,deletionClock:120});expect((await f.store.readingStates())[0]?.favoriteSaved).toBe(true);
 const restored={...base,lifecycle:life(2,'b'.repeat(32),200),updatedAt:200};await f.store.merge(restored);await f.store.installPackage(await pkg(),base.bookId);expect(await f.db.query('SELECT is_saved,is_read FROM articles WHERE link=?',[source+'/chapter/1'])).toEqual([{is_saved:1,is_read:1}]);expect((await f.store.readingStates())[0]?.readingPositionBytes).toBe(2);
 }finally{f.sql.close();}
});

test('stale article deletion and generated saved cancellations do not enter a restored book',async()=>{
 const f=await bookFixture();try{const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files}),book={...base,lifecycle:life(),updatedAt:100};await repo.mergeCloudBooks([book],[]);const file=await f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:2,sourceUrl:source,kind:'epub'},v.chapters.map((c,i)=>({...c,chapterIndex:i+1,url:source+'/chapter/'+(i+1)}))),1e7);const body=f.data.get(file.path)!;await repo.receiveCloudBook(base.bookId,body);
 await repo.mergeCloudBooks([],[{bookId:base.bookId,chapterIndex:1,isRead:true,readingProgress:.5,readingPositionBytes:2,readingPositionContentHash:'position',readingPositionChangedAt:101,sourceDeviceId:'mini',favoriteSaved:true,favoriteChangedAt:102,favoriteSortOrder:1}]);
 const legacy=(await f.repo.cloudSnapshot(false)).articles.find(a=>a.url===source+'/chapter/1')!;expect(legacy).toBeDefined();await repo.mergeCloudBooks([{...book,lifecycle:life(2,'b'.repeat(32),200),updatedAt:200}],[]);expect((await f.db.query('SELECT registration_complete FROM sync_books'))[0]?.registration_complete).toBe(0);await repo.mergeCloud([], [{...legacy,deleted:true,deletedAt:99,updatedAt:10000,favoriteSaved:false,favoriteChangedAt:10000,watchLaterSaved:false,watchLaterChangedAt:10000}], 'cloud-records');const result=await repo.cloudBooks();expect(result.books[0]?.deletedChapters).toEqual([]);expect(result.reading[0]?.favoriteSaved).toBe(true);expect(result.reading[0]?.favoriteChangedAt).toBe(102);expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:2}]);
 }finally{f.sql.close();}
});
