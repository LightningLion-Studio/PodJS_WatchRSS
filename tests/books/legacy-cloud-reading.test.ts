import {test,expect} from 'bun:test';
import {restoreBookFixture} from './restore-throughput-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {article,cloudCrypto} from '../cloud/library-fixture';
import {enabled} from '../cloud/k2-crypto';
import {sha} from '../sync/ble-v2-fixture';
import {runtimeSession} from '../cloud/runtime-wiring.fixture';
const legacy=(f:Awaited<ReturnType<typeof restoreBookFixture>>,book=6,chapter=1)=>{const item=f.items.find(v=>v.book===book&&v.chapter===chapter)!,url=item.url.replace('https://watchrss.local/','https://www.watchrss.local/');return {...article({articleId:sha(url),url,rssSourceUrl:f.states[book].sourceUrl!,independentSaved:false,independentChangedAt:0,contentHtml:null,contentText:'',isRead:true,readingProgress:.75,readingPositionBytes:7,readingPositionContentHash:'original',readingPositionChangedAt:10000+chapter}),bookIndexRetired:false};};
const document=(value:any)=>{const {contentHtml,contentText,...state}=value;return {kind:'article',value:state};};

test('runtime path maps EPUB/TXT legacy articles through historical aliases in batches, without body or witness writes',async()=>{
 const f=await restoreBookFixture();try{
  const repo=Object.assign(new SqlLibrarySessionRepository(f.db,{...f.ports,codec:{...f.ports.codec,encode:async()=>{throw Error('gzip forbidden');},decode:async()=>{throw Error('gunzip forbidden');}}}),{deviceId:async()=> 'watch'});repo.mergeCloud=async()=>{throw Error('old merge forbidden');};repo.cloudReadingRevision=async()=>{throw Error('unrelated RSS revision query forbidden');};
  const run=await runtimeSession(repo),adapter=run.session.library as WatchCloudLibraryAdapter,docs=[legacy(f,24,1),...Array.from({length:7},(_,n)=>legacy(f,6,n+1))].map(document),witness=await f.db.query('SELECT book_id,package_path,package_sha256,registration_complete FROM sync_books ORDER BY book_id'),bodies=await f.db.query('SELECT * FROM article_sync_content ORDER BY item_id'),files=[...f.data].map(([p,b])=>[p,sha(b)]);
  await adapter.applyRecords(docs);for(const d of [legacy(f,24,1),legacy(f,6,1)]){const item=f.items.find(i=>i.url===d.url.replace('https://www.','https://'))!;expect((await f.db.query('SELECT changed_at,progress FROM article_reading_state WHERE article_id=?',[item.id]))[0]).toMatchObject({changed_at:d.readingPositionChangedAt,progress:.75});}
  expect(await f.db.query('SELECT book_id,package_path,package_sha256,registration_complete FROM sync_books ORDER BY book_id')).toEqual(witness);expect(await f.db.query('SELECT * FROM article_sync_content ORDER BY item_id')).toEqual(bodies);expect([...f.data].map(([p,b])=>[p,sha(b)])).toEqual(files);expect(docs.every(d=>d.value.bookIndexRetired===false)).toBe(true);
 }finally{f.sql.close();}
},30000);

test('legacy chapter reads preserve newer native clocks, explicit unread ties and independent save clocks',async()=>{
 const f=await restoreBookFixture();try{
  const repo=new SqlLibrarySessionRepository(f.db,f.ports),a=legacy(f),item=f.items.find(v=>v.book===6&&v.chapter===1)!;
  await f.db.execute("UPDATE article_reading_state SET progress=.9,changed_at=99999,position_bytes=9,position_hash='native',state_json='opaque' WHERE article_id=?",[item.id]);
  await repo.books!.mergeReading({bookId:f.states[6].bookId,chapterIndex:1,isRead:true,readingProgress:.8,readingPositionBytes:8,readingPositionContentHash:'native',readingPositionChangedAt:99999,sourceDeviceId:'watch',favoriteSaved:true,favoriteChangedAt:500,favoriteSortOrder:3});
  await repo.mergeCloudLegacyBookReading([a]);let saved=(await f.db.query('SELECT state_json FROM sync_book_reading WHERE book_id=? AND chapter_index=1',[f.states[6].bookId]))[0];expect(JSON.parse(String(saved.state_json))).toMatchObject({readingPositionChangedAt:99999,favoriteSaved:true,favoriteChangedAt:500});
  await repo.mergeCloudLegacyBookReading([{...a,sourceDeviceId:'watch',isRead:false,readingProgress:.1,readingPositionChangedAt:99999,favoriteSaved:false,favoriteChangedAt:600,watchLaterSaved:true,watchLaterChangedAt:700,watchLaterSortOrder:8}]);saved=(await f.db.query('SELECT state_json FROM sync_book_reading WHERE book_id=? AND chapter_index=1',[f.states[6].bookId]))[0];expect(JSON.parse(String(saved.state_json))).toMatchObject({isRead:false,readingPositionChangedAt:99999,favoriteSaved:false,favoriteChangedAt:600,watchLaterSaved:true,watchLaterChangedAt:700});
 }finally{f.sql.close();}
},30000);

test('unmapped, ambiguous, deleted and real-body legacy documents retain the normal receiver path',async()=>{
 const f=await restoreBookFixture();try{
  const repo=new SqlLibrarySessionRepository(f.db,f.ports),a=legacy(f),unmapped={...a,articleId:sha('absent'),url:'https://unmapped.invalid/item'},changed=[unmapped,{...a,deleted:true},{...a,contentText:'new original'}];
  expect((await repo.mergeCloudLegacyBookReading(changed)).remaining).toEqual(changed);
  const raw={...a,url:f.items.find(i=>i.book===6&&i.chapter===1)!.url,articleId:sha('ambiguous')};await f.db.execute('INSERT INTO sync_book_aliases(book_id,chapter_index,article_id,item_id,url,channel_url) VALUES(?,1,?,NULL,?,?)',[f.states[3].bookId,sha('other'),raw.url,raw.rssSourceUrl]);
  expect((await repo.mergeCloudLegacyBookReading([raw])).remaining).toEqual([raw]);let fallback=0;repo.mergeCloud=async(_s,rows)=>{fallback+=rows.length;return 0;};await new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled).applyRecords([document(unmapped)]);expect(fallback).toBe(1);
 }finally{f.sql.close();}
},30000);

test('save-only legacy chapters do not create a reading rewind, and zero-clock false defaults do not clear saves',async()=>{
 const f=await restoreBookFixture();try{
  const repo=new SqlLibrarySessionRepository(f.db,f.ports),a=legacy(f,6,2000),id=f.states[6].bookId;await repo.books!.mergeReading({bookId:id,chapterIndex:2000,isRead:true,readingProgress:.6,readingPositionBytes:6,readingPositionContentHash:'native',readingPositionChangedAt:0,sourceDeviceId:'watch',watchLaterSaved:true,watchLaterChangedAt:400,watchLaterSortOrder:4});
  await repo.mergeCloudLegacyBookReading([{...a,isRead:false,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,sourceDeviceId:'zz',favoriteSaved:true,favoriteChangedAt:500,favoriteSortOrder:5}]);
  expect(JSON.parse(String((await f.db.query('SELECT state_json FROM sync_book_reading WHERE book_id=? AND chapter_index=2000',[id]))[0].state_json))).toMatchObject({isRead:true,readingProgress:.6,readingPositionChangedAt:0,sourceDeviceId:'watch',favoriteSaved:true,favoriteChangedAt:500,favoriteSourceDeviceId:'zz',watchLaterSaved:true,watchLaterChangedAt:400});
 }finally{f.sql.close();}
},30000);

test('native bindings can prove a legacy alias; remapped aliases are fenced even when reading would be a no-op',async()=>{
 const f=await restoreBookFixture();try{
  const item=f.items.find(v=>v.book===6&&v.chapter===1)!,id=sha('retained-native-binding'),a={...legacy(f),articleId:id,url:'https://old.invalid/known-chapter'};await f.db.execute('UPDATE sync_article_ids SET article_id=? WHERE item_id=?',[id,item.id]);
  let armed=false;const mutate=async(ss:any[])=>{if(armed&&ss.some(s=>s.sql.includes('count(DISTINCT'))){armed=false;await f.db.execute('UPDATE sync_book_aliases SET article_id=? WHERE book_id=? AND chapter_index=1 AND wire_identity=1',[sha('remapped'),f.states[6].bookId]);await f.db.execute('UPDATE sync_article_ids SET article_id=? WHERE item_id=?',[sha('moved-native-binding'),item.id]);}};
  const repo=new SqlLibrarySessionRepository({...f.db,transaction:async ss=>{await mutate(ss);return f.db.transaction(ss);},transactionChanges:async ss=>{await mutate(ss);return f.db.transactionChanges!(ss);}},f.ports);
  expect((await repo.mergeCloudLegacyBookReading([a])).remaining).toEqual([]);const before=await f.db.query('SELECT * FROM sync_book_reading ORDER BY book_id,chapter_index');armed=true;await expect(repo.mergeCloudLegacyBookReading([a])).rejects.toThrow();expect(armed).toBe(false);expect(await f.db.query('SELECT * FROM sync_book_reading ORDER BY book_id,chapter_index')).toEqual(before);
 }finally{f.sql.close();}
},30000);
