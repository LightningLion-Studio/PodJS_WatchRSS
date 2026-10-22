import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {WatchAccountStore} from '../../src/account/store.ts';
import type {WatchAccountState} from '../../src/account/types.ts';
import {watchAccountBinding} from '../../src/sync/account-binding.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session.ts';
import type {JsonObject} from '../../src/sync/protocol.ts';

const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const account:WatchAccountState={userId:'user-1',phoneMasked:'138****1234',installId:'private-install',
 watchDeviceToken:'private-access-token',watchRefreshToken:'private-refresh-token',tokenExpiresAtMillis:1,
 refreshTokenExpiresAtMillis:2,backendBaseUrl:'https://private.invalid',posthogHost:'',posthogProjectApiKey:'private-project',
 entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1};
const unexpected=async():Promise<never>=>{throw Error('probe must not touch library data');};
const repository:LibrarySessionRepository={deviceId:async()=>'watch',cursor:unexpected,mergeSources:unexpected,
 prepareWindow:unexpected,exportSources:unexpected,receiveArticle:unexpected,exportRequested:unexpected,
 finalizeSnapshot:unexpected,resetPeerState:unexpected,markSuccess:unexpected};

async function fixture(){
 const values=new Map<string,string>();let writes=0;
 const store=new WatchAccountStore({get:key=>values.get(key)??null,set:(key,value)=>{writes++;values.set(key,value);},remove:key=>{writes++;values.delete(key);}});
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch',notesChanged:()=>{},accountStore:store,accountBindingHash:sha256});
 const probe=async()=>{
  const incoming:JsonObject[]=[{version:14,action:'syncLibrary',phase:'probe'}, {action:'ack',success:true,applied:true}];
  const outgoing:JsonObject[]=[];let closed=false;
  await new LibrarySyncSession({readFrame:async()=>incoming.shift()!,writeFrame:async frame=>{outgoing.push(frame);},close:async()=>{closed=true;}},repository,{handleAction:handler}).run();
  expect(closed).toBe(true);expect(outgoing).toHaveLength(1);return outgoing[0]!;
 };
 return {store,probe,get writes(){return writes;}};
}

test('sync probe reports explicitly unbound without creating an account or touching library data',async()=>{
 const f=await fixture();expect((await f.probe()).account).toEqual({bound:false});expect(f.writes).toBe(0);
});
test('bound probe returns only SHA-256 UTF-8 identity and no tokens, phone, install or backend',async()=>{
 const f=await fixture();await f.store.save(account);const writes=f.writes;
 const reply=await f.probe();expect(reply.account).toEqual({bound:true,userIdHash:'c6c289e49e9c05b2145860387b73bcb18df43fb09a1e4a4a9713c76c88bb541b'});
 expect(JSON.stringify(reply)).not.toMatch(/user-1|private-|138\*|watchDeviceToken|watchRefreshToken|backendBaseUrl/);
 expect(f.writes).toBe(writes); // Expired access/refresh tokens still represent a bound account.
});
test('each probe rereads secure binding after logout and never caches the previous identity',async()=>{
 const f=await fixture();await f.store.save(account);const first=await f.probe();await f.store.clear();
 expect((await f.probe()).account).toEqual({bound:false});await f.store.save({...account,userId:'other'});
 expect((await f.probe()).account).not.toEqual(first.account);
});
test('no readable account port keeps legacy probe and ping shape, invalid digest never returns account data',async()=>{
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch',notesChanged:()=>{}});
 expect(handler.accountBinding).toBeUndefined();expect(await handler({action:'ping',nonce:'n'})).toEqual({success:true,action:'pong',nonce:'n'});
 await expect(watchAccountBinding({read:async()=>account},()=>account.watchDeviceToken)).rejects.toThrow('账号摘要校验失败');
});
