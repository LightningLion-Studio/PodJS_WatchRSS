import {expect,test} from 'bun:test';
import {dbFixture} from './library-fixture';

const source='https://reading-refresh.example/rss';
const inventory=(body:string)=>({url:source,title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[{url:'https://reading-refresh.example/item',guid:'stable-guid',title:'Item',excerpt:'',contentHtml:null,contentText:body,imageUrl:null,contentHash:null}]});
for(const isRead of [false,true])test(`public RSS body refresh preserves explicit reading tuple and clock (${isRead})`,async()=>{
 const f=await dbFixture();try{
  await f.adapter.mergeInventory(inventory('old body'));
  const item=(await f.db.query('SELECT id FROM articles'))[0]!.id;
  await f.db.execute('INSERT OR REPLACE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json) VALUES(?,.481124,1791760226808,9776,\'original-position-hash\',NULL)',[item]);
  await f.db.execute('UPDATE articles SET reading_progress=.481124,is_read=? WHERE id=?',[isRead?1:0,item]);
  const reading=()=>f.db.query('SELECT progress,changed_at,position_bytes,position_hash,state_json FROM article_reading_state WHERE article_id=?',[item]);
  const before=await reading();
  for(const body of ['updated RSS body','updated RSS body','another RSS body']){
   await f.adapter.mergeInventory(inventory(body));
   expect(await reading()).toEqual(before);
   expect((await f.db.query('SELECT content,reading_progress,is_read FROM articles WHERE id=?',[item]))[0]).toEqual({content:body,reading_progress:.481124,is_read:isRead?1:0});
  }
 }finally{f.sql.close();}
});
test('public RSS refresh preserves legacy article progress before a structured reading row exists',async()=>{
 const f=await dbFixture();try{
  await f.adapter.mergeInventory(inventory('old body'));
  await f.db.execute('DELETE FROM article_reading_state');
  await f.db.execute('UPDATE articles SET reading_progress=.75,is_read=1');
  await f.adapter.mergeInventory(inventory('new body'));
  expect((await f.db.query('SELECT reading_progress,is_read FROM articles'))[0]).toEqual({reading_progress:.75,is_read:1});
  expect((await f.db.query('SELECT progress,changed_at,position_bytes,position_hash FROM article_reading_state'))[0]).toEqual({progress:.75,changed_at:0,position_bytes:0,position_hash:''});
 }finally{f.sql.close();}
});
test('new public RSS rows initialize empty reading state, then an explicit unread operation survives refresh',async()=>{
 const f=await dbFixture();try{
  await f.adapter.mergeInventory(inventory('first body'));
  expect((await f.db.query('SELECT progress,changed_at,position_bytes,position_hash FROM article_reading_state'))[0]).toEqual({progress:0,changed_at:0,position_bytes:0,position_hash:''});
  await f.db.execute("UPDATE article_reading_state SET changed_at=200,position_bytes=42,position_hash='unread-anchor'");
  await f.adapter.mergeInventory(inventory('different body'));
  expect((await f.db.query('SELECT progress,changed_at,position_bytes,position_hash FROM article_reading_state'))[0]).toEqual({progress:0,changed_at:200,position_bytes:42,position_hash:'unread-anchor'});
 }finally{f.sql.close();}
});
for(const isRead of [false,true])test(`normal cloud records replay repairs an old body rewind without replacing newer local reading (${isRead})`,async()=>{
 const f=await dbFixture();try{
  await f.adapter.mergeInventory(inventory('original body'));
  await f.db.execute("UPDATE article_reading_state SET progress=.481124,changed_at=200,position_bytes=9776,position_hash='original-anchor'");
  await f.db.execute('UPDATE articles SET reading_progress=.481124,is_read=?',[isRead?1:0]);
  const records=(await f.adapter.exportRecords()).filter(r=>r.kind==='rss-state');expect(records).toHaveLength(1);
  await f.adapter.applyRecords(records);
  // Reproduce the already-shipped receiver's partial rewind, not a new user action.
  await f.db.execute("UPDATE article_reading_state SET progress=0,position_bytes=0,position_hash=''");
  await f.db.execute('UPDATE articles SET reading_progress=0');
  await f.adapter.applyRecords(records);
  expect((await f.db.query('SELECT progress,changed_at,position_bytes,position_hash FROM article_reading_state'))[0]).toEqual({progress:Math.fround(records[0]!.value.readingProgress),changed_at:200,position_bytes:9776,position_hash:'original-anchor'});
  expect((await f.db.query('SELECT is_read FROM articles'))[0]).toEqual({is_read:isRead?1:0});
  await f.db.execute("UPDATE article_reading_state SET progress=.25,changed_at=201,position_bytes=3,position_hash='newer-local'");
  await f.db.execute('UPDATE articles SET reading_progress=.25');
  await f.adapter.applyRecords(records);
  expect((await f.db.query('SELECT progress,changed_at,position_bytes,position_hash FROM article_reading_state'))[0]).toEqual({progress:.25,changed_at:201,position_bytes:3,position_hash:'newer-local'});
 }finally{f.sql.close();}
});
