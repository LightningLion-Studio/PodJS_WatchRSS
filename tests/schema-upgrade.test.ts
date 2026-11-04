import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeSchema,SCHEMA,SCHEMA_VERSION} from '../src/core/schema';
import type {SchemaStatement} from '../src/core/dedup-migration';
import installed from './fixtures/installed-v9-schema.json';
import v8 from './fixtures/installed-v8-schema.json';
import v2 from './fixtures/installed-v2-schema.json';

async function fixture(schema=installed){
 const root=await mkdtemp(join(tmpdir(),'installed-schema-')),path=join(root,'library.sqlite');let raw=new Database(path),transactions=0;
 const db={query:async(q:string,p:readonly (string|number|null)[]=[])=>raw.query(q).all(...p) as Record<string,unknown>[],transaction:async(ss:SchemaStatement[])=>{transactions++;raw.transaction(()=>{for(const s of ss)raw.query(s.sql).run(...s.params??[]);})();}};
 raw.exec('PRAGMA foreign_keys=ON');await db.transaction(schema.statements);
 raw.exec(`INSERT INTO sync_local_identity VALUES(1,'keep-device','keep-order');
 INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://test.invalid/rss','频道',1);
 INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_saved) VALUES(1,1,'正文','unchanged body','https://test.invalid/a','guid:a',1,1);UPDATE articles SET guid='a' WHERE id=1;
 INSERT INTO article_saved_states VALUES(1,'favorite',0,30,-30);
 INSERT INTO article_reading_state VALUES(1,.5,40,123,'hash','{"position":123}');

 CREATE TABLE extension_owned(value TEXT);INSERT INTO extension_owned VALUES('preserve');`);
 if(schema.version>=5)raw.exec("INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,package_path) VALUES('book','fingerprint',1,'{}','books/book.jsonl')");
 const dump=()=>Object.fromEntries((raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,raw.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
 return {db,get raw(){return raw;},get transactions(){return transactions;},dump,reopen(){raw.close();raw=new Database(path);raw.exec('PRAGMA foreign_keys=ON');},async close(){raw.close();await rm(root,{recursive:true,force:true});}};
}

test('real installed pre-clear v9 opens without replaying backfills or altering business data',async()=>{
 const f=await fixture();try{
  expect(f.raw.query('PRAGMA user_version').get()).toEqual({user_version:9});
  expect(f.raw.query("SELECT name FROM sqlite_master WHERE name='library_clear_journal'").get()).toBeNull();
  const before=f.dump(),count=f.transactions;
  await initializeSchema(f.db,{seedBuiltinChannels:true,now:()=>999});
  // Exact startup lookup in services.ts must succeed on an existing installation.
  expect(await f.db.query('SELECT id FROM library_clear_journal WHERE id=1')).toEqual([]);
  expect(f.transactions).toBe(count+1);
  const after=f.dump();delete after.library_clear_journal;for(const table of ['sync_book_install','sync_book_validation','sync_book_lifecycle_clock']){expect(after[table]).toEqual([]);delete after[table];}expect(after).toEqual(before);
  // Guard future additions to base DDL: every additive declaration must reach
  // an installed v9 too, not only fresh databases used by most fixtures.
  for(const sql of SCHEMA){const object=/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(sql);if(object)expect(f.raw.query('SELECT name FROM sqlite_master WHERE type=? AND name=?').get(object[1]!.toLowerCase(),object[2]!)).not.toBeNull();}
  expect(f.raw.query('PRAGMA user_version').get()).toEqual({user_version:SCHEMA_VERSION});
  const schema=f.raw.query('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),changes=f.raw.query('SELECT total_changes() AS n').get();
  await initializeSchema(f.db);expect(f.raw.query('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(f.raw.query('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schema);
  f.reopen();await initializeSchema(f.db);expect(f.dump()).toEqual({...before,library_clear_journal:[],sync_book_install:[],sync_book_validation:[],sync_book_lifecycle_clock:[]});
  expect(await f.db.query('PRAGMA integrity_check')).toEqual([{integrity_check:'ok'}]);expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
 }finally{await f.close();}
});

test('v9 auxiliary declarations repair missing provenance tables and cleanup table atomically',async()=>{
 const f=await fixture();try{
  f.raw.exec('DROP TABLE article_register_conflicts;DROP TABLE article_register_state;DROP TABLE article_deletion_cleanup;');
  const before=f.dump(),version=f.raw.query('PRAGMA schema_version').get();
  const fail={...f.db,transaction:(ss:SchemaStatement[])=>f.db.transaction([...ss.slice(0,1),{sql:'SELECT forced_auxiliary_failure()'},...ss.slice(1)])};
  await expect(initializeSchema(fail)).rejects.toThrow('forced_auxiliary_failure');expect(f.dump()).toEqual(before);expect(f.raw.query('PRAGMA schema_version').get()).toEqual(version);
  expect(f.raw.query('PRAGMA user_version').get()).toEqual({user_version:9});
  f.reopen();await initializeSchema(f.db);
  for(const table of ['library_clear_journal','article_register_state','article_register_conflicts','article_deletion_cleanup'])expect(await f.db.query(`SELECT * FROM ${table}`)).toEqual([]);
  const data=f.dump();await f.db.transaction([{sql:'INSERT INTO library_clear_journal VALUES(1,0,?)',params:['{"paths":[]}']}]);await initializeSchema(f.db);
  expect(await f.db.query('SELECT content_json FROM library_clear_journal')).toEqual([{content_json:'{"paths":[]}'}]);
  delete data.library_clear_journal;const actual=f.dump();delete actual.library_clear_journal;expect(actual).toEqual(data);
 }finally{await f.close();}
});

test('future v10 is rejected before any repair or data/version mutation',async()=>{
 const f=await fixture();try{
  f.raw.exec('PRAGMA user_version=10');const before=f.dump(),schema=f.raw.query('PRAGMA schema_version').get(),count=f.transactions;
  await expect(initializeSchema(f.db)).rejects.toThrow('Database schema 10 is newer than supported 9');
  expect(f.transactions).toBe(count);expect(f.dump()).toEqual(before);expect(f.raw.query('PRAGMA schema_version').get()).toEqual(schema);expect(f.raw.query('PRAGMA user_version').get()).toEqual({user_version:10});
 }finally{await f.close();}
});

for(const schema of [v2,v8])test(`historical v${schema.version} installs all new helpers before migrations reference them`,async()=>{
 const f=await fixture(schema);try{
  const before=f.dump();await initializeSchema(f.db,{seedBuiltinChannels:false});
  expect(await f.db.query('PRAGMA user_version')).toEqual([{user_version:9}]);
  for(const table of ['library_clear_journal','article_register_state','article_register_conflicts','article_deletion_cleanup','cloud_rss_article_ids'])expect(await f.db.query(`SELECT * FROM ${table}`)).toEqual([]);
  for(const table of ['articles','channels','article_saved_states','article_reading_state','sync_local_identity','extension_owned'])expect(f.dump()[table]).toEqual(before[table]);
  const changes=f.raw.query('SELECT total_changes() AS n').get();await initializeSchema(f.db);expect(f.raw.query('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(await f.db.query('PRAGMA integrity_check')).toEqual([{integrity_check:'ok'}]);expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
 }finally{await f.close();}
});

test('startup upgrades lifecycle deletion triggers before a v1 dedup migration',async()=>{
 const raw=new Database(':memory:');const db={query:async(q:string,p:readonly (string|number|null)[]=[])=>raw.query(q).all(...p) as Record<string,unknown>[],transaction:async(ss:SchemaStatement[])=>{raw.transaction(()=>{for(const s of ss)raw.query(s.sql).run(...s.params??[]);})();}};
 try{raw.exec(SCHEMA.join(';'));raw.exec('PRAGMA user_version=1;DROP TRIGGER sync_book_local_chapter_delete;CREATE TRIGGER sync_book_local_chapter_delete BEFORE DELETE ON articles BEGIN SELECT unavailable_json_function(OLD.id);END;');await initializeSchema(db,{seedBuiltinChannels:false});expect(await db.query('PRAGMA user_version')).toEqual([{user_version:9}]);expect(await db.query('PRAGMA integrity_check')).toEqual([{integrity_check:'ok'}]);expect(String((await db.query("SELECT sql FROM sqlite_master WHERE name='sync_book_local_chapter_delete'"))[0]!.sql)).toContain('sync_book_lifecycle_clock');
 }finally{raw.close();}
});
