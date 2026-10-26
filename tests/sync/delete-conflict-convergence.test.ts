import {test,expect} from 'bun:test';
import {fixture,article,sha} from './ble-v2-fixture';
import {deviceOrder} from '../../src/sync/saved-state';

test('cancelled RSS save is a live state record, never an article deletion in the manifest or payload',async()=>{const f=await fixture();try{
 const url='https://example.com/cancelled',id=sha(url);
 await f.db.execute("INSERT INTO sync_saved_states(article_id,save_type,url,saved,changed_at,sort_order,source_device_id,source_order) VALUES(?,'favorite',?,0,200,0,'watch',?)",[id,url,deviceOrder('watch')]);
 const window=await f.repo.prepareWindow('phone',0),m=window.fullArticleManifest.find(a=>a.articleId===id)!;expect(m).toBeDefined();expect(m.deleted).toBe(false);expect(m.deletedAt).toBe(0);expect(m.favoriteChangedAt).toBe(200);
 const body=(await f.repo.exportRequested([{articleId:id,bodyHash:'',chunkIndexes:[],metadataOnly:false}],'phone'))[0]!;expect(body.article.deleted).toBe(false);expect(body.article.deletedAt).toBe(0);expect(body.manifest.deleted).toBe(body.article.deleted);
 }finally{f.sql.close();}});

test('a resolved keep consumes the old tombstone, survives restart, and rejects delayed delete replay',async()=>{const f=await fixture();try{
 const kept=article({updatedAt:400,independentChangedAt:400}),oldDelete=article({deleted:true,deletedAt:200,updatedAt:200,independentSaved:false,independentChangedAt:200});
 await f.repo.receiveArticle(await f.packet(oldDelete),'phone',false);expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest[0]!.deleted).toBe(true);
 await f.repo.receiveArticle(await f.packet(kept),'phone',false);expect(await f.db.query('SELECT * FROM sync_article_deletions')).toEqual([]);
 const {SqlLibrarySessionRepository}=await import('../../src/sync/library-repository');const restarted=new SqlLibrarySessionRepository(f.db,f.ports);
 for(let i=0;i<3;i++){expect(await restarted.receiveArticle(await f.packet(oldDelete),'phone',false)).toBe(0);const m=(await restarted.prepareWindow('phone',0)).fullArticleManifest.find(x=>x.articleId===kept.articleId)!;expect(m.deleted).toBe(false);expect(m.updatedAt).toBe(400);}
 const newerDelete={...oldDelete,updatedAt:500,deletedAt:500,independentChangedAt:500};expect(await restarted.receiveArticle(await f.packet(newerDelete),'phone',false)).toBeGreaterThan(0);
 expect(await restarted.receiveArticle(await f.packet(kept),'phone',false)).toBe(0);expect((await restarted.prepareWindow('phone',0)).fullArticleManifest.find(x=>x.articleId===kept.articleId)!.deleted).toBe(true);
 }finally{f.sql.close();}});

test('a concurrent deletion cannot be consumed by an in-flight keep prepared before that deletion',async()=>{const f=await fixture();try{
 const kept=article({updatedAt:400,independentChangedAt:400}),packet=await f.packet(kept),commit=f.db.transactionChanges!;let injected=false;
 f.db.transactionChanges=async ss=>{if(!injected&&ss.some(s=>s.sql.startsWith('DELETE FROM sync_article_deletions'))){injected=true;await f.db.execute('INSERT INTO sync_article_deletions(article_id,url,changed_at,source_device_id,source_order) VALUES(?,?,500,?,?)',[kept.articleId,kept.url,'phone',deviceOrder('phone')]);}return commit(ss);};
 await expect(f.repo.receiveArticle(packet,'phone',false)).rejects.toThrow();expect(await f.db.query('SELECT changed_at FROM sync_article_deletions')).toEqual([{changed_at:500}]);expect(await f.db.query('SELECT * FROM articles')).toEqual([]);
 }finally{f.sql.close();}});

test('full manifests do not reintroduce an older alternate URL ID deletion after a durable keep decision',async()=>{const f=await fixture();try{
 const url='https://example.com/private',kept=article({updatedAt:400,independentChangedAt:400}),legacy=sha('older URL spelling');await f.repo.receiveArticle(await f.packet(kept),'phone',false);
 await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,url,200,'phone',deviceOrder('phone')]);await f.db.execute("INSERT INTO sync_saved_states(article_id,save_type,url,saved,changed_at,sort_order,source_device_id,source_order) VALUES(?,'favorite',?,0,200,0,'phone',?)",[legacy,url,deviceOrder('phone')]);
 const {SqlLibrarySessionRepository}=await import('../../src/sync/library-repository');for(let i=0;i<3;i++){const fresh=new SqlLibrarySessionRepository(f.db,f.ports),full=(await fresh.prepareWindow('phone',0)).fullArticleManifest;expect(full.some(r=>r.articleId===legacy)).toBe(false);expect(full.find(r=>r.articleId===kept.articleId)?.deleted).toBe(false);}
 // Suppression is derived from the accepted keep, not destructive journal cleanup.
 expect(await f.db.query('SELECT changed_at FROM sync_article_deletions')).toEqual([{changed_at:200}]);
 await f.db.execute('UPDATE sync_article_deletions SET changed_at=500');expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest.find(r=>r.articleId===legacy)?.deleted).toBe(true);
 }finally{f.sql.close();}});
test('an unverified feed timestamp never suppresses an old-ID deletion',async()=>{const f=await fixture();try{
 const a=article({updatedAt:400,independentChangedAt:400}),legacy=sha('old id');await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','feed-only',1)");await f.db.execute("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,'unverified','feed body',?,?,400)",[a.url,a.articleId]);await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,a.url,200,'phone',deviceOrder('phone')]);expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest.find(r=>r.articleId===legacy)?.deleted).toBe(true);
 }finally{f.sql.close();}});
test('same-URL RSS rows with distinct canonical pool identities keep the deletion visible',async()=>{const f=await fixture();try{
 const a=article({rssSourceUrl:'https://one.example/rss',updatedAt:400,independentChangedAt:400}),b=article({articleId:sha('second-row'),rssSourceUrl:'https://two.example/rss',updatedAt:400,independentChangedAt:400});await f.repo.receiveArticle(await f.packet(a),'phone',false);await f.repo.receiveArticle(await f.packet(b),'phone',false);
 const rows=await f.db.query('SELECT id FROM articles ORDER BY id');expect(rows).toHaveLength(2);for(let i=0;i<rows.length;i++)await f.db.execute('INSERT INTO cloud_rss_article_ids VALUES(?,?)',[rows[i]!.id,sha('pool-'+i)]);
 const legacy=sha('legacy-deletion');await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,a.url,200,'phone',deviceOrder('phone')]);expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest.find(r=>r.articleId===legacy)?.deleted).toBe(true);
 }finally{f.sql.close();}});
test('a unique authoritative RSS pool identity supersedes its older normalized-URL deletion alias',async()=>{const f=await fixture();try{
 const url='https://www.example.com/private',canonical=sha(url),legacy=sha('https://example.com/private'),a=article({articleId:canonical,url,rssSourceUrl:'https://feed.test/rss',independentSaved:false,independentChangedAt:0,favoriteSaved:false,favoriteChangedAt:400,updatedAt:400});f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});await f.repo.receiveArticle(await f.packet(a),'phone',false);const item=(await f.db.query('SELECT id FROM articles'))[0]!.id;await f.db.execute('INSERT OR REPLACE INTO cloud_rss_article_ids VALUES(?,?)',[item,canonical]);await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,url,200,'phone',deviceOrder('phone')]);
 for(let i=0;i<3;i++){const {SqlLibrarySessionRepository}=await import('../../src/sync/library-repository'),repo=new SqlLibrarySessionRepository(f.db,f.ports);repo.configurePeer('phone',{supportsRssCanonicalIds:true});const full=(await repo.prepareWindow('phone',0)).fullArticleManifest;expect(full.some(r=>r.articleId===legacy)).toBe(false);expect(full.find(r=>r.articleId===canonical)?.deleted).toBe(false);}
 }finally{f.sql.close();}});

test('R47.1 projection rebuild retains prior keep receipts and does not revive alternate-ID tombstones',async()=>{
 const {DOMAIN_ENCODERS}=await import('../../src/sync/domain-definitions'),{SqlLibrarySessionRepository}=await import('../../src/sync/library-repository');
 const encoder=DOMAIN_ENCODERS.library,f=await fixture();try{
  const url='https://www.example.com/private',canonical=sha(url),legacy=sha('https://example.com/private');
  const a=article({articleId:canonical,url,rssSourceUrl:'https://feed.test/rss',independentSaved:false,independentChangedAt:0,favoriteSaved:false,favoriteChangedAt:400,updatedAt:400});
  f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});await f.repo.receiveArticle(await f.packet(a),'phone',false);
  const item=(await f.db.query('SELECT id FROM articles'))[0]!.id;
  await f.db.execute('INSERT OR REPLACE INTO cloud_rss_article_ids VALUES(?,?)',[item,canonical]);
  await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,url,200,'phone',deviceOrder('phone')]);
  const business=()=>f.db.query('SELECT * FROM sync_article_deletions');const before=await business();
  for(const upgrade of [false,true,false]){
   if(upgrade)DOMAIN_ENCODERS.library++;
   const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer('phone',{supportsRssCanonicalIds:true});
   const w=await r.prepareWindow('phone',0);
   expect(w.fullArticleManifest.some(m=>m.articleId===legacy)).toBe(false);
   const kept=w.fullArticleManifest.find(m=>m.articleId===canonical)!;expect(kept.deleted).toBe(false);expect(kept.deletedAt).toBe(0);expect(kept.updatedAt).toBe(400);
   expect(await business()).toEqual(before);
  }
 }finally{DOMAIN_ENCODERS.library=encoder;f.sql.close();}
});

test('one-URL snapshot reads only its keep proofs while preserving alias suppression and other receipts',async()=>{
 const f=await fixture();try{
  const kept=article({updatedAt:400,independentChangedAt:400}),legacy=sha('old alias');
  await f.repo.receiveArticle(await f.packet(kept),'phone',false);
  await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,kept.url,200,'phone',deviceOrder('phone')]);
  for(let i=0;i<420;i++)await f.db.transaction([
   {sql:'INSERT INTO sync_article_keeps VALUES(?,?,400,?,?,NULL)',params:['unrelated-'+i,'https://unrelated.test/'+i,'phone',deviceOrder('phone')]},
   {sql:'INSERT INTO sync_article_keep_aliases VALUES(?,?,?)',params:['unrelated-'+i,'unrelated-'+i,'https://unrelated.test/'+i]},
  ]);
  const {LocalArticleManifestStore}=await import('../../src/sync/local-manifest');
  const store=new LocalArticleManifestStore(f.db,f.ports.codec,f.ports.text,f.ports.files,f.ports.migrateReading);
  const full=await store.snapshot(true,true),query=f.db.query.bind(f.db);let proofRows=0;
  f.db.query=async(q,p)=>{const rows=await query(q,p);if(q.includes('SELECT a.alias_id AS article_id,k.url,k.changed_at'))proofRows+=rows.length;return rows;};
  const partial=await store.snapshot(true,true,false,undefined,[kept.url]);
  expect(partial.map(p=>p.manifest)).toEqual(full.filter(p=>p.article.url===kept.url).map(p=>p.manifest));
  expect(partial.some(p=>p.manifest.articleId===legacy)).toBe(false);expect(proofRows).toBeLessThan(10);
  expect((await query("SELECT COUNT(*) n FROM sync_article_keeps WHERE article_id LIKE 'unrelated-%'"))[0]!.n).toBe(420);
 }finally{f.sql.close();}
});
