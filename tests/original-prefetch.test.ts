import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeSchema } from "../src/core/schema.ts";
import { OriginalContentCache } from "../src/reader/original-cache.ts";
import { visibleEntryRange } from "../src/ui/visible-range.ts";

async function fixture(download:ConstructorParameters<typeof OriginalContentCache>[1]) {
  const raw=new Database(":memory:");raw.exec("PRAGMA foreign_keys=ON");
  const queries:string[]=[];
  const db={query:async(sql:string,params:readonly unknown[]=[])=>{queries.push(sql);return raw.query(sql).all(...params as any[]) as Record<string,unknown>[];},execute:async(sql:string,params:readonly unknown[]=[])=>{raw.query(sql).run(...params as any[]);},transaction:async(statements:readonly {sql:string;params?:readonly unknown[]}[])=>{raw.transaction(()=>{for(const s of statements)raw.query(s.sql).run(...s.params as any[]??[]);})();}};
  await initializeSchema(db);
  for(const id of [1,2]){
    raw.query("INSERT INTO channels(id,url,title,created_at) VALUES(?,?,?,0)").run(id,`https://source.test/${id}`,`channel ${id}`);
    raw.query("INSERT INTO source_preferences(channel_id,use_original_content) VALUES(?,?)").run(id,id===1?1:0);
  }
  for(let id=1;id<=6;id++)raw.query("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_saved) VALUES(?,?,?,?,?,?,0,1)").run(id,id===6?2:1,`title ${id}`,"<p>RSS保持</p>",`https://page.test/${id}`,`key-${id}`);
  return {raw,queries,cache:new OriginalContentCache(db,download),count:()=>Number((raw.query("SELECT count(*) n FROM article_original_meta").get() as any).n)};
}
function gate(){let resolve!:(v:string)=>void;const promise=new Promise<string>(r=>resolve=r);return {promise,resolve};}
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,0));expect(predicate()).toBe(true);}
const page="<article><p>原文正文与图片。</p><img src='/image.png'></article>";

test("viewport range excludes overscan and edge-only contact",()=>{
  const rows=[{top:18,height:50},{top:76,height:100},{top:184,height:100},{top:292,height:100}];
  expect(visibleEntryRange(rows,0,184)).toEqual({first:0,last:1});
  expect(visibleEntryRange(rows,176,8)).toBeNull();
  expect(visibleEntryRange(rows,176,9)).toEqual({first:2,last:2});
  expect(visibleEntryRange(rows,392,20)).toBeNull();
});

test("prefetch selects only requested uncached articles in the enabled channel",async()=>{
  const requests:string[]=[];const f=await fixture(async url=>{requests.push(url);return page;});
  try{
    await f.cache.prefetch("1",["1","1","2","6"]);
    expect(requests.sort()).toEqual(["https://page.test/1","https://page.test/2"]);expect(f.count()).toBe(2);
    await f.cache.prefetch("1",["1","2"]);await f.cache.prefetch("2",["6"]);expect(requests).toHaveLength(2);
    expect(f.raw.query("SELECT content,is_saved FROM articles WHERE id=1").get()).toEqual({content:"<p>RSS保持</p>",is_saved:1});
    expect((await f.cache.get("1")).html).toContain("https://page.test/image.png");expect(requests).toHaveLength(2);
  }finally{f.raw.close();}
});

test("foreground joins an in-flight prefetch and remains readable after channel mode is disabled",async()=>{
  const response=gate();let requests=0;const f=await fixture(async()=>{requests++;return response.promise;});
  try{
    const background=f.cache.prefetch("1",["1"]);await until(()=>requests===1);
    const foreground=f.cache.get("1");f.raw.exec("UPDATE source_preferences SET use_original_content=0 WHERE channel_id=1");
    response.resolve(page);expect((await foreground).html).toContain("原文正文");await background;expect(requests).toBe(1);expect(f.count()).toBe(1);
  }finally{f.raw.close();}
});

test("closing mode suppresses unfinished background cache writes",async()=>{
  const response=gate();let requests=0;const f=await fixture(async()=>{requests++;return response.promise;});
  try{
    const work=f.cache.prefetch("1",["1"]);await until(()=>requests===1);
    f.raw.exec("UPDATE source_preferences SET use_original_content=0 WHERE channel_id=1");response.resolve(page);await work;
    expect(f.count()).toBe(0);expect(f.raw.query("SELECT count(*) n FROM article_original_chunks").get()).toEqual({n:0});
  }finally{f.raw.close();}
});

test("deleted and recreated article IDs never receive an old response",async()=>{
  const response=gate();let requests=0;const f=await fixture(async()=>{requests++;return response.promise;});
  try{
    const work=f.cache.prefetch("1",["1"]);await until(()=>requests===1);
    f.raw.exec("DELETE FROM articles WHERE id=1");f.raw.exec("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'new','https://new.test','new-key',0)");
    response.resolve(page);await work;expect(f.count()).toBe(0);
  }finally{f.raw.close();}
});

test("prefetch concurrency is bounded and deleting a channel cancels active and queued work",async()=>{
  const responses=[gate(),gate()];let requests=0,cancels=0;const f=await fixture(async(_url,job)=>{job.cancel=()=>{cancels++;};return responses[requests++].promise;});
  try{
    const work=f.cache.prefetch("1",["1","2","3","4","5"]);await until(()=>requests===2);
    await new Promise(r=>setTimeout(r,5));expect(requests).toBe(2);
    f.cache.cancelChannel("1");f.raw.exec("DELETE FROM channels WHERE id=1");responses.forEach(r=>r.resolve(page));await work;
    expect(requests).toBe(2);expect(cancels).toBe(2);expect(f.count()).toBe(0);
  }finally{f.raw.close();}
});

test("empty original failures release the job and allow an explicit retry",async()=>{
  let calls=0;const f=await fixture(async()=>++calls===1?"<html><body></body></html>":page);
  try{await f.cache.prefetch("1",["1"]);expect(f.count()).toBe(0);expect((await f.cache.get("1")).html).toContain("原文正文");expect(calls).toBe(2);expect(f.count()).toBe(1);}finally{f.raw.close();}
});

test("downloaded originals wait for scrolling to settle before their cache and preview are committed",async()=>{
  const response=gate();let requests=0;const f=await fixture(async()=>{requests++;return response.promise;});
  try{
    f.raw.exec("INSERT INTO article_previews(article_id,summary) VALUES(1,'保留RSS摘要')");
    const work=f.cache.prefetch("1",["1"]);await until(()=>requests===1);f.cache.setPaused("1",true);
    response.resolve(page);await new Promise(r=>setTimeout(r,5));expect(f.count()).toBe(0);
    f.cache.setPaused("1",false);await work;expect(f.count()).toBe(1);
    expect(f.raw.query("SELECT summary,image_url FROM article_previews WHERE article_id=1").get()).toEqual({summary:"保留RSS摘要",image_url:"https://page.test/image.png"});
  }finally{f.raw.close();}
});

test("opening a queued article prioritizes it over remaining background downloads",async()=>{
  const responses=Array.from({length:5},gate),requests:number[]=[];
  const f=await fixture(async url=>{const id=Number(url.split('/').at(-1));requests.push(id);return responses[id-1].promise;});
  try{
    const background=f.cache.prefetch("1",["1","2","3","4","5"]);await until(()=>requests.length===2);await new Promise(r=>setTimeout(r,5));
    const foreground=f.cache.get("5");responses[0].resolve(page);await until(()=>requests.length===3);expect(requests[2]).toBe(5);
    responses.forEach(r=>r.resolve(page));await foreground;await background;expect(f.count()).toBe(5);
  }finally{f.raw.close();}
});

test("legacy cached originals gain preview metadata from a bounded snippet without a network or full-body read",async()=>{
  let requests=0;const f=await fixture(async()=>{requests++;return page;});
  try{
    f.raw.exec("INSERT INTO article_original_meta(article_id,source_url,fetched_at) VALUES(1,'https://legacy.test/page',0)");
    f.raw.query("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(1,0,?)").run("<article><img src='https://legacy.test/cover.png'><p>"+"文".repeat(60000));
    f.raw.query("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(1,1,?)").run("文".repeat(60000)+"</p></article>");
    f.raw.exec("INSERT INTO article_previews(article_id,summary) VALUES(1,'保留RSS摘要')");
    await f.cache.prefetch("1",["1"]);
    expect(requests).toBe(0);expect(f.queries.some(sql=>sql.startsWith("SELECT body FROM"))).toBe(false);
    expect(f.raw.query("SELECT summary,image_url FROM article_previews WHERE article_id=1").get()).toEqual({summary:"保留RSS摘要",image_url:"https://legacy.test/cover.png"});
    expect(f.raw.query("SELECT image_url FROM article_original_previews WHERE article_id=1").get()).toEqual({image_url:"https://legacy.test/cover.png"});
  }finally{f.raw.close();}
});

test('removing selected articles cancels queued and paused work without unpausing the remaining channel',async()=>{
  const responses=[gate(),gate()];let requests=0;const f=await fixture(async()=>responses[requests++]?.promise??Promise.resolve(page));
  try{
    const work=f.cache.prefetch('1',['1','2','3']);await until(()=>requests===2);
    f.cache.setPaused('1',true);responses[0]!.resolve(page);responses[1]!.resolve(page);await new Promise(resolve=>setTimeout(resolve,0));
    await f.cache.cancelItems(['1','2','3']);await work;expect(requests).toBe(2);expect(f.count()).toBe(0);
    // A subsequent request still waits on the original channel pause.
    let finished=false;const later=f.cache.prefetch('1',['4']).then(()=>{finished=true;});await new Promise(resolve=>setTimeout(resolve,0));expect(finished).toBe(false);
    await f.cache.cancelItems(['4']);await later;expect(f.count()).toBe(0);
  }finally{f.raw.close();}
});
