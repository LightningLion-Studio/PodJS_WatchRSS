import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {gunzipSync} from 'node:zlib';
import {fixture,seedAliasCase,aliasArticle,aliasBody,aliasOutcome} from '../helpers/alias-receive-fixture.ts';
import {LocalArticleManifestStore,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {SyncArticleReceiver} from '../../src/sync/article-receiver.ts';
import {SyncSavedStateStore} from '../../src/sync/saved-state.ts';
import {WatchRssRepository} from '../../src/core/repository.ts';
import {initializeSchema} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import type {SyncBodyCodec} from '../../src/sync/article-body.ts';
import legacySchema from '../fixtures/pre-alias-schema.json';
const codec:SyncBodyCodec={sha256:async b=>new Bun.CryptoHasher('sha256').update(b).digest('hex'),encode:async b=>{if(b.contentHtml!==null||b.contentText!=='body')throw new Error('Unexpected fixture body');return new Uint8Array(Buffer.from(fixture.cases[0]!.encodedBase64,'base64'));},decode:async b=>gunzipSync(b).toString('utf8')};
const text:SyncTextPort={parseUri:async v=>{const u=new URL(v);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async()=>{throw new Error('Unexpected fixture HTML');}};
function database(){const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async list=>{sql.transaction(()=>{for(const s of list)sql.query(s.sql).run(...(s.params??[]) as any[]);})();},transactionChanges:async list=>sql.transaction(()=>list.map(s=>{sql.query(s.sql).run(...(s.params??[]) as any[]);return Number((sql.query('SELECT changes() AS n').get() as {n:number}).n);}))()};return {sql,db};}
const files={storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v};
function receiver(db:SqlDatabase){const local=new LocalArticleManifestStore(db,codec,text,files,async()=>{});return new SyncArticleReceiver(db,codec,files,async()=>{},()=>999,a=>local.resolveIncomingBody(a));}
test('ordinary RSS alias receives match 14 actual native Room merges',async()=>{
 const f=database();try{for(const row of fixture.cases){await seedAliasCase(f.db,row);let ok=true,applied:number|undefined;try{applied=await receiver(f.db).receiveWithStats(aliasArticle(row),aliasBody(row),row.input.peer,row.input.authoritative);}catch{ok=false;}if(ok)expect(applied).toBe(row.applied);
 expect({name:row.input.name,ok}).toEqual({name:row.input.name,ok:row.ok});expect(await aliasOutcome(f.db)).toEqual({items:row.items,entries:row.entries,states:row.states});
 }}finally{f.sql.close();}
});
test('old RSS aliases remain writable after canonical materialization',async()=>{const f=database();try{const row=fixture.cases[0]!;await seedAliasCase(f.db,row);await receiver(f.db).receive(aliasArticle(row),aliasBody(row),row.input.peer);await new WatchRssRepository(f.db,async()=>'').setSaved(1,false);
 const state=(await f.db.query("SELECT * FROM sync_saved_states WHERE save_type='favorite'"))[0]!;expect(state).toMatchObject({item_id:1,saved:0,source_device_id:'local'});expect(Number(state.changed_at)).toBeGreaterThan(150);expect((await f.db.query("SELECT saved FROM article_saved_states WHERE article_id=2 AND save_type='favorite'"))[0]?.saved).toBe(1);
 await expect(new SyncSavedStateStore(f.db).bindArticle(1,row.articleId,'https://example.com/alias')).rejects.toThrow('already bound');
 }finally{f.sql.close();}});
test('failed state publication rolls back the canonical row and alias promotion',async()=>{const f=database();try{const row=fixture.cases[0]!;await seedAliasCase(f.db,row);const before=await aliasOutcome(f.db);await f.db.execute("CREATE TRIGGER fail_alias_projection BEFORE INSERT ON article_saved_entry_times BEGIN SELECT RAISE(ABORT,'injected'); END");await expect(receiver(f.db).receive(aliasArticle(row),aliasBody(row),row.input.peer)).rejects.toThrow('injected');expect(await aliasOutcome(f.db)).toEqual(before);expect((await f.db.query('SELECT item_id FROM sync_article_ids'))[0]?.item_id).toBe(1);expect(await f.db.query('SELECT * FROM sync_article_aliases')).toEqual([]);
 }finally{f.sql.close();}});
test('existing databases upgrade atomically without changing saved state or bindings',async()=>{const f=database();try{for(const q of legacySchema)await f.db.execute(q);await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'feed','Feed',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'Original','url','guid',1)");await f.db.execute("INSERT INTO sync_article_ids VALUES('identity',1,'url')");await f.db.execute("INSERT INTO article_saved_states VALUES(1,'favorite',1,30,-40)");const before=await f.db.query('SELECT * FROM article_saved_states');const failed:SqlDatabase={...f.db,transaction:list=>f.db.transaction([...list.slice(0,10),{sql:'SELECT missing_upgrade_function()'},...list.slice(10)])};await expect(initializeSchema(failed)).rejects.toThrow();expect(await f.db.query("SELECT name FROM sqlite_master WHERE name='sync_article_aliases'")).toEqual([]);await initializeSchema(f.db);expect(await f.db.query('SELECT * FROM article_saved_states')).toEqual(before);expect(await f.db.query('SELECT * FROM sync_article_aliases')).toEqual([{item_id:1,article_id:'identity'}]);expect(await f.db.query('SELECT * FROM article_saved_entry_times')).toEqual([{article_id:1,save_type:'favorite',created_at:30}]);
 await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(2,1,'Other','url','identity',1)");await f.db.execute("INSERT INTO sync_article_aliases VALUES(2,'identity')");await new SyncSavedStateStore(f.db).initializeDevice('local');await expect(new SyncSavedStateStore(f.db).bindArticle(2,'identity','url')).rejects.toThrow('already bound');
 }finally{f.sql.close();}});

test('repeated remote state updates preserve native saved-entry creation time',async()=>{const f=database();try{const row=fixture.cases[0]!;await seedAliasCase(f.db,row);const receive=receiver(f.db);await receive.receive(aliasArticle(row),aliasBody(row),row.input.peer);await receive.receive({...aliasArticle(row),favoriteChangedAt:500},aliasBody(row),row.input.peer);const result=await aliasOutcome(f.db);expect(result.entries.find(e=>e.itemId===2&&e.type==='FAVORITE')?.createdAt).toBe(150);expect(result.states.find(s=>s.type==='FAVORITE')?.changedAt).toBe(500);}finally{f.sql.close();}});

import {ensureSyncDevice,prepareLocalSaveAlias} from '../../src/sync/local-identity.ts';
test('device UUID is durable and a first local RSS save journals its canonical alias atomically',async()=>{const f=database();try{await initializeSchema(f.db);let randomCalls=0;const random=async()=>{randomCalls++;return new Uint8Array(16);};const id=await ensureSyncDevice(f.db,random);expect(id).toBe('00000000-0000-4000-8000-000000000000');expect(await ensureSyncDevice(f.db,random)).toBe(id);expect(randomCalls).toBe(1);
 await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.example/rss','Feed',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'RSS','body','https://example.com/alias','feed-guid',1)");
 const repo=new WatchRssRepository(f.db,async()=>'',files.hydrate,item=>prepareLocalSaveAlias(f.db,item,text,codec));await repo.setSaved(1,true);
 expect((await f.db.query('SELECT * FROM sync_article_aliases'))[0]).toEqual({item_id:1,article_id:fixture.cases[0]!.articleId});const state=(await f.db.query('SELECT * FROM sync_saved_states'))[0]!;expect(state).toMatchObject({item_id:1,saved:1,source_device_id:id,article_id:fixture.cases[0]!.articleId});expect((await f.db.query('SELECT * FROM article_saved_entry_times'))[0]?.created_at).toBe(state.changed_at);
 }finally{f.sql.close();}});
test('a URL changed during alias preparation rolls back the save and creation time',async()=>{const f=database();try{await initializeSchema(f.db);await new SyncSavedStateStore(f.db).initializeDevice('local');await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'feed','Feed',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'RSS','https://example.com/alias','feed-guid',1)");
 const repo=new WatchRssRepository(f.db,async()=>'',files.hydrate,async item=>{const statements=await prepareLocalSaveAlias(f.db,item,text,codec);await f.db.execute("UPDATE articles SET link='https://example.com/changed' WHERE id=1");return statements;});await expect(repo.setSaved(1,true)).rejects.toThrow();expect(await f.db.query('SELECT * FROM sync_article_aliases')).toEqual([]);expect(await f.db.query('SELECT * FROM article_saved_states')).toEqual([]);expect(await f.db.query('SELECT * FROM article_saved_entry_times')).toEqual([]);
 }finally{f.sql.close();}});

test('dedup migration preserves the installed identity of a GUID-only saved article',async()=>{
 const f=database();try{
  await initializeSchema(f.db);await new SyncSavedStateStore(f.db).initializeDevice('watch');
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test','Feed',1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,guid,dedup_key,fetched_at,is_saved) VALUES(1,1,'A','body','old-guid','old-guid',1,1)");
  const {stableArticleId}=await import('../../src/sync/local-manifest.ts');
  const id=await stableArticleId('old-guid',text.parseUri,codec);
  await f.db.execute('INSERT INTO sync_article_ids VALUES(?,1,?)',[id,'old-guid']);
  await f.db.execute('INSERT INTO sync_article_aliases VALUES(1,?)',[id]);
  await f.db.execute("INSERT INTO article_saved_states VALUES(1,'favorite',1,1,-1)");
  await f.db.execute('PRAGMA user_version=1');await initializeSchema(f.db);
  expect(await f.db.query('SELECT dedup_key FROM articles')).toEqual([{dedup_key:'guid:old-guid'}]);
  const repo=new WatchRssRepository(f.db,async()=>'',files.hydrate,item=>prepareLocalSaveAlias(f.db,item,text,codec));
  await repo.setSaved(1,true);
  const {SqlLocalRssActions}=await import('../../src/sync/local-rss-actions.ts');
  await new SqlLocalRssActions(f.db,text,codec,()=>100).markChannelRead(1);
  const snapshot=await new LocalArticleManifestStore(f.db,codec,text,files,async()=>{}).snapshot();
  expect(snapshot.map(p=>({id:p.article.articleId,url:p.article.url}))).toEqual([{id,url:'old-guid'}]);
  expect(await f.db.query('SELECT entity_id FROM sync_change_log WHERE reason=?',['dedupMigration'])).toEqual([{entity_id:id}]);
 }finally{f.sql.close();}
});
