import {test,expect} from 'bun:test';
import {dbFixture,article} from './library-fixture';

test('no-change cloud merge preserves guarded snapshot; actual and independent changes still invalidate',async()=>{
 const f=await dbFixture();try{
  const item=article();await f.repo.mergeCloud([], [item], 'phone');let bodyProbes=0;const query=f.db.query.bind(f.db);f.db.query=async(q,p)=>{if(q.includes('AS has_original_chunks'))bodyProbes++;return query(q,p);};
  const first=await f.repo.cloudSnapshot(false);expect(first.articles).toHaveLength(1);const warm=bodyProbes;expect(warm).toBeGreaterThan(0);
  expect(await f.repo.mergeCloud([], [], 'cloud-records')).toBe(0);expect(await f.repo.cloudSnapshot(false)).toEqual(first);expect(bodyProbes).toBe(warm);
  await f.db.execute("UPDATE articles SET title='Independent newer title' WHERE id=(SELECT item_id FROM sync_article_ids WHERE article_id='a')");expect((await f.repo.cloudSnapshot(false)).articles[0]?.title).toBe('Independent newer title');expect(bodyProbes).toBeGreaterThan(warm);
  expect(await f.repo.mergeCloud([], [article({title:'Remote newest title',updatedAt:200})], 'phone')).toBeGreaterThan(0);expect((await f.repo.cloudSnapshot(false)).articles[0]?.title).toBe('Remote newest title');
 }finally{f.sql.close();}
});
