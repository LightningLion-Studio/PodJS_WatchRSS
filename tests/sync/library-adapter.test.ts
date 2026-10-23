import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {SqlLibrarySessionRepository,type RemovedLibraryContent} from '../../src/sync/library-repository.ts';
import {initializeSchema} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body.ts';
import {stableArticleId,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {SyncSavedStateStore} from '../../src/sync/saved-state.ts';
import {migrateLocalDeletionJournal} from '../../src/sync/deletion-journal.ts';
import {libraryRevision} from '../../src/sync/revision.ts';
import {reconcileSnapshotLog} from '../../src/sync/snapshot-log.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
const codec:SyncBodyCodec={sha256:async b=>createHash('sha256').update(b).digest('hex'),encode:async b=>gzipSync(encodeBodyJson(b)),decode:async b=>gunzipSync(b).toString()};
const text:SyncTextPort={parseUri:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async s=>s};
async function setup(){const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const sizes:number[]=[],db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{expect(ss.length).toBeLessThanOrEqual(2048);sizes.push(ss.length);sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{sql.query(s.sql).run(...(s.params??[]) as any[]);return (sql.query('SELECT changes() AS n').get() as {n:number}).n;}))()};await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice('local');const cleaned:RemovedLibraryContent[]=[];
 const ports={codec,text,uri:{parseUri:text.parseUri,parseAndroid:text.parseUri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async p=>{cleaned.push(p);},now:()=>1000} satisfies ConstructorParameters<typeof SqlLibrarySessionRepository>[1];
 const repo=new SqlLibrarySessionRepository(db,ports);const id=await stableArticleId('https://example.com/item',text.parseUri,codec);
 await db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','独立文章',1,-1)");await db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'Article','body','https://example.com/item',?,100)",[id]);return {sql,db,repo,ports,id,cleaned,sizes};}
async function stableWindow(f:Awaited<ReturnType<typeof setup>>){await f.repo.prepareWindow('phone',0);return f.repo.prepareWindow('phone',0);}
const ack=(seq:number)=>({remoteDeviceId:'phone',localSeqToInclusive:seq,remoteSeqToInclusive:5,remoteProtocolVersion:14,fullSnapshot:true});
test('reading migration completes before the snapshot revision is captured',async()=>{const f=await setup();try{
 let encodes=0,migrations=0;
 const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,
  codec:{...codec,encode:async article=>{encodes++;return codec.encode(article);}},
  migrateReadingMany:async ids=>{migrations++;await f.db.transaction(ids.map(id=>({sql:"INSERT OR IGNORE INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(?,.4,100,0,'')",params:[id]})));},
 });
 const window=await repo.prepareWindow('phone',0);
 expect(window.fullArticleManifest).toHaveLength(1);
 // The imported row is encoded once for selection and once for body-source
 // validation. A stale outer revision would repeat both encodes.
 expect(encodes).toBe(2);
 expect(migrations).toBe(1);
 expect(await f.db.query('SELECT progress FROM article_reading_state')).toEqual([{progress:.4}]);
 }finally{f.sql.close();}});
test('one exchange reuses its unchanged article snapshot and invalidates after a library edit',async()=>{const f=await setup();try{
 let metadataReads=0;const query=f.db.query;
 f.db.query=async(q,p)=>{if(q.startsWith('SELECT a.id FROM articles a JOIN channels ch'))metadataReads++;return query(q,p);};
 await f.repo.deviceId();await f.repo.cursor('phone');const initial=metadataReads;expect(initial).toBeGreaterThan(0);
 await f.repo.prepareWindow('phone',0);await f.repo.exportSources();expect(metadataReads).toBe(initial);
 const realNow=Date.now;Date.now=()=>realNow()+6*60*1000;
 try{await f.repo.exportSources();expect(metadataReads).toBe(initial);}finally{Date.now=realNow;}
 await f.db.execute("UPDATE articles SET title='New title' WHERE id=1");
 await f.repo.prepareWindow('phone',0);expect(metadataReads).toBeGreaterThan(initial);
 const afterEdit=metadataReads;const exported=await f.repo.exportRequested([{articleId:f.id,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);
 expect(exported[0]?.article.title).toBe('New title');expect(metadataReads).toBe(afterEdit);
 await f.repo.deviceId();await f.repo.cursor('phone');expect(metadataReads).toBe(afterEdit);
 await f.db.execute("UPDATE articles SET title='Second edit' WHERE id=1");await f.repo.cursor('phone');expect(metadataReads).toBeGreaterThan(afterEdit);
 }finally{f.sql.close();}});
test('empty body request skips scanning and keeps revision-validated metadata for the next sync',async()=>{const f=await setup();try{
 await f.repo.cursor('phone');
 const query=f.db.query;let queries=0,metadataReads=0;
 f.db.query=async(q,p)=>{queries++;if(q.startsWith('SELECT a.id FROM articles a JOIN channels ch'))metadataReads++;return query(q,p);};
 expect(await f.repo.exportRequested([])).toEqual([]);
 expect(queries).toBe(0);
 await f.repo.cursor('phone');
 expect(metadataReads).toBe(0);
 await f.db.execute("UPDATE articles SET content='changed body' WHERE id=1");await f.repo.cursor('phone');expect(metadataReads).toBeGreaterThan(0);
 }finally{f.sql.close();}});
test('adapter sends same-clock reading and source edits after the previous ACK',async()=>{const f=await setup();try{const w=await stableWindow(f);await f.repo.markSuccess(ack(w.toSeqInclusive));expect((await f.repo.prepareWindow('phone',w.toSeqInclusive)).articleManifest).toEqual([]);
 await f.db.execute('UPDATE articles SET reading_progress=?,is_read=1 WHERE id=1',[Math.fround(.75)]);await f.db.execute("INSERT INTO channels(url,title,created_at,sort_order) VALUES('https://feed.example/rss','Feed',20,-20)");const delta=await f.repo.prepareWindow('phone',w.toSeqInclusive);expect(delta.fullSnapshot).toBe(false);expect(delta.articleManifest).toHaveLength(1);expect(delta.articleManifest[0]).toMatchObject({articleId:f.id,readingProgress:.75,isRead:true,updatedAt:100});expect(delta.rssSources.map(s=>s.url)).toEqual(['https://feed.example/rss']);expect(delta.toSeqInclusive).toBeGreaterThan(w.toSeqInclusive);
 await f.repo.markSuccess(ack(delta.toSeqInclusive));expect((await f.repo.prepareWindow('phone',delta.toSeqInclusive)).articleManifest).toEqual([]);
 }finally{f.sql.close();}});
test('a write between snapshot logging and MAX sequence capture is included before advertising the boundary',async()=>{const f=await setup();try{const w=await stableWindow(f);await f.repo.markSuccess(ack(w.toSeqInclusive));const query=f.db.query;let injected=false;f.db.query=async(q,p)=>{if(!injected&&q.startsWith('SELECT COALESCE((SELECT MAX(seq)')){injected=true;await f.db.execute("UPDATE articles SET title='Concurrent' WHERE id=1");}return query(q,p);};const delta=await f.repo.prepareWindow('phone',w.toSeqInclusive);expect(injected).toBe(true);expect(delta.articleManifest).toHaveLength(1);const exported=await f.repo.exportRequested([{articleId:f.id,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);expect(exported[0]!.article.title).toBe('Concurrent');await f.repo.markSuccess(ack(delta.toSeqInclusive));expect((await f.repo.prepareWindow('phone',delta.toSeqInclusive)).articleManifest).toEqual([]);
 }finally{f.sql.close();}});
test('a post-window edit remains eligible after ACK and never changes the captured manifest',async()=>{const f=await setup();try{const w=await stableWindow(f);const old=JSON.stringify(w.articleManifest);await f.db.execute('UPDATE articles SET reading_progress=.5 WHERE id=1');await f.repo.markSuccess(ack(w.toSeqInclusive));expect(JSON.stringify(w.articleManifest)).toBe(old);const next=await f.repo.prepareWindow('phone',w.toSeqInclusive);expect(next.articleManifest[0]!.readingProgress).toBe(.5);expect(next.toSeqInclusive).toBeGreaterThan(w.toSeqInclusive);
 }finally{f.sql.close();}});
test('authoritative replacement retains dedup identities, removes omitted channels, prunes state and resets cursors',async()=>{const f=await setup();try{await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(2,'https://other.example/rss','Other',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(2,1,'Duplicate','https://example.com/item','rss-guid',1),(3,2,'Omitted source','https://example.com/other','other-id',1)");await f.db.execute("INSERT INTO sync_article_deletions VALUES('obsolete','https://example.com/dead',100,'local','local')");const w=await stableWindow(f);await f.repo.markSuccess(ack(w.toSeqInclusive));await f.repo.finalizeSnapshot([f.id,'other-id'],['watchrss://phone-imports']);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);expect(await f.db.query('SELECT id FROM channels')).toEqual([{id:1}]);expect(await f.db.query('SELECT * FROM sync_article_deletions')).toEqual([]);for(const t of ['sync_change_log','sync_peer_state','sync_snapshot_fingerprints','sync_snapshot_retained'])expect(await f.db.query('SELECT * FROM '+t)).toEqual([]);expect(f.cleaned).toEqual([{itemIds:[2,3],channels:[{id:2,url:'https://other.example/rss'}]}]);
 }finally{f.sql.close();}});
test('failed replacement rolls back rows, cursors and fingerprints and performs no media cleanup',async()=>{const f=await setup();try{const w=await stableWindow(f);await f.repo.markSuccess(ack(w.toSeqInclusive));const before=await f.db.query('SELECT * FROM sync_peer_state');await f.db.execute("CREATE TRIGGER fail_replace BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT,'disk full'); END");await expect(f.repo.finalizeSnapshot([],[])).rejects.toThrow('disk full');expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual(before);expect((await f.db.query('SELECT * FROM sync_snapshot_fingerprints')).length).toBeGreaterThan(0);expect(await f.db.query('SELECT * FROM sync_snapshot_retained')).toEqual([]);expect(f.cleaned).toEqual([]);
 }finally{f.sql.close();}});
test('phone clearLibrary clears the RSS library and cursors while preserving the watch identity and standalone notes',async()=>{
 const f=await setup();try{
  const w=await stableWindow(f);await f.repo.markSuccess(ack(w.toSeqInclusive));
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(1,'favorite',1,100)");
  await f.db.execute("INSERT INTO notes(article_id,body,created_at,updated_at) VALUES(1,'attached',100,100)");
  await f.db.execute("INSERT INTO local_article_deletions(channel_url,article_url,dedup_key,was_favorite,was_watch_later,changed_at) VALUES('watchrss://phone-imports','https://example.com/old','old',0,0,100)");
  await f.db.execute("CREATE TABLE standalone_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  await f.db.execute("INSERT INTO standalone_note VALUES(1,'keep')");
  const identity=await f.db.query('SELECT * FROM sync_local_identity');
  const handle=createApplicationActionHandler({notes:{} as never,deviceId:()=>f.repo.deviceId(),notesChanged:()=>{},clearLibrary:()=>f.repo.clearLibrary()});
  expect(await handle({version:14,action:'clearLibrary',nonce:'phone-confirmed'})).toEqual({success:true,action:'clearLibrary'});
  for(const table of ['channels','articles','article_saved_states','notes','local_article_deletions','sync_saved_states','sync_article_deletions','sync_article_ids','sync_source_states','sync_change_log','sync_peer_state','sync_snapshot_fingerprints'])
   expect(await f.db.query('SELECT * FROM '+table)).toEqual([]);
  expect(await f.db.query('SELECT * FROM sync_local_identity')).toEqual(identity);
  expect(await f.db.query('SELECT * FROM standalone_note')).toEqual([{id:1,body:'keep'}]);
  expect(f.cleaned).toEqual([{itemIds:[1],channels:[{id:1,url:'watchrss://phone-imports'}]}]);
  expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest).toEqual([]);
  expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
 }finally{f.sql.close();}
});
test('failed phone clearLibrary rolls back before acknowledging and leaves media untouched',async()=>{
 const f=await setup();try{
  await f.db.execute("CREATE TRIGGER fail_clear BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  const handle=createApplicationActionHandler({notes:{} as never,deviceId:()=>f.repo.deviceId(),notesChanged:()=>{},clearLibrary:()=>f.repo.clearLibrary()});
  expect(await handle({version:14,action:'clearLibrary'})).toEqual({success:false,message:'disk failure'});
  expect(await f.db.query('SELECT id FROM channels')).toEqual([{id:1}]);
  expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);
  expect(f.cleaned).toEqual([]);
 }finally{f.sql.close();}
});
test('local deletion journal is consumed atomically and cannot overwrite a later remote clock',async()=>{const f=await setup();try{await f.db.execute("INSERT INTO local_article_deletions(channel_url,article_url,dedup_key,was_favorite,was_watch_later,changed_at) VALUES('watchrss://phone-imports','https://example.com/item',?,1,1,200)",[f.id]);await f.db.execute('DELETE FROM articles');await migrateLocalDeletionJournal(f.db,'local',text,codec);expect(await f.db.query('SELECT * FROM local_article_deletions')).toEqual([]);expect(await f.db.query('SELECT saved,changed_at FROM sync_saved_states')).toEqual([{saved:0,changed_at:200},{saved:0,changed_at:200}]);await f.db.execute('UPDATE sync_article_deletions SET changed_at=0');await migrateLocalDeletionJournal(f.db,'local',text,codec);expect((await f.db.query('SELECT changed_at FROM sync_article_deletions'))[0]!.changed_at).toBe(0);
 }finally{f.sql.close();}});
test('journal migration failure preserves all events and retries once without duplicate log rows',async()=>{const f=await setup();try{await f.db.execute("INSERT INTO local_article_deletions VALUES(1,'watchrss://phone-imports','https://example.com/item','key',1,0,200)");await f.db.execute("CREATE TRIGGER fail_journal BEFORE DELETE ON local_article_deletions BEGIN SELECT RAISE(ABORT,'disk full'); END");await expect(migrateLocalDeletionJournal(f.db,'local',text,codec)).rejects.toThrow('disk full');expect(await f.db.query('SELECT * FROM sync_article_deletions')).toEqual([]);expect(await f.db.query('SELECT id FROM local_article_deletions')).toEqual([{id:1}]);await f.db.execute('DROP TRIGGER fail_journal');await migrateLocalDeletionJournal(f.db,'local',text,codec);await migrateLocalDeletionJournal(f.db,'local',text,codec);expect(await f.db.query('SELECT reason FROM sync_change_log')).toEqual([{reason:'delete'}]);
 }finally{f.sql.close();}});
test('snapshot log pages stay within host limits and unchanged signatures do not grow the journal',async()=>{const f=await setup();try{const w=await stableWindow(f),template=w.fullArticleManifest[0]!,articles=Array.from({length:1200},(_,i)=>({...template,articleId:'article-'+i})),rev=await libraryRevision(f.db);await reconcileSnapshotLog(f.db,codec,rev,'local',articles,[],1000);const count=(await f.db.query('SELECT count(*) n FROM sync_change_log'))[0]!.n,transactions=f.sizes.length;await reconcileSnapshotLog(f.db,codec,rev,'local',articles,[],1000);expect((await f.db.query('SELECT count(*) n FROM sync_change_log'))[0]!.n).toBe(count);expect(f.sizes.slice(transactions)).toEqual([1]);expect(Math.max(...f.sizes)).toBeLessThanOrEqual(2048);expect((await f.db.query('SELECT count(*) n FROM sync_snapshot_fingerprints'))[0]!.n).toBe(1200);
 }finally{f.sql.close();}});
import {fixture as replacements,seedReplacementFixture,replacementOutcome,expectedReplacement} from '../helpers/library-replacement-fixture.ts';
import {clearRepositoryFixture} from '../helpers/library-repository-fixture.ts';
for(const row of replacements.cases)test('adapter replacement matches native: '+row.input.name,async()=>{const f=await setup();try{await clearRepositoryFixture(f.db);await seedReplacementFixture(f.db);await f.repo.finalizeSnapshot(row.input.articles,row.input.sources);expect(await replacementOutcome(f.db)).toEqual(expectedReplacement(row));}finally{f.sql.close();}});

test('remote source deletion releases its actual channel and article resources after commit',async()=>{
 const f=await setup();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(2,'https://feed.example/rss','Feed',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at) VALUES(2,2,'Feed article','feed-key',1)");
  const source=(await f.repo.exportSources()).find(s=>s.url==='https://feed.example/rss')!;await f.repo.mergeSources([{...source,deleted:true,deletedAt:100}], 'phone',false);
  expect(f.cleaned).toEqual([{itemIds:[2],channels:[{id:2,url:'https://feed.example/rss'}]}]);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);
 }finally{f.sql.close();}
});
test('failed source deletion leaves resources live with the rolled-back rows',async()=>{
 const f=await setup();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(2,'https://feed.example/rss','Feed',1)");const source=(await f.repo.exportSources()).find(s=>s.url==='https://feed.example/rss')!;
  await f.db.execute("CREATE TRIGGER fail_source_delete BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT,'disk failure'); END");await expect(f.repo.mergeSources([{...source,deleted:true,deletedAt:100}], 'phone',false)).rejects.toThrow('disk failure');expect(f.cleaned).toEqual([]);expect((await f.db.query('SELECT id FROM channels WHERE id=2')).length).toBe(1);
 }finally{f.sql.close();}
});
test('remote article deletion cleans only a committed removed item',async()=>{
 const f=await setup();try{
  const item=(await f.repo.exportRequested([{articleId:f.id,bodyHash:'',metadataOnly:false,chunkIndexes:[]}]))[0]!;
  const deleted={article:{...item.article,deleted:true,deletedAt:500},body:{articleId:f.id,bodyHash:item.manifest.bodyHash,bodyByteCount:item.manifest.bodyByteCount,chunkSize:item.manifest.chunkSize,chunkHashes:item.manifest.chunkHashes,metadataOnly:true,chunks:[]}};
  await f.db.execute("CREATE TRIGGER fail_article_delete BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT,'disk failure'); END");await expect(f.repo.receiveArticle(deleted,'phone',false)).rejects.toThrow('disk failure');expect(f.cleaned).toEqual([]);
  await f.db.execute('DROP TRIGGER fail_article_delete');await f.repo.receiveArticle(deleted,'phone',false);expect(f.cleaned).toEqual([{itemIds:[1],channels:[]}]);expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
 }finally{f.sql.close();}
});
test('warm imported library rebuilds only the edited row and invalidates equal-length chunk edits',async()=>{
 const f=await setup();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(2,'https://watchrss.local/import-txt-novel/39393939393939393939393939393939','Book',1,1)");
  for(let i=2;i<=4;i++)await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,2,?,?,?,?,?)',[i,'Chapter '+i,'inline '+i,'https://book.test/'+i,'chapter-'+i,100+i]);
  await f.db.execute("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(3,0,'original A')");
  let encodes=0;const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,codec:{...codec,encode:async a=>{encodes++;return codec.encode(a);}}});
  await repo.cursor('phone');encodes=0;await repo.cursor('phone');expect(encodes).toBe(0);
  await f.db.execute("UPDATE articles SET title='one edit',fetched_at=fetched_at+1 WHERE id=2");
  await repo.cursor('phone');expect(encodes).toBe(1);
  encodes=0;const before=await repo.prepareWindow('phone',0);
  await f.db.execute("UPDATE article_original_chunks SET body='original B' WHERE article_id=3");
  const after=await repo.prepareWindow('phone',0);expect(encodes).toBe(1);
  const changed=after.fullArticleManifest.filter(a=>a.bodyHash!==before.fullArticleManifest.find(b=>b.articleId===a.articleId)?.bodyHash);
  expect(changed).toHaveLength(1);
 }finally{f.sql.close();}
});

test('warm windows reuse reconciled signatures without a full-library timestamp repair transaction',async()=>{
 const f=await setup();try{
  let repairs=0;const db={...f.db,transaction:async (statements:Parameters<SqlDatabase['transaction']>[0])=>{repairs+=statements.filter(s=>s.sql.includes("'repairState'")).length;return f.db.transaction(statements);}};
  const repo=new SqlLibrarySessionRepository(db,f.ports);
  const first=await repo.prepareWindow('phone',0);expect(first.toSeqInclusive).toBeGreaterThan(0);
  await repo.markSuccess(ack(first.toSeqInclusive));
  const unchanged=await repo.prepareWindow('phone',first.toSeqInclusive);expect(unchanged.articleManifest).toHaveLength(0);
  await db.execute("UPDATE articles SET title='same clock changed' WHERE id=1");
  const edited=await repo.prepareWindow('phone',first.toSeqInclusive);expect(edited.articleManifest).toHaveLength(1);expect(edited.toSeqInclusive).toBeGreaterThan(first.toSeqInclusive);
  expect(repairs).toBe(0);
 }finally{f.sql.close();}
});
