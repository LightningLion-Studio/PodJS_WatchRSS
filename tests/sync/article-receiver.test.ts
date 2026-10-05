import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {gzipSync,gunzipSync} from "node:zlib";
import {initializeSchema} from "../../src/core/schema.ts";
import {WatchRssRepository} from "../../src/core/repository.ts";
import type {SqlDatabase} from "../../src/core/types.ts";
import {ReadingProgressStore} from "../../src/reader/progress.ts";
import {SqlReadingProgressStore} from "../../src/reader/sql-progress.ts";
import {SyncSavedStateStore} from "../../src/sync/saved-state.ts";
import {SyncArticleReceiver,type IncomingArticle} from "../../src/sync/article-receiver.ts";
import {encodeBodyJson,type SyncBodyCodec,type SyncBodyPayload,type SyncArticleBody} from "../../src/sync/article-body.ts";
const codec:SyncBodyCodec={encode:async b=>gzipSync(encodeBodyJson(b)),sha256:async b=>new Bun.CryptoHasher("sha256").update(b).digest("hex"),decode:async b=>gunzipSync(b).toString("utf8")};
export const incoming=(p:Partial<IncomingArticle>={}):IncomingArticle=>({articleId:"one",sourceDeviceId:"phone",url:"https://article/a",title:"Article",siteName:"Site",excerpt:"excerpt",imageUrl:null,importedAt:100,updatedAt:100,rssSourceUrl:null,rssSourceTitle:null,favoriteSaved:true,favoriteChangedAt:100,favoriteSortOrder:100,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,readingProgress:.25,readingPositionBytes:2,readingPositionContentHash:"body",readingPositionChangedAt:100,isRead:false,deleted:false,...p});
async function payload(body:SyncArticleBody={contentHtml:null,contentText:"hello world"}):Promise<SyncBodyPayload>{const bytes=await codec.encode(body),hash=await codec.sha256(bytes);return {articleId:"one",bodyHash:hash,bodyByteCount:bytes.length,chunkSize:128*1024,chunkHashes:[hash],chunks:[{index:0,hash,bytes}]};}
async function setup(){
 const sql=new Database(":memory:");sql.exec("PRAGMA foreign_keys=ON");const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async list=>{sql.transaction(()=>{for(const s of list)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice("local");
 const kv=new Map<string,string>(),legacy=new ReadingProgressStore({get:async k=>kv.get(k)??null,set:async(k,v)=>{kv.set(k,v);}}),progress=new SqlReadingProgressStore(db,legacy);
 const files=new Map<string,string>(),port={storeText:async(k:string,v:string)=>{const marker="marker:"+k+":"+new Bun.CryptoHasher("sha256").update(v).digest("hex");files.set(marker,v);return marker;},hydrate:async(v:string)=>{if(!v.startsWith("marker:"))return v;const body=files.get(v);if(body===undefined)throw new Error("Missing body");return body;}};
 const receiver=new SyncArticleReceiver(db,codec,port,id=>progress.migrate(id),()=>500),repo=new WatchRssRepository(db,async()=>"",port.hydrate);
 const row=()=>sql.query("SELECT * FROM articles WHERE dedup_key='one'").get() as any;
 return {sql,db,kv,progress,files,receiver,repo,row};
}
test("verified body, original body, progress and saved states publish together",async()=>{
 const f=await setup();try{
  const p=await payload();await f.receiver.receive(incoming(),p,"phone");
  expect(f.row()).toMatchObject({content:"hello world",is_saved:1,reading_progress:.25,is_read:0});
  expect((await f.progress.load(f.row().id)).progress).toBe(.25);
  expect((await f.db.query("SELECT body FROM article_original_chunks"))[0]?.body).toBe("hello world");
  expect((await f.db.query("SELECT * FROM sync_saved_states"))[0]).toMatchObject({source_device_id:"phone",saved:1});
  await f.progress.save(f.row().id,50,.75,{character:8,fraction:.25});await f.repo.setSaved(f.row().id,false);
  await f.receiver.receive(incoming({favoriteChangedAt:101}),p,"phone");expect(f.row()).toMatchObject({is_saved:0,reading_progress:.75});expect((await f.progress.load(f.row().id)).textAnchor?.character).toBe(8);
  const changed=await payload({contentHtml:null,contentText:"changed body"});await f.receiver.receive(incoming({readingProgress:.1,readingPositionChangedAt:1}),changed,"phone");
  expect(f.row().reading_progress).toBe(Math.fround(.1));expect((await f.progress.load(f.row().id)).textAnchor).toBeUndefined();expect((await f.progress.load(f.row().id)).updatedAt).toBeGreaterThan(100);
 }finally{f.sql.close();}
});
test("corrupt body and transaction errors preserve prior article; metadata-only reuses checked local content",async()=>{
 const f=await setup();try{
  const p=await payload();await f.receiver.receive(incoming(),p,"phone");const before=f.row();
  await expect(f.receiver.receive(incoming({title:"bad"}),{...p,bodyHash:"bad"},"phone")).rejects.toThrow();expect(f.row()).toEqual(before);
  f.sql.exec("CREATE TRIGGER reject_saved BEFORE UPDATE ON sync_saved_states BEGIN SELECT RAISE(ABORT,'injected'); END");
  await expect(f.receiver.receive(incoming({title:"bad",favoriteChangedAt:101}),await payload({contentHtml:null,contentText:"bad body"}),"phone")).rejects.toThrow("injected");expect(f.row()).toEqual(before);
  f.sql.exec("DROP TRIGGER reject_saved");
  await f.receiver.receive(incoming({title:"new title"}),{...p,chunks:[],metadataOnly:true},"phone");expect(f.row().title).toBe("new title");expect(f.row().content).toBe("hello world");
 }finally{f.sql.close();}
});
test("blank incoming body preserves previous content, read is OR unless authoritative",async()=>{
 const f=await setup();try{
  await f.receiver.receive(incoming({isRead:true}),await payload(),"phone");const blank=await payload({contentHtml:null,contentText:""});
  await f.receiver.receive(incoming({isRead:false,title:"metadata",readingPositionChangedAt:101,readingProgress:.6}),blank,"phone");
  expect(f.row()).toMatchObject({content:"hello world",is_read:1,reading_progress:Math.fround(.6)});
  await f.receiver.receive(incoming({isRead:false,readingPositionChangedAt:0}),blank,"phone",true);expect(f.row().is_read).toBe(0);expect((await f.progress.load(f.row().id)).updatedAt).toBe(0);
 }finally{f.sql.close();}
});
test("large body files hydrate through repository and missing metadata-only file rejects",async()=>{
 const f=await setup();try{
  const text="汉😀".repeat(18000),p=await payload({contentHtml:null,contentText:text});await f.receiver.receive(incoming(),p,"phone");
  expect(f.row().content.startsWith("marker:")).toBe(true);expect(await f.repo.getArticleBody(f.row().id)).toBe(text);
  f.files.clear();await expect(f.receiver.receive(incoming({title:"invalid"}),{...p,chunks:[],metadataOnly:true},"phone")).rejects.toThrow("unavailable");expect(f.row().title).toBe("Article");
 }finally{f.sql.close();}
});
test("legacy KV anchor migrates once and is preserved when SQL is newer",async()=>{
 const f=await setup();try{
  await f.receiver.receive(incoming(),await payload(),"phone");const id=f.row().id;
  await f.db.execute("DELETE FROM article_reading_state WHERE article_id=?",[id]);
  const old={offset:43,progress:.8,updatedAt:200,textAnchor:{character:55,fraction:.4}};f.kv.set(`watchrss.reader.progress.${id}`,JSON.stringify(old));
  expect(await f.progress.load(id)).toMatchObject({...old,progress:Math.fround(.8)});expect(f.row().reading_progress).toBe(Math.fround(.8));
  f.kv.set(`watchrss.reader.progress.${id}`,JSON.stringify({...old,updatedAt:9999,progress:1}));expect((await f.progress.load(id)).progress).toBe(Math.fround(.8));
  await f.receiver.receive(incoming({readingPositionChangedAt:201,readingProgress:.4}),await payload(),"phone");expect(await f.progress.load(id)).toMatchObject({progress:Math.fround(.4),updatedAt:201});expect((await f.progress.load(id)).textAnchor).toBeUndefined();
 }finally{f.sql.close();}
});
import nativeMerge from "../fixtures/article-merge-native.json";
test("48 verbatim native upsert cases match body, original, progress, byte position, timestamp and read flag",async()=>{
 for(const r of nativeMerge.cases){const f=await setup();try{
  const old=await payload({contentHtml:null,contentText:"old body"});
  await f.receiver.receive(incoming({isRead:true,readingProgress:.5,readingPositionBytes:4,readingPositionContentHash:"old-position-hash",readingPositionChangedAt:r.oldTime}),old,"phone");
  const next=await payload({contentHtml:null,contentText:r.body});await f.receiver.receive(incoming({readingProgress:r.progress,readingPositionBytes:9,readingPositionContentHash:"incoming-position-hash",readingPositionChangedAt:r.newTime}),next,"phone",r.authoritative);
  const e=r.expected;expect(f.row()).toMatchObject({content:e.content,reading_progress:e.progress,is_read:e.isRead?1:0});
  expect((await f.db.query("SELECT body FROM article_original_chunks"))[0]?.body).toBe(e.originalContent);
  expect((await f.db.query("SELECT * FROM article_reading_state"))[0]).toMatchObject({position_bytes:e.positionBytes,position_hash:e.positionHash,changed_at:e.changedAt});
  expect((await f.db.query("SELECT body_hash FROM article_sync_content"))[0]?.body_hash).toBe(e.bodyHash==="old"?old.bodyHash:next.bodyHash);
 }finally{f.sql.close();}}
});
test("local progress respects native float threshold, byte rounding and content hash",async()=>{
 const f=await setup();try{
  const p=await payload();await f.receiver.receive(incoming(),p,"phone");const id=f.row().id;
  await f.progress.save(id,1,.2505,{character:1,fraction:0});expect((await f.progress.load(id)).progress).toBe(.25);expect((await f.progress.load(id)).updatedAt).toBe(100);
  await f.progress.save(id,2,.5,{character:5,fraction:0});const r=(await f.db.query("SELECT * FROM article_reading_state"))[0]!;
  expect(r.position_bytes).toBe(6);expect(r.position_hash).toBe(p.bodyHash);expect(r.changed_at).toBeGreaterThan(100);
 }finally{f.sql.close();}
});
test("source channel timestamps and original-mode preferences follow native branches",async()=>{
 const f=await setup();try{
  const p=await payload();await f.receiver.receive(incoming(),p,"phone");let ch=(await f.db.query("SELECT * FROM channels"))[0]!;expect(ch.last_fetched_at).toBe(500);
  await f.db.execute("UPDATE source_preferences SET use_original_content=0");await f.receiver.receive(incoming(),p,"phone");expect((await f.db.query("SELECT use_original_content FROM source_preferences"))[0]?.use_original_content).toBe(0);
  await f.db.execute("UPDATE channels SET title='old title'");await f.receiver.receive(incoming(),p,"phone");expect((await f.db.query("SELECT use_original_content FROM source_preferences"))[0]?.use_original_content).toBe(1);
  await f.db.execute("DELETE FROM sync_article_ids");await f.db.execute("DELETE FROM channels");
  const rss=incoming({rssSourceUrl:"https://watchrss.local/import-content/book",rssSourceTitle:"Book",importedAt:0,updatedAt:0});await f.receiver.receive(rss,p,"phone");ch=(await f.db.query("SELECT * FROM channels"))[0]!;expect(ch).toMatchObject({last_fetched_at:null,sort_order:500});
  await f.db.execute("UPDATE source_preferences SET use_original_content=0");await f.receiver.receive(rss,p,"phone");ch=(await f.db.query("SELECT * FROM channels"))[0]!;expect(ch).toMatchObject({last_fetched_at:0,sort_order:500});expect((await f.db.query("SELECT use_original_content FROM source_preferences"))[0]?.use_original_content).toBe(1);
 }finally{f.sql.close();}
});
test("phone TXT novel chapters arrive as local content channels with their bodies",async()=>{
 const f=await setup();try{
  const source="https://watchrss.local/import-txt-novel/book";
  const article=incoming({rssSourceUrl:source,rssSourceTitle:"测试小说",url:source+"/chapter/0001",title:"第一章",favoriteSaved:false});
  await f.receiver.receive(article,await payload({contentHtml:null,contentText:"第一章正文"}),"phone");
  expect((await f.db.query("SELECT url,title,last_fetched_at FROM channels"))[0]).toMatchObject({url:source,title:"测试小说",last_fetched_at:100});
  expect((await f.db.query("SELECT use_original_content FROM source_preferences"))[0]?.use_original_content).toBe(1);
  expect(await f.repo.getArticleBody(f.row().id)).toBe("第一章正文");
 }finally{f.sql.close();}
});
test("local reading action can replace a future remote clock and queued local actions preserve order",async()=>{
 const f=await setup();try{
  const future=Date.now()+86400000;await f.receiver.receive(incoming({readingPositionChangedAt:future}),await payload(),"phone");const id=f.row().id;
  await Promise.all([f.progress.save(id,1,.4,{character:4,fraction:0}),f.progress.save(id,2,.6,{character:6,fraction:0})]);
  const s=await f.progress.load(id);expect(s.progress).toBe(Math.fround(.6));expect(s.textAnchor?.character).toBe(6);expect(s.updatedAt).toBeLessThan(future);
 }finally{f.sql.close();}
});

test('a migrated RSS binding receives phone updates without recreating a SHA row',async()=>{
 const f=await setup();try{
  const hash='a'.repeat(64),source='https://feed.test/rss',url='https://article/a';
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,?,'Feed',1)",[source]);
  await f.db.execute("INSERT INTO articles(id,channel_id,title,guid,link,dedup_key,fetched_at) VALUES(10,1,'RSS','tag:one',?,'guid:tag:one',1)",[url]);
  const p={...await payload(),articleId:hash},article=incoming({articleId:hash,rssSourceUrl:source,url});
  // Receive once under the old materialization rule, then migrate the pair.
  await f.receiver.receive(article,p,'phone');
  await f.db.execute('PRAGMA user_version=1');await initializeSchema(f.db);
  expect(await f.db.query('SELECT id,dedup_key FROM articles')).toEqual([{id:10,dedup_key:'guid:tag:one'}]);
  await f.receiver.receive({...article,title:'phone update',favoriteChangedAt:101},p,'phone');
  expect(await f.db.query('SELECT id,title,guid,dedup_key FROM articles')).toEqual([{id:10,title:'phone update',guid:'tag:one',dedup_key:'guid:tag:one'}]);
  await f.repo.refreshChannel(1,'<rss><channel><title>Feed</title><item><guid>tag:one</guid><title>RSS update</title><link>https://article/a</link></item></channel></rss>');
  expect(await f.db.query('SELECT id,is_saved,dedup_key FROM articles')).toEqual([{id:10,is_saved:1,dedup_key:'guid:tag:one'}]);
 }finally{f.sql.close();}
});
