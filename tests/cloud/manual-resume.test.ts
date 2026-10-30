import {test,expect} from 'bun:test';
import {CloudManualHandoff,MANUAL_INTENT_KEY,manualEpochKey,readManualIntent} from '../../src/cloud/manual-handoff';
import {cloudAccountIdentity} from '../../src/cloud/identity';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {WatchCloudCache} from '../../src/cloud/cache';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {CloudForegroundExecution} from '../../src/cloud/execution';
import {fixture} from './service-fixture';
import {crypto,enabled} from './k2-crypto';
import {accountStatusSnapshot} from '../../src/account/status';
import {cloudSyncView} from '../../src/ui/cloud-sync-view';
const account={userId:'user',backendBaseUrl:'https://backend.invalid'},scope=cloudAccountIdentity(account),epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff';
const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function storeHost(store=new Map<string,string>()){
 const calls:{method:string;args:any}[]=[],queued=new Map<string,boolean>();let random=0;
 const host=async<T>(method:string,args:any):Promise<T>=>{calls.push({method,args});let result:any={};
  if(method==='secure.get')result={exists:store.has(args.key),value:store.get(args.key)};
  else if(method==='secure.compareAndSet'){if((store.get(args.key)??null)!==args.expected)return {updated:false} as T;if(args.value===null)store.delete(args.key);else store.set(args.key,args.value);result={updated:true};}
  else if(method==='secure.update'){for(const [k,v]of Object.entries(args.expected??{}))if((store.get(k)??null)!==v)return {updated:false} as T;for(const [k,v]of Object.entries(args.values)){if(v===null)store.delete(k);else store.set(k,String(v));}result={updated:true};}
  else if(method==='crypto.random')result={bytesBase64:'grant_'+(++random)};
  else if(method==='cloud.enqueue')queued.set(args.token,!!args.standby);
  else if(method!=='cloud.localTransfer')throw Error('Unexpected '+method);
  return result;
 };
 return {host,store,calls,queued,get random(){return random;}};
}
test('legacy recent128 startup grant is rebound once, arms durable work and resumes unchanged without a new authorization',async()=>{
 const f=storeHost();const old={version:1,token:'already_authorized',scope,mode:'recent128',createdAt:1};f.store.set(MANUAL_INTENT_KEY,JSON.stringify(old));let runs=0;
 const c=new CloudManualHandoff(f.host,async()=>scope,async mode=>{expect(mode).toBe('recent128');runs++;return true;},()=>999,async()=>epoch);
 expect(await c.restore()).toBe(true);expect(runs).toBe(1);expect(f.random).toBe(0);expect(f.queued.has(old.token)).toBe(true);expect(f.store.has(MANUAL_INTENT_KEY)).toBe(false);
});
test('HOME, screen off, guest disposal and restart preserve the original grant and real encrypted restore checkpoints',async()=>{
 const f=await fixture(),host=storeHost(f.store);await f.phone();let execution=new CloudForegroundExecution(true),checkpointNames:string[]=[],first=true,old!:CloudManualHandoff;
 f.session.state=new WatchCloudStateStore({get:async k=>f.store.get(k),set:async(k,v)=>{f.store.set(k,v);}},'user','watch',enabled,account.backendBaseUrl);
 f.session.assertCurrent=async()=>{execution.begin();};
 f.session.library.restorePayloads=async payload=>{const name=[...payload.keys()].find(n=>n==='rss-state.json'||n==='library-sync.json');if(name)checkpointNames.push(name);
  if(name==='library-sync.json'&&first){first=false;execution.foreground(false);old.foregroundChanged(false);await f.session.assertCurrent();}
  return {changed:payload.size,pending:0,abandoned:0,warnings:[]};};
 const epochRead=async()=>f.store.get(manualEpochKey(account));
 old=new CloudManualHandoff(host.host,async()=>scope,mode=>f.service.syncNow(true,mode),()=>123,epochRead);
 expect(await old.manual('recent128')).toBe(false);const saved=readManualIntent(f.store.get(MANUAL_INTENT_KEY))!;
 expect(saved).toMatchObject({version:2,epoch,mode:'recent128'});expect(host.queued.get(saved.token)).toBe(false);expect(f.service.status.phase).toBe('waiting');
 expect([...f.store.keys()].some(k=>k.includes('.restore-v1'))).toBe(true);const firstDownloads=f.calls.filter(r=>r.url.startsWith('https://objects.invalid/')).length;
 old.dispose();execution=new CloudForegroundExecution(true);
 // Reopen metadata/cache/codec/coordinator, preserving only persisted values and
 // encrypted blobs. No memory-only pending or codec checkpoint is reused.
 const secure=new Map<string,string>(JSON.parse(JSON.stringify([...f.store])));f.store.clear();for(const [k,v]of secure)f.store.set(k,v);
 const state=new WatchCloudStateStore({get:async k=>f.store.get(k),set:async(k,v)=>{f.store.set(k,v);}},'user','watch',enabled,account.backendBaseUrl);
 const cache=new WatchCloudCache({read:async p=>f.blobs.get(p)?.slice(),writeAtomic:async(p,b)=>{f.blobs.set(p,b.slice());}},crypto.sha256,enabled);
 const session={...f.session,state,cache,codec:new WatchCloudCodec(crypto,enabled)};
 const next=new WatchCloudSyncService({...((f.service as any).ports),open:async()=>session},enabled);
 const restarted=new CloudManualHandoff(host.host,async()=>scope,mode=>next.syncNow(true,mode),()=>999,epochRead);
 expect(await restarted.restore()).toBe(true);expect(host.random).toBe(1);expect(checkpointNames.filter(n=>n==='rss-state.json')).toHaveLength(1);expect(f.calls.filter(r=>r.url.startsWith('https://objects.invalid/')).length).toBe(firstDownloads);expect(f.store.has(MANUAL_INTENT_KEY)).toBe(false);
});
test('scope, backend and epoch changes invalidate persisted grants before any run; credential refresh does not widen mode',async()=>{
 for(const change of ['account','backend','epoch']){const f=storeHost();f.store.set(MANUAL_INTENT_KEY,JSON.stringify({version:2,token:'grant_old',scope,mode:'all',createdAt:1,epoch}));let runs=0;
  const c=new CloudManualHandoff(f.host,async()=>change==='account'?cloudAccountIdentity({...account,userId:'other'}):change==='backend'?cloudAccountIdentity({...account,backendBaseUrl:'https://other.invalid'}):scope,async()=>{runs++;return true;},Date.now,async()=>change==='epoch'?'new-epoch':epoch);
  expect(await c.restore()).toBe(false);expect(runs).toBe(0);expect(f.queued.size).toBe(0);expect(f.random).toBe(0);expect(f.store.has(MANUAL_INTENT_KEY)).toBe(false);
 }
 const f=storeHost();f.store.set(MANUAL_INTENT_KEY,JSON.stringify({version:2,token:'same_account',scope,mode:'recent128',createdAt:1,epoch}));const modes:string[]=[];
 const c=new CloudManualHandoff(f.host,async()=>scope,async mode=>{modes.push(mode);return false;},Date.now,async()=>epoch);await c.restore();expect(modes).toEqual(['recent128']);expect(f.random).toBe(0);c.dispose();
});
test('epoch admission deletes only the old grant and cannot clear a concurrently published newer grant',async()=>{
 const f=storeHost();f.store.set(manualEpochKey(account),epoch);const old={version:2,token:'old',scope,mode:'recent128',createdAt:1,epoch};f.store.set(MANUAL_INTENT_KEY,JSON.stringify(old));
 const state=new WatchCloudStateStore({get:async k=>f.store.get(k),set:async(k,v)=>{f.store.set(k,v);},compareAndSet:async(k,expected,value)=>{if((f.store.get(k)??undefined)!==expected)return false;if(value===undefined)f.store.delete(k);else f.store.set(k,value);return true;}},'user','watch',enabled,account.backendBaseUrl);
 expect(await state.acceptEpoch('new-epoch')).toBe(true);expect(f.store.has(MANUAL_INTENT_KEY)).toBe(false);
 const newer={...old,token:'new',epoch:'third-epoch'};f.store.set(MANUAL_INTENT_KEY,JSON.stringify(newer));const concurrent=new WatchCloudStateStore({get:async k=>f.store.get(k),set:async(k,v)=>{f.store.set(k,v);},compareAndSet:async(k,expected,value)=>{f.store.set(k,JSON.stringify({...newer,token:'concurrent'}));if(f.store.get(k)!==expected)return false;return true;}},'user','watch',enabled,account.backendBaseUrl);
 await concurrent.acceptEpoch('third-epoch');expect(readManualIntent(f.store.get(MANUAL_INTENT_KEY))?.token).toBe('concurrent');
});
test('code-only suspension is waiting/automatic continuation, not failed UI; manual recent128 does not fetch all',async()=>{
 const f=await fixture();f.session.records=async()=>({pull:async()=>{throw Object.assign(Error('host paused'),{code:'cloud_sync_suspended'});}}) as any;
 expect(await f.service.syncNow()).toBe(false);expect(f.service.status).toMatchObject({phase:'waiting',retryable:true});
 const snapshot=accountStatusSnapshot({userId:'user',backendBaseUrl:account.backendBaseUrl,watchDeviceToken:'x',tokenExpiresAtMillis:9e15,watchRefreshToken:'',entitlement:{plan:'member',active:true},telemetryConfig:{}} as any,0,f.service.status)!;
 for(const handoff of ['idle','waiting','queued'] as const)expect(cloudSyncView(snapshot,true,false,0,handoff)).toMatchObject({title:'等待继续',tone:'attention'});
 for(const handoff of ['waiting','queued'] as const){expect(cloudSyncView({...snapshot,cloud:{...snapshot.cloud!,phase:'waiting-approval'}},true,false,0,handoff).title).toBe('需要云密钥授权');expect(cloudSyncView({...snapshot,cloud:{...snapshot.cloud!,phase:'error',message:'请升级腕上RSS'}},true,false,0,handoff).title).toBe('请升级腕上RSS');}
 const g=await fixture();g.session.library.publicSources=async()=>[{url:'https://feed.example/rss'} as any];g.session.library.readingInventoryMode=async()=>{throw Error('Must not widen an authorized manual recent128');};
 expect(await g.service.syncNow(true,'recent128')).toBe(true);expect(g.calls.some(r=>r.url.includes('/entries?limit=128'))).toBe(true);expect(g.calls.some(r=>r.url.includes('/entries?limit=all'))).toBe(false);
});

test('foreground activation discovers a waiting persisted grant even without in-memory pending and resumes immediately',async()=>{
 const f=storeHost();f.store.set(MANUAL_INTENT_KEY,JSON.stringify({version:2,token:'waiting_os_backoff',scope,mode:'recent128',createdAt:1,epoch}));let runs=0;
 const c=new CloudManualHandoff(f.host,async()=>scope,async mode=>{expect(mode).toBe('recent128');runs++;return false;},()=>999,async()=>epoch);
 c.foregroundChanged(false);c.foregroundChanged(true);await settle();expect(runs).toBe(1);expect(f.random).toBe(0);expect(readManualIntent(f.store.get(MANUAL_INTENT_KEY))?.token).toBe('waiting_os_backoff');c.dispose();
});

test('foreground durable progress resets the same authorized OS backup and cannot schedule a newer grant from an old completion',async()=>{
 const f=storeHost(),intent={version:2 as const,token:'progress_grant',scope,mode:'recent128' as const,createdAt:1,epoch};f.store.set(MANUAL_INTENT_KEY,JSON.stringify(intent));const c=new CloudManualHandoff(f.host,async()=>scope,async()=>false,Date.now,async()=>epoch);
 await c.restore(false);expect(await c.progress(intent)).toBe(true);expect(f.calls.filter(v=>v.method==='cloud.enqueue').at(-1)?.args).toEqual({token:intent.token,progress:true});expect(f.random).toBe(0);
 const count=f.calls.filter(v=>v.method==='cloud.enqueue').length;f.store.set(MANUAL_INTENT_KEY,JSON.stringify({...intent,token:'newer',mode:'all'}));expect(await c.progress(intent)).toBe(false);expect(f.calls.filter(v=>v.method==='cloud.enqueue')).toHaveLength(count);expect(readManualIntent(f.store.get(MANUAL_INTENT_KEY))).toMatchObject({token:'newer',mode:'all'});c.dispose();
});
