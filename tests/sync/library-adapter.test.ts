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
 // The same resolved source is validated by the snapshot revision, without
 // encoding it twice. A stale outer revision would repeat the work.
 expect(encodes).toBe(1);
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
test('adapter sends same-clock reading and source edits after the previous ACK',async()=>{const f=await setup();try{const w=await stableWindow(f);await f.repo.markSuccess({...ack(w.toSeqInclusive),projectionGeneration:w.projectionGeneration});expect((await f.repo.prepareWindow('phone',w.toSeqInclusive)).articleManifest).toEqual([]);
 await f.db.execute('UPDATE articles SET reading_progress=?,is_read=1 WHERE id=1',[Math.fround(.75)]);await f.db.execute("INSERT INTO channels(url,title,created_at,sort_order) VALUES('https://feed.example/rss','Feed',20,-20)");const delta=await f.repo.prepareWindow('phone',w.toSeqInclusive);expect(delta.fullSnapshot).toBe(false);expect(delta.articleManifest).toHaveLength(1);expect(delta.articleManifest[0]).toMatchObject({articleId:f.id,readingProgress:.75,isRead:true,updatedAt:100});expect(delta.rssSources.map(s=>s.url)).toEqual(['https://feed.example/rss']);expect(delta.toSeqInclusive).toBeGreaterThan(w.toSeqInclusive);
 await f.repo.markSuccess({...ack(delta.toSeqInclusive),projectionGeneration:delta.projectionGeneration});expect((await f.repo.prepareWindow('phone',delta.toSeqInclusive)).articleManifest).toEqual([]);
 }finally{f.sql.close();}});
test('a write between snapshot logging and MAX sequence capture is included before advertising the boundary',async()=>{const f=await setup();try{const w=await stableWindow(f);await f.repo.markSuccess({...ack(w.toSeqInclusive),projectionGeneration:w.projectionGeneration});const query=f.db.query;let injected=false;f.db.query=async(q,p)=>{if(!injected&&q.startsWith('SELECT COALESCE((SELECT MAX(seq)')){injected=true;await f.db.execute("UPDATE articles SET title='Concurrent' WHERE id=1");}return query(q,p);};const delta=await f.repo.prepareWindow('phone',w.toSeqInclusive);expect(injected).toBe(true);expect(delta.articleManifest).toHaveLength(1);const exported=await f.repo.exportRequested([{articleId:f.id,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);expect(exported[0]!.article.title).toBe('Concurrent');await f.repo.markSuccess({...ack(delta.toSeqInclusive),projectionGeneration:delta.projectionGeneration});expect((await f.repo.prepareWindow('phone',delta.toSeqInclusive)).articleManifest).toEqual([]);
 }finally{f.sql.close();}});
test('a post-window edit remains eligible after ACK and never changes the captured manifest',async()=>{const f=await setup();try{const w=await stableWindow(f);const old=JSON.stringify(w.articleManifest);await f.db.execute('UPDATE articles SET reading_progress=.5 WHERE id=1');await f.repo.markSuccess({...ack(w.toSeqInclusive),projectionGeneration:w.projectionGeneration});expect(JSON.stringify(w.articleManifest)).toBe(old);const next=await f.repo.prepareWindow('phone',w.toSeqInclusive);expect(next.articleManifest[0]!.readingProgress).toBe(.5);expect(next.toSeqInclusive).toBeGreaterThan(w.toSeqInclusive);
 }finally{f.sql.close();}});
test('authoritative replacement retains dedup identities, removes omitted channels, prunes state and resets cursors',async()=>{const f=await setup();try{await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(2,'https://other.example/rss','Other',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(2,1,'Duplicate','https://example.com/item','rss-guid',1),(3,2,'Omitted source','https://example.com/other','other-id',1)");await f.db.execute("INSERT INTO sync_article_deletions VALUES('obsolete','https://example.com/dead',100,'local','local')");const w=await stableWindow(f);await f.repo.markSuccess({...ack(w.toSeqInclusive),projectionGeneration:w.projectionGeneration});await f.repo.finalizeSnapshot([f.id,'other-id'],['watchrss://phone-imports']);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);expect(await f.db.query('SELECT id FROM channels')).toEqual([{id:1}]);expect(await f.db.query('SELECT * FROM sync_article_deletions')).toEqual([]);for(const t of ['sync_change_log','sync_peer_state','sync_snapshot_fingerprints','sync_snapshot_retained'])expect(await f.db.query('SELECT * FROM '+t)).toEqual([]);expect(f.cleaned).toEqual([{itemIds:[2,3],channels:[{id:2,url:'https://other.example/rss'}]}]);
 }finally{f.sql.close();}});
test('failed replacement rolls back rows, cursors and fingerprints and performs no media cleanup',async()=>{const f=await setup();try{const w=await stableWindow(f);await f.repo.markSuccess({...ack(w.toSeqInclusive),projectionGeneration:w.projectionGeneration});const before=await f.db.query('SELECT * FROM sync_peer_state');await f.db.execute("CREATE TRIGGER fail_replace BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT,'disk full'); END");await expect(f.repo.finalizeSnapshot([],[])).rejects.toThrow('disk full');expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual(before);expect((await f.db.query('SELECT * FROM sync_snapshot_fingerprints')).length).toBeGreaterThan(0);expect(await f.db.query('SELECT * FROM sync_snapshot_retained')).toEqual([]);expect(f.cleaned).toEqual([]);
 }finally{f.sql.close();}});
test('phone clearLibrary clears the RSS library and cursors while preserving the watch identity and standalone notes',async()=>{
 const f=await setup();try{
  const w=await stableWindow(f);await f.repo.markSuccess({...ack(w.toSeqInclusive),projectionGeneration:w.projectionGeneration});
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
  await repo.cursor('phone');expect(encodes).toBe(1); // only the edited local chapter is rebuilt
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
  await repo.markSuccess({...ack(first.toSeqInclusive),projectionGeneration:first.projectionGeneration});
  const unchanged=await repo.prepareWindow('phone',first.toSeqInclusive);expect(unchanged.articleManifest).toHaveLength(0);
  await db.execute("UPDATE articles SET title='same clock changed' WHERE id=1");
  const edited=await repo.prepareWindow('phone',first.toSeqInclusive);expect(edited.articleManifest).toHaveLength(1);expect(edited.toSeqInclusive).toBeGreaterThan(first.toSeqInclusive);
  expect(repairs).toBe(0);
 }finally{f.sql.close();}
});

test('R47 saved-item cancellation reuses received text instead of re-extracting the RSS HTML',async()=>{
 const f=await setup();try{
  const {prepareArticle,bodyForRequest}=await import('../../src/sync/article-export');
  const url='https://example.com/received',id=await stableArticleId(url,text.parseUri,codec);
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(2,'https://feed.example/rss','RSS',1,1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(2,2,'Feed original','stale RSS excerpt',?,'guid:original',100)",[url]);
  await f.db.execute("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(2,0,'stale separately fetched original')");
  await f.db.execute('INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,?,?)',[id,2,url]);
  const p=await prepareArticle({...(await f.repo.exportRequested([{articleId:f.id,bodyHash:'',chunkIndexes:[],metadataOnly:false}]))[0]!.article,articleId:id,url,title:'Received',rssSourceUrl:'https://feed.example/rss',rssSourceTitle:'RSS',independentSaved:false,independentChangedAt:0,contentHash:'phone-semantic-hash',contentHtml:'<p>exact phone original</p>',contentText:'exact phone original',favoriteSaved:true,favoriteChangedAt:200,updatedAt:200,sourceDeviceId:'phone'},codec);
  await f.repo.receiveArticle({article:p.article,body:bodyForRequest(p,{articleId:id,bodyHash:'',chunkIndexes:[],metadataOnly:false})},'phone',false);
  const cancel={...p.article,favoriteSaved:false,favoriteChangedAt:300,updatedAt:300};
  const body=bodyForRequest(p,{articleId:id,bodyHash:p.manifest.bodyHash,chunkIndexes:[],metadataOnly:true});
  await expect(f.repo.receiveArticle({article:cancel,body},'phone',false)).resolves.toBeGreaterThan(0);
  expect((await f.db.query("SELECT saved FROM sync_saved_states WHERE article_id=? AND save_type='favorite'",[id]))[0]!.saved).toBe(0);
  expect((await f.db.query('SELECT body FROM article_original_chunks WHERE article_id=2'))[0]!.body).toBe('<p>exact phone original</p>');
 }finally{f.sql.close();}
});

test('R47 persistent projection survives a new repository and rebuilds only dirty URLs',async()=>{
 const f=await setup();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(2,'https://watchrss.local/import-content/txt/fixture','Imported',1,1)");
  for(let i=2;i<=302;i++)await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,2,?,?,?,?,?)',[i,'chapter '+i,'body '+i,'https://example.com/chapter/'+i,'chapter:'+i,100+i]);
  const traces:Record<string,string|number>[]=[],first=new SqlLibrarySessionRepository(f.db,{...f.ports,diagnostic:r=>traces.push(r)});
  first.configurePeer('phone',{supportsRssCanonicalIds:true});await first.prepareWindow('phone',0);const baseline=await first.prepareWindow('phone',0);
  let encoded=0,wideRows=0,hashed=0;const query=f.db.query;
  f.db.query=async(q,p)=>{const r=await query(q,p);if(q.startsWith('SELECT a.id FROM articles a JOIN channels ch'))wideRows+=r.length;return r;};
  const fresh=()=>{const r=new SqlLibrarySessionRepository(f.db,{...f.ports,diagnostic:r=>traces.push(r),codec:{...codec,encode:async b=>{encoded++;return codec.encode(b);},sha256:async b=>{hashed++;return codec.sha256(b);}}});r.configurePeer('phone',{supportsRssCanonicalIds:true});return r;};
  const restarted=fresh();await restarted.cursor('phone');expect(wideRows).toBe(0);expect(encoded).toBe(0);expect(hashed).toBeLessThan(24);const afterDefinitionCheck=hashed;await restarted.cursor('phone');expect(hashed).toBe(afterDefinitionCheck);
  await f.db.execute("UPDATE articles SET title='one edited chapter',is_read=1 WHERE id=101");
  const changed=await restarted.prepareWindow('phone',0);expect(wideRows).toBe(1);expect(encoded).toBe(0);expect(changed.fullArticleManifest).toHaveLength(baseline.fullArticleManifest.length);
  expect(traces.some(r=>r.stage==='repository.projection'&&r.cached===1&&r.dirtyUrls===1)).toBe(true);
  const live=await restarted.exportRequested([{articleId:(await stableArticleId('https://example.com/chapter/101',text.parseUri,codec)),bodyHash:'',chunkIndexes:[],metadataOnly:false}],'phone');expect(live[0]!.article.title).toBe('one edited chapter');
  await f.db.execute('DELETE FROM sync_projection_header');const full=await fresh().prepareWindow('phone',0);
  const sorted=(rows:typeof full.fullArticleManifest)=>[...rows].sort((a,b)=>a.articleId.localeCompare(b.articleId));expect(sorted(changed.fullArticleManifest)).toEqual(sorted(full.fullArticleManifest));
 }finally{f.sql.close();}
});

test('R47 dirty-URL cache preserves distinct canonical RSS GUIDs sharing one URL',async()=>{const f=await setup();try{
 await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(2,'https://feed.example/rss','RSS',1)");
 for(const [id,guid]of [[2,'guid:a'],[3,'guid:b']] as const){await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,2,?,?,?,?,?,100)',[id,'row'+id,'body'+id,'https://same.example/url',guid,guid]);await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(?,'favorite',1,100)",[id]);}
 const fresh=()=>{const repo=new SqlLibrarySessionRepository(f.db,f.ports);repo.configurePeer('phone',{supportsRssCanonicalIds:true});return repo;};
 const r=fresh();await r.prepareWindow('phone',0);await r.prepareWindow('phone',0);await f.db.execute("UPDATE articles SET title='changed',is_read=1 WHERE id=2");const partial=await r.prepareWindow('phone',0);
 expect(partial.fullArticleManifest.filter(m=>m.bodySyncMode==='saved')).toHaveLength(2);
 await f.db.execute('DELETE FROM sync_projection_header');const full=await fresh().prepareWindow('phone',0);expect([...partial.fullArticleManifest].sort((a,b)=>a.articleId.localeCompare(b.articleId))).toEqual([...full.fullArticleManifest].sort((a,b)=>a.articleId.localeCompare(b.articleId)));
 }finally{f.sql.close();}});
test('R47 unobserved revision changes and missing journal entries force a safe full projection',async()=>{const f=await setup();try{
 f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});await stableWindow(f);await f.db.execute('UPDATE sync_library_revision SET revision=revision+1 WHERE id=1');const traces:Record<string,string|number>[]=[],repo=new SqlLibrarySessionRepository(f.db,{...f.ports,diagnostic:r=>traces.push(r)});repo.configurePeer('phone',{supportsRssCanonicalIds:true});await repo.cursor('phone');expect(traces.some(r=>r.stage==='repository.projection'&&r.cached===0)).toBe(true);
 await f.db.execute("UPDATE articles SET title='new' WHERE id=1");await f.db.execute('DELETE FROM sync_projection_events');traces.length=0;const last=new SqlLibrarySessionRepository(f.db,{...f.ports,diagnostic:r=>traces.push(r)});last.configurePeer('phone',{supportsRssCanonicalIds:true});await last.cursor('phone');expect(traces.some(r=>r.stage==='repository.projection'&&r.cached===0)).toBe(true);
 }finally{f.sql.close();}});
test('R47 malformed cached rows are rebuilt and failed publication leaves the old generation valid',async()=>{const f=await setup();try{
 f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});const fresh=()=>{const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer('phone',{supportsRssCanonicalIds:true});return r;};await stableWindow(f);await f.db.execute("UPDATE sync_projection_rows SET json='{broken' WHERE scope=':canonical'");const rebuilt=fresh();expect((await rebuilt.prepareWindow('phone',0)).fullArticleManifest).toHaveLength(1);
 const old=await f.db.query("SELECT generation FROM sync_projection_header WHERE scope=':canonical'");await f.db.execute("UPDATE articles SET title='changed' WHERE id=1");await f.db.execute("CREATE TRIGGER fail_projection_publish BEFORE INSERT ON sync_projection_header BEGIN SELECT RAISE(ABORT,'cache disk full'); END");await expect(fresh().cursor('phone')).rejects.toThrow('cache disk full');expect(await f.db.query("SELECT generation FROM sync_projection_header WHERE scope=':canonical'")).toEqual(old);
 await f.db.execute('DROP TRIGGER fail_projection_publish');const next=await fresh().prepareWindow('phone',0);expect(next.fullArticleManifest).toHaveLength(1);expect((await f.db.query('SELECT title FROM articles WHERE id=1'))[0]!.title).toBe('changed');
 }finally{f.sql.close();}});

test('R47 restarted projection retains source-less unsave and deletion records with exact synthetic bodies',async()=>{const f=await setup();try{
 const url='https://example.com/no-longer-saved',id=await stableArticleId(url,text.parseUri,codec);
 await f.db.execute("INSERT INTO sync_saved_states VALUES(?,'favorite',NULL,?,0,200,0,'local','local')",[id,url]);await f.db.execute("INSERT INTO sync_article_deletions VALUES('gone','https://example.com/deleted',300,'local','local')");
 const fresh=()=>{const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer('phone',{supportsRssCanonicalIds:true});return r;};const first=fresh();await first.prepareWindow('phone',0);const initial=await first.prepareWindow('phone',0),restarted=fresh(),warm=await restarted.prepareWindow('phone',0);expect(warm.fullArticleManifest).toEqual(initial.fullArticleManifest);
 const item=warm.fullArticleManifest.find(m=>m.articleId===id)!;expect(item.bodyAvailable).toBe(true);const body=await restarted.exportRequested([{articleId:id,bodyHash:'',metadataOnly:false,chunkIndexes:[]}],'phone');expect(body).toHaveLength(1);expect(await codec.sha256(body[0]!.encodedBody!)).toBe(item.bodyHash);expect(body[0]!.article.favoriteSaved).toBe(false);expect(body[0]!.article.contentText).toBe('');
 }finally{f.sql.close();}});

test('R47 derived-only writes arriving after cached planning are not consumed as an older window',async()=>{const f=await setup();const {LibraryProjectionCache}=await import('../../src/sync/projection-cache');const original=LibraryProjectionCache.prototype.plan;try{
 const fresh=()=>{const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer('phone',{supportsRssCanonicalIds:true});return r;};const r=fresh();await r.prepareWindow('phone',0);await r.prepareWindow('phone',0);let plans=0;
 LibraryProjectionCache.prototype.plan=async function(...args){const p=await original.apply(this,args);plans++;if(plans===1){await f.db.execute("INSERT INTO sync_projection_events(kind,new_url) VALUES('cacheUrl','https://example.com/item')");}return p;};
 await fresh().cursor('phone');expect(plans).toBeGreaterThanOrEqual(2);expect((await f.db.query("SELECT seq FROM sync_projection_header WHERE scope=':canonical'"))[0]!.seq).toBe((await f.db.query("SELECT seq FROM sqlite_sequence WHERE name='sync_projection_events'"))[0]!.seq);
 }finally{LibraryProjectionCache.prototype.plan=original;f.sql.close();}});
test('R47 small cache publications never copy unchanged rows and other hot repositories see the new revision',async()=>{const f=await setup();try{
 const fresh=()=>{const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer('phone',{supportsRssCanonicalIds:true});return r;};const a=fresh(),b=fresh();await a.prepareWindow('phone',0);await a.prepareWindow('phone',0);await b.prepareWindow('phone',0);const generation=(await f.db.query("SELECT generation FROM sync_projection_header WHERE scope=':canonical'"))[0]!.generation;
 let copies=0,inserted=0;const tx=f.db.transaction;f.db.transaction=async ss=>{copies+=ss.filter(s=>s.sql.startsWith('INSERT INTO sync_projection_rows')&&s.sql.includes(' SELECT ')).length;inserted+=ss.filter(s=>s.sql.startsWith('INSERT INTO sync_projection_rows')&&s.sql.includes(' VALUES')).length;return tx(ss);};
 await f.db.execute("UPDATE articles SET title='updated once' WHERE id=1");const first=await a.prepareWindow('phone',0);expect(copies).toBe(0);expect(inserted).toBe(1);expect((await f.db.query("SELECT generation FROM sync_projection_header WHERE scope=':canonical'"))[0]!.generation).toBe(generation);const second=await b.prepareWindow('phone',0);expect(second.fullArticleManifest).toEqual(first.fullArticleManifest);
 }finally{f.sql.close();}});

test('incremental fingerprint reconciliation reads only changed IDs and retains unrelated scopes and deletions',async()=>{const f=await setup();try{
 const w=await stableWindow(f),template=w.fullArticleManifest[0]!,articles=Array.from({length:1200},(_,i)=>({...template,articleId:'scoped-'+i})),rev=await libraryRevision(f.db);
 await reconcileSnapshotLog(f.db,codec,rev,'local',articles,[],1000,':one');await reconcileSnapshotLog(f.db,codec,rev,'local',articles,[],1000,':other');
 const query=f.db.query.bind(f.db);let rowsRead=0;f.db.query=async(q,p,l)=>{const rows=await query(q,p,l);if(q.includes('FROM sync_snapshot_fingerprints'))rowsRead+=rows.length;return rows;};
 await reconcileSnapshotLog(f.db,codec,rev,'local',articles.filter(a=>a.articleId!=='scoped-10'),[],1000,':one',new Set(['scoped-10','scoped-20']));
 expect(rowsRead).toBe(2);expect(await query("SELECT entity_id FROM sync_snapshot_fingerprints WHERE kind='article:one' AND entity_id='scoped-10'")).toEqual([]);
 expect((await query("SELECT COUNT(*) n FROM sync_snapshot_fingerprints WHERE kind='article:one'"))[0]!.n).toBe(1199);expect((await query("SELECT COUNT(*) n FROM sync_snapshot_fingerprints WHERE kind='article:other'"))[0]!.n).toBe(1200);
 }finally{f.sql.close();}});
