import {CloudVisibility} from '../../src/cloud/visibility';
import {test,expect} from 'bun:test';
import {CloudManualHandoff,MANUAL_INTENT_KEY,readManualIntent} from '../../src/cloud/manual-handoff';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){const store=new Map<string,string>(),calls:{method:string;args:any}[]=[];let finish!:(value:boolean)=>void,scope='account',runs=0;
 const host=async(method:string,args:any):Promise<any>=>{calls.push({method,args});if(method==='crypto.random')return {bytesBase64:'opaque-'+calls.length};if(method==='secure.set')store.set(args.key,args.value);if(method==='secure.get')return {exists:store.has(args.key),value:store.get(args.key)};if(method==='secure.delete')store.delete(args.key);if(method==='secure.compareAndSet'){if((store.get(args.key)??null)!==args.expected)return {updated:false};if(args.value===null)store.delete(args.key);else store.set(args.key,args.value);return {updated:true};}if(method==='secure.update'){for(const [k,v]of Object.entries(args.expected??{}))if((store.get(k)??null)!==v)return {updated:false};for(const [k,v]of Object.entries(args.values)){if(v===null)store.delete(k);else store.set(k,String(v));}return {updated:true};}return {};};
 const handoff=new CloudManualHandoff(host,async()=>scope,()=>{runs++;return new Promise(resolve=>finish=resolve);},()=>123);
 return {handoff,store,calls,get runs(){return runs;},get finish(){return finish;},scope:(value:string)=>scope=value};
}
test('leaving cloud page while foreground keeps the same run, durable standby is armed before running',async()=>{const f=fixture();const run=f.handoff.manual('all');await flush();expect(f.runs).toBe(1);expect(f.handoff.state.phase).toBe('foreground');expect(f.calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(1);f.finish(true);expect(await run).toBe(true);expect(f.store.has(MANUAL_INTENT_KEY)).toBe(false);});
for(const reason of ['HOME','lock'])test(reason+' permanently fenced foreground hands off one opaque request and preserves full-sync mode',async()=>{
 const f=fixture(),run=f.handoff.manual('all');await flush();f.handoff.foregroundChanged(false);await flush();f.finish(false);await run;await flush();
 expect(f.calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(2);const intent=readManualIntent(f.store.get(MANUAL_INTENT_KEY))!;expect(intent.mode).toBe('all');expect(f.calls.filter(c=>c.method==='cloud.enqueue').at(-1)!.args).toEqual({token:intent.token,standby:false});expect(f.handoff.state.phase).toBe('queued');
 f.handoff.foregroundChanged(true);f.handoff.foregroundChanged(false);await flush();expect(f.calls.filter(c=>c.method==='cloud.enqueue')).toHaveLength(2);
});
test('local BLE activity publishes a native lease and holds OS continuation independently of page state',async()=>{const f=fixture(),run=f.handoff.manual();await flush();f.handoff.localTransferChanged(true);f.handoff.foregroundChanged(false);await flush();expect(f.handoff.state.phase).toBe('held');expect(f.calls.some(c=>c.method==='cloud.localTransfer'&&c.args.active)).toBe(true);f.handoff.localTransferChanged(false);await flush();expect(f.handoff.state.phase).toBe('queued');f.finish(false);await run;});
test('old-account completion cannot clear a newer durable handoff',async()=>{const f=fixture(),old=f.handoff.manual();await flush();const oldFinish=f.finish;f.handoff.accountChanged();f.scope('other');const next=f.handoff.manual('all');await flush();const value=f.store.get(MANUAL_INTENT_KEY);oldFinish(true);await old;await flush();expect(f.store.get(MANUAL_INTENT_KEY)).toBe(value);f.finish(true);await next;});
test('invalid or truncated persistent manual intent never authorizes worker playback',()=>{expect(readManualIntent('{')).toBeUndefined();expect(readManualIntent({version:1,scope:'a',mode:'all',createdAt:1})).toBeUndefined();expect(readManualIntent({version:1,token:'secret/url',scope:'a',mode:'all',createdAt:1})).toBeUndefined();});

test('lock SCREEN_OFF fences before Activity pause; screen-on alone cannot resume a paused Activity',()=>{
 const visibility=new CloudVisibility('active');expect(visibility.active).toBe(true);expect(visibility.display({interactive:false,resumed:true})).toBe(false);
 expect(visibility.lifecycle('background')).toBe(false);expect(visibility.display({interactive:true,resumed:false})).toBe(false);expect(visibility.lifecycle('active')).toBe(false);expect(visibility.display({interactive:true,resumed:true})).toBe(true);
});

test('a foreground manual run resumed by the BLE-hold scheduler clears its exact intent on later completion',async()=>{
 const f=fixture(),run=f.handoff.manual('all');await flush();f.finish(false);await run;expect(f.store.has(MANUAL_INTENT_KEY)).toBe(true);
 const completed=f.handoff.captureCompletion();await completed(true);expect(f.store.has(MANUAL_INTENT_KEY)).toBe(false);expect(f.handoff.state.phase).toBe('idle');
});

test('recreating the cloud controller preserves monotonic native local-transfer generations',async()=>{
 const first=fixture();first.handoff.localTransferChanged(true);first.handoff.localTransferChanged(false);await flush();const last=first.calls.filter(c=>c.method==='cloud.localTransfer').at(-1)!.args.generation;
 const next=fixture();next.handoff.localTransferChanged(true);await flush();expect(next.calls.find(c=>c.method==='cloud.localTransfer')!.args.generation).toBeGreaterThan(last);
});


test('new manual authorization and restored authorization have distinct scheduling intent',async()=>{
 const store=new Map<string,string>(),flags:boolean[]=[];
 const host:any=async(method:string,args:any)=>{
  if(method==='secure.get')return {exists:store.has(args.key),value:store.get(args.key)};
  if(method==='crypto.random')return {bytesBase64:'manual_token'};
  if(method==='secure.compareAndSet'){if((store.get(args.key)??null)!==args.expected)return {updated:false};if(args.value===null)store.delete(args.key);else store.set(args.key,args.value);return {updated:true};}
  return {};
 };
 const h=new CloudManualHandoff(host,async()=>'scope',async(_mode,restored)=>{flags.push(!!restored);return false;});
 expect(await h.manual('all')).toBe(false);expect(await h.restore()).toBe(false);expect(flags).toEqual([false,true]);expect(readManualIntent(store.get(MANUAL_INTENT_KEY))?.mode).toBe('all');h.dispose();
});
