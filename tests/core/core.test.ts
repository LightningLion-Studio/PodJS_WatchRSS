import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { htmlToText, parseFeed, resolveUrl, WatchRssRepository, initializeSchema } from "../../src/core";
import {builtinForInput} from '../../src/core/builtin-channels.ts';

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
  expect(feed.articles[0]).toMatchObject({ link: "https://example.test/post", guid: "tag:one", pubDate: "2024-09-03T10:00:00Z" });
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
  async query(_sql: string, _params?: readonly unknown[]) { return [{id:1,url:"https://feed",title:"Feed",description:null,image_url:null,last_fetched_at:null,created_at:1,sort_order:0,is_pinned:0}]; }
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
    const interrupted={execute:db.execute.bind(db),transaction:async(statements:{sql:string}[])=>db.transaction([...statements,{sql:'SELECT missing_seed_commit()'}])};
    await expect(initializeSchema(interrupted,{seedBuiltinChannels:true})).rejects.toThrow();
    expect(raw.query("SELECT count(*) n FROM sqlite_master WHERE name='channels'").get()).toEqual({n:0});
    await initializeSchema(db,{seedBuiltinChannels:true});
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
  const db=new BunDb(new Database(":memory:")); await initializeSchema(db); await db.execute(`INSERT INTO channels(id,url,title,created_at) VALUES(1,'u','before',1)`); await db.execute(`INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at,is_read,is_saved) VALUES(9,1,'old','g',1,1,1)`);
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
    expect(raw.query("SELECT channel_url,article_url,was_favorite,was_watch_later FROM local_article_deletions").all()).toEqual([{channel_url:local.url,article_url:"shared-guid",was_favorite:1,was_watch_later:1}]);
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
