import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { initializeSchema } from "../../src/core/schema.ts";
import type { SqlDatabase } from "../../src/core/types.ts";
import { SqlLocalRssActions } from "../../src/sync/local-rss-actions.ts";

function database(){
  const sql=new Database(":memory:");sql.exec("PRAGMA foreign_keys=ON");
  const db:SqlDatabase={
    query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,
    execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},
    transaction:async statements=>{sql.transaction(()=>{for(const statement of statements)sql.query(statement.sql).run(...(statement.params??[]) as any[]);})();},
  };
  return {sql,db};
}
const parseUri=async(value:string)=>{try{const url=new URL(value);return {valid:true,scheme:url.protocol.slice(0,-1),host:url.hostname,rawPath:url.pathname,rawQuery:url.search.slice(1)||null};}catch{return {valid:false,scheme:null,host:null,rawPath:null,rawQuery:null};}};
const sha256=async(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

test("channel placement updates channel, source state and change log atomically",async()=>{
  const fixture=database();let clock=400;
  try{
    await initializeSchema(fixture.db);
    await fixture.db.execute("INSERT INTO sync_local_identity VALUES(1,'watch','watch')");
    await fixture.db.execute("INSERT INTO channels(id,url,title,description,last_fetched_at,created_at,sort_order) VALUES(1,'https://feed.example/rss','Feed','Desc',15,10,-20)");
    const actions=new SqlLocalRssActions(fixture.db,{parseUri},{sha256},()=>clock);
    await actions.moveChannelToTop(1);
    expect((await fixture.db.query("SELECT sort_order,is_pinned FROM channels WHERE id=1"))[0]).toEqual({sort_order:-400,is_pinned:0});
    expect((await fixture.db.query("SELECT sort_order,is_pinned,updated_at,deleted FROM sync_source_states"))[0]).toEqual({sort_order:400,is_pinned:0,updated_at:400,deleted:0});
    clock=500;await actions.setChannelPinned(1,true);
    clock=600;await actions.setChannelPinned(1,false);
    expect((await fixture.db.query("SELECT sort_order,is_pinned FROM channels WHERE id=1"))[0]).toEqual({sort_order:-500,is_pinned:0});
    expect((await fixture.db.query("SELECT sort_order,is_pinned,updated_at FROM sync_source_states"))[0]).toEqual({sort_order:500,is_pinned:0,updated_at:500});
    expect(await fixture.db.query("SELECT changed_at,reason FROM sync_change_log ORDER BY seq")).toEqual([
      {changed_at:400,reason:"sourceState"},{changed_at:500,reason:"sourceState"},{changed_at:500,reason:"sourceState"},
    ]);
  }finally{fixture.sql.close();}
});

test("mark channel read records stable article deltas and leaves already-read rows alone",async()=>{
  const fixture=database();
  try{
    await initializeSchema(fixture.db);
    await fixture.db.execute("INSERT INTO sync_local_identity VALUES(1,'watch','watch')");
    await fixture.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.example/rss','Feed',1)");
    await fixture.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at,is_read) VALUES(1,1,'A','https://example.com/a','a',1,0)");
    await fixture.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at,is_read) VALUES(2,1,'B',NULL,'fallback-b',2,0)");
    await fixture.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at,is_read) VALUES(3,1,'C','https://example.com/c','c',3,1)");
    const actions=new SqlLocalRssActions(fixture.db,{parseUri},{sha256},()=>700);
    await actions.markChannelRead(1);
    expect(await fixture.db.query("SELECT id,is_read FROM articles ORDER BY id")).toEqual([{id:1,is_read:1},{id:2,is_read:1},{id:3,is_read:1}]);
    expect(await fixture.db.query("SELECT item_id FROM sync_article_aliases ORDER BY item_id")).toEqual([{item_id:1},{item_id:2}]);
    expect(await fixture.db.query("SELECT kind,changed_at,reason FROM sync_change_log ORDER BY seq")).toEqual([
      {kind:"article",changed_at:700,reason:"read"},{kind:"article",changed_at:700,reason:"read"},
    ]);
  }finally{fixture.sql.close();}
});

test("source-state failure rolls back the placement change",async()=>{
  const fixture=database();
  try{
    await initializeSchema(fixture.db);
    await fixture.db.execute("INSERT INTO sync_local_identity VALUES(1,'watch','watch')");
    await fixture.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://feed.example/rss','Feed',10,-20)");
    await fixture.db.execute("CREATE TRIGGER fail_home_source BEFORE INSERT ON sync_source_states BEGIN SELECT RAISE(ABORT,'disk full'); END");
    const actions=new SqlLocalRssActions(fixture.db,{parseUri},{sha256},()=>400);
    await expect(actions.moveChannelToTop(1)).rejects.toThrow("disk full");
    expect((await fixture.db.query("SELECT sort_order,is_pinned FROM channels WHERE id=1"))[0]).toEqual({sort_order:-20,is_pinned:0});
    expect(await fixture.db.query("SELECT * FROM sync_change_log")).toEqual([]);
  }finally{fixture.sql.close();}
});
