import {test,expect} from 'bun:test';
import {dbFixture} from './library-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';

test('cloud reading reuses the durable projection across restart and independent reading edits without encoding cancelled bodies',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://projection.example/rss','Feed',1,1)");
  f.sql.transaction(()=>{const a=f.sql.prepare("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,1,'Item','body',?,?,?,1)"),s=f.sql.prepare("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,'favorite',0,20,2)");for(let i=1;i<=638;i++){a.run(i,'https://projection.example/'+i,'guid-'+i,'guid-'+i);s.run(i);}})();
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(639,1,'Unsaved','body','https://projection.example/639','guid-639','guid-639',1)");
  const first=await f.repo.cloudReadingCandidates();expect(first).toHaveLength(639);
  let encodes=0;const ports={...f.ports,codec:{...f.ports.codec,encode:async(body:Parameters<typeof f.ports.codec.encode>[0])=>{encodes++;return f.ports.codec.encode(body);}}};
  const restarted=new SqlLibrarySessionRepository(f.db,ports);expect(await restarted.cloudReadingCandidates()).toEqual(first);expect(encodes).toBe(0);
  await f.db.execute('INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(639,.75,40,8,\'hash\')');
  const edited=await restarted.cloudReadingCandidates();expect(edited.find(a=>a.url.endsWith('/639'))).toMatchObject({readingProgress:.75,readingPositionChangedAt:40,readingPositionBytes:8,readingPositionContentHash:'hash'});expect(encodes).toBe(0);
  await f.db.execute("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(638,.5,50,4,'new')");await restarted.cloudReadingCandidates();expect(encodes).toBe(1);
 }finally{f.sql.close();}
});

test('persisted reading projection materializes saved clocks and sort orders from full metadata',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://projection.example/rss','Feed',1,1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(1,1,'Saved','body','https://projection.example/one','one','one',1)");
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(1,'favorite',1,42,7),(1,'watchLater',1,55,9)");
  await f.db.execute("INSERT INTO article_saved_entry_times(article_id,save_type,created_at) VALUES(1,'favorite',42),(1,'watchLater',55)");
  const first=await f.repo.cloudReadingCandidates();const row=first[0]!;expect(row).toMatchObject({favoriteSaved:true,favoriteChangedAt:42,favoriteSortOrder:42,watchLaterSaved:true,watchLaterChangedAt:55,watchLaterSortOrder:55});
  const restarted=new SqlLibrarySessionRepository(f.db,f.ports);expect(await restarted.cloudReadingCandidates()).toEqual(first);
 }finally{f.sql.close();}
});

test('canonical reading lookup keeps independent save types for same-URL distinct RSS GUIDs',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://projection.example/rss','Feed',1,1)");
  for(const [id,guid,type,clock]of [[1,'alpha','favorite',42],[2,'beta','watchLater',55]]as const){await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,1,'Saved','body','https://projection.example/shared',?,?,1)",[id,guid,guid]);await f.db.execute('INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(?,?,1,?,1)',[id,type,clock]);await f.db.execute('INSERT INTO article_saved_entry_times(article_id,save_type,created_at) VALUES(?,?,?)',[id,type,clock]);}
  const {rssArticleId}=await import('../../src/cloud/rss-identity'),{cloudCrypto}=await import('./library-fixture');const alpha=await rssArticleId({guid:'alpha'},cloudCrypto.sha256),beta=await rssArticleId({guid:'beta'},cloudCrypto.sha256);
  for(const repo of [f.repo,new SqlLibrarySessionRepository(f.db,f.ports)]){const rows=await repo.cloudReadingCandidates();expect(rows.find(a=>a.articleId===alpha)).toMatchObject({favoriteSaved:true,favoriteChangedAt:42,watchLaterSaved:false});expect(rows.find(a=>a.articleId===beta)).toMatchObject({favoriteSaved:false,watchLaterSaved:true,watchLaterChangedAt:55});}
 }finally{f.sql.close();}
});
