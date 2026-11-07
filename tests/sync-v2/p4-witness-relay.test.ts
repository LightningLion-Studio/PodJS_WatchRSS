import {test,expect} from 'bun:test';
import {LocalWitnessStore} from '../../src/sync-v2/witness';
import {WatchRelayAuthor} from '../../src/sync-v2/relay-author';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {signCommit,signControl,verifySigned} from '../../src/sync-v2/signing';
import {objectOid} from '../../src/sync-v2/sealed';
import {canonical,jsonBytes} from '../../src/sync-v2/protocol';
import {scope} from './fixture';
import {crypt,keys} from './p3-fixture';
import {cache,proofs,approved,watchId,phoneId,nonce,openLocal} from './p4-fixture';
const commitBody=(author=watchId,sequence='1',parent:string|null=null,own:string|null=null)=>({version:2,scope,authorDeviceId:author,deviceSequence:sequence,previousOwnCommit:own,mergedParents:[],treeRoot:'tree:sha256:'+'1'.repeat(64),requiredFeatures:[],createdAtMillis:1,observedRefs:[],indexComplete:true,accountParent:parent,rollbackGeneration:'0',operation:{kind:'normal',rollbackTarget:null,resolvesGeneration:null}});
const header=(c:any)=>({commitOid:c.oid,headerOid:objectOid('commit-header',jsonBytes({body:c.body,signature:c.signature})),body:c.body,signature:c.signature});
test('C27 independent future headers do not poison accepted account or author pins (B07)',async()=>{
 const f=await cache(),projection=f.db.store();await projection.initialize();const root=await signCommit(crypt,'fixture',commitBody()),next=await signCommit(crypt,'fixture',commitBody(watchId,'2',root.oid,root.oid)),extra=await signCommit(crypt,'fixture',commitBody(watchId,'999',root.oid,root.oid)),[session]=await proofs(['witness']);
 try{const initial=await projection.readState(),key=await approved(watchId),pins={accountOid:root.oid,authors:{[watchId]:{sequence:'1',oid:root.oid,keyId:key.keyId,publicKey:key.publicKey}},seenOids:[]};await projection.controlUpdate(initial,{...initial,account:{oid:root.oid,revision:'1',generation:'0'},lastSeenAccountOid:root.oid,knownAuthors:pins.authors,cloud:{pins}});const before=await projection.readState(),store=new LocalWitnessStore(f.store,projection,scope,crypt,approved);
  await store.receive({scope,head:next.oid,headers:[header(next),header(root),header(extra)]},session);const after=await projection.readState();expect(after.cloud.pins).toEqual(before.cloud.pins);expect(after.knownAuthors).toEqual(before.knownAuthors);expect(after.lastSeenAccountOid).toBe(root.oid);expect(after.cloud.witnessConflict).toBeUndefined();expect((await f.store.page('',32,'witness:')).length).toBe(1);
 }finally{await f.close();}
});
test('unknown witnessed fork persists a stop marker without accepting a new pin',async()=>{
 const f=await cache(),projection=f.db.store();await projection.initialize();const root=await signCommit(crypt,'fixture',commitBody()),fork=await signCommit(crypt,'fixture',commitBody(phoneId)),[session]=await proofs(['witness']);
 try{const initial=await projection.readState();await projection.controlUpdate(initial,{...initial,account:{oid:root.oid,revision:'1',generation:'0'},lastSeenAccountOid:root.oid,cloud:{pins:{accountOid:root.oid,authors:{},seenOids:[]}}});const store=new LocalWitnessStore(f.store,projection,scope,crypt,approved);await store.receive({scope,head:fork.oid,headers:[header(fork)]},session);const after=await projection.readState();expect(after.lastSeenAccountOid).toBe(root.oid);expect(after.cloud.pins.accountOid).toBe(root.oid);expect(after.cloud.witnessConflict.head).toBe(fork.oid);
  const reader=new WatchCloudIndex(projection,{capabilities:async()=>{throw Error('network_must_not_run');}} as any,crypt,keys,approved,async()=>{});await expect(reader.pull({})).rejects.toThrow('ref_continuity_unavailable');expect((await projection.readState()).cloud.witnessConflict).toEqual(after.cloud.witnessConflict);
 }finally{await f.close();}
});
test('witness feature, authentication, signature and bounds are enforced before writes',async()=>{
 const f=await cache(),projection=f.db.store();await projection.initialize();const root=await signCommit(crypt,'fixture',commitBody()),[off]=await proofs(),[on]=await proofs(['witness']),store=new LocalWitnessStore(f.store,projection,scope,crypt,approved),value={scope,head:root.oid,headers:[header(root)]};
 try{await expect(store.receive(value,off)).rejects.toThrow('feature_missing');await expect(store.receive({...value,headers:Array(65).fill(header(root))},on)).rejects.toThrow('object_too_large');await expect(store.receive({...value,headers:[{...header(root),body:{...root.body,createdAtMillis:3}}]},on)).rejects.toThrow('hash_mismatch');on.close();await expect(store.receive(value,on)).rejects.toThrow('proof_invalid');expect((await f.store.page('',32,'witness:')).length).toBe(0);}finally{await f.close();}
});
async function relayFixture(){const c=await signCommit(crypt,'fixture',commitBody()),requestId=await nonce(),common={version:2,scope,newCommitOid:c.oid,expectedOid:null,expectedRevision:'0',requestId,issuedAtMillis:1,expiresAtMillis:100000},device=await signControl(crypt,'fixture','wrss.sync.v2/ref-update-sign',{...common,ref:'refs/devices/'+watchId+'/index'}),account=await signControl(crypt,'fixture','wrss.sync.v2/ref-update-sign',{...common,ref:'refs/account/current'}),state={pendingChoice:null,cloud:{pendingPublish:{commitOid:c.oid,requestId,request:{device,account,relayGrant:null}}}},store={readStableState:async()=>JSON.parse(canonical(state)),uploadPage:async(_id:string,after:string)=>after?[]:[{oid:c.oid,bytes:jsonBytes({body:c.body,signature:c.signature})}]};return {c,device,account,state,options:{enabled:true,scope,deviceId:watchId,alias:'fixture',store:store as any,crypto:crypt,approved,cloudAuthorization:async()=>{},now:()=>1000}};}
test('C23 grant retains the original signed author commit and both RefUpdates',async()=>{
 const f=await relayFixture(),grant=await new WatchRelayAuthor(f.options).grant(phoneId,[f.c.oid],await nonce());expect(grant.commit).toEqual({body:f.c.body,signature:f.c.signature});expect(grant.device).toEqual(f.device);expect(grant.account).toEqual(f.account);const key=await approved(watchId);await verifySigned(crypt,key.publicKey,'wrss.sync.v2/relay-grant-sign',grant.relayGrant.body,grant.relayGrant.signature);expect(grant.relayGrant.body.expiresAtMillis).toBe(601000);expect(grant.relayGrant.body.relayDeviceId).toBe(phoneId);
});
test('no cloud authorization, revoked members, unowned objects or closed relay gate cannot issue a grant',async()=>{
 const f=await relayFixture();for(const patch of [{enabled:false},{cloudAuthorization:async()=>{throw Error('authorization_required');}},{approved:async(id:string)=>{if(id===phoneId)throw Error('member_revoked');return approved(id);}},{approved:async(id:string)=>{if(id===watchId)throw Error('member_revoked');return approved(id);}}])await expect(new WatchRelayAuthor({...f.options,...patch}).grant(phoneId,[f.c.oid],await nonce())).rejects.toThrow();await expect(new WatchRelayAuthor(f.options).grant(phoneId,['blob:sha256:'+'0'.repeat(64)],await nonce())).rejects.toThrow('object_missing');
});
test('C29 queues the exact signed publication and keeps the journal after queue ACK or lost ACK',async()=>{
 const f=await relayFixture(),[session]=await proofs(),grantId=await nonce(),before=canonical(f.state),author=new WatchRelayAuthor(f.options);let calls=0;
 const local={control:async(action:string,body:any)=>{calls++;expect(action).toBe('syncObjectsV2.refUpdate');expect(Object.keys(body).sort()).toEqual(['account','device','relayGrant']);expect(body.account).toEqual(f.account);expect(body.device).toEqual(f.device);expect(body.relayGrant.body.grantId).toBe(grantId);return {kind:'relay-queued',requestId:f.account.body.requestId,grantId};}};
 expect((await author.queue(phoneId,[f.c.oid],grantId,session,local)).kind).toBe('relay-queued');expect(canonical(f.state)).toBe(before);
 await expect(author.queue(phoneId,[f.c.oid],grantId,session,{control:async()=>{throw Error('lost_ack');}})).rejects.toThrow('lost_ack');expect(canonical(f.state)).toBe(before);
 await expect(author.queue(phoneId,[f.c.oid],grantId,session,{control:async()=>({kind:'local',requestId:f.account.body.requestId,grantId})})).rejects.toThrow('invalid_schema');
 session.close();await expect(author.queue(phoneId,[f.c.oid],grantId,session,local)).rejects.toThrow('proof_invalid');expect(calls).toBe(1);
});
test('C29 local dispatcher checks all publication scopes before invoking the relay port',async()=>{
 const f=await relayFixture(),c=await cache(),grant=await new WatchRelayAuthor(f.options).grant(phoneId,[f.c.oid],await nonce());let calls=0;
 const s=await openLocal(c.objects,{refUpdate:async()=>{calls++;return {kind:'relay-queued',requestId:f.account.body.requestId,grantId:grant.relayGrant.body.grantId};}}),body={account:grant.account,device:grant.device,relayGrant:grant.relayGrant};
 try{expect((await s.client.control('syncObjectsV2.refUpdate',body)).kind).toBe('relay-queued');
  for(const field of ['account','device','relayGrant']){const bad=JSON.parse(canonical(body));bad[field].body.scope.contentGeneration='99';await expect(s.client.control('syncObjectsV2.refUpdate',bad)).rejects.toThrow('scope_mismatch');}
  expect(calls).toBe(1);
 }finally{await s.close();await c.close();}
});
