import {test,expect} from 'bun:test';
import {memoizeSmallDigest} from '../../src/core/digest-cache';
import {dbFixture} from './library-fixture';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {cloudCrypto} from './library-fixture';
import {enabled} from './k2-crypto';
import {rssSourceKey,rssArticleId} from '../../src/cloud/rss-identity';
import {utf8Encode} from '../../src/cloud/types';

test('digest reuse is exact, bounded, mutation-safe and fences hits',async()=>{
 let calls=0,allowed=true;const hash=memoizeSmallDigest(async b=>{calls++;await Promise.resolve();return [...b].join(',');},{maxEntries:2,maxBytes:1024,maxInputBytes:4,beforeUse:()=>{if(!allowed)throw Error('account fenced');}});
 const input=new Uint8Array([1,0,255]);const one=hash(input);input[0]=2;expect(await one).toBe('1,0,255');expect(await hash(new Uint8Array([1,0,255]))).toBe('1,0,255');expect(calls).toBe(1);
 await hash(input);await hash(new Uint8Array([3]));await hash(new Uint8Array([1,0,255]));expect(calls).toBe(4);
 await hash(new Uint8Array(5));await hash(new Uint8Array(5));expect(calls).toBe(6);allowed=false;await expect(hash(new Uint8Array([1,0,255]))).rejects.toThrow('account fenced');
});
test('digest failure retries and separate instances never share cache',async()=>{
 let calls=0;const digest=async()=>{if(++calls===1)throw Error('host failed');return 'ok';};const one=memoizeSmallDigest(digest),two=memoizeSmallDigest(digest);await expect(one(new Uint8Array([1]))).rejects.toThrow('host failed');expect(await one(new Uint8Array([1]))).toBe('ok');expect(await two(new Uint8Array([1]))).toBe('ok');expect(calls).toBe(3);
});
test('repeated real cloud reading batches reuse identity digests without dropping later state clocks',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://digest.example/rss','Feed',1,1)");
  f.sql.transaction(()=>{const insert=f.sql.prepare("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,1,'Item','','https://digest.example/'||?, ?,1)");for(let i=1;i<=5500;i++)insert.run(i,i,'guid-'+i);})();
  let hashes=0;const crypto={...cloudCrypto,sha256:async(b:Uint8Array)=>{hashes++;return cloudCrypto.sha256(b);}};
  const adapter=new WatchCloudLibraryAdapter(f.repo,'watch',crypto,enabled);
  const articleId=await rssArticleId('https://digest.example/5500',cloudCrypto.sha256),sourceId=await rssSourceKey('https://digest.example/rss',cloudCrypto.sha256),articleIdHash=await cloudCrypto.sha256(utf8Encode(articleId));
  const doc=(clock:number)=>({kind:'rss-state',value:{sourceId,articleIdHash,sourceDeviceId:'phone',isRead:true,readingProgress:.5,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:clock,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0}} as any);
  await adapter.applyRecords([doc(20)]);const first=hashes;expect(first).toBeGreaterThan(5500);await adapter.applyRecords([doc(30)]);expect(hashes-first).toBeLessThan(10);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=5500'))[0]?.changed_at).toBe(30);
 }finally{f.sql.close();}
});


test('byte ceiling evicts exact values and in-flight identical calls coalesce',async()=>{
 let calls=0;const hash=memoizeSmallDigest(async b=>{calls++;await Promise.resolve();return [...b].join(',');},{maxBytes:520,maxEntries:100});
 await Promise.all([hash(new Uint8Array([1])),hash(new Uint8Array([1]))]);expect(calls).toBe(1);
 await hash(new Uint8Array([2]));await hash(new Uint8Array([3]));await hash(new Uint8Array([1]));expect(calls).toBe(4);
});

test('replayed RSS state keeps pending aliases but does not replay an unchanged receiver mutation',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://replay.example/rss','Feed',1,1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(1,1,'Item','','https://replay.example/1','g1','g1',1)");
  const sourceId=await rssSourceKey('https://replay.example/rss',cloudCrypto.sha256),articleId=await rssArticleId('https://replay.example/1',cloudCrypto.sha256),articleIdHash=await cloudCrypto.sha256(utf8Encode(articleId));
  const doc=(clock:number)=>({kind:'rss-state',value:{sourceId,articleIdHash,sourceDeviceId:'phone',isRead:true,readingProgress:.5,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:clock,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0}} as any);
  const merge=f.repo.mergeCloud.bind(f.repo);let mutations=0;f.repo.mergeCloud=async(s,a,...rest)=>{mutations+=a.length;return merge(s,a,...rest);};const adapter=new WatchCloudLibraryAdapter(f.repo,'watch',cloudCrypto,enabled);
  await adapter.applyRecords([doc(20)]);expect(mutations).toBe(1);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=1'))[0]?.changed_at).toBe(20);
  await adapter.applyRecords([doc(20)]);expect(mutations).toBe(1);
  await adapter.applyRecords([doc(30)]);expect(mutations).toBe(2);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=1'))[0]?.changed_at).toBe(30);
  // A local older edit remains observable; pending state is retained, not dropped.
  await f.db.execute('UPDATE article_reading_state SET progress=.2,changed_at=10 WHERE article_id=1');await adapter.applyReadingStates();expect(mutations).toBe(3);expect((await f.db.query('SELECT progress,changed_at FROM article_reading_state WHERE article_id=1'))[0]).toMatchObject({progress:.5,changed_at:30});
 }finally{f.sql.close();}
});

test('reading identity memo fences warm hits and observes changed pool-source aliases',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://memo.example/rss','Feed',1,1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(1,1,'Item','','https://memo.example/1','g1','g1',1)");
  let allowed=true;const guard={require(){if(!allowed)throw Error('guard revoked');}},adapter=new WatchCloudLibraryAdapter(f.repo,'watch',cloudCrypto,guard),articleId=await rssArticleId({link:'https://memo.example/1',guid:'g1',title:'Item'},cloudCrypto.sha256),articleIdHash=await cloudCrypto.sha256(utf8Encode(articleId)),sourceId=await rssSourceKey('https://memo.example/rss',cloudCrypto.sha256);
  const doc=(sourceId:string,clock:number)=>({kind:'rss-state',value:{sourceId,articleIdHash,sourceDeviceId:'phone',isRead:true,readingProgress:.5,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:clock,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0}}as any);
  await adapter.applyRecords([doc(sourceId,20)]);await adapter.applyRecords([doc(sourceId,30)]);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=1'))[0]?.changed_at).toBe(30);
  allowed=false;await expect(adapter.applyReadingStates()).rejects.toThrow('guard revoked');allowed=true;
  await adapter.applyRecords([{kind:'source',value:{url:'https://memo.example/rss',sourceId:'pool-source-new',title:'Feed',sourceDeviceId:'phone',sortOrder:1,isPinned:false,updatedAt:100,deleted:false,deletedAt:0}}as any]);
  await adapter.applyRecords([doc('pool-source-new',40)]);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=1'))[0]?.changed_at).toBe(40);
 }finally{f.sql.close();}
});
