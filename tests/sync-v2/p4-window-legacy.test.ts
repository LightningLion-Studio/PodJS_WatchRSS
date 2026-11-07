import {test,expect} from 'bun:test';
import {LocalReadWindows} from '../../src/sync-v2/local-window';
import {affectedSet,canonical} from '../../src/sync-v2/protocol';
import {SqlFixture,scope,vector} from './fixture';
import {cache,openLocal,nonce} from './p4-fixture';
const snapshot=()=>({serverRevision:'1',refs:[],account:{commitOid:null,revision:'0',rollbackGeneration:'0'},historyFloorRevision:'0',checkpointOid:null});
test('C28 third negotiate freezes a local read snapshot without cloud access',async()=>{
 const f=await cache();let captures=0,clock=1000;const s=await openLocal(f.objects,{snapshot:async()=>{captures++;return snapshot();},now:()=>clock});try{expect(captures).toBe(1);const value=await s.client.control('syncObjectsV2.haveWant',{scope,windowId:s.windowId,oids:[]});expect(value.objects).toEqual([]);clock+=300000;await expect(s.client.control('syncObjectsV2.haveWant',{scope,windowId:s.windowId,oids:[]})).rejects.toThrow('window_expired');const fresh=await s.client.control('syncObjectsV2.negotiate',{scope,knownRefs:[],features:[]});expect(fresh.windowId).not.toBe(s.windowId);expect(captures).toBe(2);}finally{await s.close();await f.close();}
});
test('C28 closed, expired, rolled-back-clock and foreign-session windows are refused',async()=>{
 let active=true,clock=100;const source=snapshot(),one=new LocalReadWindows(scope,()=>active,async()=>source,nonce,()=>clock),two=new LocalReadWindows(scope,()=>true,async()=>source,nonce,()=>clock),w=await one.issue([],[]);source.serverRevision='9';expect(one.check(w.windowId).serverRevision).toBe('1');expect(()=>two.check(w.windowId)).toThrow('window_expired');clock=99;expect(()=>one.check(w.windowId)).toThrow('window_expired');clock=100;active=false;expect(()=>one.check(w.windowId)).toThrow('window_expired');active=true;one.close();expect(()=>one.check(w.windowId)).toThrow('window_expired');
});
for(const version of [13,14] as const)test('v'+version+' affected alias/chapter/asset and unknown enter atomic durable pendingChoice',async()=>{
 const db=new SqlFixture();try{const store=db.store();await store.initialize();const old=await store.readState();await store.controlUpdate(old,{...old,rollbackGeneration:'1'});const v=vector('rc3-contracts'),affected=affectedSet(v.before,v.target);expect(affected).toEqual(v.affected);
  for(const [n,key]of ['alias','chapter','asset'].entries()){const receipt=await store.receiveLegacy({peer:'synthetic-peer',version,cursor:'cursor-'+n,entityKeys:[key],body:{[key]:{value:'retained'}}},affected);expect(receipt.route).toBe('pendingChoice');expect(receipt.ack).toBe(false);}
  await store.receiveLegacy({peer:'synthetic-peer',version,cursor:'unknown',entityKeys:['stable'],body:{stable:{value:'also-retained'}}},null);const reopened=db.store(),state=await reopened.readState();expect(state.pendingChoice?.inboxKeys.length).toBe(4);expect(state.applied).toEqual({});const raw=db.raw.query('SELECT body FROM syncv2_legacy_inbox').all();expect(raw.length).toBe(4);expect(JSON.stringify(raw)).not.toContain('retained');
  const before=canonical(state);db.crashAt=1;await expect(store.receiveLegacy({peer:'synthetic-peer',version,cursor:'failed',entityKeys:['asset'],body:{asset:{value:'never-partial'}}},affected)).rejects.toThrow('injected_crash');db.crashAt=null;expect(canonical(await reopened.readState())).toBe(before);expect(db.raw.query('SELECT body FROM syncv2_legacy_inbox').all().length).toBe(4);
 }finally{db.close();}
});
