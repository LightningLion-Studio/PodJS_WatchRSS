import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFile} from 'node:fs/promises';
import {versionRootText,AckedStateVector,type StateRoots,type StateReceipts} from '@podjs/framework/acked-state-vector';
import {SqlDomainVectorStore,SYNC_DOMAINS,DOMAIN_FAST_PATH_PROFILE,type DomainExternalState} from '../../src/sync/domain-fast-path';
import {LibraryProjectionCache} from '../../src/sync/projection-cache';
import {initializeSchema} from '../../src/core/schema';
import {initializeMemoSchema} from '../../src/notes/repository';
import type {SqlDatabase} from '../../src/core/types';
import {createApplicationActionHandler} from '../../src/sync/application-actions';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session';
import type {JsonObject} from '../../src/sync/protocol';
import {encodeFrame} from '../../src/sync/protocol';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),hash=async(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
async function setup(){const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};await initializeSchema(db);await initializeMemoSchema(db);await new LibraryProjectionCache(db).initialize();let external:DomainExternalState={scope:a,roots:{books:b,reader:b,notes:b,account:b}};const store=()=>new SqlDomainVectorStore(db,{sha256:hash},async()=>external,{canSkipLibrary:async()=>true});return {sql,db,store,set:(r:DomainExternalState)=>{external=r;}};}
const descriptors=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,{encoder:1,schema:18,definition:b}]));
const remote=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,b]));
async function prime(f:Awaited<ReturnType<typeof setup>>){const v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE),w=await v.summary(remote,{},descriptors);for(const d of SYNC_DOMAINS)v.completed(d);expect((await v.stage(w.windowId,remote,SYNC_DOMAINS,descriptors)).committedDomains).toHaveLength(7);await v.applied();return Object.fromEntries(Object.entries(w.roots).map(([d,r])=>[d,{localRoot:b,remoteRoot:r}])) as StateReceipts;}
test('R47 shared version-root and receipt vectors',async()=>{
 const vectors=JSON.parse(await readFile(new URL('../../../.codex-tmp/cloud-v2/vectors/domain-fast-path.json',import.meta.url),'utf8'));
 for(const v of vectors.cases){const text=versionRootText('watchrss.ble.domain-version.v1',v.domain,v.epoch,v.revision);expect(Buffer.from(text).toString('hex')).toBe(v.utf8Hex);expect(await hash(new TextEncoder().encode(text))).toBe(v.root);}
 for(const r of vectors.receiptCases){const v=new AckedStateVector(['one'],async()=>({one:r.localRoot}),async()=>(r.saved?{one:r.saved}:{}) as StateReceipts,async()=>{},()=>r.name);expect((await v.summary({one:r.remoteRoot},r.known?{one:r.known}:{})).skipDomains).toEqual(r.skip?['one']:[]);}
});
test('R47 durable per-domain roots survive restart without building manifests or bodies',async()=>{const f=await setup();try{
 const known=await prime(f);let scanned=0;const q=f.db.query;f.db.query=async(sql,p)=>{if(/FROM articles|FROM sync_book_reading(?:\s|$)|FROM memo_notes/.test(sql))scanned++;return q(sql,p);};
 const restarted=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE);expect((await restarted.summary(remote,known,descriptors)).skipDomains).toEqual([...SYNC_DOMAINS]);expect(scanned).toBe(0);
 await f.db.execute('UPDATE sync_fast_versions SET revision=revision WHERE domain=?',['library']);expect((await restarted.summary(remote,known,descriptors)).skipDomains).toHaveLength(7);
 }finally{f.sql.close();}});
test('R47 each side must prove its own unchanged root and its mirrored ACK',async()=>{const f=await setup();try{
 const known=await prime(f),v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE);
 expect((await v.summary({...remote,notes:c},known,descriptors)).skipDomains).not.toContain('notes');expect((await v.summary(remote,{},descriptors)).skipDomains).toEqual([]);
 expect((await (await f.store().open('another-phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors)).skipDomains).toEqual([]);
 }finally{f.sql.close();}});
test('R47 same-clock notes edits, explicit unsave and read/unread invalidate only relevant roots',async()=>{const f=await setup();try{
 await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','local',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'one','https://example.test/a','one',1)");
 await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(1,'favorite',1,10)");const known=await prime(f);
 await f.db.execute("UPDATE article_saved_states SET saved=0 WHERE article_id=1");const v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE);expect((await v.summary(remote,known,descriptors)).skipDomains).not.toContain('library');
 await f.db.execute("INSERT INTO memo_notes(note_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,created_at,updated_at,modified_by) VALUES('n','n','one','one','h','h','one',1,1,'local')");const s=await v.summary(remote,known,descriptors);expect(s.skipDomains).not.toContain('notes');expect(s.skipDomains).toContain('usage');
 const before=s.roots.notes;await f.db.execute("UPDATE memo_notes SET markdown='two',plain_text='two' WHERE note_id='n'");expect((await v.summary(remote,known,descriptors)).roots.notes).not.toBe(before);
 const prior=(await v.summary(remote,known,descriptors)).roots.library;await f.db.execute('UPDATE articles SET is_read=1 WHERE id=1');const read=(await v.summary(remote,known,descriptors)).roots.library;expect(read).not.toBe(prior);await f.db.execute('UPDATE articles SET is_read=0 WHERE id=1');expect((await v.summary(remote,known,descriptors)).roots.library).not.toBe(prior);
 }finally{f.sql.close();}});
test('R47 physical book reading dirty entries invalidate roots before any capture/export',async()=>{const f=await setup();try{
 await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://watchrss.local/import-txt-novel/book','book',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'chapter','https://book/ch/1','one',1)");await f.db.execute("INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,registration_complete) VALUES('book','hash',1,'{}',1)");await f.db.execute("INSERT INTO sync_book_aliases(book_id,chapter_index,article_id,item_id,url,channel_url) VALUES('book',0,'one',1,'https://book/ch/1','https://watchrss.local/import-txt-novel/book')");
 const known=await prime(f);await f.db.execute('UPDATE articles SET is_read=1 WHERE id=1');const s=await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors);expect(s.skipDomains).not.toContain('bookReading');expect(s.skipDomains).toContain('library');expect(s.skipDomains).toContain('books');expect(s.skipDomains).toContain('notes');
 }finally{f.sql.close();}});
test('R47 missing/modified asset inventory, account scope and epoch reset cannot reuse receipts',async()=>{const f=await setup();try{
 const known=await prime(f);f.set({scope:a,roots:{books:b,reader:c,notes:c,account:b}});let s=await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors);expect(s.skipDomains).not.toContain('reader');expect(s.skipDomains).not.toContain('notes');expect(s.skipDomains).toContain('library');
 f.set({scope:a,roots:{books:b,notes:b,account:b}});s=await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors);expect(s.roots.reader).toBeUndefined();
 await f.db.execute("UPDATE sync_fast_definitions SET epoch='ffffffffffffffffffffffffffffffff'");s=await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors);expect(s.skipDomains).toEqual([]);
 f.set({scope:c,roots:{books:b,reader:b,notes:b,account:b}});expect((await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors)).skipDomains).toEqual([]);
 }finally{f.sql.close();}});
test('R47 frozen windows and failed/lost final ACK do not publish newer states',async()=>{const f=await setup();try{
 const v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE),s=await v.summary(remote,{},descriptors);for(const d of SYNC_DOMAINS)v.completed(d);await v.stage(s.windowId,remote,SYNC_DOMAINS,descriptors);expect(await f.db.query('SELECT * FROM sync_fast_receipts')).toEqual([]);v.abort();await v.applied();expect(await f.db.query('SELECT * FROM sync_fast_receipts')).toEqual([]);
 const n=await v.summary(remote,{},descriptors);for(const d of SYNC_DOMAINS)v.completed(d);await v.stage(n.windowId,remote,SYNC_DOMAINS,descriptors);f.set({scope:c,roots:{books:b,reader:b,notes:b,account:b}});await v.applied();expect(await f.db.query('SELECT * FROM sync_fast_receipts')).toEqual([]);
 }finally{f.sql.close();}});
function fastSession(negotiated=true,failAck=false){
 const roots=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,a])),saved=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,{localRoot:a,remoteRoot:b}])),known=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,{localRoot:b,remoteRoot:a}]));let published=0,window='',index=0;
 const provider={open:async()=>new AckedStateVector(SYNC_DOMAINS,async()=>roots,async()=>saved,async()=>{published++;},()=> 'window-one',{versions:()=>descriptors})};
 const handleAction=createApplicationActionHandler({domainVectors:provider,books:{apply:async()=>{throw Error('must skip book export');}},notes:{initialize:async()=>{},merge:async()=>0,allIncludingDeleted:async()=>{throw Error('must skip notes');}},deviceId:async()=>'watch',notesChanged:()=>{}});
 const ack={action:'ack',success:true,applied:true};const requests:(()=>JsonObject)[]=[()=>({action:'syncLibrary',version:14,phase:'probe',deviceId:'phone',requestPersistentSession:true,supportsPersistentSession:true,supportsDomainFastPathV2:negotiated,supportsRssCanonicalIds:true,supportsBookSyncV1:true,supportsBookReadingDeltaV1:true}),()=>ack,()=>({action:'syncDomains',version:2,phase:'summary',deviceId:'phone',profile:DOMAIN_FAST_PATH_PROFILE,projectionVersions:descriptors,roots:remote,known}),()=>ack,()=>({action:'syncDomains',version:2,phase:'commit',deviceId:'phone',windowId:window,projectionVersions:descriptors,roots:remote,completedDomains:[]}),()=>ack,()=>({action:'syncSession',phase:'complete'}),()=>{if(failAck)throw Error('lost final ACK');return ack;}];
 const outbound:JsonObject[]=[];const repo={deviceId:async()=>'watch'} as LibrarySessionRepository;
 const session=new LibrarySyncSession({readFrame:async()=>requests[index++]!(),writeFrame:async frame=>{outbound.push(frame);if(frame.action==='syncDomains'&&frame.phase==='summary')window=String(frame.windowId);},close:async()=>{}},repo,{handleAction});return {session,outbound,published:()=>published};
}
test('R47 production session factory completes all-equal seven domains without invoking legacy exports',async()=>{const f=fastSession();await f.session.run();expect(f.outbound.map(r=>r.action)).toEqual(['syncLibrary','syncDomains','syncDomains','syncSession']);expect(f.outbound[1]!.skipDomains).toHaveLength(7);expect(f.published()).toBe(1);expect(f.outbound.reduce((n,f)=>n+encodeFrame(f).length,0)).toBeLessThan(10000);});
test('R47 requires explicit physical-connection negotiation and final applied ACK',async()=>{const missing=fastSession(false);await expect(missing.session.run()).rejects.toThrow('domain_fast_path_not_negotiated');expect(missing.published()).toBe(0);const lost=fastSession(true,true);const result=await lost.session.run();expect(result.at(-1)!.ack).toBeNull();expect(lost.published()).toBe(0);});

test('R47 ignores unsaved public RSS refresh clocks but witnesses unknown source revision writers',async()=>{const f=await setup();try{
 await f.db.execute("INSERT INTO channels(id,url,title,created_at,last_fetched_at) VALUES(1,'https://public.example/rss','public',1,1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'not retained','ordinary RSS','https://public.example/a','guid:a',1)");const known=await prime(f),v=await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE);
 await f.db.execute("UPDATE articles SET title='new RSS title',fetched_at=99,is_read=1 WHERE id=1");await f.db.execute('UPDATE channels SET last_fetched_at=99 WHERE id=1');await f.db.execute("INSERT INTO cloud_rss_article_ids(item_id,article_id) VALUES(1,'pool-id')");expect((await v.summary(remote,known,descriptors)).skipDomains).toContain('library');
 await f.db.execute('UPDATE sync_library_revision SET revision=revision+1 WHERE id=1');expect((await v.summary(remote,known,descriptors)).skipDomains).not.toContain('library');
 }finally{f.sql.close();}});

test('R47 raw imports and pending display edits invalidate books before registration',async()=>{const f=await setup();try{
 const known=await prime(f);await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://watchrss.local/import-txt-novel/new','new book',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'chapter','https://book/new/1','new',1)");
 const s=await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,known,descriptors);expect(s.skipDomains).not.toContain('books');expect(await f.db.query('SELECT * FROM sync_books')).toEqual([]);
 const newer=await prime(f);await f.db.execute("INSERT INTO sync_book_display_dirty(book_id) VALUES('pending-display')");expect((await (await f.store().open('phone',DOMAIN_FAST_PATH_PROFILE)).summary(remote,newer,descriptors)).skipDomains).not.toContain('books');
 }finally{f.sql.close();}});
