import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {ArticleRegisterStore} from '../../src/sync/article-register-store';
import {CloudRecordCodec} from '../../src/cloud/records';
import {articleKnownCanonical} from '../../src/cloud/article-register';
import {WatchRssRepository} from '../../src/core/repository';
import {prepareArticle} from '../../src/sync/article-export';
import {gzipSync,gunzipSync} from 'node:zlib';
import {encodeBodyJson} from '../../src/sync/article-body';
import vectors from './fixtures/article-provenance-v1/vectors.json';
import bodyVectors from './fixtures/article-provenance-v1/body-bindings.json';
import {crypto} from './k2-crypto';
const reader=new CloudRecordCodec({...crypto,hmac:async()=>''});
const bodyCodec={encode:async(body:any)=>gzipSync(encodeBodyJson(body)),decode:async(b:Uint8Array)=>gunzipSync(b).toString(),sha256:crypto.sha256};
async function open(path=':memory:'){
 const sql=new Database(path);sql.exec('PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 await initializeSchema(db);return {sql,db,store:new ArticleRegisterStore(db,crypto.sha256)};
}
const doc=(value:any)=>reader.readPlaintext(JSON.stringify(value));
test('SQLite register merge retains all independent winners and deletion masking without synthetic save cancellations',async()=>{
 const f=await open();try{const v=vectors.mergeCases[0]!;for(const d of v.inputs)await f.store.apply(doc(d));
  const saved=(await f.store.documents())[0]!;expect(articleKnownCanonical(saved)).toBe(v.expected.canonicalUtf8);
  expect(f.sql.query('SELECT count(*) n FROM articles').get()).toEqual({n:0});
  expect(f.sql.query('SELECT saved,changed_at,source_device_id FROM sync_saved_states WHERE save_type=?').get('favorite')).toEqual({saved:1,changed_at:300,source_device_id:'save-a'});
  const deletion=f.sql.query('SELECT changed_at,source_device_id FROM sync_article_deletions').get();expect(deletion).toEqual({changed_at:500,source_device_id:'delete-c'});
  expect(await f.store.apply(doc(v.inputs[0]))).toMatchObject({removed:[]});expect(articleKnownCanonical((await f.store.documents())[0]!)).toBe(v.expected.canonicalUtf8);
 }finally{f.sql.close();}
});
test('real v8 database upgrades without clearing accepted encoding receipts and freezes the old alias only once across restarts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-register-')),path=join(root,'library.sqlite');let f=await open(path);
 try{
  f.sql.exec("DROP TABLE article_register_conflicts; DROP TABLE article_register_state; PRAGMA user_version=8");
  f.sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','local',0,0); INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'old','https://old','synthetic-article',100); INSERT INTO sync_article_ids VALUES('synthetic-article',1,'https://old'); INSERT INTO article_sync_encoding_cache(item_id,body_hash,source_device_id) VALUES(1,'frozen','legacy-source')");
  await initializeSchema(f.db);expect(f.sql.query('PRAGMA user_version').get()).toEqual({user_version:9});expect(f.sql.query('SELECT body_hash,source_device_id FROM article_sync_encoding_cache').get()).toEqual({body_hash:'frozen',source_device_id:'legacy-source'});
  const base=vectors.mergeCases[0]!.inputs[0]!,legacy={kind:'article',value:{...base.value,sourceDeviceId:'legacy-source',updatedAt:50,readingPositionChangedAt:20}};delete (legacy.value as any).registerSources;
  await f.store.apply(doc(base),legacy);const frozen=(f.sql.query('SELECT legacy_json FROM article_register_state').get() as any).legacy_json;expect(JSON.parse(frozen).value.registerSources.reading).toBe('legacy-source');
  f.sql.close();f=await open(path);await f.store.apply(doc({...base,value:{...base.value,updatedAt:400}}),{kind:'article',value:{...legacy.value,sourceDeviceId:'metadata-new',updatedAt:900}});
  expect((f.sql.query('SELECT legacy_json FROM article_register_state').get() as any).legacy_json).toBe(frozen);
  expect((await f.store.documents())[0]!.value.registerSources.reading).toBe('legacy-source');
 }finally{f.sql.close();rmSync(root,{recursive:true,force:true});}
});
test('local edits remain visible and durably pending while remote state keeps merging, including after a new store instance',async()=>{
 const f=await open();try{
  const base=vectors.mergeCases[0]!.inputs[0]!;await f.store.apply(doc(base));const id=(f.sql.query('SELECT id FROM articles').get() as any).id;
  f.sql.query('UPDATE articles SET title=? WHERE id=?').run('local pending title',id);
  const next={...base,value:{...base.value,title:'remote newer',updatedAt:900}};await new ArticleRegisterStore(f.db,crypto.sha256).apply(doc(next));
  expect((f.sql.query('SELECT title FROM articles').get() as any).title).toBe('local pending title');const d=(await f.store.documents())[0]!;expect(d.pendingEdit).toBe(true);expect(d.value.title).toBe('remote newer');
  const pending=(f.sql.query('SELECT pending_json FROM article_register_state').get() as any).pending_json;await f.store.apply(doc(base));expect((f.sql.query('SELECT pending_json FROM article_register_state').get() as any).pending_json).toBe(pending);
 }finally{f.sql.close();}
});
test('a first legacy snapshot cannot overwrite a UI reading edit made before protected reception',async()=>{
 const f=await open();try{
  const base=vectors.mergeCases[0]!.inputs[0]!,legacy={kind:'article',value:{...base.value,sourceDeviceId:'legacy-alias',readingPositionChangedAt:20}};delete (legacy.value as any).registerSources;
  f.sql.query("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','local',0,0)").run();
  f.sql.query('INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at,is_read,reading_progress) VALUES(1,1,?,?,?,?,1,.9)').run(base.value.title,base.value.url,base.value.articleId,base.value.updatedAt);
  f.sql.query('INSERT INTO sync_article_ids VALUES(?,1,?)').run(base.value.articleId,base.value.url);
  f.sql.exec("INSERT INTO article_reading_state VALUES(1,.9,900,90,'newer-local',NULL); INSERT INTO native_reading_sources VALUES(1,'current-local',900)");
  await f.store.apply(doc({...base,value:{...base.value,readingPositionChangedAt:100}}),legacy);
  expect(f.sql.query('SELECT changed_at,position_bytes,position_hash FROM article_reading_state').get()).toEqual({changed_at:900,position_bytes:90,position_hash:'newer-local'});
  const state=f.sql.query('SELECT legacy_json,pending_json FROM article_register_state').get() as any;expect(state.pending_json).toContain('900');expect(JSON.parse(state.legacy_json).value.registerSources.reading).toBe('legacy-alias');
 }finally{f.sql.close();}
});
test('transaction failures and concurrent UI writes cannot publish a new witness or overwrite the local edit',async()=>{
 const f=await open();try{const base=vectors.mergeCases[0]!.inputs[0]!;
  f.sql.exec("CREATE TRIGGER stop_register BEFORE INSERT ON article_register_state BEGIN SELECT RAISE(ABORT,'disk fixture failure'); END");
  await expect(f.store.apply(doc(base))).rejects.toThrow('disk fixture failure');expect(f.sql.query('SELECT count(*) n FROM articles').get()).toEqual({n:0});f.sql.exec('DROP TRIGGER stop_register');
  const original=f.db.transaction;let race=true;f.db.transaction=async statements=>{if(race){race=false;f.sql.exec('UPDATE sync_library_revision SET revision=revision+1 WHERE id=1');}await original(statements);};
  await expect(f.store.apply(doc(base))).rejects.toThrow();expect(await f.store.documents()).toHaveLength(0);f.db.transaction=original;await f.store.apply(doc(base));expect(await f.store.documents()).toHaveLength(1);
 }finally{f.sql.close();}
});
test('conflicting authenticated unknown raw versions survive SQLite reopen and suspend the object',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-register-raw-')),path=join(root,'raw.sqlite');let f=await open(path);try{const base=JSON.stringify(vectors.mergeCases[0]!.inputs[0]!),a=base.replace('"value":{','"value":{"future": {"n":9007199254740993},'),b=base.replace('"value":{','"value":{"future": {"n":9007199254740994},');
  await f.store.apply(reader.readPlaintext(a));await new ArticleRegisterStore(f.db,crypto.sha256).apply(reader.readPlaintext(b));
  f.sql.close();f=await open(path);const rows=f.sql.query('SELECT raw_json FROM article_register_conflicts ORDER BY raw_json').all();expect(rows).toEqual([{raw_json:a},{raw_json:b}]);expect((f.sql.query('SELECT raw_conflict FROM article_register_state').get() as any).raw_conflict).toBe(1);
 }finally{f.sql.close();rmSync(root,{recursive:true,force:true});}
});
test('metadata version changes retain reading tuple and old bytes, hide an unbound body, and only an authenticated matching body can fill it',async()=>{
 const f=await open();try{const base=vectors.mergeCases[0]!.inputs[1]!,full={...base.value,contentHtml:null,contentText:'authenticated v1 body'} as any;await f.store.apply(doc(base));
  f.sql.exec("INSERT INTO article_sync_encoding_cache(item_id,body_hash,source_device_id,updated_at,metadata_state) SELECT id,'old-receipt','original-device',50,'original-witness' FROM articles");const accepted=f.sql.query('SELECT * FROM article_sync_encoding_cache').all();
  const files={storeText:async(_k:string,s:string)=>s,hydrate:async(s:string)=>s};await f.store.restoreBody(full,await prepareArticle(full,bodyCodec),files);
  const repo=new WatchRssRepository(f.db,async()=>'',async s=>s),item=(f.sql.query('SELECT id FROM articles').get() as any).id;expect(await repo.getArticleBody(item)).toBe(full.contentText);
  const oldReading=f.sql.query('SELECT * FROM article_reading_state').get(),next={...base,value:{...base.value,updatedAt:900,contentHash:'v2'}};await f.store.apply(doc(next));
  expect(f.sql.query('SELECT * FROM article_reading_state').get()).toEqual(oldReading);expect(await repo.getArticleBody(item)).toBeNull();expect((f.sql.query('SELECT content_text FROM article_sync_content').get() as any).content_text).toBe(full.contentText);
  expect(await f.store.restoreBody(full,await prepareArticle(full,bodyCodec),files)).toBe(0);
  const fresh={...full,contentHash:'v2',contentText:'authenticated v2 body',readingProgress:0,readingPositionChangedAt:0,isRead:false};expect(await f.store.restoreBody(fresh,await prepareArticle(fresh,bodyCodec),files)).toBe(1);
  expect(await repo.getArticleBody(item)).toBe(fresh.contentText);expect(f.sql.query('SELECT * FROM article_reading_state').get()).toEqual(oldReading);expect(f.sql.query('SELECT * FROM article_sync_encoding_cache').all()).toEqual(accepted);
  await f.store.apply(doc({...next,value:{...next.value,updatedAt:901,title:'metadata only'}}));expect(await repo.getArticleBody(item)).toBe(fresh.contentText);expect(f.sql.query('SELECT * FROM article_sync_encoding_cache').all()).toEqual(accepted);
 }finally{f.sql.close();}
});
test('explicit restore preserves its positive deletion clock and saved registers, including replay of the old tombstone',async()=>{
 const f=await open();try{
  const deleted=vectors.mergeCases[0]!.expected.record;await f.store.apply(doc(deleted));
  const restored={...deleted,value:{...deleted.value,deleted:false,deletedAt:900,registerSources:{...deleted.value.registerSources,deletion:'restore-device'}}};
  await f.store.apply(doc(restored));expect((f.sql.query('SELECT is_saved FROM articles').get() as any).is_saved).toBe(1);
  expect((f.sql.query('SELECT saved,changed_at,source_device_id FROM sync_saved_states WHERE save_type=?').get('favorite') as any)).toEqual({saved:1,changed_at:300,source_device_id:'save-a'});
  await f.store.apply(doc(deleted));const state=(await f.store.documents())[0]!;expect(state.value.deleted).toBe(false);expect(state.value.deletedAt).toBe(900);expect(state.value.registerSources.deletion).toBe('restore-device');expect(f.sql.query('SELECT * FROM sync_article_deletions').all()).toHaveLength(0);
 }finally{f.sql.close();}
});
for(const v of bodyVectors.cases)test('shared body binding through production SQL / '+v.id,async()=>{
 const f=await open();try{
  for(const input of v.inputs)await f.store.apply(doc(input));
  const state=(await f.store.documents())[0]!;expect(articleKnownCanonical(state)).toBe(v.expected.merged.canonicalUtf8);
  const before=f.sql.query('SELECT * FROM article_reading_state').get(),files={storeText:async(_k:string,s:string)=>s,hydrate:async(s:string)=>s};
  for(const inventory of v.inventory){expect(await crypto.sha256(Buffer.from(inventory.bodyUtf8))).toBe(inventory.contentHash);const article={...state.value,contentHash:inventory.contentHash,contentText:inventory.bodyUtf8,contentHtml:null} as any;await f.store.restoreBody(article,await prepareArticle(article,bodyCodec),files);}
  for(const placeholder of v.placeholders){const article={...state.value,contentHash:placeholder.contentHash,contentText:'',contentHtml:null} as any;expect(await f.store.restoreBody(article,await prepareArticle(article,bodyCodec),files)).toBe(0);}
  const id=(f.sql.query('SELECT id FROM articles').get() as any).id,repo=new WatchRssRepository(f.db,async()=>'',async s=>s),body=await repo.getArticleBody(id);expect(body===null?null:Buffer.from(body).toString('hex')).toBe(v.expected.selectedBodyHex);expect(f.sql.query('SELECT * FROM article_reading_state').get()).toEqual(before);
 }finally{f.sql.close();}
});
