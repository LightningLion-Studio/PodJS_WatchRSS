import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { htmlToText, parseFeed, resolveUrl, rssDedupKey, WatchRssRepository, initializeSchema, SCHEMA, SCHEMA_VERSION } from "../../src/core";
import {builtinForInput} from '../../src/core/builtin-channels.ts';
import nativeDedup from '../fixtures/rss-dedup-native.json';

test('native builtin links resolve to provider channels without confusing another host',()=>{
  expect(builtinForInput('https://www.bilibili.com','www.bilibili.com')?.url).toBe('builtin:bili');
  expect(builtinForInput('https://www.douyin.com','www.douyin.com')?.url).toBe('builtin:douyin');
  expect(builtinForInput('builtin:bili',null)?.url).toBe('builtin:bili');
  expect(builtinForInput('https://www.douyin.com.evil.test','www.douyin.com.evil.test')).toBeUndefined();
});

test("htmlToText preserves readable structure and unicode", () => {
  expect(htmlToText(`<p>你好&nbsp;世界</p><div>第二行<br>🙂</div><script>x()</script>`)).toBe("你好 世界\n第二行\n🙂");
});

test("parses RSS CDATA, namespaces, enclosure and entity text", () => {
  const feed = parseFeed(`<?xml version="1.0"?><rss><channel><title>中文 &amp; News</title><description>desc</description><item><guid>g-1</guid><title><![CDATA[标题 &amp; 1]]></title><link>https://e.test/a?x=1&amp;y=2</link><pubDate>Tue, 03 Sep 2024 10:00:00 GMT</pubDate><content:encoded xmlns:content="urn"><![CDATA[<p>正文</p>]]></content:encoded><enclosure url="https://e.test/a.mp3" type="audio/mpeg"/></item></channel></rss>`);
  expect(feed.title).toBe("中文 & News");
  expect(feed.articles[0]).toMatchObject({ title: "标题 & 1", link: "https://e.test/a?x=1&y=2", guid: "g-1", audioUrl: "https://e.test/a.mp3", content: "<p>正文</p>" });
});

test("parses Atom alternate links and unicode dates", () => {
  const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>我的订阅</title><subtitle>简介</subtitle><entry><id>tag:one</id><title>文章</title><link rel="alternate" href="https://example.test/post"/><summary>摘要</summary><content type="html">&lt;p&gt;内容&lt;/p&gt;</content><updated>2024-09-03T10:00:00Z</updated></entry></feed>`);
  expect(feed.title).toBe("我的订阅");
  expect(feed.articles[0]).toMatchObject({ link: "https://example.test/post", guid: "tag:one", pubDate: "2024-09-03T10:00:00Z",dedupKey:"guid:tag:one" });
});
test('dedup keys match the native Kotlin branch fixture exactly',()=>{
  for(const row of nativeDedup.cases)expect({name:row.name,key:rssDedupKey(row.guid,row.link,row.title)}).toEqual({name:row.name,key:row.expected});
  const linked=parseFeed(`<rss><channel><title>F</title><item><title></title><link>HTTPS://WWW.Example.COM/Path?Q=Upper</link></item></channel></rss>`,1);
  expect(linked.articles[0]).toMatchObject({title:'HTTPS://WWW.Example.COM/Path?Q=Upper',dedupKey:'link:HTTPS://WWW.Example.COM/Path?Q=Upper'});
  const titled=parseFeed(`<rss><channel><title>F</title><item><title>same</title><pubDate>2099-12-31</pubDate></item></channel></rss>`,1);
  expect(titled.articles[0]?.dedupKey).toBe('title:same');
  const relative=parseFeed('<rss><channel><title>F</title><item><link> ../Path?Q=Upper </link></item></channel></rss>',1,'https://example.test/feed/rss');
  expect(relative.articles[0]).toMatchObject({title:'../Path?Q=Upper',link:'https://example.test/Path?Q=Upper',dedupKey:'link:../Path?Q=Upper'});
  expect(parseFeed('<rss><channel><title>F</title><item><guid>　tag:Case　</guid></item></channel></rss>',1).articles[0]).toMatchObject({guid:'tag:Case',dedupKey:'guid:tag:Case'});
});
test("resolves relative article and media URLs without browser globals", () => {
  const base="https://example.test/feed/main.xml";
  expect(resolveUrl("/article",base)).toBe("https://example.test/article");
  expect(resolveUrl("media.mp3",base)).toBe("https://example.test/feed/media.mp3");
  expect(resolveUrl("../image.png",base)).toBe("https://example.test/image.png");
  expect(resolveUrl("?page=2",base)).toBe("https://example.test/feed/main.xml?page=2");
  expect(parseFeed(`<feed><title>F</title><entry><id>x</id><title>A</title><link href="/article"/><enclosure url="media.mp3" type="audio/mpeg"/></entry></feed>`,Date.now(),base).articles[0]).toMatchObject({link:"https://example.test/article",audioUrl:"https://example.test/feed/media.mp3"});
  expect(()=>parseFeed(`<a/><b/>`)).toThrow(/one root/);
});

test("collects nested text and rejects malformed XML", () => {
  expect(parseFeed(`<rss><channel><title><b>Nested</b> title</title><item><title>A</title><link>u</link></item></channel></rss>`).title).toBe("Nested title");
  expect(() => parseFeed(`<rss><channel><title>x</channel></rss>`)).toThrow(/Malformed XML/);
});

class FakeDb {
  executed: { sql: string; params?: readonly unknown[] }[] = [];
  async execute(sql: string, params?: readonly unknown[]) { this.executed.push({sql,params}); }
  async query(sql: string, _params?: readonly unknown[]) { return sql==='PRAGMA user_version'?[{user_version:0}]:[{id:1,url:"https://feed",title:"Feed",description:null,image_url:null,last_fetched_at:null,created_at:1,sort_order:0,is_pinned:0}]; }
  async transaction(statements: {sql:string;params?:readonly unknown[]}[]) { for (const s of statements) await this.execute(s.sql,s.params); }
}
test("schema uses portable statements and refresh is transactional", async () => {
  const db = new FakeDb(); await initializeSchema(db); expect(db.executed.some(s=>s.sql.includes("CREATE TABLE IF NOT EXISTS article_saved_states"))).toBe(true);
  const repo = new WatchRssRepository(db, async () => `<rss><channel><title>F</title><item><guid>x</guid><title>X</title><link>https://x</link></item></channel></rss>`);
  const c = await repo.addChannel("https://feed"); expect(c.id).toBe(1); await repo.refreshChannel(1);
  expect(db.executed.some(x => x.sql.includes("ON CONFLICT(channel_id,dedup_key)"))).toBe(true);
});

class BunDb {
  constructor(readonly raw: Database) {}
  maxChunkResult = 0;
  async execute(sql: string, params: readonly unknown[] = []) { this.raw.query(sql).run(...params as any[]); }
  async query(sql: string, params: readonly unknown[] = []) { const rows=this.raw.query(sql).all(...params as any[]) as Record<string, unknown>[]; if(sql.includes("article_body_chunks")) this.maxChunkResult=Math.max(this.maxChunkResult,...rows.map(r=>String(r.body ?? "").length)); return rows; }
  async transaction(statements: {sql:string;params?:readonly unknown[]}[]) { this.raw.exec("BEGIN"); try { for (const s of statements) this.raw.query(s.sql).run(...(s.params ?? []) as any[]); this.raw.exec("COMMIT"); } catch (e) { this.raw.exec("ROLLBACK"); throw e; } }
}
test('new libraries seed native builtin rows atomically, while an existing deletion stays deleted',async()=>{
  const raw=new Database(':memory:');const db=new BunDb(raw);
  try{
    const interrupted={query:db.query.bind(db),transaction:async(statements:{sql:string}[])=>db.transaction([...statements,{sql:'SELECT missing_seed_commit()'}])};
    await expect(initializeSchema(interrupted,{seedBuiltinChannels:true})).rejects.toThrow();
    expect(raw.query("SELECT count(*) n FROM sqlite_master WHERE name='channels'").get()).toEqual({n:0});
    await initializeSchema(db,{seedBuiltinChannels:true});
    expect(raw.query('PRAGMA user_version').get()).toEqual({user_version:SCHEMA_VERSION});
    const rows=raw.query("SELECT c.url,c.title,c.description,p.use_original_content FROM channels c JOIN source_preferences p ON p.channel_id=c.id ORDER BY c.url").all();
    expect(rows).toEqual([
      {url:'builtin:bili',title:'哔哩哔哩',description:'进入后登录获取推荐内容',use_original_content:1},
      {url:'builtin:douyin',title:'抖音',description:'进入后登录获取推荐内容',use_original_content:1},
    ]);
    raw.query("DELETE FROM channels WHERE url='builtin:douyin'").run();
    await initializeSchema(db);
    expect(raw.query("SELECT url FROM channels").all()).toEqual([{url:'builtin:bili'}]);
  }finally{raw.close();}
});
test('schema version upgrades in order, skips matching versions, and retries an interrupted migration atomically',async()=>{
  const raw=new Database(':memory:'),db=new BunDb(raw);
  try{
    for(const sql of SCHEMA)raw.run(sql);raw.run('PRAGMA user_version=1');
    raw.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test/rss','Feed',1)");
    raw.run("INSERT INTO articles(id,channel_id,title,guid,dedup_key,fetched_at) VALUES(1,1,'Article','raw-guid','raw-guid',1)");
    const interrupted={query:db.query.bind(db),transaction:async(statements:{sql:string;params?:readonly unknown[]}[])=>db.transaction([...statements.slice(0,12),{sql:'SELECT missing_schema_step()'},...statements.slice(12)])};
    await expect(initializeSchema(interrupted,{now:()=>99})).rejects.toThrow();
    expect(raw.query('PRAGMA user_version').get()).toEqual({user_version:1});
    expect(raw.query('SELECT dedup_key FROM articles').get()).toEqual({dedup_key:'raw-guid'});
    await initializeSchema(db,{now:()=>99});
    expect(raw.query('PRAGMA user_version').get()).toEqual({user_version:SCHEMA_VERSION});
    expect(raw.query('SELECT dedup_key FROM articles').get()).toEqual({dedup_key:'guid:raw-guid'});
    const queries:string[]=[];let transactions=0;const matching={query:async(sql:string)=>{queries.push(sql);return db.query(sql);},transaction:async()=>{transactions++;throw Error('must skip');}};
    await initializeSchema(matching,{seedBuiltinChannels:true,now:()=>{throw Error('must not prepare migrations');}});expect(transactions).toBe(0);expect(queries).toEqual(['PRAGMA user_version']);
  }finally{raw.close();}
});
test('dedup upgrade merges native-prefix and sync-hash rows without losing user or sync state',async()=>{
  const raw=new Database(':memory:');raw.exec('PRAGMA foreign_keys=ON');const db=new BunDb(raw);
  try{
    for(const sql of SCHEMA)raw.run(sql);raw.run('PRAGMA user_version=1');
    const hash='a'.repeat(64),link='https://www.ruanyifeng.com/blog/2026/01/example.html';
    raw.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://www.ruanyifeng.com/blog/atom.xml','Feed',1)");
    raw.query("INSERT INTO articles(id,channel_id,title,content,link,guid,is_read,is_saved,reading_progress,dedup_key,fetched_at) VALUES(10,1,'local','local body',?,?,0,0,.2,?,100)").run(link,'tag:www.ruanyifeng.com,2026:/blog//1.2552','guid:tag:www.ruanyifeng.com,2026:/blog//1.2552');
    raw.query("INSERT INTO articles(id,channel_id,title,guid,dedup_key,fetched_at) VALUES(12,1,'raw',?,?,50)").run('tag:www.ruanyifeng.com,2026:/blog//1.2552','tag:www.ruanyifeng.com,2026:/blog//1.2552');
    raw.query("INSERT INTO articles(id,channel_id,title,content,link,guid,is_read,is_saved,reading_progress,dedup_key,fetched_at) VALUES(11,1,'phone','phone body',?,?,1,1,.8,?,200)").run(link,hash,hash);
    raw.run("INSERT INTO article_reading_state VALUES(10,.3,100,3,'old',NULL),(11,.8,200,8,'new','{\"page\":2}')");
    raw.run("INSERT INTO article_saved_states VALUES(10,'favorite',0,100,-100),(11,'favorite',1,200,-200),(10,'watchLater',1,300,-300),(11,'watchLater',0,250,-250)");
    raw.run("INSERT INTO article_saved_entry_times VALUES(10,'watchLater',90),(11,'favorite',80)");
    raw.run("INSERT INTO notes(id,article_id,body,created_at,updated_at) VALUES(1,11,'keep note',1,1)");
    raw.run("INSERT INTO sync_local_identity VALUES(1,'watch','watch')");
    raw.query("INSERT INTO sync_article_ids VALUES(?,11,?)").run(hash,link);raw.query("INSERT INTO sync_article_aliases VALUES(11,?)").run(hash);
    raw.query("INSERT INTO sync_saved_states VALUES(?,'favorite',11,?,1,200,200,'phone','phone')").run(hash,link);
    raw.run("INSERT INTO article_body_chunks VALUES(10,0,'short'),(11,0,'complete body preserved')");
    raw.run("INSERT INTO article_original_chunks VALUES(11,0,'original preserved')");
    raw.run("INSERT INTO article_original_meta VALUES(11,'https://original.test',200)");
    raw.run("INSERT INTO offline_media(item_id,media_type,origin_url,relative_path,created_at) VALUES(11,'IMAGE','https://image.test','offline/image',100)");
    await initializeSchema(db,{now:()=>500});
    expect(raw.query('SELECT id,title,content,is_read,is_saved,reading_progress,dedup_key FROM articles').all()).toEqual([{id:10,title:'phone',content:'phone body',is_read:1,is_saved:1,reading_progress:.8,dedup_key:'guid:tag:www.ruanyifeng.com,2026:/blog//1.2552'}]);
    expect(raw.query('SELECT progress,changed_at,position_bytes,position_hash,state_json FROM article_reading_state').get()).toEqual({progress:.8,changed_at:200,position_bytes:8,position_hash:'new',state_json:'{"page":2}'});
    expect(raw.query('SELECT article_id,save_type,saved,changed_at FROM article_saved_states ORDER BY save_type').all()).toEqual([{article_id:10,save_type:'favorite',saved:1,changed_at:200},{article_id:10,save_type:'watchLater',saved:1,changed_at:300}]);
    expect(raw.query('SELECT article_id FROM notes').get()).toEqual({article_id:10});
    expect(raw.query('SELECT article_id,body FROM article_body_chunks').all()).toEqual([{article_id:10,body:'complete body preserved'}]);
    expect(raw.query('SELECT article_id,body FROM article_original_chunks').all()).toEqual([{article_id:10,body:'original preserved'}]);
    expect(raw.query('SELECT item_id,relative_path FROM offline_media').all()).toEqual([{item_id:10,relative_path:'offline/image'}]);
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(raw.query('SELECT article_id,item_id FROM sync_article_ids').get()).toEqual({article_id:hash,item_id:10});
    expect(raw.query('SELECT item_id,article_id FROM sync_article_aliases').get()).toEqual({item_id:10,article_id:hash});
    expect(raw.query('SELECT item_id FROM sync_saved_states').get()).toEqual({item_id:10});
    expect(raw.query("SELECT entity_id,reason,origin_device_id FROM sync_change_log WHERE reason='dedupMigration'").all()).toEqual([{entity_id:hash,reason:'dedupMigration',origin_device_id:'watch'}]);
    await initializeSchema(db,{now:()=>900});
    expect(raw.query("SELECT count(*) n FROM sync_change_log WHERE reason='dedupMigration'").get()).toEqual({n:1});
  }finally{raw.close();}
});
test("bun:sqlite preserves read, saved and source preferences across restart", async () => {
  const path=`/tmp/podjs-watchrss-${Date.now()}.db`, first=new BunDb(new Database(path)); await initializeSchema(first); await first.execute(`INSERT INTO channels(id,url,title,created_at) VALUES(1,'u','F',1)`); await first.execute(`INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at) VALUES(7,1,'A','g',1)`);
  const repo=new WatchRssRepository(first,async()=>""); await repo.setRead(7,true,.4); await repo.setSaved(7,true); await repo.setSourcePreferences(1,{useOriginalContent:true,readPreset:"compact"}); first.raw.close();
  const second=new BunDb(new Database(path)); const row=(await second.query(`SELECT is_read,is_saved,reading_progress FROM articles WHERE id=7`))[0]; expect(row).toMatchObject({is_read:1,is_saved:1,reading_progress:.4}); expect(await new WatchRssRepository(second,async()=>"").getSourcePreferences(1)).toMatchObject({useOriginalContent:true,readPreset:"compact"}); second.raw.close();
});
test("bun:sqlite transaction rolls back all refresh statements on failure", async () => {
  const db=new BunDb(new Database(":memory:")); await initializeSchema(db); await db.execute(`INSERT INTO channels(id,url,title,created_at) VALUES(1,'u','before',1)`);
  await expect(db.transaction([{sql:`UPDATE channels SET title='after' WHERE id=1`},{sql:`INSERT INTO no_such_table VALUES(1)`}])).rejects.toThrow(); expect((await db.query(`SELECT title FROM channels WHERE id=1`))[0].title).toBe("before"); db.raw.close();
});
test("large bodies are chunked and reconstructed without changing read state", async () => {
  const db=new BunDb(new Database(":memory:")); await initializeSchema(db); await db.execute(`INSERT INTO channels(id,url,title,created_at) VALUES(1,'u','before',1)`); await db.execute(`INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at,is_read,is_saved) VALUES(9,1,'old','guid:g',1,1,1)`);
  const body="界".repeat(550_000); const repo=new WatchRssRepository(db,async()=>`<rss><channel><title>F</title><item><guid>g</guid><title>new</title><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`); await repo.refreshChannel(1); expect(await repo.getArticleBody(9)).toBe(body); expect(db.maxChunkResult).toBeLessThanOrEqual(200_000); expect((await db.query(`SELECT is_read,is_saved FROM articles WHERE id=9`))[0]).toMatchObject({is_read:1,is_saved:1}); db.raw.close();
});

test("refresh accepts already downloaded feed without a second network request", async () => {
  const db = new BunDb(new Database(":memory:"));
  await initializeSchema(db);
  const repo = new WatchRssRepository(db, async () => { throw new Error("unexpected second download"); });
  const channel = await repo.addChannel("https://example.test/rss");
  const refreshed = await repo.refreshChannel(channel.id, "<rss><channel><title>预览频道</title><item><guid>one</guid><title>正文</title></item></channel></rss>");
  expect(refreshed.channel.title).toBe("预览频道");
  expect(refreshed.articles).toHaveLength(1);
  db.raw.close();
});

test("local clear preserves channels, isolates articles, journals deletion and rolls back failures", async () => {
  const {isDeletableLocalContentChannel}=await import("../../src/core/imported-content.ts");
  for(const url of [" HTTPS://WATCHRSS.LOCAL/import-content/txt/book ","https://watchrss.local/import-epub/book","https://watchrss.local/import-txt-novel/book","watchrss://phone-imports"])expect(isDeletableLocalContentChannel(url)).toBe(true);
  for(const url of [null,"https://ordinary.test/feed","watchrss://phone-imports/other","https://watchrss.local.evil/import-content"])expect(isDeletableLocalContentChannel(url)).toBe(false);
  const raw=new Database(":memory:");raw.exec("PRAGMA foreign_keys=ON");
  try {
    const db=new BunDb(raw);await initializeSchema(db);const repo=new WatchRssRepository(db,async()=>"");
    const local=await repo.addChannel("watchrss://phone-imports","独立文章"),other=await repo.addChannel("https://ordinary.test/feed","保留频道");
    await repo.setSourcePreferences(local.id,{useOriginalContent:true,readPreset:"custom"});
    for(const c of [local,other]) {
      await repo.refreshChannel(c.id,`<rss><channel><title>${c.title}</title><item><guid>shared-guid</guid><title>文章</title><description>正文</description></item></channel></rss>`);
      const a=(await repo.listArticles(c.id))[0];await repo.setSaved(a.id,true);await repo.setSaveState(a.id,"watchLater",true);await repo.saveNote(a.id,"笔记");
      await db.execute("INSERT INTO article_original_meta VALUES(?,?,?)",[a.id,"https://article.test",1]);await db.execute("INSERT INTO article_original_chunks VALUES(?,?,?)",[a.id,0,"缓存正文"]);
    }
    await repo.clearLocalContent(other.id);expect(await repo.listArticles(other.id)).toHaveLength(1);
    await repo.clearLocalContent(local.id);expect(await repo.listArticles(local.id)).toHaveLength(0);expect(await repo.listChannels()).toHaveLength(2);
    expect(await repo.getSourcePreferences(local.id)).toMatchObject({useOriginalContent:true,readPreset:"custom"});
    for(const table of ["articles","notes","article_original_meta","article_original_chunks"])expect(raw.query(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:1});
    expect(raw.query("SELECT channel_url,article_url,was_favorite,was_watch_later FROM local_article_deletions").all()).toEqual([{channel_url:local.url,article_url:"guid:shared-guid",was_favorite:1,was_watch_later:1}]);
    await repo.clearLocalContent(local.id);expect(raw.query("SELECT COUNT(*) n FROM local_article_deletions").get()).toEqual({n:1});
    raw.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT,'blocked'); END");
    const book=await repo.addChannel("https://watchrss.local/import-epub/book");await repo.refreshChannel(book.id,"<rss><channel><title>书籍</title><item><guid>book</guid><title>章</title></item></channel></rss>");
    await expect(repo.clearLocalContent(book.id)).rejects.toThrow("blocked");expect(await repo.listArticles(book.id)).toHaveLength(1);expect(raw.query("SELECT COUNT(*) n FROM local_article_deletions").get()).toEqual({n:1});
  } finally {raw.close();}
});

test('RSS body chunk boundaries preserve supplementary Unicode characters',async()=>{
  const db=new BunDb(new Database(':memory:'));try{await initializeSchema(db);const repo=new WatchRssRepository(db,async()=>''),channel=await repo.addChannel('https://example.test/rss');
  const body='x'.repeat(63999)+'😀'+'y'.repeat(70000);const result=await repo.refreshChannel(channel.id,`<rss><channel><title>F</title><item><guid>unicode-boundary</guid><title>T</title><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`);
  expect((await repo.getArticleBody(result.articles[0]!.id))===body).toBe(true);
  const chunks=await db.query('SELECT body FROM article_body_chunks ORDER BY chunk_index');expect(chunks.every(row=>!/[\uD800-\uDBFF]$/.test(String(row.body)))).toBe(true);
  }finally{db.raw.close();}
});

test('unversioned installed libraries migrate atomically and newer versions fail closed',async()=>{
  const raw=new Database(':memory:'),db=new BunDb(raw);
  try{
    for(const sql of SCHEMA)raw.run(sql);
    raw.exec("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test','F',1); INSERT INTO articles(id,channel_id,title,guid,dedup_key,fetched_at,is_saved) VALUES(1,1,'A','tag:x','tag:x',1,1)");
    const interrupted={query:db.query.bind(db),transaction:async(statements:Parameters<BunDb['transaction']>[0])=>db.transaction([...statements,{sql:'SELECT failed_final_step()'}])};
    await expect(initializeSchema(interrupted)).rejects.toThrow();
    expect(raw.query('PRAGMA user_version').get()).toEqual({user_version:0});
    expect(raw.query('SELECT dedup_key,is_saved FROM articles').get()).toEqual({dedup_key:'tag:x',is_saved:1});
    await initializeSchema(db);
    expect(raw.query('SELECT dedup_key,is_saved FROM articles').get()).toEqual({dedup_key:'guid:tag:x',is_saved:1});
    // Replaying the data migration itself (not just the version gate) is safe.
    raw.run('PRAGMA user_version=1');await initializeSchema(db);
    expect(raw.query('SELECT dedup_key,is_saved FROM articles').get()).toEqual({dedup_key:'guid:tag:x',is_saved:1});
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
    raw.run(`PRAGMA user_version=${SCHEMA_VERSION+1}`);
    await expect(initializeSchema(db)).rejects.toThrow('newer than supported');
    expect(raw.query('PRAGMA user_version').get()).toEqual({user_version:SCHEMA_VERSION+1});
  }finally{raw.close();}
});

test('dedup migration handles prefix-shaped GUIDs, link/title fallbacks and leaves unidentifiable sync hashes intact',async()=>{
 const raw=new Database(':memory:'),db=new BunDb(raw);try{
  for(const sql of SCHEMA)raw.run(sql);
  raw.exec("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test','Feed',1),(2,'https://watchrss.local/import-epub/book','Book',1)");
  const rows=[
   [1,1,'A','x',null,'x'],[2,1,'B','guid:x',null,'guid:x'],
   [3,1,'C',null,'HTTPS://Host/Path?Q=Case','HTTPS://Host/Path?Q=Case'],
   [4,1,'Title',null,null,'Title'],[5,1,'Synced','b'.repeat(64),'https://page.test','b'.repeat(64)],
   [6,2,'Chapter','chapter',null,'chapter'],
  ];
  for(const r of rows)raw.query('INSERT INTO articles(id,channel_id,title,guid,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,1)').run(...r as any[]);
  await initializeSchema(db);
  expect(raw.query('SELECT dedup_key FROM articles ORDER BY id').all()).toEqual(['guid:x','guid:guid:x','link:HTTPS://Host/Path?Q=Case','title:Title','b'.repeat(64),'chapter'].map(dedup_key=>({dedup_key})));
  expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{raw.close();}
});

test('cancelled refresh closes sliced work before its atomic database transaction',async()=>{
 const db=new FakeDb();const repo=new WatchRssRepository(db,async()=>'<rss><channel><title>F</title><item><title>A</title></item></channel></rss>');let cancelled=false;
 const work=repo.refreshChannel(1,undefined,()=>cancelled);cancelled=true;await expect(work).rejects.toThrow('刷新已取消');expect(db.executed).toHaveLength(0);
});
