import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {LibrarySnapshotBusyError,ManifestContention} from '../../src/sync/manifest-contention';
import {parseUri,sha} from './ble-v2-fixture';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body';
import {gzipSync,gunzipSync} from 'node:zlib';

/** A second real SQLite connection commits imports between bridge calls. No
 * fake revisions, cache mocks, widened retry counts, or weakened guards. */
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'wrss-manifest-churn-')),path=join(directory,'library.db');
 const sql=new Database(path);sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
 const run=(q:string,p:readonly unknown[]=[])=>sql.query(q).run(...p as any[]);
 let tick:((q:string)=>void)|undefined;
 const db:SqlDatabase={query:async(q,p=[])=>{const rows=sql.query(q).all(...p as any[]) as Record<string,unknown>[];tick?.(q);return rows;},execute:async(q,p=[])=>{run(q,p);},transaction:async ss=>{sql.transaction(()=>ss.forEach(s=>run(s.sql,s.params)))();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{run(s.sql,s.params);return Number((sql.query('SELECT changes() n').get() as any).n);} ))()};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice('watch');
 await db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','Imports',1,-1)");
 const writer=new Database(path);writer.exec('PRAGMA foreign_keys=ON');
 const insert=writer.query('INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,?,?,?,?,?)');let count=0;
 const add=(amount:number)=>writer.transaction(()=>{for(let i=0;i<amount;i++){const id=++count,url='https://fixture.invalid/article/'+id;insert.run('Article '+id,'Fixture body '+id,url,sha(url),id);}})();
 add(2);
 const codec:SyncBodyCodec={sha256:async b=>sha(b),encode:async b=>gzipSync(encodeBodyJson(b)),decode:async b=>gunzipSync(b).toString('utf8')};
 const diagnostics:Record<string,string|number>[]=[];
 const ports={codec,text:{parseUri,htmlText:async(s:string)=>s},uri:{parseUri,parseAndroid:parseUri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},diagnostic:(r:Record<string,string|number>)=>diagnostics.push(r),now:()=>1000};
 const repo=new SqlLibrarySessionRepository(db,ports);await repo.prepareFastProjection();
 return {sql,writer,db,repo,add,diagnostics,count:()=>count,onQuery:(fn?:typeof tick)=>{tick=fn;},close:async()=>{tick=undefined;writer.close();sql.close();await rm(directory,{recursive:true,force:true});}};
}
const ack=(window:{toSeqInclusive:number;projectionGeneration?:string})=>({remoteDeviceId:'phone',localSeqToInclusive:window.toSeqInclusive,remoteSeqToInclusive:50,remoteProtocolVersion:14,fullSnapshot:true,projectionGeneration:window.projectionGeneration});

for(const canonical of [false,true])test('real SQLite concurrent 520 imports settle before manifest, retain edits and ACK only the captured window: canonical='+canonical,async()=>{
 const f=await fixture();try{
  f.repo.configurePeer('phone',{supportsRssCanonicalIds:canonical});let batches=0;
  f.onQuery(q=>{if(!q.startsWith('SELECT revision')||batches===52)return;
   f.add(10);batches++;
   f.writer.query('UPDATE articles SET reading_progress=?,is_read=1 WHERE id=1').run(batches/100);
   if(batches%4===0)f.writer.query('UPDATE channels SET title=? WHERE id=1').run('Imports '+batches);
  });
  // Slow storage may exhaust the bounded settle allowance. That response must
  // be retryable, not fatal/applied; an explicit fresh library retry converges.
  let window:Awaited<ReturnType<typeof f.repo.prepareWindow>>|undefined,busyDeferrals=0;
  for(let retry=0;retry<4&&!window;retry++)try{window=await f.repo.prepareWindow('phone',0);}catch(error){expect(error).toBeInstanceOf(LibrarySnapshotBusyError);busyDeferrals++;expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);}
  f.onQuery();expect(window).toBeDefined();if(!window)throw Error('finite import did not converge');
  expect(batches).toBe(52);expect(f.count()).toBe(522);
  expect(window.fullArticleManifest).toHaveLength(522);expect(new Set(window.fullArticleManifest.map(a=>a.articleId)).size).toBe(522);
  const first=window.fullArticleManifest.find(a=>a.articleId===sha('https://fixture.invalid/article/1'))!;expect(first.readingProgress).toBe(Math.fround(.52));expect(first.isRead).toBe(true);
  expect(window.rssSources).toEqual([]); // phone-import channel is private, not a public subscription.
  expect(f.diagnostics.some(r=>r.stage==='repository.contention'&&Number(r.changes)>3)).toBe(true);
  expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);
  const requested=await f.repo.exportRequested(window.fullArticleManifest.map(a=>({articleId:a.articleId,bodyHash:a.bodyHash,chunkIndexes:[],metadataOnly:false})),'phone');
  expect(requested).toHaveLength(522);expect(new Set(requested.map(p=>p.article.articleId)).size).toBe(522);
  for(const p of requested){expect(p.encodedBody).not.toBeNull();expect(sha(p.encodedBody!)).toBe(p.manifest.bodyHash);const id=Number(p.article.url.split('/').at(-1));expect(JSON.parse(gunzipSync(p.encodedBody!).toString('utf8')).contentText).toBe('Fixture body '+id);}
  const before=JSON.stringify(window.fullArticleManifest);
  f.writer.query("UPDATE articles SET title='After captured window',reading_progress=.9 WHERE id=1").run();f.add(1);
  await f.repo.markSuccess(ack(window));expect(JSON.stringify(window.fullArticleManifest)).toBe(before);
  const next=await f.repo.prepareWindow('phone',window.toSeqInclusive);
  expect(next.fullArticleManifest).toHaveLength(523);expect(next.articleManifest.some(a=>a.articleId===first.articleId&&a.readingProgress===Math.fround(.9))).toBe(true);
  expect(next.articleManifest.some(a=>a.articleId===sha('https://fixture.invalid/article/523'))).toBe(true);
  expect(next.toSeqInclusive).toBeGreaterThan(window.toSeqInclusive);
  await f.repo.markSuccess(ack(next));expect((await f.repo.prepareWindow('phone',next.toSeqInclusive)).articleManifest).toEqual([]);
  expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
  console.info('manifest-contention.metrics',JSON.stringify({canonical,imports:520,busyDeferrals,initialUnique:522,nextUnique:523,postAckPending:0,settle:f.diagnostics.filter(r=>r.stage==='repository.contention')}));
 }finally{await f.close();}
},15000);

test('continuous real SQL reading writes return bounded retryable busy and preserve cursor; a later exchange converges',async()=>{
 const f=await fixture();try{
  let writes=0;f.onQuery(q=>{if(q.startsWith('SELECT revision'))f.writer.query('UPDATE articles SET reading_progress=? WHERE id=1').run(++writes/10000);});
  const started=Date.now();await expect(f.repo.prepareWindow('phone',0)).rejects.toBeInstanceOf(LibrarySnapshotBusyError);f.onQuery();
  expect(Date.now()-started).toBeLessThan(5000);expect(writes).toBeGreaterThan(3);expect(writes).toBeLessThan(150);
  expect(f.diagnostics.some(r=>r.stage==='repository.contention'&&r.busy===1)).toBe(true);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);
  const window=await f.repo.prepareWindow('phone',0);expect(window.fullArticleManifest.find(a=>a.articleId===sha('https://fixture.invalid/article/1'))!.readingProgress).toBe(Math.fround(writes/10000));
  await f.repo.markSuccess(ack(window));expect((await f.repo.prepareWindow('phone',window.toSeqInclusive)).articleManifest).toEqual([]);
 }finally{await f.close();}
},10000);

test('cancellation is checked inside quiet-window wait and never acknowledges a partial snapshot',async()=>{
 const f=await fixture();try{
  let writes=0,samples=0,cancelled=false;f.onQuery(q=>{if(!q.startsWith('SELECT revision'))return;f.add(1);writes++;if(q.includes('AS projection_seq')&&++samples===2)cancelled=true;});
  await expect(f.repo.prepareWindow('phone',0,()=>{if(cancelled)throw Error('Sync session cancelled');})).rejects.toThrow('cancelled');f.onQuery();
  expect(samples).toBe(2);expect(writes).toBeGreaterThan(3);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);
  expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest).toHaveLength(f.count());
 }finally{await f.close();}
});

test('a real SQL storage failure is not converted into contention or an applied window',async()=>{
 const f=await fixture();try{
  await f.db.execute("CREATE TRIGGER fail_manifest BEFORE INSERT ON sync_snapshot_fingerprints BEGIN SELECT RAISE(ABORT,'disk full');END");
  await expect(f.repo.prepareWindow('phone',0)).rejects.toThrow('disk full');expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);
  await f.db.execute('DROP TRIGGER fail_manifest');expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest).toHaveLength(2);
 }finally{await f.close();}
});

test('real public-source refreshes and source clock publication settle without losing the last source edit',async()=>{
 const f=await fixture();try{
  f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(2,'https://fixture.invalid/rss','Feed',1,-1)");
  let writes=0;f.onQuery(q=>{if(q.startsWith('SELECT revision')&&writes<12)f.writer.query('UPDATE channels SET title=?,last_fetched_at=? WHERE id=2').run('Feed '+(++writes),writes);});
  const window=await f.repo.prepareWindow('phone',0);f.onQuery();expect(writes).toBe(12);expect(window.rssSources).toHaveLength(1);expect(window.rssSources[0]!.title).toBe('Feed 12');
  await f.repo.markSuccess(ack(window));f.writer.query("UPDATE channels SET title='After source window' WHERE id=2").run();
  const next=await f.repo.prepareWindow('phone',window.toSeqInclusive);expect(next.rssSources).toHaveLength(1);expect(next.rssSources[0]!.title).toBe('After source window');expect(next.toSeqInclusive).toBeGreaterThan(window.toSeqInclusive);
 }finally{await f.close();}
});

test('derived-cache-only writers retry on projection witness even when the source revision is unchanged',async()=>{
 const f=await fixture();try{
  f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});await f.repo.prepareWindow('phone',0);
  const revision=(await f.db.query('SELECT revision FROM sync_library_revision'))[0]!.revision;let writes=0;
  f.onQuery(q=>{if(q.startsWith('SELECT revision')&&writes<12)f.writer.query('UPDATE article_sync_encoding_cache SET site_name=? WHERE item_id=1').run('Cache '+(++writes));});
  const window=await f.repo.prepareWindow('phone',0);f.onQuery();expect(writes).toBe(12);expect(window.fullArticleManifest).toHaveLength(2);expect((await f.db.query('SELECT revision FROM sync_library_revision'))[0]!.revision).toBe(revision);
  expect(f.diagnostics.some(r=>r.stage==='repository.contention')).toBe(true);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual([]);
 }finally{await f.close();}
});

test('quiet-window sampling also terminates with a frozen clock and emits fixed numeric diagnostics',async()=>{
 let seq=0,turns=0;const logs:Record<string,string|number>[]=[];
 const db={query:async()=>[{revision:++seq,projection_seq:seq}]} as unknown as SqlDatabase;
 const contention=new ManifestContention(db,async()=>{turns++;},r=>logs.push(r),()=>0,async()=>{});
 await expect(contention.settle(1)).rejects.toBeInstanceOf(LibrarySnapshotBusyError);expect(turns).toBe(128);
 expect(logs).toEqual([{stage:'repository.contention',attempt:1,changes:128,waitMs:0,samples:128,busy:1}]);
});
