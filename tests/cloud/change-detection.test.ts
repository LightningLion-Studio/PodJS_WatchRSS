import {test,expect} from 'bun:test';
import {detectorFixture} from './change-detection-fixture';
import {SqlCloudChangeDetection,cloudChangeUnchanged,cloudRemoteUnchanged,CLOUD_SAFETY_CHECK_MS} from '../../src/cloud/change-detection';

test('unchanged receipts require only a scalar SQL read; every canonical write bumps in its own transaction',async()=>{
 const f=detectorFixture(),initial=await f.detector.read('epoch+policy');await f.detector.commit(initial.stamp,'heads','7',100);
 let read=await f.detector.read('epoch+policy');expect(cloudChangeUnchanged(read,'heads','7',101)).toBe(true);const before=f.queries();await f.detector.read('epoch+policy');expect(f.queries()-before).toBe(1);
 f.db.run("INSERT INTO articles VALUES(1,'title',0)");read=await f.detector.read('epoch+policy');expect(read.stamp.revision).toBeGreaterThan(initial.stamp.revision);expect(cloudChangeUnchanged(read,'heads','7',101)).toBe(false);
 await f.detector.commit(read.stamp,'heads','7',101);f.db.run('UPDATE articles SET reading_progress=0.4 WHERE id=1');read=await f.detector.read('epoch+policy');expect(cloudChangeUnchanged(read,'heads','7',102)).toBe(false);
 const revision=read.stamp.revision;expect(()=>f.db.transaction(()=>{f.db.run("INSERT INTO memo_notes VALUES('note','body')");throw Error('rollback');})()).toThrow('rollback');expect((await f.detector.read('epoch+policy')).stamp.revision).toBe(revision);
 f.db.run('UPDATE articles SET reading_progress=0.4 WHERE id=1');expect((await f.detector.read('epoch+policy')).stamp.revision).toBe(revision);
});
test('new heads/revisions, daily safety, schema, build and revision rewind all fall back',async()=>{
 const f=detectorFixture(),read=await f.detector.read('epoch');await f.detector.commit(read.stamp,'heads','7',100);let warm=await f.detector.read('epoch');
 expect(cloudChangeUnchanged(warm,'new-head','7',101)).toBe(false);expect(cloudChangeUnchanged(warm,'heads','8',101)).toBe(false);expect(cloudChangeUnchanged(warm,'heads','7',100+CLOUD_SAFETY_CHECK_MS)).toBe(false);expect(cloudChangeUnchanged(warm,'heads','7',99)).toBe(false);
 f.db.run('ALTER TABLE articles ADD COLUMN new_export_field TEXT');warm=await f.detector.read('epoch');expect(warm.stamp.generation).not.toBe(read.stamp.generation);expect(cloudChangeUnchanged(warm,'heads','7',101)).toBe(false);
 await f.detector.commit(warm.stamp,'heads','7',101);const rebuilt=new SqlCloudChangeDetection(f.host,'account+backend+device','build-2');expect(cloudChangeUnchanged(await rebuilt.read('epoch'),'heads','7',102)).toBe(false);
});
test('a concurrent write cannot be certified by an older export; failed transactions retain the old receipt',async()=>{
 const f=detectorFixture(),old=await f.detector.read('epoch');f.db.run("INSERT INTO articles VALUES(1,'changed',0)");await f.detector.commit(old.stamp,'heads','7',100);expect((await f.detector.read('epoch')).checkpoint).toBeUndefined();
 const current=await f.detector.read('epoch');await f.detector.commit(current.stamp,'heads','7',100);f.db.run('UPDATE sync_idle_change_revision SET revision=revision-1');expect(cloudChangeUnchanged(await f.detector.read('epoch'),'heads','7',101)).toBe(false);
});
test('search virtual tables and shadow caches do not become canonical change sources',async()=>{const f=detectorFixture();f.db.run('CREATE VIRTUAL TABLE memo_search USING fts5(text)');const before=await f.detector.read('epoch');f.db.run("INSERT INTO memo_search VALUES('index only')");expect((await f.detector.read('epoch')).stamp.revision).toBe(before.stamp.revision);f.db.run("INSERT INTO memo_notes VALUES('note','body')");expect((await f.detector.read('epoch')).stamp.revision).toBeGreaterThan(before.stamp.revision);});

test('remote applied witness is independent of local publication and invalidates on schema and daily expiry',async()=>{
 const f=detectorFixture(),initial=await f.detector.read('epoch');f.db.run("INSERT INTO articles VALUES(1,'concurrent local edit',0)");expect(await f.detector.commitRemote(initial.stamp,'heads','7',100)).toBe(true);
 const read=await f.detector.read('epoch');expect(read.checkpoint).toBeUndefined();expect(cloudRemoteUnchanged(read,'heads','7',101)).toBe(true);expect(cloudChangeUnchanged(read,'heads','7',101)).toBe(false);expect(cloudRemoteUnchanged(read,'heads','8',101)).toBe(false);expect(cloudRemoteUnchanged(read,'heads','7',100+CLOUD_SAFETY_CHECK_MS)).toBe(false);
 f.db.run('ALTER TABLE articles ADD COLUMN new_field TEXT');expect(cloudRemoteUnchanged(await f.detector.read('epoch'),'heads','7',101)).toBe(false);
});

test('source preferences, article preview metadata, old notes and remote body readiness are export change sources',async()=>{
 const f=detectorFixture();for(const table of ['source_preferences','source_media_preferences','article_previews','article_original_previews','notes','cloud_article_state','cloud_source_state','sync_books','sync_book_reading'])f.db.run(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,value TEXT)`);
 let read=await f.detector.read('epoch');await f.detector.commit(read.stamp,'heads','7',100);
 for(const table of ['source_preferences','source_media_preferences','article_previews','article_original_previews','notes','cloud_article_state','cloud_source_state','sync_books','sync_book_reading']){
  const before=(await f.detector.read('epoch')).stamp.revision;f.db.run(`INSERT INTO ${table} VALUES(1,'before')`);f.db.run(`UPDATE ${table} SET value='after' WHERE id=1`);f.db.run(`DELETE FROM ${table} WHERE id=1`);read=await f.detector.read('epoch');expect(read.stamp.revision).toBe(before+3);expect(cloudChangeUnchanged(read,'heads','7',101)).toBe(false);
 }
});

test('DDL racing trigger installation cannot certify a schema whose write triggers were omitted',async()=>{
 const f=detectorFixture();let raced=false;
 const detector=new SqlCloudChangeDetection(async<T>(method:string,args:any):Promise<T>=>{const result=await f.host<T>(method,args);if(!raced&&method==='sql.query'&&args.sql.includes("type='table'")){raced=true;f.db.run('CREATE TABLE source_preferences(id INTEGER PRIMARY KEY,value TEXT)');}return result;},'account+backend+device','build-1');
 await expect(detector.read('epoch')).rejects.toThrow('CHECK constraint failed');
 const before=await detector.read('epoch');f.db.run("INSERT INTO source_preferences VALUES(1,'new preference')");expect((await detector.read('epoch')).stamp.revision).toBeGreaterThan(before.stamp.revision);
});
