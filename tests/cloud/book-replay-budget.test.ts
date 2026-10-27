import {test,expect} from 'bun:test';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {bookFixture} from '../books/fixture';
import {article,cloudCrypto} from './library-fixture';
import {enabled} from './k2-crypto';
import {rssSourceKey} from '../../src/cloud/rss-identity';
import {utf8Encode} from '../../src/cloud/types';
import vectors from '../fixtures/book-fingerprint.json';
import type {BookReading} from '../../src/books/protocol';
const reading=(n:number):BookReading=>({bookId:vectors.cases[0]!.bookId,chapterIndex:n,isRead:true,readingProgress:.5,readingPositionBytes:5,readingPositionContentHash:'h',readingPositionChangedAt:10000,sourceDeviceId:'remote'});

test('1250 book readings do not rescan or hash 1000 unrelated public RSS candidates',async()=>{
 const source='https://fixture.invalid/rss';let scans=0,hashes=0,bookRows=0;const applied:any[]=[];
 const candidates=Array.from({length:1000},(_,i)=>article({articleId:'rss-'+i,cloudRssArticleId:'rss-'+i,url:'https://fixture.invalid/'+i,rssSourceUrl:source,independentSaved:false,favoriteSaved:false,watchLaterSaved:false}));
 const adapter=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[],stateArticles:candidates,sources:[]}),cloudReadingCandidates:async()=>{scans++;return candidates;},mergeCloud:async(_,values)=>{applied.push(...values);return values.length;},mergeCloudBooks:async(_,values)=>{bookRows+=values.length;return values.length;}},'watch',{...cloudCrypto,sha256:async bytes=>{hashes++;return cloudCrypto.sha256(bytes);}},enabled);
 const value={sourceId:await rssSourceKey(source,cloudCrypto.sha256),articleIdHash:await cloudCrypto.sha256(utf8Encode('rss-1')),sourceDeviceId:'remote',isRead:true,readingProgress:.5,readingPositionChangedAt:10000,readingPositionBytes:5,readingPositionContentHash:'h',favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0};
 await adapter.applyRecords([{kind:'rss-state',value}]);expect(scans).toBe(1);const beforeHashes=hashes,beforeApplied=applied.length;
 for(let page=0;page<25;page++)expect(await adapter.applyRecords(Array.from({length:50},(_,i)=>({kind:'book-reading',value:reading(page*50+i+1)})))).toBe(50);
 expect(bookRows).toBe(1250);expect(scans).toBe(1);expect(hashes).toBe(beforeHashes);expect(applied).toHaveLength(beforeApplied);
 // A later RSS edit still re-reads candidates and applies the new explicit clock.
 await adapter.applyRecords([{kind:'rss-state',value:{...value,readingProgress:.75,readingPositionChangedAt:10001}}]);
 expect(scans).toBe(2);expect(applied.at(-1).readingProgress).toBe(.75);
});

test('cloud repository merges 250 pending chapter states in bounded durable batches',async()=>{
 const f=await bookFixture();try{
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});const books=repo.books!,batch=books.mergeReadingBatch.bind(books),sizes:number[]=[];
  books.mergeReading=async()=>{throw Error('Cloud replay must use bounded batches');};
  books.mergeReadingBatch=async(values,options)=>{sizes.push(values.length);return batch(values,options);};
  const states=Array.from({length:250},(_,i)=>reading(i+1));
  await repo.mergeCloudBooks([],states);expect(sizes).toEqual([100,100,50]);expect(await f.db.query('SELECT COUNT(*) n FROM sync_book_reading')).toEqual([{n:250}]);
  sizes.length=0;await repo.mergeCloudBooks([],states);expect(sizes).toEqual([100,100,50]);expect(await f.db.query('SELECT COUNT(*) n FROM sync_book_reading')).toEqual([{n:250}]);
 }finally{f.sql.close();}
});

test('failure between cloud reading batches remains retryable without duplicate states',async()=>{
 const f=await bookFixture();try{
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});const books=repo.books!,batch=books.mergeReadingBatch.bind(books);let calls=0;
  books.mergeReadingBatch=async(values,options)=>{if(++calls===2)throw Error('fixture disk interruption');return batch(values,options);};
  const states=Array.from({length:250},(_,i)=>reading(i+1));
  await expect(repo.mergeCloudBooks([],states)).rejects.toThrow('fixture disk interruption');expect(await f.db.query('SELECT COUNT(*) n FROM sync_book_reading')).toEqual([{n:100}]);
  books.mergeReadingBatch=batch;await repo.mergeCloudBooks([],states);expect(await f.db.query('SELECT COUNT(*) n FROM sync_book_reading')).toEqual([{n:250}]);
  expect(await f.db.query('SELECT COUNT(*) n FROM sync_book_reading WHERE clock=10000 AND progress=0.5')).toEqual([{n:250}]);
 }finally{f.sql.close();}
});
