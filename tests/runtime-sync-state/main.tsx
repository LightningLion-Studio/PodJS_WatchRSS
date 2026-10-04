import {runArticleCases} from "./article-cases.ts";
import {mount} from "@pocketjs/framework/solid";
import {Text} from "@pocketjs/framework/components";
import {kv} from "@podjs/framework/watch";
import {sqlite} from "@podjs/framework/services";
import {initializeSchema} from "../../src/core/schema.ts";
import {WatchRssRepository} from "../../src/core/repository.ts";
import {SyncSavedStateStore,deviceOrder,type RemoteSavedState} from "../../src/sync/saved-state.ts";
import type {SqlDatabase} from "../../src/core/types.ts";
import native from "../fixtures/saved-state-native.json";
const db:SqlDatabase={query:(q,p)=>sqlite.query(q,p as any),execute:(q,p)=>sqlite.execute(q,p as any),transaction:s=>sqlite.transaction(s as any)};
const store=new SyncSavedStateStore(db),repo=new WatchRssRepository(db,async()=>"");
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const remote=(p:Partial<RemoteSavedState>={}):RemoteSavedState=>({articleId:"a",url:"https://a",type:"favorite",saved:true,changedAt:100,sortOrder:42,sourceDeviceId:"phone",...p});
async function reset(){
 await db.transaction(["DELETE FROM sync_saved_states","DELETE FROM sync_article_ids","DELETE FROM articles","DELETE FROM channels","INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',1)","INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'one','https://a','a',1)"].map(sql=>({sql})));
 await store.bindArticle(1,"a","https://a");
}
async function state(){return (await db.query("SELECT * FROM sync_saved_states WHERE article_id='a' AND save_type='favorite'"))[0];}
async function run(){
 const started=Date.now();kv.set("sync-state-result",{state:"running",case:0});
 await initializeSchema(db);check(await store.initializeDevice("local")==="local","identity");check(await store.initializeDevice("new-candidate")==="local","identity replaced");
 let index=0;
 for(const row of native.cases){
  await reset();if(row.tombstone)await db.execute("DELETE FROM articles WHERE id=1");
  if(row.current){const c=row.current;await db.execute("INSERT INTO sync_saved_states VALUES(?,?,?,?,?,?,?,?,?)",["a","favorite",row.tombstone?null:1,"https://a",c.saved?1:0,c.changedAt,c.sortOrder,c.sourceDeviceId,deviceOrder(c.sourceDeviceId)]);
   if(!row.tombstone)await db.execute("INSERT INTO article_saved_states VALUES(1,'favorite',?,?,?)",[c.saved?1:0,c.changedAt,-c.sortOrder]);
  }
  await store.apply(remote(row.remote),{authoritative:row.authoritative,tombstone:row.tombstone});
  const s=await state(),e=row.expected;
  check(e?!!s&&s.saved===(e.saved?1:0)&&s.changed_at===e.changedAt&&s.sort_order===e.sortOrder&&s.source_device_id===e.sourceDeviceId&&s.item_id===e.itemId:!s,`native state ${index}: ${JSON.stringify(s)}`);
  const entry=(await db.query("SELECT saved FROM article_saved_states WHERE article_id=1 AND save_type='favorite'"))[0];check(Boolean(entry?.saved)===row.entrySaved,`native entry ${index}`);
  if(++index%24===0)kv.set("sync-state-result",{state:"running",case:index});
 }
 await reset();await store.apply(remote());await repo.setSaved(1,true);check((await state())?.source_device_id==="phone","noop origin");
 const prepared=store.remoteStatements(remote({changedAt:101}));await repo.setSaved(1,false);await db.transaction(prepared);check((await state())?.source_device_id==="local"&&(await state())?.saved===0,"concurrent local update lost");
 await reset();await db.execute("CREATE TRIGGER fail_projection BEFORE INSERT ON article_saved_states BEGIN SELECT RAISE(ABORT,'injected'); END");
 let rejected=false;try{await store.apply(remote());}catch{rejected=true;}finally{await db.execute("DROP TRIGGER fail_projection");}
 check(rejected&&!(await state()),"remote rollback");
 await store.apply(remote());await db.execute("CREATE TRIGGER fail_journal BEFORE UPDATE ON sync_saved_states BEGIN SELECT RAISE(ABORT,'injected'); END");
 rejected=false;try{await repo.setSaved(1,false);}catch{rejected=true;}finally{await db.execute("DROP TRIGGER fail_journal");}
 check(rejected&&(await state())?.saved===1&&(await db.query("SELECT is_saved FROM articles WHERE id=1"))[0]?.is_saved===1,"local rollback");
 await db.execute("DELETE FROM channels WHERE id=1");check((await state())?.item_id===null,"FK SET NULL");
 await store.apply(remote({saved:false,changedAt:102}),{tombstone:true});check((await state())?.saved===0,"retained tombstone");
 await db.transaction(["DELETE FROM sync_saved_states","DELETE FROM sync_article_ids"].map(sql=>({sql})));
 const articles=await runArticleCases(db);
 kv.set("sync-state-result",{state:"passed",...articles,nativeCases:index,concurrentLocalWrite:true,remoteRollback:true,localRollback:true,cascadeTombstone:true,elapsedMs:Date.now()-started});
}
mount(()=><Text>Sync state verification</Text>);
void run().catch(error=>kv.set("sync-state-result",{state:"failed",error:String(error),stack:error instanceof Error?error.stack:""}));
