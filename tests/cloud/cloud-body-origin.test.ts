import {expect,test} from 'bun:test';
import {article,dbFixture} from './library-fixture';
import {stableArticleId} from '../../src/sync/local-manifest';

test('uninitialized cloud reading metadata preserves the body source across publish and own-record replay',async()=>{
 const f=await dbFixture();
 try{
  const incoming=article({readingPositionChangedAt:0,readingPositionBytes:0,readingPositionContentHash:'',readingProgress:0,isRead:false});
  incoming.articleId=await stableArticleId(incoming.url,f.ports.text.parseUri,f.ports.codec);
  await f.repo.mergeCloud([], [incoming], 'phone');
  const row=(await f.db.query('SELECT reading_clock,reading_source FROM cloud_article_state'))[0]!;
  expect(row.reading_clock).toBe(0);expect(row.reading_source).toBe('');
  const full=await f.repo.cloudSnapshot(true);
  expect(full.articles[0]!.sourceDeviceId).toBe(incoming.sourceDeviceId);
  const docs=await f.adapter.exportRecords(),doc=docs.find(d=>d.kind==='article')!;
  expect(doc.value.sourceDeviceId.length).toBeGreaterThan(0);
  await expect(f.adapter.applyRecords([doc])).resolves.toBeGreaterThanOrEqual(0);
  expect((await f.repo.cloudSnapshot(true)).pendingPrivateBodies).toBe(false);
  expect((await f.db.query('SELECT COUNT(*) AS n FROM articles'))[0]!.n).toBe(1);
 }finally{f.sql.close();}
});
