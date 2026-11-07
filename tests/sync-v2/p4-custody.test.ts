import {test,expect} from 'bun:test';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {PeerCustodyStore} from '../../src/sync-v2/peer-custody';
import {WatchContentStore} from '../../src/sync-v2/content-store';
import {WatchSpaceV2} from '../../src/sync-v2/space';
import {signControl} from '../../src/sync-v2/signing';
import {digest,canonical} from '../../src/sync-v2/protocol';
import {fixture,body,now,id,revision,recipeOid} from './p3b-fixture';
import {cipher,scope} from './fixture';
import {crypt} from './p3-fixture';
import {proofs,approved,watchId,phoneId,scratch,nonce,cache,openLocal,windowId} from './p4-fixture';
async function setup(){mkdirSync(scratch,{recursive:true});const f=await fixture(mkdtempSync(join(scratch,'custody-'))),store=new WatchContentStore(f.db,cipher,f.cache.files,{scope,p4:'custody'});await store.init();const custody=new PeerCustodyStore(store,scope,watchId,crypt,approved),[watch]=await proofs();return {f,store,custody,watch};}
const pinBody=async()=>({version:2,scope,pinId:await nonce(),holderDeviceId:phoneId,claimantDeviceId:watchId,entityKey:id,bodyRevision:revision,recipeOid,blobOidsHash:digest([]),createdAtMillis:now});
const signed=(b:any)=>signControl(crypt,'fixture','wrss.sync.v2/custody-pin-sign',b);
test('C19 durable authenticated custody authorizes P3B cleanup without a cloud receipt',async()=>{
 const {f,custody,watch}=await setup();try{await f.add();const pin=await signed(await pinBody());await custody.accept(pin,watch);
  const space=new WatchSpaceV2(f.cache,{...f.space.ports,peerCustody:custody,remote:{...f.space.ports.remote,availability:async()=>{throw Error('cloud_offline');}} as any});await f.cache.setAutoEvict(true);const result=await space.runWindow(128);expect(result.freed).toBe(128);const row=await f.cache.journal.row(id),value=await f.cache.open(row!);expect(value.status).toBe('placeholder');expect(value.metadata).toEqual(body().metadata);expect((value.proof as any).kind).toBe('peer-custody');expect(f.requests).toBe(0);
 }finally{f.close();}
});
test('C19 local ACK alone preserves the only body when the cloud is offline',async()=>{
 const {f,custody,store}=await setup();try{await f.add();await store.put('local-peer-receipt:'+phoneId+':'+recipeOid,{kind:'local',oid:recipeOid,durableOffset:128,totalBytes:128},null);const space=new WatchSpaceV2(f.cache,{...f.space.ports,peerCustody:custody,remote:{...f.space.ports.remote,availability:async()=>{throw Error('cloud_offline');}} as any});await f.cache.setAutoEvict(true);const result=await space.runWindow(128);expect(result.freed).toBe(0);expect((await f.cache.open((await f.cache.journal.row(id))!)).status).toBe('ready');}finally{f.close();}
});
test('C24 same pin/body is idempotent; conflicting body retains first obligation',async()=>{
 const {f,custody,watch,store}=await setup();try{const b=await pinBody(),one=await signed(b),first=await custody.accept(one,watch);expect(await custody.accept(await signed(b),watch)).toEqual(first);await expect(custody.accept(await signed({...b,recipeOid:'recipe:sha256:'+'2'.repeat(64)}),watch)).rejects.toThrow('idempotency_conflict');expect((await store.get('custody-id:'+b.pinId))!.value).toEqual(first);
  watch.close();const restarted=new PeerCustodyStore(store,scope,watchId,crypt,approved);const result=await restarted.authorize({...f.proof,scope});expect(result.receipt.body.pinId).toBe(b.pinId);expect(result.validUntil).toBe(Number.MAX_SAFE_INTEGER);
 }finally{f.close();}
});
test('unauthenticated, forged, wrong claimant and expired-looking lease cannot grant custody',async()=>{
 const {f,custody,watch,store}=await setup();try{
  const b=await pinBody();await expect(custody.accept({kind:'local',oid:recipeOid,durableOffset:100,totalBytes:100},watch)).rejects.toThrow('invalid_schema');
  const pin=await signed(b);await expect(custody.accept({...pin,body:{...pin.body,blobOidsHash:'0'.repeat(64)}},watch)).rejects.toThrow('signature_invalid');
  await expect(custody.accept(await signed({...b,claimantDeviceId:'c'.repeat(32)}),watch)).rejects.toThrow('scope_mismatch');await expect(custody.accept(await signed({...b,expiresAtMillis:now+1000}),watch)).rejects.toThrow('invalid_schema');watch.close();await expect(custody.accept(pin,watch)).rejects.toThrow('proof_invalid');expect(await store.get('custody-id:'+b.pinId)).toBeNull();
 }finally{f.close();}
});
test('custody with wrong revision/recipe/blob closure never authorizes deletion',async()=>{
 const {f,custody,watch}=await setup();try{const b=await pinBody();await custody.accept(await signed(b),watch);for(const patch of [{bodyRevision:'0'.repeat(32)},{recipeOid:'recipe:sha256:'+'0'.repeat(64)},{blobOids:['blob:sha256:'+'0'.repeat(64)]}])await expect(custody.authorize({...f.proof,scope,...patch})).rejects.toThrow('custody_missing');}finally{f.close();}
});
test('C26 local receipt uses a peer namespace and never creates a custody pin',async()=>{
 const f=await cache(),s=await openLocal(f.objects);try{const oid='blob:sha256:'+'1'.repeat(64),reply=await s.client.control('syncObjectsV2.receipt',{kind:'local',oid,durableOffset:65536,totalBytes:100000});expect(reply).toEqual({accepted:true});expect((await f.store.page('',32,'custody-id:')).length).toBe(0);expect((await f.store.page('',32,'local-peer-receipt:')).length).toBe(1);}finally{await s.close();await f.close();}
});
