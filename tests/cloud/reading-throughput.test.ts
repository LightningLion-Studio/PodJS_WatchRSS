import {test,expect} from 'bun:test';
import {readingThroughputFixture} from './reading-throughput-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {cloudCrypto} from './library-fixture';
import {enabled,crypto} from './k2-crypto';
import {utf8Encode} from '../../src/cloud/types';

test('1178 RSS replay reuses one identity catalogue, batches live metadata and never reads/encodes bodies or all book mappings',async()=>{
 const f=await readingThroughputFixture(320);try{let warms=0,body=0;const query=f.db.query.bind(f.db),events:any[]=[];
 const db={...f.db,query:async(q:string,p:any=[])=>{if(q.includes('NOT (k.item_id IS NOT NULL'))warms++;if(q.includes('SELECT m.* FROM sync_book_aliases'))throw Error('whole book mapping');return query(q,p);}};
 const repo=new SqlLibrarySessionRepository(db,{...f.ports,diagnostic:e=>events.push(e),codec:{...f.ports.codec,encode:async()=>{body++;throw Error('encode forbidden');},decode:async()=>{body++;throw Error('decode forbidden');}},files:{...f.ports.files,hydrate:async()=>{body++;throw Error('hydrate forbidden');}}}),adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);
 await adapter.applyRecords(f.metadata);const warmStart=warms;for(let n=0;n<320;n+=20)await adapter.applyRecords(f.docs.slice(n,n+20));
 expect(warms-warmStart).toBeLessThanOrEqual(1);expect(body).toBe(0);expect((await query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(6542);expect((await query('SELECT COUNT(*) n FROM article_reading_state WHERE changed_at>=100'))[0].n).toBe(320);expect(events.some(e=>e.stage==='prepareFastProjection')).toBe(false);
 const row=(await query('SELECT r.*,a.is_read FROM article_reading_state r JOIN articles a ON a.id=r.article_id WHERE r.article_id=3496'))[0];expect(row).toMatchObject({progress:.75,changed_at:100,is_read:1,position_bytes:3,position_hash:'synthetic-anchor'});
 }finally{f.sql.close();}
},30000);

test('candidate catalogue observes new identity rows and live SQL refuses older remote clocks, including writes after commit',async()=>{
 const f=await readingThroughputFixture(2);try{
  await f.adapter.applyRecords(f.docs.slice(0,1));await f.db.execute("UPDATE article_reading_state SET progress=.9,changed_at=9999,state_json='native-opaque' WHERE article_id=3496");
  await f.adapter.applyRecords([{kind:'rss-state',value:{...f.docs[0].value,readingProgress:.2,readingPositionChangedAt:500}}]);expect((await f.db.query('SELECT progress,changed_at,state_json FROM article_reading_state WHERE article_id=3496'))[0]).toMatchObject({changed_at:9999,state_json:'native-opaque'});
  await f.db.execute("UPDATE articles SET guid='new-guid',dedup_key='new-guid' WHERE id=3497");const {rssArticleId}=await import('../../src/cloud/rss-identity'),id=await rssArticleId({guid:'new-guid'},crypto.sha256);
  await f.adapter.applyRecords([{kind:'rss-state',value:{...f.docs[1].value,articleIdHash:await crypto.sha256(utf8Encode(id))}}]);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=3497'))[0].changed_at).toBe(101);
 }finally{f.sql.close();}
},30000);

test('reading transaction is atomic on storage failure, and an identity edit immediately after commit invalidates the catalogue',async()=>{
 const f=await readingThroughputFixture(3);try{
  await f.adapter.applyRecords(f.docs.slice(0,1));const transaction=f.db.transactionChanges!.bind(f.db);let armed=true;
  f.db.transactionChanges=async ss=>{const result=await transaction(ss);if(armed&&ss.some(s=>s.sql.startsWith('INSERT INTO cloud_reading_commit'))){armed=false;await f.db.execute("UPDATE articles SET guid='after-commit',dedup_key='after-commit' WHERE id=3498");}return result;};
  await f.adapter.applyRecords(f.docs.slice(1,2));expect(armed).toBe(false);
  const {rssArticleId}=await import('../../src/cloud/rss-identity'),id=await rssArticleId({guid:'after-commit'},crypto.sha256);
  await f.adapter.applyRecords([{kind:'rss-state',value:{...f.docs[2].value,articleIdHash:await crypto.sha256(utf8Encode(id))}}]);expect((await f.db.query('SELECT changed_at FROM article_reading_state WHERE article_id=3498'))[0].changed_at).toBe(102);
  const before=f.sql.serialize();f.fail();await expect(f.adapter.applyRecords([{kind:'rss-state',value:{...f.docs[0].value,readingPositionChangedAt:10000}}])).rejects.toThrow('disk fault');expect(f.sql.serialize()).toEqual(before);
 }finally{f.sql.close();}
},30000);

test('body-free clock/save conflict decisions match the existing receiver while preserving the accepted body witness',async()=>{
 const {dbFixture}=await import('./library-fixture');
 for(const [clock,source,isRead]of [[10,'phone',true],[30,'phone',true],[20,'zz',true],[20,'aa',true],[20,'watch',false],[20,'watch',true]] as const){
  const fixtures=await Promise.all([dbFixture(),dbFixture()]);try{
   for(const f of fixtures){await f.adapter.mergeInventory({url:'https://diff.invalid/rss',title:'Feed',items:[{url:'https://diff.invalid/item',guid:'diff-guid',title:'Item',excerpt:'Preview',contentHtml:null,contentText:'Original body',imageUrl:null,contentHash:null}]} as any);await f.db.execute("INSERT OR REPLACE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash,state_json) VALUES(1,.8,20,8,'native','opaque')");await f.db.execute('UPDATE articles SET is_read=1,reading_progress=.8 WHERE id=1');}
   const [fast,legacy]=fixtures,witness=await fast.db.query('SELECT * FROM article_sync_content');
   for(let n=0;n<2;n++){const f=fixtures[n],candidate=(await f.repo.cloudReadingCandidates())[0],a={...candidate,isRead,readingProgress:.4,readingPositionBytes:4,readingPositionContentHash:'remote',readingPositionChangedAt:clock,sourceDeviceId:source,favoriteSaved:true,favoriteChangedAt:31,favoriteSortOrder:7};if(n===0)await f.repo.mergeCloudReading([a]);else await f.repo.mergeCloud([], [a],'cloud-records');}
   for(const q of ['SELECT * FROM article_reading_state','SELECT is_read,reading_progress FROM articles','SELECT save_type,saved,changed_at,sort_order,source_device_id FROM sync_saved_states ORDER BY save_type'])expect(await fast.db.query(q),q).toEqual(await legacy.db.query(q));expect(await fast.db.query('SELECT * FROM article_sync_content')).toEqual(witness);
  }finally{for(const f of fixtures)f.sql.close();}
 }
},30000);

test('the production legacy KV migration joins the guarded reading transaction and preserves newer opaque native state',async()=>{
 const f=await readingThroughputFixture(1);try{
  const {SqlReadingProgressStore}=await import('../../src/reader/sql-progress'),{ReadingProgressStore}=await import('../../src/reader/progress');const legacy=new ReadingProgressStore({get:async k=>k==='watchrss.reader.progress.3496'?JSON.stringify({offset:42,progress:.9,updatedAt:9999,textAnchor:{character:5,fraction:.3}}):null,set:async()=>{}}),progress=new SqlReadingProgressStore(f.db,legacy),repo=new SqlLibrarySessionRepository(f.db,{...f.ports,prepareReadingMigration:ids=>progress.migrationStatements(ids)}),adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);
  await adapter.applyRecords(f.docs);const row=(await f.db.query('SELECT * FROM article_reading_state WHERE article_id=3496'))[0];expect(row.changed_at).toBe(9999);expect(Number(row.progress)).toBeCloseTo(.9);expect(JSON.parse(String(row.state_json))).toMatchObject({offset:42,updatedAt:9999,textAnchor:{character:5,fraction:.3}});
 }finally{f.sql.close();}
},30000);
