import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {initializeSchema} from "../../src/core/schema.ts";
import {WatchRssRepository} from "../../src/core/repository.ts";
import {SyncSavedStateStore,deviceOrder,type RemoteSavedState} from "../../src/sync/saved-state.ts";
import type {SqlDatabase} from "../../src/core/types.ts";
async function setup(){
 const sql=new Database(":memory:");sql.exec("PRAGMA foreign_keys=ON");
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>{sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 await initializeSchema(db);
 await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',1)");
 await db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'one','https://a','a',1),(2,1,'two','https://b','b',1)");
 const store=new SyncSavedStateStore(db),repo=new WatchRssRepository(db,async()=>"");
 await store.initializeDevice("local");await store.bindArticle(1,"a","https://a");
 return {sql,db,store,repo,state:()=>sql.query("SELECT * FROM sync_saved_states WHERE article_id='a' AND save_type='favorite'").get() as any,ui:()=>sql.query("SELECT is_saved FROM articles WHERE id=1").get() as any};
}
function remote(p:Partial<RemoteSavedState>={}):RemoteSavedState{return {articleId:"a",url:"https://a",type:"favorite",saved:true,changedAt:100,sortOrder:42,sourceDeviceId:"phone",...p};}
test("remote conflict ordering, ignored zero unsave, authoritative replacement and UI sorting",async()=>{
 const f=await setup();try{
  await f.store.apply(remote());expect(f.ui().is_saved).toBe(1);expect(f.state().source_device_id).toBe("phone");
  expect((f.sql.query("SELECT sort_order FROM article_saved_states WHERE article_id=1").get() as any).sort_order).toBe(-42);
  for(const p of [{changedAt:99,saved:false},{changedAt:100,sourceDeviceId:"a",saved:false},{changedAt:100,saved:false},{changedAt:0,saved:false}])await f.store.apply(remote(p));
  expect(f.ui().is_saved).toBe(1);
  await f.store.apply(remote({changedAt:100,sourceDeviceId:"z",saved:false}));expect(f.ui().is_saved).toBe(0);
  await f.store.apply(remote({changedAt:1,saved:true}),{authoritative:true});expect(f.state().changed_at).toBe(1);
  await f.store.apply(remote({changedAt:0,saved:false}),{authoritative:true});expect(f.ui().is_saved).toBe(0);
 }finally{f.sql.close();}
});
test("local mutation between receive preparation and commit wins; no-op keeps remote provenance",async()=>{
 const f=await setup();try{
  await f.store.apply(remote());await f.repo.setSaved(1,true);expect(f.state().source_device_id).toBe("phone");
  const prepared=f.store.remoteStatements(remote({changedAt:101}));
  await f.repo.setSaved(1,false);const local=f.state();expect(local.source_device_id).toBe("local");expect(local.changed_at).toBeGreaterThan(101);
  await f.db.transaction(prepared);expect(f.state()).toEqual(local);expect(f.ui().is_saved).toBe(0);
 }finally{f.sql.close();}
});
test("failed projection rolls back incoming state and failed local journaling rolls back UI",async()=>{
 const f=await setup();try{
  f.sql.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON article_saved_states BEGIN SELECT RAISE(ABORT,'injected'); END");
  await expect(f.store.apply(remote())).rejects.toThrow("injected");expect(f.state()).toBeNull();expect(f.ui().is_saved).toBe(0);
  f.sql.exec("DROP TRIGGER fail_projection");await f.store.apply(remote());
  f.sql.exec("CREATE TRIGGER fail_journal BEFORE UPDATE ON sync_saved_states BEGIN SELECT RAISE(ABORT,'journal'); END");
  await expect(f.repo.setSaved(1,false)).rejects.toThrow("journal");expect(f.ui().is_saved).toBe(1);expect(f.state().saved).toBe(1);
 }finally{f.sql.close();}
});
test("mapping preserves pre-sync local writes, is immutable and survives article cascade",async()=>{
 const f=await setup();try{
  await f.repo.setSaveState(2,"watchLater",true);await f.store.bindArticle(2,"b","https://b");
  const seeded=f.sql.query("SELECT * FROM sync_saved_states WHERE article_id='b'").get() as any;expect(seeded.source_device_id).toBe("local");
  await f.store.apply(remote({articleId:"b",type:"watchLater",saved:false,changedAt:1}));
  expect((f.sql.query("SELECT saved FROM article_saved_states WHERE article_id=2").get() as any).saved).toBe(1);
  await expect(f.store.bindArticle(2,"a","wrong")).rejects.toThrow();
  expect((f.sql.query("SELECT url FROM sync_article_ids WHERE article_id='a'").get() as any).url).toBe("https://a");
  await f.store.apply(remote());await f.db.execute("DELETE FROM channels WHERE id=1");
  expect(f.state().item_id).toBeNull();expect(f.state().saved).toBe(1);
  await f.store.apply(remote({saved:false,changedAt:101,sortOrder:999}),{tombstone:true});expect(f.state()).toMatchObject({saved:0,changed_at:101,sort_order:0,item_id:null});
  await f.store.apply(remote({saved:true,changedAt:102}),{tombstone:true});expect(f.state().saved).toBe(0);
  await f.store.apply(remote({changedAt:103}));expect(f.state().changed_at).toBe(101);
 }finally{f.sql.close();}
});
test("device id tie uses Kotlin UTF-16 ordering and identity is persistent",async()=>{
 const f=await setup();try{
  expect(await f.store.initializeDevice("different")).toBe("local");
  expect(deviceOrder("😀")<deviceOrder("\ue000")).toBe(true);
  await f.store.apply(remote({sourceDeviceId:"😀"}));await f.store.apply(remote({sourceDeviceId:"\ue000",saved:false}));expect(f.ui().is_saved).toBe(0);
  for(const p of [{changedAt:NaN},{changedAt:Number.MAX_SAFE_INTEGER+1},{sortOrder:1.5},{sourceDeviceId:""}])expect(()=>f.store.remoteStatements(remote(p))).toThrow();
 }finally{f.sql.close();}
});

import native from "../fixtures/saved-state-native.json";
test("144 native method oracle cases match SQLite conflict results and saved entries",async()=>{
 for(const row of native.cases){
  const f=await setup();try{
   if(row.tombstone)await f.db.execute("DELETE FROM articles WHERE id=1");
   if(row.current){const c=row.current;await f.db.execute("INSERT INTO sync_saved_states VALUES(?,?,?,?,?,?,?,?,?)",["a","favorite",row.tombstone?null:1,"https://a",c.saved?1:0,c.changedAt,c.sortOrder,c.sourceDeviceId,deviceOrder(c.sourceDeviceId)]);
    if(!row.tombstone)await f.db.execute("INSERT INTO article_saved_states VALUES(1,'favorite',?,?,?)",[c.saved?1:0,c.changedAt,-c.sortOrder]);
   }
   await f.store.apply(remote(row.remote),{authoritative:row.authoritative,tombstone:row.tombstone});
   const state=f.state();if(!row.expected)expect(state).toBeNull();else expect(state).toMatchObject({saved:row.expected.saved?1:0,changed_at:row.expected.changedAt,sort_order:row.expected.sortOrder,source_device_id:row.expected.sourceDeviceId,item_id:row.expected.itemId});
   const entry=f.sql.query("SELECT saved FROM article_saved_states WHERE article_id=1 AND save_type='favorite'").get() as any;
   expect(Boolean(entry?.saved)).toBe(row.entrySaved);
  }finally{f.sql.close();}
 }
});
