import {test,expect} from 'bun:test';
import {restoreBookFixture} from './restore-throughput-fixture';
import {bookFixture,seedChapters} from './fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {bookPackageLines} from '../../src/books/package';
import {bookFingerprint,bookId,chapterHash} from '../../src/books/protocol';
import {sha} from '../sync/ble-v2-fixture';

test('1177 registered metadata replay does not materialize unrelated pending originals and captures newer native reading',async()=>{
 const f=await restoreBookFixture();try{
  let queries=0;const events:any[]=[];const db={...f.db,query:async(...a:Parameters<typeof f.db.query>)=>{queries++;if(a[0].includes('a.content IS NOT NULL AS has_content'))throw Error('unrelated legacy scan');return f.db.query(...a);}},repo=new SqlLibrarySessionRepository(db,{...f.ports,diagnostic:e=>events.push(e)});
  const original=f.sql.query('SELECT book_id,fingerprint,chapter_count,package_sha256,registration_complete FROM sync_books ORDER BY book_id').all();
  for(const state of f.states){const before=queries;await repo.mergeCloudBooks([state],[]);expect(queries-before).toBeLessThan(35);}
  expect(f.hydrates()).toBe(0);expect(f.sql.query('SELECT book_id,fingerprint,chapter_count,package_sha256,registration_complete FROM sync_books ORDER BY book_id').all()).toEqual(original);expect(events.some(e=>e.stage==='book-prepare')).toBe(true);
  const native=f.items.find(r=>r.book===6&&r.chapter===1)!;await f.db.execute('UPDATE article_reading_state SET progress=.875,changed_at=99999 WHERE article_id=?',[native.id]);const old=f.readings.find(r=>r.bookId===f.states[6].bookId&&r.chapterIndex===1)!;
  await repo.mergeCloudBooks([], [{...old,readingProgress:.1,readingPositionChangedAt:2}]);const saved=JSON.parse((await f.db.query('SELECT state_json FROM sync_book_reading WHERE book_id=? AND chapter_index=1',[old.bookId]))[0].state_json as string);expect(saved.readingProgress).toBe(.875);expect(saved.readingPositionChangedAt).toBe(99999);expect(f.hydrates()).toBe(0);
 }finally{f.sql.close();}
},30000);

test('unknown or incomplete registered book still takes normal migration without certifying an unrelated pending body',async()=>{
 const f=await restoreBookFixture();try{
  const fingerprint=sha('new unknown'),id=await bookId(fingerprint,f.bookPorts.sha256),repo=new SqlLibrarySessionRepository(f.db,f.ports);await repo.mergeCloudBooks([{...f.states[0],bookId:id,fingerprint,deletedChapters:[]}],[]);
  expect(f.hydrates()).toBeGreaterThan(0);expect((await f.db.query('SELECT registration_complete FROM sync_books WHERE book_id=?',[id]))[0].registration_complete).toBe(0);expect(f.writes()).toBe(0);
 }finally{f.sql.close();}
},30000);

test('known preview with an original digest still quarantines through full migration; metadata shortcut cannot certify it',async()=>{
 const f=await bookFixture();try{
  const source='https://watchrss.local/import-txt-novel/restore-proof',excerpt='preview',full='original '.repeat(200),url=source+'/chapter/1';await seedChapters(f,source,[{title:'Chapter',contentText:full,contentHtml:null}]);const item=(await f.db.query('SELECT id FROM articles'))[0].id;
  await f.db.execute('UPDATE articles SET description=? WHERE id=?',[excerpt,item]);await f.db.execute('INSERT INTO article_sync_encoding_cache(item_id,body_hash,content_hash) VALUES(?,?,?)',[item,'cache',sha(full)]);
  const fingerprint=await bookFingerprint([await chapterHash(1,'Chapter',excerpt,f.bookPorts.sha256)],f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256),state={bookId:id,fingerprint,title:'Book',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:source,kind:'txt'};
  await f.store.merge(state);const packed=await f.files.publish(await f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:1,sourceUrl:source,kind:'txt'},[{chapterIndex:1,title:'Chapter',contentText:excerpt,contentHtml:null,url}]),100000),id),bytes=f.data.get(packed.path)!.slice();
  await f.db.execute('UPDATE sync_books SET registration_complete=1,package_path=?,package_sha256=?,package_bytes=? WHERE book_id=?',[packed.path,packed.sha256,packed.size,id]);await f.db.execute('INSERT INTO sync_book_aliases(book_id,chapter_index,article_id,item_id,url,channel_url) VALUES(?,1,?,?,?,?)',[id,sha(url),item,url,source]);
  await f.store.prepareCloudMerge([state],[]);expect(await f.store.package(id)).toBeUndefined();expect(f.data.get(packed.path)).toEqual(bytes);expect((await f.store.manifests()).filter(b=>b.contentAvailable).some(b=>b.bookId!==id)).toBe(true);
 }finally{f.sql.close();}
},30000);
