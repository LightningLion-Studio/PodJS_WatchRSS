import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {sqlite,hostOperation,base64ToBytes} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {initializeSchema} from '../../src/core/schema.ts';
import {fixture,seedAliasCase,clearAliasFixture,aliasArticle,aliasBody,aliasOutcome} from '../helpers/alias-receive-fixture.ts';
import {hostArticleBodyCodec as codec,hostSyncText as text} from '../../src/sync/article-body-host.ts';
import {LocalArticleManifestStore} from '../../src/sync/local-manifest.ts';
import {SyncArticleReceiver} from '../../src/sync/article-receiver.ts';
import {SyncSavedStateStore} from '../../src/sync/saved-state.ts';
import {ensureSyncDevice,prepareLocalSaveAlias} from '../../src/sync/local-identity.ts';
import {WatchRssRepository} from '../../src/core/repository.ts';
const db:SqlDatabase={query:(q,p)=>sqlite.query(q,p as any),execute:(q,p)=>sqlite.execute(q,p as any),transaction:s=>sqlite.transaction(s as any)};
const files={storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v};
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(v);}
const local=new LocalArticleManifestStore(db,codec,text,files,async()=>{}),receive=new SyncArticleReceiver(db,codec,files,async()=>{},()=>999,a=>local.resolveIncomingBody(a));
async function run(){const started=Date.now();kv.set('alias-receive-result',{state:'running',phase:'native-cases'});
 try{
  for(let i=0;i<fixture.cases.length;i++){const row=fixture.cases[i]!;kv.set('alias-receive-result',{state:'running',phase:row.input.name,index:i});await seedAliasCase(db,row);let ok=true;try{await receive.receive(aliasArticle(row),aliasBody(row),row.input.peer,row.input.authoritative);}catch{ok=false;}check(ok===row.ok,'Native outcome: '+row.input.name);check(canonical(await aliasOutcome(db))===canonical({items:row.items,entries:row.entries,states:row.states}),'Native SQL values: '+row.input.name);}
  kv.set('alias-receive-result',{state:'running',phase:'rollback'});const row=fixture.cases[0]!;await seedAliasCase(db,row);const before=await aliasOutcome(db);
  await db.execute("CREATE TRIGGER fail_alias_projection BEFORE INSERT ON article_saved_entry_times BEGIN SELECT RAISE(ABORT,'injected'); END");let rejected=false;try{await receive.receive(aliasArticle(row),aliasBody(row),row.input.peer);}catch{rejected=true;}finally{await db.execute('DROP TRIGGER fail_alias_projection');}check(rejected&&canonical(await aliasOutcome(db))===canonical(before),'Receive rollback failed');check((await db.query('SELECT item_id FROM sync_article_ids'))[0]?.item_id===1,'Rollback moved anchor');
  await receive.receive(aliasArticle(row),aliasBody(row),row.input.peer);await receive.receive({...aliasArticle(row),favoriteChangedAt:500},aliasBody(row),row.input.peer);check((await aliasOutcome(db)).entries.find(e=>e.itemId===2&&e.type==='FAVORITE')?.createdAt===150,'Saved creation time changed');
  rejected=false;try{await new SyncSavedStateStore(db).bindArticle(1,row.articleId,'https://example.com/alias');}catch{rejected=true;}check(rejected,'Ordinary binding bypassed immutability');
  kv.set('alias-receive-result',{state:'running',phase:'first-local-save'});await clearAliasFixture(db);await db.execute('DELETE FROM sync_local_identity');let randomCalls=0;
  const random=async()=>{randomCalls++;return base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64);};
  const uuid=await ensureSyncDevice(db,random);check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),'Invalid UUID');check(await ensureSyncDevice(db,random)===uuid&&randomCalls===1,'Identity was regenerated');
  await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.example/rss','Feed',1)");await db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'Original RSS','body','https://example.com/alias','feed-guid',1)");
  const repo=new WatchRssRepository(db,async()=>'',files.hydrate,id=>prepareLocalSaveAlias(db,id,text,codec));await repo.setSaved(1,true);
  check((await db.query('SELECT * FROM sync_article_aliases'))[0]?.article_id===row.articleId,'Local alias missing');check((await db.query('SELECT * FROM sync_saved_states'))[0]?.source_device_id===uuid,'Local save not journaled');check((await db.query('SELECT * FROM sync_article_ids')).length===0,'Local alias unexpectedly moved primary anchor');
  await receive.receive(aliasArticle(row),aliasBody(row),row.input.peer);check((await db.query('SELECT count(*) n FROM articles'))[0]?.n===2,'Local RSS metadata-only receive failed');check((await db.query('SELECT item_id FROM sync_article_ids'))[0]?.item_id===2,'Canonical row not materialized');
  await repo.setSaved(1,false);const state=(await db.query("SELECT * FROM sync_saved_states WHERE save_type='favorite'"))[0]!;check(state.item_id===1&&state.saved===0&&state.source_device_id===uuid,'Original RSS alias no longer writable');
  kv.set('alias-receive-result',{state:'passed',nativeCases:fixture.cases.length,perTypeBindings:true,originalRssRetained:true,creationTimePreserved:true,receiveRollback:true,ordinaryBindGuard:true,persistentUuid:true,firstLocalSaveJournal:true,ordinaryRssMetadataOnlyReceive:true,oldAliasStillWritable:true,elapsedMs:Date.now()-started});
 }finally{await clearAliasFixture(db);await db.execute('DELETE FROM sync_local_identity');await new SyncSavedStateStore(db).initializeDevice('local');}
}
mount(()=><Text>Alias receive verification</Text>);
void run().catch(e=>kv.set('alias-receive-result',{state:'failed',error:String(e),stack:e instanceof Error?e.stack:''}));
