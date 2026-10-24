import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {fixture,article,sha} from './ble-v2-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {DOMAIN_ENCODERS} from '../../src/sync/domain-definitions';
import {buildManifestResponse,buildManifestFrames,combineManifestFrames} from '../../src/sync/library-wire';
import {encodeFrame} from '../../src/sync/protocol';
import {deviceOrder} from '../../src/sync/saved-state';
const vectors=JSON.parse(await readFile(new URL('../fixtures/conflict-resolution/resolved-delete-conflicts-v1.json',import.meta.url),'utf8')) as {cases:{name:string;url:string;feed:string;canonicalId:string;legacyId:string;deletedAt:number;keptAt:number}[]};
function asWire(frames:ReturnType<typeof buildManifestFrames>){return combineManifestFrames(frames.map(f=>JSON.parse(new TextDecoder().decode(encodeFrame(f).subarray(4)))));}
test('five resolved keep decisions atomically retire legacy tombstones, survive full wire resync/cache loss/restart/upgrade, and reject old delete replay',async()=>{
 const f=await fixture(),encoder=DOMAIN_ENCODERS.library;try{
 f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});
 for(const c of vectors.cases){
  expect(sha(c.url)).toBe(c.canonicalId);expect(sha(c.url.replace('://www.', '://'))).toBe(c.legacyId);
  const old=article({articleId:c.legacyId,url:c.url,sourceDeviceId:'watch',deleted:true,deletedAt:c.deletedAt,updatedAt:c.deletedAt,independentSaved:false,independentChangedAt:c.deletedAt,favoriteChangedAt:c.deletedAt});
  await f.repo.receiveArticle(await f.packet(old),'phone',false);
  // The actual decisions are live cancellation records with no retained lists.
  // A verified empty body must still persist a keep decision independently.
  const kept=article({articleId:c.canonicalId,legacyArticleIds:[c.legacyId],url:c.url,rssSourceUrl:c.feed,sourceDeviceId:'phone',contentHtml:null,contentText:'',independentSaved:false,independentChangedAt:0,favoriteSaved:false,favoriteChangedAt:c.keptAt,watchLaterSaved:false,watchLaterChangedAt:0,deleted:false,deletedAt:0,updatedAt:c.keptAt});
  await f.repo.receiveArticle(await f.packet(kept),'phone',false);
 }
 expect(await f.db.query('SELECT article_id FROM sync_article_deletions')).toEqual([]);
 expect(await f.db.query('SELECT article_id FROM sync_article_keeps')).toHaveLength(5);
 expect(await f.db.query('SELECT alias_id FROM sync_article_keep_aliases')).toHaveLength(10);
 const decisions=await f.db.query('SELECT * FROM sync_article_keeps ORDER BY article_id'),aliases=await f.db.query('SELECT * FROM sync_article_keep_aliases ORDER BY alias_id');
 await f.db.execute('DELETE FROM article_sync_encoding_cache');await f.db.execute('DELETE FROM article_sync_content');DOMAIN_ENCODERS.library++;
 for(let round=0;round<3;round++){
  const fresh=new SqlLibrarySessionRepository(f.db,f.ports);fresh.configurePeer('phone',{supportsRssCanonicalIds:true});
  const w=await fresh.prepareWindow('phone',0);expect(w.fullSnapshot).toBe(true);
  const packet=asWire(buildManifestFrames(buildManifestResponse('watch',w.fullArticleManifest,[],w.rssSources,0,w,()=>1000)));
  const entries=packet.articleManifest as {articleId:string;deleted:boolean;deletedAt:number}[];
  for(const c of vectors.cases){expect(entries.some(m=>m.articleId===c.legacyId)).toBe(false);const keep=entries.find(m=>m.articleId===c.canonicalId)!;expect(keep.deleted).toBe(false);expect(keep.deletedAt).toBe(0);expect((keep as any).updatedAt).toBe(c.keptAt);
   const old=article({articleId:c.legacyId,url:c.url,deleted:true,deletedAt:c.deletedAt,updatedAt:c.deletedAt,independentSaved:false,independentChangedAt:c.deletedAt,favoriteChangedAt:c.deletedAt});
   expect(await fresh.receiveArticle(await f.packet(old),'phone',false)).toBe(0);
  }
  expect(await f.db.query('SELECT * FROM sync_article_keeps ORDER BY article_id')).toEqual(decisions);expect(await f.db.query('SELECT * FROM sync_article_keep_aliases ORDER BY alias_id')).toEqual(aliases);
 }
 // Later, genuine user deletion remains effective; the keep is not permanent immunity.
 const c=vectors.cases[0]!,later=c.keptAt+1000;
 expect(await f.repo.receiveArticle(await f.packet(article({articleId:c.legacyId,url:c.url,deleted:true,deletedAt:later,updatedAt:later,independentSaved:false,independentChangedAt:later,favoriteChangedAt:later})),'phone',false)).toBeGreaterThan(0);
 expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest.find(m=>m.articleId===c.legacyId)?.deleted).toBe(true);
 }finally{DOMAIN_ENCODERS.library=encoder;f.sql.close();}
});
test('keep receipt and alias retirement roll back with a failed article transaction',async()=>{const f=await fixture();try{
 const c=vectors.cases[0]!;await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[c.legacyId,c.url,c.deletedAt,'watch',deviceOrder('watch')]);const transaction=f.db.transactionChanges!;
 f.db.transactionChanges=async()=>{throw Error('failed commit');};
 await expect(f.repo.receiveArticle(await f.packet(article({articleId:c.canonicalId,legacyArticleIds:[c.legacyId],url:c.url,updatedAt:c.keptAt,independentChangedAt:c.keptAt})),'phone',false)).rejects.toThrow('failed commit');
 f.db.transactionChanges=transaction;expect(await f.db.query('SELECT * FROM sync_article_keeps')).toEqual([]);expect(await f.db.query('SELECT article_id FROM sync_article_deletions')).toEqual([{article_id:c.legacyId}]);
 }finally{f.sql.close();}});

import {ArticleBatchReceiver} from '../../src/sync/article-batches';
import {initializeSchema,SCHEMA_VERSION} from '../../src/core/schema';
const phoneVectors=JSON.parse(await readFile(new URL('../fixtures/conflict-resolution/conflict-resolution-v1.json',import.meta.url),'utf8')) as {cases:{name:string;watch:Parameters<typeof article>[0];expected:{deleted:boolean;updatedAt:number}}[]};
for(const c of phoneVectors.cases)test('actual Kotlin encoded decision is durable on watch after replay/restart/upgrade: '+c.name,async()=>{
 const f=await fixture(),encoder=DOMAIN_ENCODERS.library;try{
 const frame=JSON.parse(await readFile(new URL('../fixtures/conflict-resolution/wire/'+c.name+'.json',import.meta.url),'utf8'));
 await f.repo.receiveArticle(await f.packet(article(c.watch)),'test-phone',false);
 for(let round=0;round<3;round++){
  if(round===1){await f.db.execute('DELETE FROM article_sync_encoding_cache');await f.db.execute('DELETE FROM article_sync_content');DOMAIN_ENCODERS.library++;}
  const fresh=new SqlLibrarySessionRepository(f.db,f.ports),receiver=new ArticleBatchReceiver([{articleId:frame.articles[0].articleId,bodyHash:frame.articles[0].body.bodyHash,chunkIndexes:[],metadataOnly:false}],entry=>fresh.receiveArticle(entry,'test-phone',false).then(()=>{}));
  await receiver.consume(frame);receiver.finish();
  // These synthetic Kotlin IDs are opaque; the old native independent-item
  // export normalizes the URL ID. Assert received decision durability at the
  // original ID and semantic wire state at its deterministic native URL ID.
  const w=await fresh.prepareWindow('test-phone',0),m=w.fullArticleManifest.find(m=>m.articleId===frame.articles[0].articleId||m.articleId===sha(frame.articles[0].url))!;
  expect(m.deleted).toBe(c.expected.deleted);
  if(c.expected.deleted)expect(m.updatedAt).toBe(c.expected.updatedAt);
  else {expect(m.favoriteChangedAt).toBe(frame.articles[0].favoriteChangedAt);expect(m.watchLaterChangedAt).toBe(frame.articles[0].watchLaterChangedAt);}
  if(!c.expected.deleted){const receipt=(await f.db.query('SELECT changed_at FROM sync_article_keeps WHERE article_id=?',[frame.articles[0].articleId]))[0]!;expect(Number(receipt.changed_at)).toBe(c.expected.updatedAt);expect(m.deletedAt).toBe(0);}
 }
 }finally{DOMAIN_ENCODERS.library=encoder;f.sql.close();}
});
test('v7 migration seeds only verified received keep provenance and survives later cache erasure',async()=>{const f=await fixture();try{
 const kept=article({updatedAt:400,independentChangedAt:400});await f.repo.receiveArticle(await f.packet(kept),'phone',false);
 await f.db.transaction([{sql:'DROP TABLE sync_article_keep_aliases'},{sql:'DROP TABLE sync_article_keeps'},{sql:'DROP TABLE sync_article_keep_migration'},{sql:'PRAGMA user_version=7'}]);
 await initializeSchema(f.db,{seedBuiltinChannels:false});expect((await f.db.query('PRAGMA user_version'))[0]!.user_version).toBe(SCHEMA_VERSION);expect(await f.db.query('SELECT changed_at FROM sync_article_keeps')).toEqual([{changed_at:400}]);
 await f.db.execute('DELETE FROM article_sync_encoding_cache');await f.db.execute('DELETE FROM article_sync_content');
 const legacy=sha('old alias');await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[legacy,kept.url,200,'phone',deviceOrder('phone')]);
 const r=new SqlLibrarySessionRepository(f.db,f.ports);expect((await r.prepareWindow('phone',0)).fullArticleManifest.some(m=>m.articleId===legacy)).toBe(false);
 }finally{f.sql.close();}});

import {ArticleKeepStore} from '../../src/sync/article-keep';
import {libraryRevision} from '../../src/sync/revision';
import {SqlDomainDefinitions} from '../../src/sync/domain-definitions';
test('ambiguous alias cannot consume another canonical deletion or newer independent saved state',async()=>{const f=await fixture();try{
 const keeps=new ArticleKeepStore(f.db);await keeps.initialize();const c=vectors.cases[0]!,other=sha('distinct RSS GUID');
 await f.db.transaction(keeps.record(c.canonicalId,c.url,100,'phone','NULL',[],[c.legacyId]));
 await f.db.transaction(keeps.record(other,c.url,100,'phone','NULL',[],[c.legacyId]));
 await f.db.execute('INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)',[c.legacyId,c.url,50,'watch',deviceOrder('watch')]);
 await f.db.execute("INSERT INTO sync_saved_states VALUES(?,'favorite',NULL,?,1,300,0,'watch',?)",[c.legacyId,c.url,deviceOrder('watch')]);
 await f.db.execute("INSERT INTO sync_saved_states VALUES(?,'favorite',NULL,?,0,200,0,'phone',?)",[c.canonicalId,c.url,deviceOrder('phone')]);
 await f.db.transaction(keeps.record(c.canonicalId,c.url,200,'phone','NULL',[],[c.legacyId]));
 expect(await keeps.lookup(c.legacyId,c.url)).toBeUndefined();expect(await f.db.query('SELECT changed_at FROM sync_article_deletions')).toEqual([{changed_at:50}]);expect(await f.db.query('SELECT changed_at FROM sync_saved_states WHERE article_id=?',[c.legacyId])).toEqual([{changed_at:300}]);
 }finally{f.sql.close();}});
test('keep-only business changes invalidate revision and fast library root; identical replay is zero-write',async()=>{const f=await fixture();try{
 await f.repo.prepareFastProjection();const defs=new SqlDomainDefinitions(f.db,f.codec);await defs.ensure();const before=await libraryRevision(f.db),root=(await f.db.query("SELECT revision FROM sync_fast_versions WHERE domain='library'"))[0]!.revision;
 const keeps=new ArticleKeepStore(f.db);await keeps.initialize();const c=vectors.cases[0]!;
 await f.db.transaction(keeps.record(c.canonicalId,c.url,100,'phone','NULL',[],[c.legacyId]));
 expect(await libraryRevision(f.db)).toBeGreaterThan(before);expect(Number((await f.db.query("SELECT revision FROM sync_fast_versions WHERE domain='library'"))[0]!.revision)).toBeGreaterThan(Number(root));
 // Production reception applies onlyChangedSql; verify that exact replay there
 // preserves the root rather than issuing trigger-visible no-op writes.
 const a=article({url:c.url,articleId:c.canonicalId,legacyArticleIds:[c.legacyId],updatedAt:200,independentChangedAt:200});await f.repo.receiveArticle(await f.packet(a),'phone',false);const revision=await libraryRevision(f.db),changes=f.changes();
 expect(await f.repo.receiveArticle(await f.packet(a),'phone',false)).toBe(0);expect(f.changes()).toBe(changes);expect(await libraryRevision(f.db)).toBe(revision);
 }finally{f.sql.close();}});

for(const version of [1,2,3,4,5,6,7])test('legacy schema '+version+' without keep tables upgrades before revision triggers reference them',async()=>{const f=await fixture();try{
 await f.db.transaction([{sql:'DROP TABLE sync_article_keep_aliases'},{sql:'DROP TABLE sync_article_keeps'},{sql:'DROP TABLE sync_article_keep_migration'},{sql:'PRAGMA user_version='+version}]);
 await initializeSchema(f.db);expect((await f.db.query('PRAGMA user_version'))[0]!.user_version).toBe(SCHEMA_VERSION);expect(await f.db.query('SELECT * FROM sync_article_keeps')).toEqual([]);expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
 }finally{f.sql.close();}});
