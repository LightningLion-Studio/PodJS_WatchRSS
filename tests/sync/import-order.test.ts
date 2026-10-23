import {expect,test} from 'bun:test';
import {orderImportedRows} from '../../src/sync/import-order';
import {isImportedContentUrl} from '../../src/core/imported-content';
const n=(x:unknown)=>Number(x??0);
test('cooperative import order matches all six historical sort columns and filters RSS before key conversion',async()=>{
 const rows=Array.from({length:2000},(_,i)=>({id:String(i),channel_url:i%7===0?'https://rss.invalid/feed':i%3===0?'watchrss://phone-imports':'https://watchrss.local/import-epub/book',channel_pinned:String(i%2),channel_sort:String(i%5),channel_created:String(i%11),channel_id:String(i%3),fetched_at:String(i%17)}));
 const old=rows.slice().sort((a,b)=>n(b.channel_pinned)-n(a.channel_pinned)||n(a.channel_sort)-n(b.channel_sort)||n(b.channel_created)-n(a.channel_created)||n(a.channel_id)-n(b.channel_id)||n(b.fetched_at)-n(a.fetched_at)||n(b.id)-n(a.id)).filter(r=>r.channel_url==='watchrss://phone-imports'||isImportedContentUrl(r.channel_url));
 let slices=0;expect(await orderImportedRows(rows,{yieldTurn:async()=>{},stepLimit:128,onSlice:(_ms,count)=>{expect(count).toBeLessThanOrEqual(128);slices++;}})).toEqual(old);expect(slices).toBeGreaterThan(16);
});
test('ordinary RSS rows never evaluate numeric ordering keys and cancellation closes the sort',async()=>{
 const rss={channel_url:'https://rss.invalid',get id(){throw Error('RSS keys must stay unread');}};expect(await orderImportedRows([rss],{yieldTurn:async()=>{}})).toEqual([]);
 let paused=false;await expect(orderImportedRows([{channel_url:'watchrss://phone-imports',id:1}],{yieldTurn:async()=>{paused=true;},check(){if(paused)throw Error('cloud_sync_suspended');}})).rejects.toThrow('cloud_sync_suspended');
});
test('real SQL snapshot propagates pause from a work boundary and a later complete snapshot still exports all rows',async()=>{
 const {bookFixture,seedChapters}=await import('../books/fixture');const {SqlLibrarySessionRepository}=await import('../../src/sync/library-repository');const f=await bookFixture();
 try{
  await seedChapters(f,'https://watchrss.local/import-epub/cancel-sort',[{title:'One',contentText:'one',contentHtml:null},{title:'Two',contentText:'two',contentHtml:null}]);
  const query=f.db.query.bind(f.db);let paused=false,yields=0;
  f.db.query=async(q,p)=>{const rows=await query(q,p);if(q==='SELECT 1'){paused=true;yields++;}return rows;};
  const repo=new SqlLibrarySessionRepository(f.db,f.ports);
  await expect(repo.cloudSnapshot(false,()=>{if(paused)throw Error('cloud_sync_suspended');})).rejects.toThrow('cloud_sync_suspended');expect(yields).toBe(1);
  f.db.query=query;const complete=await repo.cloudSnapshot(false);expect(complete.articles).toHaveLength(2);expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:2}]);
 }finally{f.sql.close();}
});
