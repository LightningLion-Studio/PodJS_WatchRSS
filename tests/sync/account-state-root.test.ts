import {test,expect} from 'bun:test';
import {WatchAccountStore} from '../../src/account/store';
import {parseAccountSyncRequest,syncAccount} from '../../src/sync/account-actions';
import {createApplicationActionHandler} from '../../src/sync/application-actions';
import {createDomainExternalState,readAccountDomainState} from '../../src/sync/domain-external-state';
import {parseUri} from './ble-v2-fixture';
const hash=async(v:string)=>new Bun.CryptoHasher('sha256').update(v).digest('hex');
const request={action:'syncAccount',account:{userId:'fixture-user',installId:'fixture-install',watchAccessToken:'fixture-token',watchRefreshToken:'fixture-refresh',accessTokenExpiresAt:1000000,refreshTokenExpiresAt:2000000,backendBaseUrl:'https://fixture.invalid/'}};
function setup(){const values=new Map<string,string>();let writes=0;const store=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{writes++;values.set(key,value);},remove:key=>{values.delete(key);}});return {store,writes:()=>writes};}
test('syncAccount returns actual persisted account root; identical grant replay leaves updatedAt/root/storage unchanged',async()=>{
 const f=setup();await f.store.save(await parseAccountSyncRequest(request,parseUri,100));const root=async()=>(await readAccountDomainState(await f.store.read(),hash,1000)).root;
 const external=createDomainExternalState({account:()=>f.store.read(),hash,now:()=>1000,kvFingerprint:()=>undefined,list:async()=>({entries:[]})});
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch',notesChanged:()=>{},accountStore:f.store,accountUriParse:parseUri,accountStateRoot:root});
 const old=await f.store.read(),writes=f.writes(),a=await handler(request),b=await handler(request);
 expect(a.accountStateRoot).toBe((await external()).roots.account);expect(b.accountStateRoot).toBe(a.accountStateRoot);expect(await f.store.read()).toEqual(old);expect(f.writes()).toBe(writes);expect((await f.store.read())?.updatedAtMillis).toBe(100);
 const changed=await handler({...request,account:{...request.account,watchAccessToken:'rotated-fixture',accessTokenExpiresAt:3000000}});
 expect(changed.success).toBe(true);expect(changed.accountStateRoot).not.toBe(a.accountStateRoot);expect(changed.accountStateRoot).toBe(await root());expect(f.writes()).toBe(writes+1);
});
test('receipt is optional for legacy handlers, unavailable hashes, and never runs before a failed durable save',async()=>{
 const f=setup(),legacy=await syncAccount(request,f.store,async()=>'watch',parseUri);expect(legacy.success).toBe(true);expect('accountStateRoot' in legacy).toBe(false);
 const unavailable=await syncAccount(request,f.store,async()=>'watch',parseUri,undefined,undefined,async()=>{throw Error('unavailable');});expect(unavailable.success).toBe(true);expect('accountStateRoot' in unavailable).toBe(false);
 let roots=0;await expect(syncAccount(request,{save:async()=>{throw Error('disk write failed');}},async()=>'watch',parseUri,undefined,undefined,async()=>{roots++;return 'a'.repeat(64);})).rejects.toThrow('disk write failed');expect(roots).toBe(0);
});
test('receipt includes current expiry boundary and account state, not a frozen old domain proof',async()=>{
 const account=await parseAccountSyncRequest(request,parseUri,1),a=await readAccountDomainState(account,hash,1000),due=await readAccountDomainState(account,hash,950000);
 expect(due.root).not.toBe(a.root);expect(due.scope).toBe(a.scope);expect((await readAccountDomainState({...account,userId:'other'},hash,1000)).scope).not.toBe(a.scope);
});

test('post-save grant receipt equals the complete SQLite account domain summary, not the external digest',async()=>{
 const {fixture}=await import('./ble-v2-fixture'),{SqlDomainVectorStore,DOMAIN_FAST_PATH_PROFILE}=await import('../../src/sync/domain-fast-path');const f=await fixture(),secure=setup();
 try{
  const {LibraryProjectionCache}=await import('../../src/sync/projection-cache');await new LibraryProjectionCache(f.db).initialize();
  const external=async()=>{const a=await readAccountDomainState(await secure.store.read(),hash,1000);return {scope:a.scope,roots:{account:a.root}};};
  const domains=new SqlDomainVectorStore(f.db,f.codec,external),root=async()=>domains.accountStateRoot(await readAccountDomainState(await secure.store.read(),hash,1000));
  const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch',notesChanged:()=>{},accountStore:secure.store,accountUriParse:parseUri,accountStateRoot:root});
  const a=await handler(request),vector=await domains.open('phone',DOMAIN_FAST_PATH_PROFILE),summary=await vector.summary({},{},{});
  expect(a.accountStateRoot).toBe(summary.roots.account);expect(a.accountStateRoot).not.toBe((await external()).roots.account);
  const before=await secure.store.read(),writes=secure.writes();expect((await handler(request)).accountStateRoot).toBe(a.accountStateRoot);expect(secure.writes()).toBe(writes);expect(await secure.store.read()).toEqual(before);
  const b=await handler({...request,account:{...request.account,watchAccessToken:'rotated-fixture'}});expect(b.accountStateRoot).not.toBe(a.accountStateRoot);const fresh=await (await domains.open('phone',DOMAIN_FAST_PATH_PROFILE)).summary({},{},{});expect(b.accountStateRoot).toBe(fresh.roots.account);
 }finally{f.sql.close();}
});
