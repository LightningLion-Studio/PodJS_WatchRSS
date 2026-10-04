import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import {initializeSchema} from '../../src/core/schema.ts';
import {SqlLibrarySessionRepository,type RemovedLibraryContent} from '../../src/sync/library-repository.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import type {SqlDatabase} from '../../src/core/types.ts';

mount(()=><View class="absolute inset-0 bg-black items-center justify-center"><Text class="text-sm text-white">清空资料库隔离验证</Text></View>);
const db:SqlDatabase={query:(sql,params)=>sqlite.query(sql,params as (string|number|null)[]),
 execute:(sql,params)=>sqlite.execute(sql,params as (string|number|null)[]),
 transaction:statements=>sqlite.transaction(statements as {sql:string;params?:(string|number|null)[]}[])};
const count=async(table:string)=>Number((await db.query(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count??0);
void (async()=>{
 await initializeSchema(db);
 if(await count('channels'))throw Error('fixture package is not empty');
 await db.execute("INSERT INTO sync_local_identity(id,device_id,device_order) VALUES(1,'fixture-watch','fixture-watch')");
 await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','本地内容',1)");
 await db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'fixture','body','https://example.test/fixture','fixture',1)");
 await db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(1,'favorite',1,1)");
 await db.execute("INSERT INTO notes(article_id,body,created_at,updated_at) VALUES(1,'attached',1,1)");
 await db.execute("CREATE TABLE standalone_note(id INTEGER PRIMARY KEY,body TEXT NOT NULL)");
 await db.execute("INSERT INTO standalone_note VALUES(1,'keep')");
 await db.execute("INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at) VALUES('article','fixture',1,'fixture-watch','test',1)");
 await db.execute("INSERT INTO sync_peer_state(peer_device_id,updated_at) VALUES('fixture-phone',1)");
 let cleaned:RemovedLibraryContent|undefined,cleanedAfterCommit=false;
 const uri=async()=>({valid:false,scheme:null,host:null,rawPath:null,rawQuery:null});
 const repository=new SqlLibrarySessionRepository(db,{codec:{sha256:async()=>'',encode:async()=>new Uint8Array(),decode:async()=>''},
  text:{parseUri:uri,htmlText:async value=>value},uri:{parseUri:uri,parseAndroid:uri},
  files:{storeText:async(_key,value)=>value,hydrate:async value=>value},migrateReading:async()=>{},
  cleanupRemovedContent:async content=>{cleaned=content;cleanedAfterCommit=(await count('channels'))===0&&(await count('articles'))===0;}});
 const handle=createApplicationActionHandler({notes:{} as never,deviceId:()=>repository.deviceId(),notesChanged:()=>{},clearLibrary:()=>repository.clearLibrary()});
 const response=await handle({version:14,action:'clearLibrary',nonce:'fixture-confirmed'});
 if(response.success!==true||response.action!=='clearLibrary'||!cleanedAfterCommit||cleaned?.itemIds.join(',')!=='1'||cleaned.channels[0]?.id!==1)
  throw Error('clearLibrary did not commit and clean in order');
 for(const table of ['channels','articles','article_saved_states','notes','sync_change_log','sync_peer_state'])if(await count(table))throw Error(table+' survived clear');
 if(await count('standalone_note')!==1||await count('sync_local_identity')!==1)throw Error('unrelated state was removed');
 if((await db.query('PRAGMA quick_check'))[0]?.quick_check!=='ok'||(await db.query('PRAGMA foreign_key_check')).length)throw Error('SQLite integrity failed');
 await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(2,'https://feed.example.test/rss','Feed',2)");
 await db.execute("INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at) VALUES(2,2,'Retained','retained',2)");
 await db.execute("CREATE TRIGGER fail_clear BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 const failed=await handle({version:14,action:'clearLibrary',nonce:'fixture-failure'});
 if(failed.success!==false||await count('channels')!==1||await count('articles')!==1)throw Error('failed clear did not roll back');
 kv.set('clear-library-runtime-result',{state:'passed',clearResponse:response.action,cleanedAfterCommit,
  clearedArticles:1,retainedStandaloneNotes:await count('standalone_note'),retainedIdentity:await count('sync_local_identity'),
  failedClearPreservedRows:true,quickCheck:true,foreignKeyErrors:0});
})().catch(error=>kv.set('clear-library-runtime-result',{state:'failed',message:String(error).slice(0,300)}));
