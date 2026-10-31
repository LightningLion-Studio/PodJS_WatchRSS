import {expect,test} from 'bun:test';
import {bookFixture} from './fixture';
import {SqlBookStore} from '../../src/books/store';
import {mergeLegacyBookReading} from '../../src/books/legacy-cloud-reading';
import {readNovelDirectory,novelResumeChapter,novelNavigation} from '../../src/reader/novel';
import {WatchRssRepository} from '../../src/core/repository';
import {BookReadingDelta} from '../../src/books/reading-delta';
import {article} from '../sync/ble-v2-fixture';
import type {SqlDatabase} from '../../src/core/types';
const source='https://watchrss.local/import-txt-novel/bookquery';
/** PodServices.query: JSON scalar bindings, 1000 rows, 512 Ki UTF-16 JSON chars.
 * Never silently truncate. This wraps the same SqlDatabase port as services.ts. */
function hostSql(db:SqlDatabase){const calls:{sql:string;rows:number}[]=[];return {calls,db:{...db,query:async(sql:string,params:readonly unknown[]=[])=>{
 const rows=await db.query(sql,JSON.parse(JSON.stringify(params)));calls.push({sql,rows:rows.length});
 if(rows.length>1000)throw Error('Query exceeds 1000 rows; use LIMIT and pagination');
 if(rows.reduce((n,r)=>n+JSON.stringify(r).length,0)>512*1024)throw Error('Query result too large; use paging');
 return JSON.parse(JSON.stringify(rows));
 }} as SqlDatabase};}
test('5601 chapter directory and reading clocks use bounded metadata pages under the production host guard',async()=>{
 const f=await bookFixture();try{
  f.sql.run('INSERT INTO channels(id,url,title,created_at) VALUES(90,?,"Book",0)',[source]);
  const insert=f.sql.prepare('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,90,?,?,?, ?,0)');
  f.sql.transaction(()=>{for(let n=5601;n>=1;n--)insert.run(n,'Chapter '+n,'body'.repeat(1000),source+'/chapter/'+n,String(n));})();
  f.sql.run("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(1811,.7,9999,0,'x'),(5601,.2,10,0,'x')");
  const host=hostSql(f.db);let yields=0;
  const rows=await readNovelDirectory(host.db,source,async()=>{yields++;});
  expect(rows).toHaveLength(5601);expect(rows[0]!.id).toBe('1');expect(rows.at(-1)!.id).toBe('5601');
  expect(novelResumeChapter(rows)?.id).toBe('1811');expect(novelNavigation(rows,'1811')?.next?.id).toBe('1812');
  expect(rows.every(r=>r.content==='')).toBe(true);expect(yields).toBeGreaterThan(0);
  expect(host.calls.every(c=>c.rows<=1000&&c.sql.includes('LIMIT'))).toBe(true);
  f.sql.run('UPDATE articles SET content=NULL WHERE id=1811');
  const fragment=f.sql.prepare('INSERT INTO article_body_chunks(article_id,chunk_index,body) VALUES(1811,?,?)');
  f.sql.transaction(()=>{for(let n=0;n<1201;n++)fragment.run(n,String(n)+',');})();
  // Production repository defaults; 1201 body fragments must never become one host result.
  expect(await new WatchRssRepository(host.db,async()=>'').getArticleBody(1811)).toBe(Array.from({length:1201},(_,n)=>String(n)+',').join(''));
  expect(host.calls.every(c=>c.rows<=1000)).toBe(true);
 }finally{f.sql.close();}
},30000);
test('5601 ambiguous chapter aliases remain ambiguous across SQL pages and book-state/range readers stay bounded',async()=>{
 const f=await bookFixture();try{
  const id='a'.repeat(64),fingerprint='b'.repeat(64),state={bookId:id,fingerprint,title:'Book',chapterCount:5601,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:source,kind:'txt'};
  f.sql.run('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,registration_complete) VALUES(?,?,?,?,1)',[id,fingerprint,5601,JSON.stringify(state)]);
  const insert=f.sql.prepare('INSERT INTO sync_book_aliases(book_id,chapter_index,article_id,url,channel_url) VALUES(?,?,?,?,?)');
  f.sql.transaction(()=>{for(let n=1;n<=5601;n++)insert.run(id,n,'legacy-'+n,source+'/chapter/1',source);})();
  const host=hostSql(f.db),store=new SqlBookStore(host.db,f.bookPorts);
  const incoming=article({articleId:'unknown',url:source+'/chapter/1',rssSourceUrl:source,contentHtml:null,contentText:'',isRead:true,readingPositionChangedAt:1000,independentSaved:false});
  const result=await mergeLegacyBookReading(host.db,store,[incoming],()=>{});
  expect(result).toEqual({changed:0,remaining:[incoming]});expect(await store.mappings()).toHaveLength(5601);
  expect(await store.mapping('unknown',incoming.url)).toBeUndefined();
  const insertReading=f.sql.prepare("INSERT INTO sync_book_reading(book_id,chapter_index,state_json,is_read,progress,clock,position,hash,source) VALUES(?,?,?,1,.5,1,1,'','watch')");
  f.sql.transaction(()=>{for(let n=1;n<=5601;n++)insertReading.run(id,n,JSON.stringify({bookId:id,chapterIndex:n,isRead:true,readingProgress:.5,readingPositionBytes:1,readingPositionContentHash:'',readingPositionChangedAt:n,sourceDeviceId:'watch'}));})();
  expect(await store.readingStates(false)).toHaveLength(5601);
  const delta=new BookReadingDelta(host.db,store),summary=await delta.summary();expect(summary.count).toBe(5601);
  const entries=await delta.entries(0,summary.seq);expect(entries).toHaveLength(5601);expect(entries.at(-1)?.state.chapterIndex).toBe(5601);
  expect(host.calls.every(c=>c.rows<=1000)).toBe(true);
 }finally{f.sql.close();}
},30000);

test('5601 chapter mark-read and saved-link inventory respect SQL and transaction guards, including an interrupted retry',async()=>{
 const f=await bookFixture();try{
  const {SqlLocalRssActions}=await import('../../src/sync/local-rss-actions');
  const {readSavedLinks}=await import('../../src/sync/saved-links');
  f.sql.run("INSERT INTO channels(id,url,title,created_at) VALUES(90,?,'Book',0)",[source]);
  const insert=f.sql.prepare('INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(?,90,?,?,?,0)');
  const save=f.sql.prepare("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',1,1,?)");
  f.sql.transaction(()=>{for(let n=1;n<=5601;n++){insert.run(n,'Chapter '+n,source+'/chapter/'+n,String(n));save.run(n,n);}})();
  const host=hostSql(f.db);let transactions=0,interrupt=true;
  const guarded={...host.db,transaction:async(ss:Parameters<SqlDatabase['transaction']>[0])=>{
   expect(ss.length).toBeLessThanOrEqual(2048);transactions++;
   if(interrupt&&transactions===2)throw Error('interrupted');await f.db.transaction(ss);
  }};
  const actions=new SqlLocalRssActions(guarded,f.ports.text,f.codec);
  await expect(actions.markChannelRead(90)).rejects.toThrow('interrupted');
  expect((await f.db.query('SELECT count(*) n FROM articles WHERE is_read=1'))[0]!.n).toBe(200);
  expect((await f.db.query('SELECT count(*) n FROM sync_article_aliases'))[0]!.n).toBe(200);
  interrupt=false;await actions.markChannelRead(90);
  expect((await f.db.query('SELECT count(*) n FROM articles WHERE is_read=1'))[0]!.n).toBe(5601);
  expect((await f.db.query("SELECT count(*) n FROM sync_change_log WHERE reason='read'"))[0]!.n).toBe(5601);
  expect(await readSavedLinks(host.db,'favorite')).toHaveLength(5601);
 }finally{f.sql.close();}
},30000);

test('reading summary pages more than 1000 dirty book keys without changing the host guard',async()=>{
 const f=await bookFixture();try{
  const insert=f.sql.prepare('INSERT INTO sync_book_reading_hash_dirty(book_id) VALUES(?)');
  f.sql.transaction(()=>{for(let n=1;n<=1001;n++)insert.run(String(n).padStart(64,'0'));})();
  f.sql.run('UPDATE sync_book_reading_meta SET root=NULL WHERE id=1');
  const host=hostSql(f.db),store=new SqlBookStore(host.db,f.bookPorts);
  expect((await new BookReadingDelta(host.db,store).summary()).count).toBe(0);
  expect((await f.db.query('SELECT count(*) n FROM sync_book_reading_hash_dirty'))[0]!.n).toBe(0);
  expect(host.calls.every(c=>c.rows<=1000)).toBe(true);
 }finally{f.sql.close();}
});
