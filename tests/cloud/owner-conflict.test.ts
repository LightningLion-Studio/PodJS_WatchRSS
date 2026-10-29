import {test,expect} from 'bun:test';
import {WatchAccountStore,LibraryOwnerMismatchError} from '../../src/account/store';
import type {WatchAccountState} from '../../src/account/types';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
import {cloudFormatFailure} from '../../src/cloud/format-diagnostic';
import {createCloudRuntime} from '../../src/cloud/runtime';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {fixture} from './service-fixture';
import {dbFixture} from './library-fixture';
import {MemoRepository} from '../../src/notes/repository';
import {crypto,enabled} from './k2-crypto';
const account:WatchAccountState={userId:'personal-fixture',backendBaseUrl:'https://backend.invalid',phoneMasked:'',installId:'watch',watchDeviceToken:'synthetic',watchRefreshToken:'',refreshTokenExpiresAtMillis:0,tokenExpiresAtMillis:0,posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:1,entitlement:{plan:'free',active:true,features:[],expiresAtMillis:0},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0}};
function accounts(){const old=JSON.stringify([account.backendBaseUrl,'old-test-fixture']),values=new Map([['state_json',JSON.stringify(account)],['watchrss.library.owner',old]]),writes:string[]=[];const store=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);writes.push(k);},remove:k=>{values.delete(k);}});return {store,values,writes,old};}
test('typed and installed legacy owner errors keep the fixed code at both records and overall boundaries',async()=>{
 const f=accounts();await expect(f.store.assertLibraryOwner(account)).rejects.toMatchObject({code:'library_owner_mismatch',message:'library_owner_mismatch'});
 for(const e of [new LibraryOwnerMismatchError(),Error('library_owner_mismatch: 请清空本机资料或明确确认合并')]){expect(JSON.parse(recordFailureDiagnostic(e,'interactions',55))).toMatchObject({code:'library_owner_mismatch',stage:'interactions'});expect(JSON.parse(recordFailureDiagnostic(e)).code).toBe('library_owner_mismatch');expect(cloudFormatFailure(e)).toBe('conflict');}
});
test('empty adoption changes only the owner, while real local content requires explicit choice',async()=>{
 const f=accounts();await expect(f.store.ensureLibraryOwner(account,async()=>true)).rejects.toMatchObject({code:'library_owner_mismatch'});expect(f.values.get('watchrss.library.owner')).toBe(f.old);expect(f.writes).toEqual([]);
 await f.store.ensureLibraryOwner(account,async()=>false);expect(f.writes).toEqual(['watchrss.library.owner']);expect(f.values.get('state_json')).toBe(JSON.stringify(account));expect(f.values.get('watchrss.library.owner')).toBe(JSON.stringify([account.backendBaseUrl,account.userId]));
 await f.store.ensureLibraryOwner(account,async()=>{throw Error('same owner never scans library');});
});
test('a failed probe or account change during the probe cannot auto-adopt or mutate credentials',async()=>{
 const f=accounts();await expect(f.store.ensureLibraryOwner(account,async()=>{throw Error('SQLITE_IOERR');})).rejects.toThrow('SQLITE_IOERR');expect(f.writes).toEqual([]);
 await expect(f.store.ensureLibraryOwner(account,async()=>{f.values.set('state_json',JSON.stringify({...account,userId:'changed'}));return false;})).rejects.toThrow('account_switch_rejected');expect(f.values.get('watchrss.library.owner')).toBe(f.old);expect(f.writes).toEqual([]);
});
test('real SQLite empty probe ignores only builtin entry channels and includes memo/deletion/provenance/book state',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'builtin:bili','Bili',1),(2,'builtin:douyin','Douyin',1)");expect(await f.repo.hasLocalPrivateContent()).toBe(false);
  await new MemoRepository(f.db,'fixture').initialize();await f.db.execute("INSERT INTO memo_folders VALUES('folder','private',0,1,'old',0,0)");expect(await f.repo.hasLocalPrivateContent()).toBe(true);await f.db.execute('DELETE FROM memo_folders');
  await f.db.execute("INSERT INTO sync_article_deletions(article_id,url,changed_at,source_order,source_device_id) VALUES('gone','https://fixture.invalid/gone',1,'old','old')");expect(await f.repo.hasLocalPrivateContent()).toBe(true);await f.db.execute('DELETE FROM sync_article_deletions');
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(3,'https://old.invalid/rss','Old',1)");expect(await f.repo.hasLocalPrivateContent()).toBe(true);await f.db.execute('DELETE FROM channels WHERE id=3');expect(await f.repo.hasLocalPrivateContent()).toBe(false);
  await f.db.execute("INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json) VALUES('fixture-book','{}',1,'{}')");expect(await f.repo.hasLocalPrivateContent()).toBe(true);await f.db.execute('DELETE FROM sync_books');
  await f.db.execute("INSERT INTO article_register_state(article_id,state_json,raw_json) VALUES('pending-provenance','{}','{}')");expect(await f.repo.hasLocalPrivateContent()).toBe(true);await f.db.execute('DELETE FROM article_register_state');
  // No body SELECTs or crypto, and no LIMIT changes needed for a large library.
  f.sql.transaction(()=>{const add=f.sql.prepare("INSERT INTO articles(id,channel_id,title,dedup_key,fetched_at) VALUES(?,1,'Item',?,1)");for(let i=1;i<=500;i++)add.run(i,'item-'+i);})();expect(await f.repo.hasLocalPrivateContent()).toBe(true);
 }finally{f.sql.close();}
});
test('production runtime preflight emits owner choice before refresh/bootstrap/pull and never uploads',async()=>{
 const f=accounts(),db=await dbFixture();try{await db.db.execute("INSERT INTO channels(url,title,created_at) VALUES('https://old.invalid/rss','Old',1)");const calls:string[]=[];
 const host=async<T>(method:string,args:Record<string,unknown>)=>{calls.push(method);if(method==='discovery.networkSnapshot')return {active:true,validated:true,wifi:true,metered:false} as T;if(method==='cloud.acquire')return {acquired:true} as T;if(method==='cloud.release')return {} as T;if(method==='file.list')return {entries:[]} as T;throw Error('unexpected host operation '+method);};
 const records:string[]=[],formats:string[]=[];const runtime=createCloudRuntime(host,async()=>Object.assign(db.repo,{deviceId:async()=> 'watch'}),enabled,f.store,undefined,undefined,{recordDiagnostic:s=>records.push(s),formatDiagnostic:s=>formats.push(s)});
 expect(await runtime.inspectOwner()).toBe(false);expect(runtime.service.status).toMatchObject({ownerChoiceRequired:true,errorCode:'library_owner_mismatch'});expect(await runtime.service.syncNow()).toBe(false);expect(calls.some(c=>c.startsWith('http.')||c.startsWith('crypto.'))).toBe(false);expect(f.writes).toEqual([]);
 expect(JSON.parse(formats.at(-1)!)).toMatchObject({code:'library_owner_mismatch',category:'conflict',outcome:'failed'});expect(runtime.service.status.retryAtMillis).toBeUndefined();
 }finally{db.sql.close();}
});
test('production empty runtime adopts under the writer lease; busy writer and missing capability fail closed',async()=>{
 for(const acquired of [false,true]){const f=accounts(),db=await dbFixture();try{const calls:string[]=[];const runtime=createCloudRuntime(async<T>(method:string)=>{calls.push(method);if(method==='cloud.acquire')return {acquired} as T;if(method==='cloud.release')return {} as T;throw Error('must stay local');},async()=>Object.assign(db.repo,{deviceId:async()=> 'watch'}),enabled,f.store);
 expect(await runtime.inspectOwner()).toBe(acquired);expect(f.values.get('watchrss.library.owner')).toBe(acquired?JSON.stringify([account.backendBaseUrl,account.userId]):f.old);expect(calls).toEqual(acquired?['cloud.acquire','cloud.release']:['cloud.acquire']);
 }finally{db.sql.close();}}
});
test('service ownership fence precedes all cloud read/apply work; late installed-path conflict remains fixed and prevents publication',async()=>{
 for(const preflight of [true,false]){const f=await fixture();let pulls=0,pushes=0;const err=Error('library_owner_mismatch: legacy installed explanation');if(preflight)f.session.assertOwnership=async()=>{throw err;};
 f.session.records=async()=>({pull:async()=>{pulls++;return 0;},flushInteractions:async()=>{await f.session.assertUpload?.();pushes++;return 0;}} as any);f.session.assertUpload=async()=>{throw err;};
 const messages:string[]=[],metrics:string[]=[];const service=new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'unused',exclusive:async fn=>fn(),recordDiagnostic:v=>messages.push(v),formatDiagnostic:v=>metrics.push(v)},enabled);
 expect(await service.syncNow()).toBe(false);expect(pulls).toBe(preflight?0:1);expect(pushes).toBe(0);expect(f.reservations.size).toBe(0);expect(service.status).toMatchObject({errorCode:'library_owner_mismatch',ownerChoiceRequired:true});expect(JSON.parse(metrics.at(-1)!)).toMatchObject({code:'library_owner_mismatch',category:'conflict'});if(!preflight)expect(messages.map(s=>JSON.parse(s)).some(v=>v.code==='library_owner_mismatch'&&v.stage==='interactions')).toBe(true);
 }
});
test('failed explicit clear retains old ownership; successful clear retains credentials then permits a new restore',async()=>{
 const f=accounts();await expect(f.store.resolveLibraryOwner(account,'clear',async()=>{throw Error('disk failure');})).rejects.toThrow();expect(f.values.get('watchrss.library.owner')).toBe(f.old);
 const order:string[]=[];await f.store.resolveLibraryOwner(account,'clear',async()=>{order.push('clear');expect(f.values.get('watchrss.library.owner')).toBe(f.old);});expect(order).toEqual(['clear']);await f.store.assertLibraryOwner(account);expect(await f.store.read()).toMatchObject({userId:account.userId,watchDeviceToken:account.watchDeviceToken});
});

test('owner choice remains visible while a retry is awaiting its preflight result',async()=>{
 const f=await fixture();let resume!:(v:void)=>void;f.session.assertOwnership=async()=>{await new Promise<void>(yes=>{resume=yes;});throw new LibraryOwnerMismatchError();};
 f.service.requireOwnerChoice();const running=f.service.syncNow();for(let i=0;i<30;i++)await Promise.resolve();expect(f.service.status.ownerChoiceRequired).toBe(true);expect(f.service.status.errorCode).toBe('library_owner_mismatch');resume();expect(await running).toBe(false);expect(f.service.status.ownerChoiceRequired).toBe(true);
});

test('a fixed-code owner cause with unrelated message cannot be downgraded by record-stage recovery',async()=>{
 const f=await fixture(),cause=Object.assign(Error('opaque host explanation'),{code:'library_owner_mismatch'});let published=0;
 f.session.records=async()=>({pull:async()=>0,flushInteractions:async()=>{throw cause;}} as any);
 f.session.client.snapshotHeads=async()=>{published++;return [];};
 expect(await f.service.syncNow()).toBe(false);expect(f.service.status).toMatchObject({ownerChoiceRequired:true,errorCode:'library_owner_mismatch',retryable:false});expect(published).toBe(0);expect(f.reservations.size).toBe(0);
});
