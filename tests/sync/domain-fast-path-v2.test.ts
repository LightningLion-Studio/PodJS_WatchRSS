import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFile} from 'node:fs/promises';
import {AckedStateVector,projectionVersionRootText,projectionProfileText,receiptIsCurrent,STATE_RECEIPT_MAX_AGE_MS,checkedProjectionVersions,type StateReceipts} from '@podjs/framework/acked-state-vector';
import {directoryWitnessWindow,type WitnessStat} from '@podjs/framework/directory-witness';
import {SqlDomainDefinitions,DOMAIN_ENCODERS,SYNC_DOMAINS} from '../../src/sync/domain-definitions';
import {SqlDomainVectorStore,DOMAIN_FAST_PATH_PROFILE} from '../../src/sync/domain-fast-path';
import {LibraryProjectionCache} from '../../src/sync/projection-cache';
import {initializeSchema} from '../../src/core/schema';
import {initializeMemoSchema} from '../../src/notes/repository';
import type {SqlDatabase} from '../../src/core/types';
const a='a'.repeat(64),b='b'.repeat(64),hash=async(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const remote=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,b])),versions=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,{encoder:1,schema:18,definition:b}]));
async function fixture(){
 const sql=new Database(':memory:');const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 await initializeSchema(db);await db.execute("INSERT INTO sync_local_identity VALUES(1,'watch','watch')");await initializeMemoSchema(db);await new LibraryProjectionCache(db).initialize();let now=1000000;
 const store=(encoders=DOMAIN_ENCODERS)=>new SqlDomainVectorStore(db,{sha256:hash},async()=>({scope:a,roots:{books:b,reader:b,notes:b,account:b}}),{now:()=>now,canSkipLibrary:async()=>true,encoders});
 return {sql,db,store,now:(v:number)=>{now=v;},time:()=>now};
}
async function prime(f:Awaited<ReturnType<typeof fixture>>){const v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE),s=await v.summary(remote,{},versions);for(const d of SYNC_DOMAINS)v.completed(d);await v.stage(s.windowId,remote,SYNC_DOMAINS,versions);await v.applied();return Object.fromEntries(Object.entries(s.roots).map(([d,r])=>[d,{localRoot:b,remoteRoot:r}])) as StateReceipts;}
test('R47.1 byte-exact shared projection/root/TTL vectors and cross-platform descriptors',async()=>{
 const v=JSON.parse(await readFile(new URL('../../../.codex-tmp/cloud-v2/vectors/domain-fast-path-v2.json',import.meta.url),'utf8'));
 for(const c of v.cases){const p={encoder:c.encoder,schema:c.schema,definition:c.definition};expect(projectionProfileText(c.domain,p)).toBe(c.projectionText);const text=projectionVersionRootText(c.domain,p,c.epoch,c.revision);expect(Buffer.from(text).toString('hex')).toBe(c.utf8Hex);expect(await hash(new TextEncoder().encode(text))).toBe(c.root);}
 for(const value of [{encoder:0,schema:1,definition:a},{encoder:1,schema:-1,definition:a},{encoder:2147483648,schema:1,definition:a},{encoder:1,schema:2147483648,definition:a}])expect(()=>checkedProjectionVersions({library:value},SYNC_DOMAINS)).toThrow();
 expect(receiptIsCurrent(100,100+STATE_RECEIPT_MAX_AGE_MS-1)).toBe(true);expect(receiptIsCurrent(100,100+STATE_RECEIPT_MAX_AGE_MS)).toBe(false);expect(receiptIsCurrent(101,100)).toBe(false);expect(receiptIsCurrent(0,100)).toBe(false);
});
test('R47.1 encoder/schema/ABI upgrades invalidate durable roots and old receipts without source writes',async()=>{const f=await fixture();try{
 const known=await prime(f),before=(await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE));expect((await before.summary(remote,known,versions)).skipDomains).toHaveLength(7);
 const upgrade=f.store({...DOMAIN_ENCODERS,library:DOMAIN_ENCODERS.library+1});expect((await (await upgrade.open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,versions)).skipDomains).not.toContain('library');
 const baseline=await new SqlDomainDefinitions(f.db,{sha256:hash},{...DOMAIN_ENCODERS,library:DOMAIN_ENCODERS.library+1}).ensure();await f.db.execute('PRAGMA user_version='+(baseline.notes.schema+1));const changed=await new SqlDomainDefinitions(f.db,{sha256:hash},{...DOMAIN_ENCODERS,library:DOMAIN_ENCODERS.library+1}).ensure();expect(changed.notes.schema).toBe(baseline.notes.schema+1);expect(changed.notes.epoch).not.toBe(baseline.notes.epoch);
 const abi=await new SqlDomainDefinitions(f.db,{sha256:hash},{...DOMAIN_ENCODERS,library:DOMAIN_ENCODERS.library+1},15).ensure();expect(abi.library.definition).not.toBe(changed.library.definition);
 }finally{f.sql.close();}});
test('R47.1 live ADD COLUMN refreshes trigger columns and same-clock writes bump the domain',async()=>{const f=await fixture();try{
 const known=await prime(f),v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE);await f.db.execute("ALTER TABLE memo_notes ADD COLUMN new_state TEXT NOT NULL DEFAULT ''");
 const w=await v.summary(remote,known,versions);expect(w.skipDomains).not.toContain('notes');
 const trigger=(await f.db.query("SELECT sql FROM sqlite_master WHERE name='sync_fast_notes_memo_notes_update'"))[0]!;expect(String(trigger.sql)).toContain('new_state');
 await f.db.execute("INSERT INTO memo_notes(note_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,created_at,updated_at,modified_by) VALUES('n','N','','','','','',1,1,'watch')");const n=Number((await f.db.query("SELECT revision FROM sync_fast_versions WHERE domain='notes'"))[0]!.revision);
 await f.db.execute("UPDATE memo_notes SET new_state='changed' WHERE note_id='n'");expect(Number((await f.db.query("SELECT revision FROM sync_fast_versions WHERE domain='notes'"))[0]!.revision)).toBe(n+1);
 }finally{f.sql.close();}});
test('R47.1 warm SKIP does not slide TTL, expired/future/legacy receipts fail closed, cleared SKIP never resurrects',async()=>{const f=await fixture();try{
 const known=await prime(f),original=await f.db.query('SELECT domain,verified_at FROM sync_fast_receipts ORDER BY domain');f.now(f.time()+100);
 const v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE),s=await v.summary(remote,known,versions);expect(s.skipDomains).toHaveLength(7);await v.stage(s.windowId,remote,[],versions);await v.applied();expect(await f.db.query('SELECT domain,verified_at FROM sync_fast_receipts ORDER BY domain')).toEqual(original);
 const late=await v.summary(remote,known,versions);await v.stage(late.windowId,remote,[],versions);await f.db.execute('DELETE FROM sync_fast_receipts');await v.applied();expect(await f.db.query('SELECT * FROM sync_fast_receipts')).toEqual([]);
 await prime(f);f.now(f.time()+STATE_RECEIPT_MAX_AGE_MS);expect((await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,versions)).skipDomains).toEqual([]);
 await f.db.execute('UPDATE sync_fast_receipts SET verified_at=?',[f.time()+1]);expect((await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,versions)).skipDomains).toEqual([]);
 await f.db.execute('UPDATE sync_fast_receipts SET verified_at=0');expect((await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,versions)).skipDomains).toEqual([]);
 }finally{f.sql.close();}});
test('R47.1 commit descriptor changes cannot be signed, while unlike local schema versions are valid',async()=>{
 let calls=0;const vector=new AckedStateVector(['library'],async()=>({library:a}),async()=>({}),async()=>{calls++;},()=> 'v2',{versions:()=>({library:{encoder:1,schema:6,definition:a}})});
 const s=await vector.summary({library:b},{},{library:{encoder:1,schema:18,definition:b}});vector.completed('library');
 const result=await vector.stage(s.windowId,{library:b},['library'],{library:{encoder:2,schema:18,definition:b}});expect(result.committedDomains).toEqual([]);expect(result.retryDomains).toEqual(['library']);await vector.applied();expect(calls).toBe(0);
 await expect(vector.summary({library:b},{},{})).rejects.toThrow('Missing projection');
});
test('R47.1 directory windows list once and detect late file/directory changes through known stat tokens',async()=>{
 let scans=0,token='dir1',file='file1';const stat=async(p:string):Promise<WitnessStat>=>({exists:true,file:p==='assets/a',directory:p==='assets',size:8,modified:1,changeToken:p==='assets'?token:file});
 const w=await directoryWitnessWindow(['assets'],async()=>{scans++;return {entries:[{path:'assets/a',file:true,directory:false,size:8,modified:1,changeToken:file}]};},stat,async s=>hash(new TextEncoder().encode(s)));expect(w).toBeDefined();expect(await w!.valid()).toBe(true);expect(await w!.valid()).toBe(true);expect(scans).toBe(1);file='file2';expect(await w!.valid()).toBe(false);file='file1';token='new-membership';expect(await w!.valid()).toBe(false);expect(scans).toBe(1);
 let exists=false;const missing=await directoryWitnessWindow(['missing'],async()=>({entries:[]}),async()=>({exists,file:false,directory:exists,size:0,modified:0,changeToken:exists?'now-present':undefined}),async s=>hash(new TextEncoder().encode(s)));expect(await missing!.valid()).toBe(true);exists=true;expect(await missing!.valid()).toBe(false);
});

import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body';
import {gzipSync,gunzipSync} from 'node:zlib';
async function libraryFixture(){
 const f=await fixture();let encoded=0;
 const codec:SyncBodyCodec={sha256:hash,encode:async body=>{encoded++;return gzipSync(encodeBodyJson(body));},decode:async bytes=>gunzipSync(bytes).toString()};
 const uri=async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};};
 const ports={codec,text:{parseUri:uri,htmlText:async(s:string)=>s},uri:{parseUri:uri,parseAndroid:uri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:f.time};
 const create=()=>{const repo=new SqlLibrarySessionRepository(f.db,ports);repo.configurePeer('phone',{supportsRssCanonicalIds:true});return repo;};
 await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','local',1)");
 await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'One','body one','https://example.test/one','one',100),(2,1,'Two','body two','https://example.test/two','two',100)");
 const repo=create(),window=await repo.prepareWindow('phone',0);
 const acknowledge=async(r:SqlLibrarySessionRepository,w:typeof window)=>r.markSuccess({remoteDeviceId:'phone',localSeqToInclusive:w.toSeqInclusive,remoteSeqToInclusive:0,remoteProtocolVersion:14,fullSnapshot:w.fullSnapshot,projectionGeneration:w.projectionGeneration});
 await acknowledge(repo,window);return {...f,repo,create,window,acknowledge,encoded:()=>encoded,codec};
}
test('R47.1 unchanged items re-encode and full-ACK exactly once after projection upgrade, including non-fast paths',async()=>{
 const f=await libraryFixture(),encoder=DOMAIN_ENCODERS.library;
 try{
  expect(await f.repo.canSkipLibrary('phone')).toBe(true);const before=await f.db.query('SELECT count(*) n FROM sync_change_log'),encoded=f.encoded();DOMAIN_ENCODERS.library=encoder+1;
  const upgraded=f.create(),window=await upgraded.prepareWindow('phone',f.window.toSeqInclusive);
  expect(window.fullSnapshot).toBe(true);expect(window.fallbackReason).toBe('projectionChanged');expect(window.articleManifest).toHaveLength(2);expect(f.encoded()).toBeGreaterThan(encoded);expect(await f.db.query('SELECT count(*) n FROM sync_change_log')).toEqual(before);
  await f.acknowledge(upgraded,f.window);expect(await upgraded.canSkipLibrary('phone')).toBe(false); // stale ACK cannot confirm new definition
  await f.acknowledge(upgraded,window);expect(await upgraded.canSkipLibrary('phone')).toBe(true);expect((await upgraded.prepareWindow('phone',window.toSeqInclusive)).articleManifest).toHaveLength(0);
 }finally{DOMAIN_ENCODERS.library=encoder;f.sql.close();}
});
test('R47.1 library periodicFull, future full timestamps and peerProtocol defeat valid fast receipts',async()=>{const f=await libraryFixture();try{
 const provider=new SqlDomainVectorStore(f.db,{sha256:hash},async()=>({scope:a,roots:{books:b,reader:b,notes:b,account:b}}),{now:f.time,canSkipLibrary:p=>f.repo.canSkipLibrary(p)});
 const v=await provider.open('phone',DOMAIN_FAST_PATH_PROFILE),first=await v.summary(remote,{},versions);for(const d of SYNC_DOMAINS)v.completed(d);await v.stage(first.windowId,remote,SYNC_DOMAINS,versions);await v.applied();const known=Object.fromEntries(Object.entries(first.roots).map(([d,r])=>[d,{localRoot:b,remoteRoot:r}]));
 expect((await (await provider.open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,versions)).skipDomains).toHaveLength(7);
 for(const [sql,reason]of [["UPDATE sync_peer_state SET last_protocol_version=12",'peerProtocol'],[`UPDATE sync_peer_state SET last_protocol_version=14,last_full_sync_at=${f.time()+1}`,'periodicFull'],['UPDATE sync_peer_state SET last_full_sync_at=0','noFullSnapshot']] as const){
  await f.db.execute(sql);const s=await (await provider.open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,versions);expect(s.skipDomains).not.toContain('library');expect(s.skipDomains).toHaveLength(6);expect((await f.repo.prepareWindow('phone',f.window.toSeqInclusive)).fallbackReason).toBe(reason);
 }
 }finally{f.sql.close();}});
test('R47.1 same-definition trigger reinstall rotates cache generation and rejects ABA publication',async()=>{const f=await libraryFixture();try{
 const old=(await new SqlDomainDefinitions(f.db,f.codec).ensure()).library;await f.db.execute('DROP TRIGGER sync_fast_cache_manifest');const next=(await new SqlDomainDefinitions(f.db,f.codec).ensure()).library;
 expect(next.definition).toBe(old.definition);expect(next.generation).not.toBe(old.generation);expect(await f.db.query('SELECT * FROM sync_fast_library_baseline')).toEqual([]);
 const cache=new LibraryProjectionCache(f.db),revision=Number((await f.db.query('SELECT revision FROM sync_library_revision'))[0]!.revision);
 await expect(cache.publish('aba',revision,[],new Map(),undefined,undefined,await cache.sequence(),old.generation)).rejects.toThrow();expect(await f.db.query("SELECT * FROM sync_projection_header WHERE scope='aba'")).toEqual([]);
 }finally{f.sql.close();}});
test('R47.1 reading encoder rebuilds R46 namespace while retaining explicit unread, saved clocks and all business values',async()=>{const f=await fixture();try{
 const defs=new SqlDomainDefinitions(f.db,{sha256:hash}),before=(await defs.ensure()).bookReading;
 await f.db.execute("INSERT INTO sync_book_reading(book_id,chapter_index,state_json,is_read,progress,clock,position,hash,source,favorite_saved,favorite_clock) VALUES('book',1,'{\"explicitUnread\":true}',0,0.3,55,42,'body','phone',0,77)");
 await f.db.execute("INSERT INTO sync_book_reading_peers VALUES('phone',?,1,'remote',1,'root')",[before.epoch]);const state=await f.db.query('SELECT * FROM sync_book_reading');
 const next=(await new SqlDomainDefinitions(f.db,{sha256:hash},{...DOMAIN_ENCODERS,bookReading:DOMAIN_ENCODERS.bookReading+1}).ensure()).bookReading;
 expect(next.epoch).not.toBe(before.epoch);expect(await f.db.query('SELECT * FROM sync_book_reading')).toEqual(state);expect(await f.db.query('SELECT * FROM sync_book_reading_peers')).toEqual([]);expect((await f.db.query('SELECT * FROM sync_book_reading_versions')).length).toBe(1);expect((await f.db.query('SELECT * FROM sync_book_reading_history')).length).toBe(1);
 }finally{f.sql.close();}});
test('R47.1 active user_version changes and newly added cache fields invalidate before later same-clock writes',async()=>{const f=await libraryFixture();try{
 const manager=new SqlDomainDefinitions(f.db,f.codec),before=(await manager.ensure()).library;await f.db.execute('PRAGMA user_version='+(before.schema+1));const changed=(await manager.ensure()).library;expect(changed.schema).toBe(before.schema+1);expect(changed.generation).not.toBe(before.generation);
 await f.db.execute("ALTER TABLE article_sync_content ADD COLUMN late_encoded_state TEXT NOT NULL DEFAULT ''");await f.repo.prepareFastProjection();
 expect(String((await f.db.query("SELECT sql FROM sqlite_master WHERE name='sync_projection_track_cache_article_sync_content_update'"))[0]!.sql)).toContain('late_encoded_state');
 await f.db.execute("UPDATE sync_fast_definitions SET seeded=1 WHERE domain='library'");await f.db.execute("INSERT OR IGNORE INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(1,NULL,'body',?,4,131072,?,4)",[a,JSON.stringify([a])]);const rev=Number((await f.db.query("SELECT revision FROM sync_fast_versions WHERE domain='library'"))[0]!.revision);await f.db.execute("UPDATE article_sync_content SET late_encoded_state='changed' WHERE item_id=1");expect(Number((await f.db.query("SELECT revision FROM sync_fast_versions WHERE domain='library'"))[0]!.revision)).toBeGreaterThan(rev);
 }finally{f.sql.close();}});
test('R47.1 new reading columns extend the live dirty trigger without touching existing clocks',async()=>{const f=await fixture();try{
 const defs=new SqlDomainDefinitions(f.db,{sha256:hash});await defs.ensure();await f.db.execute("ALTER TABLE articles ADD COLUMN reading_extension TEXT NOT NULL DEFAULT ''");await defs.ensure();
 const sql=String((await f.db.query("SELECT sql FROM sqlite_master WHERE name='sync_book_reading_dirty_articles_update'"))[0]!.sql);expect(sql).toContain('reading_extension');expect(sql).toContain('OLD.\"reading_extension\" IS NOT NEW.\"reading_extension\"');
 }finally{f.sql.close();}});
import {readTokenUsagePage} from '../../src/sync/token-usage';
test('R47.1 usage encoder change resets its inner cursor epoch without removing records',async()=>{const f=await fixture();try{
 await f.db.execute("INSERT INTO llm_token_usage(id,provider,model,request_id,usage_json,created_at) VALUES(1,'p','m','r','{\"total_tokens\":5}',9)");
 const old=await readTokenUsagePage(f.db,{limit:10,afterId:0}),defs=new SqlDomainDefinitions(f.db,{sha256:hash});await defs.ensure();const baseline=await readTokenUsagePage(f.db,{limit:10,afterId:0});
 await new SqlDomainDefinitions(f.db,{sha256:hash},{...DOMAIN_ENCODERS,usage:DOMAIN_ENCODERS.usage+1}).ensure();const next=await readTokenUsagePage(f.db,{limit:10,afterId:1,usageEpoch:baseline.usageEpoch});expect(next.reset).toBe(true);expect(next.records).toEqual(old.records);expect(next.usageEpoch).not.toBe(baseline.usageEpoch);
 }finally{f.sql.close();}});

test('R47.1 import witness uses URL indexes instead of scanning every chapter on body mutations',async()=>{const f=await fixture();try{
 await new SqlDomainDefinitions(f.db,{sha256:hash}).ensure();
 const article=await f.db.query('EXPLAIN QUERY PLAN SELECT 1 FROM articles WHERE channel_id=? AND COALESCE(link,dedup_key) IN (?,?)',[1,'old','new']);
 expect(article.map(r=>String(r.detail)).join(' ')).toContain('sync_fast_import_article_url');
 const book=await f.db.query('EXPLAIN QUERY PLAN SELECT 1 FROM sync_book_aliases WHERE url IN (?,?) OR channel_url IN (?,?)',['old','new','old','new']);
 expect(book.map(r=>String(r.detail)).join(' ')).toContain('sync_fast_import_channel_url');
 }finally{f.sql.close();}});
