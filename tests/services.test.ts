import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

const database = new Database(":memory:");
const speechCalls:unknown[]=[];
let feedBytes = new Uint8Array();
const feedRequests:string[]=[];
const feedResponses=new Map<string,Promise<Uint8Array>[]>();
let feedCancels=0;
let originalHtml="",originalDownloads=0;
const downloaded = new Map<string, Uint8Array>();

function paramsOf(params: readonly (string | number | null)[] = []): (string | number | null)[] { return [...params]; }
const sqlite = {
  async query(sql: string, params: readonly (string | number | null)[] = []) {
    const rows=database.query(sql).all(...paramsOf(params)) as Record<string, unknown>[];
    if(rows.reduce((sum,row)=>sum+JSON.stringify(row).length,0)>512*1024)throw new Error("Query result too large; use paging");
    return rows;
  },
  async execute(sql: string, params: readonly (string | number | null)[] = []) {
    database.query(sql).run(...paramsOf(params));
  },
  async transaction(statements: readonly { sql: string; params?: readonly (string | number | null)[] }[]) {
    database.transaction(() => {
      for (const statement of statements) database.query(statement.sql).run(...paramsOf(statement.params));
    })();
  },
};

mock.module("@podjs/framework/services", () => ({
  sqlite,
  uri:{parse:async(value:string)=>{try{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};}catch{return {valid:false,scheme:null,host:null,rawPath:null,rawQuery:null};}}},
  secureStorage:{get:async()=>null,set:async()=>{},delete:async()=>{}},
  browser:{open:()=>({result:Promise.resolve()})},
  bytesToBase64:(value:Uint8Array)=>Buffer.from(value).toString("base64"),
  stringToUtf8:(value:string)=>new TextEncoder().encode(value),
  hostOperation: (method:string,args:Record<string,unknown>)=>{
    if(method==='crypto.random')return {result:Promise.resolve({bytesBase64:Buffer.alloc(Number(args.bytes)).toString('base64')})};
    if(method==='crypto.hash')return {result:Promise.resolve({digestBase64:Buffer.from(new Bun.CryptoHasher('sha256').update(Buffer.from(String(args.dataBase64),'base64')).digest('hex'),'hex').toString('base64')})};
    expect(method).toBe("http.download");expect(args.text).toBe(true);expect(args.temporary).toBe(true);originalDownloads++;
    const bytes=new TextEncoder().encode(originalHtml);downloaded.set(String(args.path),bytes);
    return {result:Promise.resolve({status:200,headers:{},url:"https://example.test/final/article",path:args.path,size:bytes.length}),cancel:()=>{}};
  },
  http: { download: (url:string,path:string) => {
    feedRequests.push(url);const source=feedResponses.get(url)?.shift()??Promise.resolve(feedBytes);
    let cancelled=false,reject!:(error:unknown)=>void;
    const result=new Promise((yes,no)=>{reject=no;source.then(bytes=>{if(cancelled)return;downloaded.set(path,bytes);yes({status:200,headers:{},url,path,size:bytes.length});},no);});
    return {result,cancel:()=>{cancelled=true;feedCancels++;reject(new Error("cancelled"));}};
  } },
  fileChunks: {
    stat: async (path:string) => ({exists:downloaded.has(path),file:downloaded.has(path),directory:false,size:downloaded.get(path)?.length??0,modified:0}),
    list: async (path:string) => ({entries:[...downloaded.keys()].filter(key=>key.startsWith(path+'/')).map(key=>({path:key,file:true,directory:false,size:downloaded.get(key)!.length,modified:0}))}),
    read: async (path: string, offset = 0, maxBytes = 65536) => {
      const bytes = downloaded.get(path) ?? feedBytes;
      const part = bytes.slice(offset, offset + maxBytes);
      return { dataBase64: Buffer.from(part).toString("base64"), offset, size: bytes.length, eof: offset + part.length >= bytes.length };
    },
    remove: async (path: string) => { downloaded.delete(path); },
    touch: async () => {},
  },
  base64ToBytes: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
  utf8ToString: (value: Uint8Array) => new TextDecoder().decode(value),
  textInput: { prompt: () => ({ result: Promise.resolve(null) }) },
  delay: (ms:number) => {speechCalls.push(["delay",ms]);return {result:Promise.resolve(),cancel:()=>{}};},
  speech: { onProgress:()=>()=>{}, initializeLocal:async()=>{speechCalls.push(["initializeLocal"]);}, state:async()=>({state:"ready"}), speak: (text:string,language:string,rate:number) => {speechCalls.push(["speak",text,language,rate]);return { result: Promise.resolve(undefined) };}, stop: () => Promise.resolve(undefined) },
  audio: {play:()=>({result:Promise.resolve(undefined)}),setSpeed:async()=>{},state:async()=>({state:'stopped'}),stop:async()=>{}},
}));

const services = await import("../src/services.ts");
const {loadFeedWindow}=await import("../src/ui/feed-window.ts");

function feed(count: number): string {
  const items = Array.from({ length: count }, (_, i) => {
    const number = i + 1;
    return `<item><guid>article-${number}</guid><title>标题 ${number}</title><link>https://example.test/${number}</link><pubDate>${new Date(2024, 0, number).toUTCString()}</pubDate><description><![CDATA[<p>摘要 ${number}</p>]]></description><content:encoded xmlns:content="urn:content"><![CDATA[<p>正文 <strong>${number}</strong></p>]]></content:encoded></item>`;
  }).join("");
  return `<rss><channel><title>测试订阅</title><description>集成测试</description>${items}</channel></rss>`;
}

beforeAll(() => { feedBytes = new TextEncoder().encode(feed(35)); });
afterAll(() => { database.close(); });

describe("application services adapter", () => {
  test("direct add follows native URL, duplicate and initial-read semantics",async()=>{
    await services.services.listChannels();
    const url="http://example.test/direct-native-feed";
    const before=feedRequests.length;
    const channel=await services.services.addChannel("example.test/direct-native-feed");
    try {
      expect(channel.url).toBe(url);
      expect(feedRequests.length).toBe(before+1);
      expect((database.query("SELECT count(*) total FROM articles WHERE channel_id=?").get(Number(channel.id)) as {total:number}).total).toBe(35);
      expect((database.query("SELECT count(*) total FROM articles WHERE channel_id=? AND is_read=0").get(Number(channel.id)) as {total:number}).total).toBe(0);
      expect((await services.services.addChannel(url)).id).toBe(channel.id);
      expect(feedRequests.length).toBe(before+1);
      await expect(services.services.addChannel("builtin:douyin")).rejects.toThrow("URL 不合法");
    } finally {
      const id=Number(channel.id);
      database.query("DELETE FROM article_previews WHERE article_id IN (SELECT id FROM articles WHERE channel_id=?)").run(id);
      database.query("DELETE FROM articles WHERE channel_id=?").run(id);
      await services.services.deleteChannel(channel.id);
    }
  });
  test("add preview is read-only, confirm uses the same feed and opens duplicates",async()=>{
    await services.services.listChannels();
    const url="http://example.test/add-confirm-feed";
    const count=()=>Number((database.query("SELECT count(*) total FROM channels WHERE url=?").get(url) as {total:number}).total);
    const fetched=feedRequests.length;
    const preview=await services.services.previewChannel!("example.test/add-confirm-feed");
    expect(preview.kind).toBe("ready");
    if(preview.kind!=="ready")throw new Error("Missing preview token");
    expect(preview.url).toBe(url);
    expect(preview.title).toBe("测试订阅");
    expect(count()).toBe(0);
    expect(feedRequests.length).toBe(fetched+1);
    const channel=await services.services.confirmAddChannel!(preview.token);
    try {
      expect(channel.url).toBe(url);
      expect(count()).toBe(1);
      expect(feedRequests.length).toBe(fetched+1);
      const unread=database.query("SELECT count(*) total FROM articles WHERE channel_id=? AND is_read=0").get(Number(channel.id)) as {total:number};
      expect(unread.total).toBe(0);
      expect((database.query("SELECT count(*) total FROM articles WHERE channel_id=?").get(Number(channel.id)) as {total:number}).total).toBe(35);
      const duplicate=await services.services.previewChannel!(url);
      expect(duplicate.kind).toBe("existing");
      if(duplicate.kind==="existing")expect(duplicate.channel.id).toBe(channel.id);
    } finally {
      const id=Number(channel.id);
      database.query("DELETE FROM article_previews WHERE article_id IN (SELECT id FROM articles WHERE channel_id=?)").run(id);
      database.query("DELETE FROM articles WHERE channel_id=?").run(id);
      await services.services.deleteChannel(channel.id);
    }
  });
  test("long feed stays below the host reply limit while preserving the 200-item order",async()=>{
    await services.services.listChannels();
    const url="https://watchrss.local/feed-window-large-preview";
    database.query("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)").run(url,"长预览频道",1);
    const channelId=Number((database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}).id);
    try {
      const insert=database.query("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)");
      database.transaction(()=>{for(let index=0;index<205;index++)insert.run(channelId,`Article ${index}`,"x".repeat(4096),`${url}/${index}`,`large-preview-${index}`,index);})();
      await expect(services.services.listArticles({channelId:String(channelId),pageSize:201})).rejects.toThrow("Query result too large");
      const window=await loadFeedWindow(services.services.listArticles,String(channelId),200);
      expect(window.items).toHaveLength(200);
      expect(window.items[0]?.title).toBe("Article 204");
      expect(window.items[199]?.title).toBe("Article 5");
      expect(window.hasMore).toBe(true);
      expect((await services.services.listArticles({channelId:String(channelId),offset:12,pageSize:1}))[0]?.title).toBe("Article 192");
    } finally {
      database.query("DELETE FROM articles WHERE channel_id=?").run(channelId);
      await services.services.deleteChannel(String(channelId));
    }
  });
  test("a 200-item native feed window can inspect one more chapter without losing its order", async () => {
    await services.services.listChannels();
    const url="https://watchrss.local/import-txt-novel/feed-window-fixture";
    database.query("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)").run(url,"长篇章节",1);
    const channelId=Number((database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}).id);
    try {
      const insert=database.query("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)");
      database.transaction(()=>{for(let index=0;index<205;index++)insert.run(channelId,`Chapter ${index}`,`Body ${index}`,`${url}/chapter/${index}`,`feed-window-${index}`,index);})();
      const rows=await services.services.listArticles({channelId:String(channelId),pageSize:201});
      expect(rows).toHaveLength(201);
      expect(rows[0]?.title).toBe("Chapter 204");
      expect(rows[199]?.title).toBe("Chapter 5");
      expect(rows[200]?.title).toBe("Chapter 4");
      const older=await services.services.listArticles({channelId:String(channelId),query:'Chapter 0',pageSize:30});
      expect(older.map(article=>article.title)).toEqual(['Chapter 0']);
      const visible=await services.services.searchArticles!(String(channelId),'Chapter 0');
      expect(visible.map(article=>article.title)).toEqual(['Chapter 0']);
      expect(visible[0]?.searchSnippet).toContain('Body 0');
    } finally {
      database.query("DELETE FROM articles WHERE channel_id=?").run(channelId);
      await services.services.deleteChannel(String(channelId));
    }
  });
  test("search matches native description, summary and original body fields with literal wildcard input", async () => {
    await services.services.listChannels();
    const url="https://watchrss.local/search-native-fields";
    database.query("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)").run(url,"搜索字段",1);
    const channelId=Number((database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}).id);
    try {
      const insert=database.query("INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?)");
      insert.run(channelId,"描述条目","only-description-token","","https://example.test/description","search-description",1);
      insert.run(channelId,"摘要条目","","","https://example.test/summary","search-summary",2);
      insert.run(channelId,"原文条目","","","https://example.test/original","search-original",3);
      insert.run(channelId,"正文条目","","","https://example.test/body","search-body",4);
      insert.run(channelId,"Literal %_\\ marker","","","https://example.test/literal","search-literal",5);
      insert.run(channelId,"Literal anything marker","","","https://example.test/decoy","search-decoy",6);
      const id=(key:string)=>Number((database.query("SELECT id FROM articles WHERE channel_id=? AND dedup_key=?").get(channelId,key) as {id:number}).id);
      database.query("INSERT INTO article_previews(article_id,summary) VALUES(?,?)").run(id("search-summary"),"only-summary-token");
      database.query("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(?,?,?)").run(id("search-original"),0,"only-original-token");
      database.query("INSERT INTO article_body_chunks(article_id,chunk_index,body) VALUES(?,?,?)").run(id("search-body"),0,"only-body-token");
      for(const [term,title] of [["description-token","描述条目"],["summary-token","摘要条目"],["original-token","原文条目"],["body-token","正文条目"],["%_\\","Literal %_\\ marker"]]) {
        expect((await services.services.listArticles({channelId:String(channelId),query:term})).map(article=>article.title)).toEqual([title]);
        const visible=await services.services.searchArticles!(String(channelId),term);
        expect(visible.map(article=>article.title)).toEqual([title]);
        if(term!=="%_\\")expect(visible[0]?.searchSnippet).toContain(term);
      }
    } finally {
      database.query("DELETE FROM articles WHERE channel_id=?").run(channelId);
      await services.services.deleteChannel(String(channelId));
    }
  });
  test("search finds a keyword crossing adjacent long-body and original-body chunks",async()=>{
    await services.services.listChannels();
    const url="https://watchrss.local/search-chunk-seam";
    database.query("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)").run(url,"分块搜索",1);
    const channelId=Number((database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}).id);
    try {
      const insert=database.query("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)");
      insert.run(channelId,"正文跨块","",`${url}/body`,"body-seam",1);
      insert.run(channelId,"原文跨块","",`${url}/original`,"original-seam",2);
      const id=(key:string)=>Number((database.query("SELECT id FROM articles WHERE dedup_key=?").get(key) as {id:number}).id);
      const body=id("body-seam"),original=id("original-seam");
      database.query("INSERT INTO article_body_chunks(article_id,chunk_index,body) VALUES(?,?,?)").run(body,0,"x".repeat(128)+"跨段");
      database.query("INSERT INTO article_body_chunks(article_id,chunk_index,body) VALUES(?,?,?)").run(body,1,"命中"+"y".repeat(128));
      database.query("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(?,?,?)").run(original,0,"x".repeat(128)+"跨段");
      database.query("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(?,?,?)").run(original,1,"命中"+"y".repeat(128));
      const found=await services.services.searchArticles!(String(channelId),"跨段命中");
      expect(found.map(value=>value.title)).toEqual(["原文跨块","正文跨块"]);
      expect(found.every(value=>value.searchSnippet?.includes("跨段命中"))).toBe(true);
      expect(await services.services.searchArticles!(String(channelId),"跨段未命中")).toEqual([]);
    }finally{database.query("DELETE FROM articles WHERE channel_id=?").run(channelId);await services.services.deleteChannel(String(channelId));}
  });
  test("visible channel search uses the native 120-result cap and newest-first order",async()=>{
    await services.services.listChannels();
    const url="https://watchrss.local/search-visible-limit";
    database.query("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)").run(url,"搜索上限",1);
    const channelId=Number((database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}).id);
    try {
      const insert=database.query("INSERT INTO articles(channel_id,title,description,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)");
      database.transaction(()=>{for(let index=0;index<125;index++)insert.run(channelId,`匹配 ${index}`,`片段 ${index}`,`${url}/${index}`,`match-${index}`,index);})();
      const rows=await services.services.searchArticles!(String(channelId),"匹配");
      expect(rows).toHaveLength(120);
      expect(rows[0]?.title).toBe("匹配 124");
      expect(rows[119]?.title).toBe("匹配 5");
      expect(rows[0]?.searchSnippet).toBe("片段 124");
    }finally{database.query("DELETE FROM articles WHERE channel_id=?").run(channelId);await services.services.deleteChannel(String(channelId));}
  });
  test("refreshes a feed, pages articles, and persists article state and notes", async () => {
    const channel = await services.services.addChannel("https://example.test/feed.xml");
    expect(channel).toMatchObject({ title: "测试订阅", url: "https://example.test/feed.xml" });

    const channels = await services.services.listChannels();
    expect(channels.map(channel=>channel.url)).toContain('builtin:bili');
    expect(channels.map(channel=>channel.url)).toContain('builtin:douyin');
    expect(channels).toHaveLength(3);
    expect(channels.find(item=>item.id===channel.id)).toMatchObject({ title: "测试订阅", description: "集成测试", isPinned: false, unreadCount: 0 });
    expect(channels.find(item=>item.id===channel.id)?.lastFetchedAt).toEqual(expect.any(Number));

    const page0 = await services.services.listArticles({ channelId: channel.id, page: 0, pageSize: 30 });
    const page1 = await services.services.listArticles({ channelId: channel.id, page: 1, pageSize: 30 });
    expect(page0).toHaveLength(30);
    expect(page1).toHaveLength(5);
    expect(page0[0]).toMatchObject({ title: "标题 35" });
    expect(page1[0]).toMatchObject({ title: "标题 5" });

    const article = await services.services.getArticle(page0[0].id);
    expect(article?.rawContent).toContain("<strong>");
    expect(article?.contentBlocks).toEqual([{type:"text",style:"body",text:"正文 35"}]);
    expect(article).toMatchObject({ id: page0[0].id, content: "正文 35", read: true, saved: false });
    const offlinePath=`offline/rss/${article!.id}/image_0.jpg`;
    downloaded.set(offlinePath,new Uint8Array([1,2,3]));
    await sqlite.execute('INSERT INTO offline_media(item_id,media_type,origin_url,relative_path,created_at) VALUES(?,?,?,?,?)',[Number(article!.id),'IMAGE','https://example.test/image.jpg',offlinePath,1]);
    await sqlite.execute('INSERT INTO offline_media(item_id,media_type,origin_url,relative_path,created_at) VALUES(?,?,?,?,?)',[Number(article!.id),'IMAGE','https://example.test/missing.jpg',null,1]);
    try{
      expect(await services.services.getArticle(article!.id)).toMatchObject({offlineMedia:{'https://example.test/image.jpg':offlinePath},offlineMediaFailures:1});
    }finally{await sqlite.execute('DELETE FROM offline_media WHERE item_id=?',[Number(article!.id)]);downloaded.delete(offlinePath);}
    await services.services.toggleSaved(article!.id, true);
    const saved = await services.services.listArticles({ saved: true });
    expect(saved.map(item => item.id)).toContain(article!.id);

    const note = await services.services.saveNote({ articleId: article!.id, title: article!.title, body: "稍后复读" });
    expect(note).toMatchObject({ articleId: article!.id, title: article!.title, body: "稍后复读" });
    expect(await services.services.listNotes(article!.id)).toEqual([note]);
  });
});

 test("invalid feed does not leave an empty subscription", async () => {
 const previous = feedBytes;
 feedBytes = new TextEncoder().encode("<html><body>Not RSS</body></html>");
 try {
 await expect(services.services.addChannel("https://invalid.test/feed")).rejects.toThrow();
 expect(await sqlite.query("SELECT id FROM channels WHERE url=?", ["https://invalid.test/feed"])).toHaveLength(0);
 } finally { feedBytes = previous; }
 });

test("RSS favorite and watch later are independent and survive schema reopening", async () => {
  const items=await services.services.listArticles({pageSize:2});
  const first=items[0]!.id, second=items[1]!.id;
  await services.services.setSaveState(first,"favorite",true);
  await services.services.setSaveState(first,"watchLater",true);
  await services.services.setSaveState(second,"watchLater",true);
  await sqlite.execute("UPDATE article_saved_states SET sort_order=-1 WHERE article_id=? AND save_type='watchLater'",[Number(first)]);
  await sqlite.execute("UPDATE article_saved_states SET sort_order=-2 WHERE article_id=? AND save_type='watchLater'",[Number(second)]);
  expect((await services.services.listArticles({saveType:"watchLater",pageSize:1}))[0]?.id).toBe(second);
  expect((await services.services.listArticles({saveType:"watchLater",pageSize:1,page:1}))[0]?.id).toBe(first);
  const before=database.query("SELECT changed_at FROM article_saved_states WHERE article_id=? AND save_type='watchLater'").get(Number(first)) as {changed_at:number};
  await services.services.reorderSavedArticles("watchLater",[first,second]);
  const reordered=await services.services.listArticles({saveType:"watchLater"});
  expect(reordered.map(item=>item.id)).toEqual([first,second]);
  expect(reordered[0]?.savedAt).toEqual(expect.any(Number));
  expect((database.query("SELECT changed_at FROM article_saved_states WHERE article_id=? AND save_type='watchLater'").get(Number(first)) as {changed_at:number}).changed_at).toBe(before.changed_at);
  await expect(services.services.reorderSavedArticles("watchLater",[first,first])).rejects.toThrow("Invalid saved item order");
  await services.services.setSaveState(first,"favorite",false);
  expect(await services.services.getArticle(first)).toMatchObject({saved:false,watchLater:true,link:expect.stringContaining("https://example.test/")});
  const {initializeSchema}=await import("../src/core/schema.ts");
  await initializeSchema(sqlite);
  expect(await services.services.getArticle(first)).toMatchObject({saved:false,watchLater:true});
  await services.services.setSaveState(first,"watchLater",false);
  expect((await services.services.listArticles({saveType:"watchLater"})).map(a=>a.id)).not.toContain(first);
  expect(await sqlite.query("SELECT saved FROM article_saved_states WHERE article_id=? ORDER BY save_type",[Number(first)])).toEqual([{saved:0},{saved:0}]);
});

test("preexisting favorites are backfilled without duplication or resurrection",async()=>{
  const id=(await services.services.listArticles({pageSize:1,page:3}))[0]!.id;
  await sqlite.execute("UPDATE articles SET is_saved=1 WHERE id=?",[Number(id)]);
  const {initializeSchema}=await import("../src/core/schema.ts");
  await initializeSchema(sqlite); await initializeSchema(sqlite);
  expect(await sqlite.query("SELECT saved FROM article_saved_states WHERE article_id=? AND save_type='favorite'",[Number(id)])).toEqual([{saved:1}]);
  await services.services.setSaveState(id,"favorite",false);
  await initializeSchema(sqlite);
  expect((await services.services.listArticles({saveType:"favorite"})).map(a=>a.id)).not.toContain(id);
});

test("feed refresh persists native-shaped content previews and replaces stale image previews",async()=>{
  const previous=feedBytes;
  try {
    feedBytes=new TextEncoder().encode('<rss><channel><title>预览</title><item><guid>preview</guid><title>标题</title><link>https://example.test/news/item</link><description>描述</description><content:encoded><![CDATA[<p>正文优先</p><img src="../cover.png">]]></content:encoded></item></channel></rss>');
    const channel=await services.services.addChannel("https://example.test/preview-feed");
    const items=await services.services.listArticles({channelId:channel.id});
    expect(items[0]).toMatchObject({excerpt:"正文优先",imageUrl:"https://example.test/cover.png"});
    await services.services.setSaveState(items[0]!.id,"watchLater",true);
    feedBytes=new TextEncoder().encode('<rss><channel><title>预览</title><item><guid>preview</guid><title>更新标题</title><description>更新描述</description></item></channel></rss>');
    await services.services.refresh(channel.id);
    expect((await services.services.listArticles({channelId:channel.id}))[0]).toMatchObject({excerpt:"更新描述",imageUrl:"",watchLater:true});
  } finally {feedBytes=previous;}
});

test("reader speech adapter uses host initialization, rate and timer services",async()=>{
  speechCalls.length=0;
  let started=false;
  await services.services.speak("正文",1.6,()=>{started=true;});
  expect(speechCalls).toEqual([["initializeLocal"],["speak","正文","",1.6],["delay",200]]);
  expect(started).toBe(true);
});


test("original article is cached separately, shared across callers and keeps RSS body/preferences",async()=>{
 const saved=feedBytes;feedBytes=new TextEncoder().encode('<rss><channel><title>原文验证</title><item><guid>original</guid><title>原文验证文章</title><link>../item</link><description>RSS摘要</description></item></channel></rss>');
 try{
  const channel=await services.services.addChannel("https://example.test/original/feed.xml"),article=(await services.services.listArticles({channelId:channel.id}))[0];
  const initial=await services.services.getArticle(article.id);expect(initial?.content).toBe("RSS摘要");
  originalHtml='<main><nav>应移除</nav><p>'+"原文𠮷".repeat(150000)+'</p><img data-src="../cover.jpg"></main>';const before=originalDownloads;
  const first=services.services.getOriginalArticle(article.id),second=services.services.getOriginalArticle(article.id);expect(first).toBe(second);
  const result=await first;expect(originalDownloads).toBe(before+1);expect(result.content).toContain("原文𠮷");expect(result.content).not.toContain("应移除");expect(result.contentBlocks?.at(-1)).toMatchObject({type:"image",url:"https://example.test/cover.jpg"});
  expect(database.query("SELECT count(*) n FROM article_original_chunks WHERE article_id=?").get(Number(article.id))).toMatchObject({n:10});
  originalHtml="changed";expect(await services.services.getOriginalArticle(article.id)).toEqual(result);expect(originalDownloads).toBe(before+1);
  expect(await services.services.getArticle(article.id)).toEqual(initial);
  expect(database.query("SELECT use_original_content FROM source_preferences WHERE channel_id=?").get(Number(channel.id))).toBeNull();
 }finally{feedBytes=saved;}
});

test("empty original is retryable and never replaces the RSS content",async()=>{
 const saved=feedBytes;feedBytes=new TextEncoder().encode('<rss><channel><title>原文失败</title><item><guid>failed-original</guid><title>失败文章</title><link>https://example.test/empty</link><description>保留摘要</description></item></channel></rss>');
 try{const channel=await services.services.addChannel("https://example.test/empty/feed.xml"),article=(await services.services.listArticles({channelId:channel.id}))[0];
  originalHtml='<article><script>hidden</script></article>';await expect(services.services.getOriginalArticle(article.id)).rejects.toThrow("网页没有可读取的正文");
  expect(database.query("SELECT * FROM article_original_meta WHERE article_id=?").get(Number(article.id))).toBeNull();expect((await services.services.getArticle(article.id))?.content).toBe("保留摘要");
  originalHtml='<article><p>重试成功</p></article>';expect((await services.services.getOriginalArticle(article.id)).content).toBe("重试成功");
 }finally{feedBytes=saved;}
});

  test("channel mutations preserve other channels and dependent state is removed only on delete", async()=>{
  database.exec("PRAGMA foreign_keys=ON");
  feedBytes=new TextEncoder().encode(feed(2));
  const a=await services.services.addChannel("https://example.test/channel-a");
  const b=await services.services.addChannel("https://example.test/channel-b");
  const [article]=await services.services.listArticles({channelId:a.id});
  await services.services.setSaveState(article.id,"favorite",true);
  await services.services.saveNote({articleId:article.id,title:"note",body:"preserve until deletion"});
  database.query("INSERT INTO source_preferences(channel_id,read_preset) VALUES(?,'compact')").run(Number(a.id));
  await services.services.setChannelOriginalMode(a.id,true);
  expect(await services.services.getChannelOriginalMode(a.id)).toBe(true);
  expect(await services.services.getChannelOriginalMode(b.id)).toBe(false);
  expect(database.query("SELECT read_preset FROM source_preferences WHERE channel_id=?").get(Number(a.id))).toEqual({read_preset:"compact"});
  database.query("UPDATE articles SET is_read=0 WHERE channel_id=?").run(Number(b.id));
  await services.services.markChannelRead(a.id);
  expect((await services.services.listArticles({channelId:a.id})).every(a=>a.read)).toBe(true);
  expect((await services.services.listArticles({channelId:b.id})).every(a=>!a.read)).toBe(true);
  expect((await services.services.getArticle(article.id))?.saved).toBe(true);
  expect((await services.services.listNotes(article.id))).toHaveLength(1);
  await services.services.deleteChannel(a.id);
  expect(await services.services.listArticles({channelId:a.id})).toHaveLength(0);
  expect(await services.services.listNotes(article.id)).toHaveLength(0);
  expect(database.query("SELECT count(*) n FROM source_preferences WHERE channel_id=?").get(Number(a.id))).toEqual({n:0});
  expect(database.query("SELECT count(*) n FROM article_saved_states WHERE article_id=?").get(Number(article.id))).toEqual({n:0});
  expect(await services.services.listArticles({channelId:b.id})).toHaveLength(2);
  });
  test("home channels use native pinned and descending logical order",async()=>{
    await services.services.listChannels();
    const rows=[
      ["https://home-order.example/older","older",10,0],
      ["https://home-order.example/newer","newer",30,0],
      ["https://home-order.example/pinned","pinned",20,1],
      ["https://home-order.example/phone","phone",-40,0],
    ] as const;
    try{
      for(const [url,title,order,pinned] of rows)database.query("INSERT INTO channels(url,title,created_at,sort_order,is_pinned) VALUES(?,?,1,?,?)").run(url,title,order,pinned);
      database.query("INSERT INTO sync_source_states VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(rows[3][0],"phone","phone","",null,null,1,40,40,0,0,0);
      const channels=(await services.services.listChannels()).filter(channel=>channel.url.startsWith("https://home-order.example/"));
      expect(channels.map(channel=>[channel.title,channel.sortOrder,channel.isPinned])).toEqual([
        ["pinned",20,true],["phone",40,false],["newer",30,false],["older",10,false],
      ]);
    }finally{
      database.query("DELETE FROM channels WHERE url LIKE 'https://home-order.example/%'").run();
      database.query("DELETE FROM sync_source_states WHERE url LIKE 'https://home-order.example/%'").run();
    }
  });
  test("refresh all skips builtins, continues after failure, and reports the first error",async()=>{
    await services.services.listChannels();
    const first="https://refresh-all.example/a",second="https://refresh-all.example/b";
    database.query("INSERT INTO channels(url,title,created_at,sort_order) VALUES(?,?,1,0)").run(first,"A");
    database.query("INSERT INTO channels(url,title,created_at,sort_order) VALUES(?,?,1,0)").run(second,"B");
    feedResponses.set(first,[Promise.resolve().then(()=>{throw new Error("first refresh failed");})]);
    feedResponses.set(second,[Promise.resolve(new TextEncoder().encode(feed(1)))]);
    const before=feedRequests.length;
    try{
      await expect(services.services.refresh()).rejects.toThrow("first refresh failed");
      const requests=feedRequests.slice(before);
      expect(requests.filter(url=>url===first||url===second)).toEqual([first,second]);
      expect(requests.some(url=>url.startsWith("builtin:"))).toBe(false);
    }finally{
      for(const url of [first,second]){
        const row=database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}|null;
        if(row){database.query("DELETE FROM articles WHERE channel_id=?").run(row.id);await services.services.deleteChannel(String(row.id));}
      }
      feedResponses.delete(first);feedResponses.delete(second);
    }
  });

test("deleting a persisted Bili channel clears only its provider cache",async()=>{
  const channel=database.query("SELECT id FROM channels WHERE url='builtin:bili'").get() as {id:number};
  const bili=`managed-cache/bili-preview/${'a'.repeat(64)}.img`;
  const image=`managed-cache/images/${'b'.repeat(64)}.img`;
  downloaded.set(bili,new Uint8Array([1]));downloaded.set(image,new Uint8Array([2]));
  await services.services.deleteChannel(String(channel.id));
  expect(downloaded.has(bili)).toBe(false);
  expect(downloaded.has(image)).toBe(true);
  expect(database.query("SELECT id FROM channels WHERE id=?").get(channel.id)).toBeNull();
  downloaded.delete(image);
});

test("deleting a persisted Douyin channel clears preload files without touching Bili covers",async()=>{
  const channel=database.query("SELECT id FROM channels WHERE url='builtin:douyin'").get() as {id:number};
  const preload=`managed-cache/douyin-preload/${'c'.repeat(64)}.mp4`;
  const cover=`managed-cache/bili-preview/${'d'.repeat(64)}.img`;
  downloaded.set(preload,new Uint8Array([1]));downloaded.set(cover,new Uint8Array([2]));
  await services.services.deleteChannel(String(channel.id));
  expect(downloaded.has(preload)).toBe(false);
  expect(downloaded.has(cover)).toBe(true);
  expect(database.query("SELECT id FROM channels WHERE id=?").get(channel.id)).toBeNull();
  downloaded.delete(cover);
});

test('recommending a deleted builtin persists it once with native defaults and no RSS fetch',async()=>{
  const before=feedRequests.length;
  const created=await services.services.addChannel('https://www.douyin.com');
  expect(created).toMatchObject({url:'builtin:douyin',title:'抖音',description:'进入后登录获取推荐内容'});
  await expect(services.services.addChannel('builtin:douyin')).rejects.toThrow('URL 不合法');
  expect(feedRequests).toHaveLength(before);
  expect(database.query('SELECT use_original_content FROM source_preferences WHERE channel_id=?').get(Number(created.id))).toEqual({use_original_content:1});
  expect(database.query("SELECT count(*) n FROM channels WHERE url='builtin:douyin'").get()).toEqual({n:1});
});

function feedGate(){let resolve!:(value:Uint8Array)=>void;const promise=new Promise<Uint8Array>(r=>resolve=r);return {promise,resolve};}
async function waitFeed(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,0));expect(predicate()).toBe(true);}
test("mode changes commit before background refresh, notify data changes, and coalesce manual refresh",async()=>{
  feedBytes=new TextEncoder().encode(feed(1));const channel=await services.services.addChannel("https://example.test/background-refresh");
  const response=feedGate();feedResponses.set(channel.url,[response.promise]);
  const events:unknown[]=[];const unsubscribe=services.services.subscribeChannel(e=>events.push(e));
  try{
    const before=feedRequests.length;await services.services.setChannelOriginalMode(channel.id,true);
    expect(await services.services.getChannelOriginalMode(channel.id)).toBe(true);
    await waitFeed(()=>feedRequests.length===before+1);
    const refresh=services.services.refresh(channel.id);await new Promise(r=>setTimeout(r,0));expect(feedRequests.length).toBe(before+1);
    expect(events).toHaveLength(0);
    response.resolve(new TextEncoder().encode(feed(2).replace("测试订阅","后台更新")));await refresh;
    expect((await services.services.listChannels()).find(c=>c.id===channel.id)?.title).toBe("后台更新");
    expect(await services.services.listArticles({channelId:channel.id})).toHaveLength(2);
    expect(events).toEqual([{id:channel.id,kind:"refresh"}]);
  }finally{unsubscribe();}
});
test("rapid mode changes cancel superseded refresh and never apply an older response",async()=>{
  feedBytes=new TextEncoder().encode(feed(1));const channel=await services.services.addChannel("https://example.test/replace-refresh");
  const first=feedGate(),second=feedGate();feedResponses.set(channel.url,[first.promise,second.promise]);
  const before=feedRequests.length,cancelBefore=feedCancels;await services.services.setChannelOriginalMode(channel.id,true);await waitFeed(()=>feedRequests.length===before+1);
  await services.services.setChannelOriginalMode(channel.id,false);await waitFeed(()=>feedRequests.length===before+2);
  expect(feedCancels).toBe(cancelBefore+1);
  const latest=services.services.refresh(channel.id);second.resolve(new TextEncoder().encode(feed(1).replace("测试订阅","最新响应")));await latest;
  first.resolve(new TextEncoder().encode(feed(1).replace("测试订阅","过时响应")));await new Promise(r=>setTimeout(r,0));
  expect((await services.services.listChannels()).find(c=>c.id===channel.id)).toMatchObject({title:"最新响应",useOriginalContent:false});
});
test("deleting a channel cancels its pending background refresh without affecting another source",async()=>{
  feedBytes=new TextEncoder().encode(feed(1));const channel=await services.services.addChannel("https://example.test/delete-refresh");
  const response=feedGate();feedResponses.set(channel.url,[response.promise]);const before=feedRequests.length,cancelBefore=feedCancels;
  await services.services.setChannelOriginalMode(channel.id,true);await waitFeed(()=>feedRequests.length===before+1);
  await services.services.deleteChannel(channel.id);expect(feedCancels).toBe(cancelBefore+1);
  response.resolve(new TextEncoder().encode(feed(3)));await new Promise(r=>setTimeout(r,0));
  expect((await services.services.listChannels()).some(c=>c.id===channel.id)).toBe(false);
  expect(await services.services.listArticles({channelId:channel.id})).toHaveLength(0);
});

test("refresh restores the cached original image when an RSS image disappears",async()=>{
  const xml=feed(1);feedBytes=new TextEncoder().encode(xml.replace('<p>正文 <strong>1</strong></p>',"<p>正文 <strong>1</strong></p><img src='https://rss-image.test/old.png'>"));
  const channel=await services.services.addChannel("https://example.test/original-preview-refresh");
  const [article]=await services.services.listArticles({channelId:channel.id});expect(article.imageUrl).toBe("https://rss-image.test/old.png");
  originalHtml="<article><p>原文正文</p><img src='https://original-image.test/cover.png'></article>";await services.services.getOriginalArticle(article.id);
  feedBytes=new TextEncoder().encode(xml);await services.services.refresh(channel.id);
  const [refreshed]=await services.services.listArticles({channelId:channel.id});
  expect(refreshed.imageUrl).toBe("https://original-image.test/cover.png");expect(refreshed.excerpt).toBe("正文 1");
});

test("RSS media enclosures reach both reader modes and background preference is isolated",async()=>{
  feedBytes=new TextEncoder().encode('<rss><channel><title>视频订阅</title><item><guid>media-enclosure</guid><title>视频正文</title><description>RSS正文</description><link>https://example.test/article</link><enclosure url="https://video.test/a.mp4" type="video/mp4"/></item></channel></rss>');
  const channel=await services.services.addChannel('https://example.test/media-channel');
  const [item]=await services.services.listArticles({channelId:channel.id});
  expect((await services.services.getArticle(item.id))?.contentBlocks?.at(-1)).toEqual({type:'video',url:'https://video.test/a.mp4'});
  expect(await services.services.getChannelPlaybackSettings(channel.id)).toEqual({hasPlayableMedia:true,continuePlaybackInBackground:false});
  await services.services.setChannelBackgroundPlayback(channel.id,true);
  expect(await services.services.getChannelPlaybackSettings(channel.id)).toEqual({hasPlayableMedia:true,continuePlaybackInBackground:true});
  expect(await services.services.getChannelOriginalMode(channel.id)).toBe(false);
  originalHtml='<article><p>原文正文</p></article>';
  expect((await services.services.getOriginalArticle(item.id)).contentBlocks?.at(-1)).toEqual({type:'video',url:'https://video.test/a.mp4'});
  feedBytes=new TextEncoder().encode('<rss><channel><title>纯文本</title><item><guid>text-only</guid><title>文字</title><description>正文</description></item></channel></rss>');
  const text=await services.services.addChannel('https://example.test/plain-channel');
  expect(await services.services.getChannelPlaybackSettings(text.id)).toEqual({hasPlayableMedia:false,continuePlaybackInBackground:false});
  database.query("UPDATE articles SET audio_url='https://audio.test/a.mp3' WHERE channel_id=?").run(Number(text.id));
  expect((await services.services.getChannelPlaybackSettings(text.id)).hasPlayableMedia).toBe(true);
  await services.services.deleteChannel(channel.id);
  expect(database.query('SELECT count(*) n FROM source_media_preferences WHERE channel_id=?').get(Number(channel.id))).toEqual({n:0});
});

test("imported EPUB and TXT novel chapters survive refresh without network requests and clear locally",async()=>{
  for(const kind of ["import-epub","import-txt-novel"]){
    const url=`https://watchrss.local/${kind}/refresh-fixture`,now=Date.now();
    database.query("INSERT INTO channels(url,title,created_at) VALUES(?,?,?)").run(url,"测试书",now);
    const id=Number((database.query("SELECT id FROM channels WHERE url=?").get(url) as {id:number}).id);
    for(let index=1;index<=2;index++)database.query("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)")
      .run(id,`第${index}章`,`正文${index}`,`${url}/chapter/${String(index).padStart(4,"0")}`,`chapter-${index}`,now-index);
    const before=feedRequests.length;
    await services.services.refresh(String(id));
    await services.services.setChannelOriginalMode(String(id),true);
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(feedRequests).toHaveLength(before);
    const chapters=await services.services.listArticles({channelId:String(id)});
    expect(chapters.map(article=>article.title)).toEqual(["第1章","第2章"]);
    const originalBefore=originalDownloads;
    await services.services.requestOriginalContents(String(id),chapters.map(article=>article.id));
    expect((await services.services.getOriginalArticle(chapters[0]!.id)).rawContent).toBe("正文1");
    expect(originalDownloads).toBe(originalBefore);
    await services.services.clearLocalContent(String(id));
    expect((await services.services.listChannels()).find(channel=>channel.id===String(id))).toMatchObject({useOriginalContent:true,unreadCount:0});
    expect(await services.services.listArticles({channelId:String(id)})).toHaveLength(0);
    expect(database.query("SELECT count(*) n FROM local_article_deletions WHERE channel_url=?").get(url)).toEqual({n:2});
  }
});

test("single imported article deletion service cleans owned files and leaves its sibling and channel",async()=>{
  const now=Date.now(),url='https://watchrss.local/import-epub/c2-single-delete';
  database.query('INSERT INTO channels(url,title,created_at) VALUES(?,?,?)').run(url,'C2',now);
  const channel=database.query('SELECT id FROM channels WHERE url=?').get(url) as {id:number};
  database.query("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,'Delete','watchrss-watch-content:c2-body.txt',?,'c2-delete',?)").run(channel.id,url+'/1',now);
  const item=database.query("SELECT id FROM articles WHERE dedup_key='c2-delete'").get() as {id:number};
  database.query("INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,'Keep','body',?,'c2-keep',?)").run(channel.id,url+'/2',now);
  downloaded.set('article_content/c2-body.txt',new TextEncoder().encode('body'));
  downloaded.set(`offline/rss/${item.id}/image.png`,new Uint8Array([1]));
  await services.services.deleteArticle(String(item.id));
  expect(await services.services.getArticle(String(item.id))).toBeNull();
  expect(downloaded.has('article_content/c2-body.txt')).toBe(false);
  expect(downloaded.has(`offline/rss/${item.id}/image.png`)).toBe(false);
  expect((await services.services.listArticles({channelId:String(channel.id)})).map(a=>a.title)).toEqual(['Keep']);
  expect((await services.services.listChannels()).some(c=>c.id===String(channel.id))).toBe(true);
  const before=database.query("SELECT count(*) n FROM sync_change_log WHERE reason='delete'").get();
  await services.services.deleteArticle(String(item.id));
  expect(database.query("SELECT count(*) n FROM sync_change_log WHERE reason='delete'").get()).toEqual(before);
});
