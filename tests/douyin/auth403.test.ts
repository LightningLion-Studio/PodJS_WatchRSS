import {afterEach,expect,test} from 'bun:test';
import {DouyinClient} from '../../src/douyin/client.ts';
import {Douyin403Policy,DOUYIN_AUTH403_CONFIG_KEY,DOUYIN_AUTH403_COOLDOWN_KEY,DOUYIN_AUTH403_MAX_COOLDOWN_MS,readDouyin403Enabled,type Douyin403Options} from '../../src/douyin/auth403.ts';
import {AppLogger,installAppLogger} from '../../src/logs/app-logger.ts';
import type {HttpRequest,HttpResponse} from '../../src/cloud/types.ts';
import type {DouyinSecureStorage} from '../../src/douyin/types.ts';

const response=(status=200,body='{"aweme_list":[],"has_more":0}'):HttpResponse=>({status,headers:{},body:new TextEncoder().encode(body)});
const forbidden=()=>response(403,'forbidden');
async function until(done:()=>boolean){const end=Date.now()+3000;while(!done()&&Date.now()<end)await new Promise<void>(r=>setTimeout(r,0));expect(done()).toBe(true);}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {resolve,promise};}
class Store implements DouyinSecureStorage {
 values=new Map<string,string>([['douyin.cookie','sessionid=SYNTHETIC_COOKIE']]);
 async get(key:string){return this.values.get(key)??null;}
 async set(key:string,value:string){this.values.set(key,value);}
 async remove(key:string){this.values.delete(key);}
}
function fixture(options:Douyin403Options={},store=new Store()){
 let now=1_000_000,signatures=0,redirects=0,signatureGate:Promise<void>|undefined;
 const requests:HttpRequest[]=[],waits:number[]=[],replies:Array<HttpResponse|Error|Promise<HttpResponse>>=[];
 const client=new DouyinClient({secureStorage:store,now:()=>now,
  auth403:{sleep:async ms=>{waits.push(ms);},random:()=>.25,timer:()=>({result:new Promise(()=>{}),cancel(){}}),...options},
  signer:{sign:()=>{const value=`SYNTHETIC_SIGNATURE_${++signatures}`,gate=signatureGate;signatureGate=undefined;return gate?gate.then(()=>value):value;}},transport:{request:async request=>{requests.push(request);const next=replies.shift();if(next instanceof Error)throw next;if(!next)throw Error('unexpected synthetic request');return next;}}});
 client.onAuthExpired(()=>redirects++);
 return {client,store,requests,waits,replies,holdSignature:(gate:Promise<void>)=>{signatureGate=gate;},advance:(ms:number)=>{now+=ms;},time:()=>now,redirects:()=>redirects,signatures:()=>signatures};
}
afterEach(()=>installAppLogger(undefined));

for(const thrown of [false,true])test(`403 resigns exactly once without deleting Cookie (thrown=${thrown})`,async()=>{
 const sleep=deferred<void>(),f=fixture({sleep:()=>sleep.promise});f.replies.push(thrown?new Error('http_status:403'):forbidden(),response());
 const work=f.client.fetchFeedPage();await until(()=>!(f.requests.length<1));await Promise.resolve();expect(await f.client.isLoggedIn()).toBe(true);expect(f.redirects()).toBe(0);
 sleep.resolve();expect(await work).toMatchObject({ok:true});expect(f.requests).toHaveLength(2);expect(f.signatures()).toBe(2);
 expect(new URL(f.requests[0]!.url).searchParams.get('a_bogus')).not.toBe(new URL(f.requests[1]!.url).searchParams.get('a_bogus'));
 expect(f.requests.map(r=>r.headers?.Cookie)).toEqual(['sessionid=SYNTHETIC_COOKIE','sessionid=SYNTHETIC_COOKIE']);expect(f.redirects()).toBe(0);
});
test('repeated 403 plus authenticated probe enters persistent cooldown and does not log out',async()=>{
 let probes=0;const f=fixture({probe:async context=>{probes++;expect(context.timeoutMs).toBe(5000);return 'authenticated' as const;}});f.replies.push(forbidden(),forbidden());
 expect(await f.client.fetchFeedPage()).toMatchObject({ok:false,code:'RATE_LIMITED',retryAfterMs:30000,message:'抖音暂时不可用，请稍后重试'});
 expect(probes).toBe(1);expect(f.waits).toEqual([750]);expect(await f.client.isLoggedIn()).toBe(true);expect(f.redirects()).toBe(0);
 for(let i=0;i<10;i++)expect(await f.client.fetchFeedPage()).toMatchObject({code:'RATE_LIMITED'});
 expect(f.requests).toHaveLength(2);expect(f.signatures()).toBe(2);expect(f.store.values.has(DOUYIN_AUTH403_COOLDOWN_KEY)).toBe(true);
});
test('unconfigured, unknown and failed probes preserve Cookie and use temporary-unavailable cooldown',async()=>{
 for(const probe of [undefined,async()=> 'unknown' as const,async()=>{throw Error('private probe error');}]){
  const f=fixture({probe});f.replies.push(forbidden(),forbidden());
  expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE',retryAfterMs:30000});expect(await f.client.isLoggedIn()).toBe(true);expect(f.redirects()).toBe(0);expect(f.requests).toHaveLength(2);
 }
});
test('only an explicitly unauthenticated injected probe expires the session',async()=>{
 const f=fixture({probe:async()=> 'unauthenticated' as const});f.replies.push(forbidden(),forbidden());
 expect(await f.client.fetchFeedPage()).toMatchObject({code:'NOT_LOGGED_IN'});expect(await f.client.isLoggedIn()).toBe(false);expect(f.redirects()).toBe(1);
 expect(await f.client.fetchFeedPage()).toMatchObject({code:'NOT_LOGGED_IN'});expect(f.requests).toHaveLength(2);expect(f.redirects()).toBe(1);
});
for(const body of ['blocked','', '  '])test(`blocked or empty body after resign preserves authentication (${JSON.stringify(body)})`,async()=>{
 const f=fixture();f.replies.push(forbidden(),response(200,body));expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(await f.client.isLoggedIn()).toBe(true);expect(f.redirects()).toBe(0);
});
test('different simultaneous requests share one probe and one cooldown write',async()=>{
 const gate=deferred<'authenticated'>();let probes=0;const f=fixture({probe:async()=>{probes++;return gate.promise;}});
 f.replies.push(forbidden(),forbidden(),forbidden(),forbidden());
 const a=f.client.fetchFeedPage({cursor:'a'}),b=f.client.fetchFeedPage({cursor:'b'});
 await until(()=>!(probes<1));for(let i=0;i<30;i++)await Promise.resolve();expect(probes).toBe(1);gate.resolve('authenticated');
 expect(await a).toMatchObject({code:'RATE_LIMITED'});expect(await b).toMatchObject({code:'RATE_LIMITED'});expect(f.requests).toHaveLength(4);expect(f.redirects()).toBe(0);
 expect(JSON.parse(f.store.values.get(DOUYIN_AUTH403_COOLDOWN_KEY)!).strikes).toBe(1);
});
test('same simultaneous requests share one retry as well as one probe',async()=>{
 const gate=deferred<void>();let probes=0;const f=fixture({sleep:()=>gate.promise,probe:async()=>{probes++;return 'authenticated' as const;}});f.replies.push(forbidden(),forbidden());
 const a=f.client.fetchFeedPage(),b=f.client.fetchFeedPage();await until(()=>f.requests.length===1);for(let i=0;i<20;i++)await Promise.resolve();gate.resolve();await Promise.all([a,b]);
 expect(f.requests).toHaveLength(2);expect(probes).toBe(1);
});
test('cooldown survives client restart, expires, doubles on repeated 403 and resets on success',async()=>{
 const first=fixture();first.replies.push(forbidden(),forbidden());await first.client.fetchFeedPage();
 const restarted=fixture({},first.store);expect(await restarted.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE',retryAfterMs:30000});expect(restarted.requests).toHaveLength(0);
 restarted.advance(30000);restarted.replies.push(forbidden(),forbidden());expect(await restarted.client.fetchFeedPage()).toMatchObject({retryAfterMs:60000});
 restarted.advance(60000);restarted.replies.push(response());expect(await restarted.client.fetchFeedPage()).toMatchObject({ok:true});expect(first.store.values.has(DOUYIN_AUTH403_COOLDOWN_KEY)).toBe(false);
 restarted.replies.push(forbidden(),forbidden());expect(await restarted.client.fetchFeedPage()).toMatchObject({retryAfterMs:30000});
});
test('cooldown exponent has a 15 minute ceiling',async()=>{
 const f=fixture();for(let i=0;i<9;i++){
  f.replies.push(forbidden(),forbidden());const result=await f.client.fetchFeedPage();expect(result).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
  if(result.ok)throw Error('expected limited');expect(result.retryAfterMs).toBeLessThanOrEqual(DOUYIN_AUTH403_MAX_COOLDOWN_MS);f.advance(result.retryAfterMs!);
 }expect(JSON.parse(f.store.values.get(DOUYIN_AUTH403_COOLDOWN_KEY)!).strikes).toBe(6);
});
test('probe has a bounded timeout and late unauthenticated completion cannot log out',async()=>{
 const gate=deferred<'unauthenticated'>(),timeout=deferred<void>();let cancellations=0;
 const f=fixture({probe:()=>gate.promise,timer:()=>({result:timeout.promise,cancel(){cancellations++;}})});f.replies.push(forbidden(),forbidden());
 const work=f.client.fetchFeedPage();await until(()=>!(f.requests.length<2));timeout.resolve();expect(await work).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
 gate.resolve('unauthenticated');for(let i=0;i<20;i++)await Promise.resolve();expect(await f.client.isLoggedIn()).toBe(true);expect(f.redirects()).toBe(0);expect(cancellations).toBe(1);
});
test('new Cookie invalidates a pending unauthenticated probe and removes prior cooldown',async()=>{
 const gate=deferred<'unauthenticated'>();let probing=false;const f=fixture({probe:async()=>{probing=true;return gate.promise;}});f.replies.push(forbidden(),forbidden());
 const work=f.client.fetchFeedPage();await until(()=>!(!probing));await f.client.applyCookie('sessionid=NEW_SYNTHETIC_COOKIE');gate.resolve('unauthenticated');
 expect(await work).toMatchObject({code:'CANCELLED'});expect(await f.client.readCookie()).toBe('sessionid=NEW_SYNTHETIC_COOKIE');expect(f.redirects()).toBe(0);expect(f.store.values.has(DOUYIN_AUTH403_COOLDOWN_KEY)).toBe(false);
});
test('new Cookie during retry backoff cancels the old retry before transport',async()=>{
 const gate=deferred<void>(),f=fixture({sleep:()=>gate.promise});f.replies.push(forbidden());const work=f.client.fetchFeedPage();await until(()=>!(f.requests.length<1));
 await f.client.applyCookie('sessionid=NEW_SYNTHETIC_COOKIE');gate.resolve();expect(await work).toMatchObject({code:'CANCELLED'});expect(f.requests).toHaveLength(1);expect(f.redirects()).toBe(0);
});
test('four automatic recovery slots bound unrelated retries without discarding authentication',async()=>{
 const gate=deferred<void>(),f=fixture({sleep:()=>gate.promise});for(let i=0;i<12;i++)f.replies.push(forbidden());
 const jobs=Array.from({length:8},(_,i)=>f.client.fetchFeedPage({cursor:String(i)}));await until(()=>!(f.requests.length<8));for(let i=0;i<40;i++)await Promise.resolve();gate.resolve();await Promise.all(jobs);
 expect(f.requests.length).toBeLessThanOrEqual(12);expect(await f.client.isLoggedIn()).toBe(true);expect(f.redirects()).toBe(0);
});
test('explicit false preserves authentication and honors persisted cooldown',async()=>{
 const store=new Store();store.values.set(DOUYIN_AUTH403_COOLDOWN_KEY,JSON.stringify({version:1,until:2_000_000,strikes:2,authenticated:true}));
 const f=fixture({enabled:false},store);f.replies.push(forbidden());expect(await f.client.fetchFeedPage()).toMatchObject({code:'RATE_LIMITED'});expect(await f.client.isLoggedIn()).toBe(true);expect(f.requests).toHaveLength(0);expect(f.waits).toEqual([]);
 expect(readDouyin403Enabled({get:()=>undefined})).toBe(true);expect(readDouyin403Enabled({get:<T>(key:string)=>key===DOUYIN_AUTH403_CONFIG_KEY?{enabled:false} as T:undefined})).toBe(false);
});
test('metrics contain only fixed categories/counts and never credential or signature text',async()=>{
 let log='';const logger=new AppLogger({read:async()=>log,size:async()=>log.length,replace:async s=>{log=s;},append:async s=>{log+=s;}});installAppLogger(logger);
 const f=fixture({probe:async()=>{throw Error('SYNTHETIC_PROBE_SECRET');}});f.replies.push(new Error('http_status:403 https://fixture/?a_bogus=SYNTHETIC_SIGNATURE Cookie: SYNTHETIC_COOKIE'),forbidden());
 await f.client.fetchFeedPage();await f.client.fetchFeedPage();await logger.flush();
 expect(log).toContain('"stage":"forbidden"');expect(log).toContain('"stage":"resign"');expect(log).toContain('"stage":"probe"');expect(log).toContain('"stage":"cooldown"');
 expect(log).not.toMatch(/SYNTHETIC|a_bogus|https:|Cookie:/);expect((log.match(/"stage":"probe"/g)??[]).length).toBe(1);
});
test('a cancellable probe releases its operation when its timeout expires',async()=>{
 const timeout=deferred<void>();let cancelled=0,started=false;
 const f=fixture({probe:()=>{started=true;return {result:new Promise(()=>{}),cancel(){cancelled++;}};},timer:()=>({result:timeout.promise,cancel(){}})});
 f.replies.push(forbidden(),forbidden());const work=f.client.fetchFeedPage();await until(()=>started);timeout.resolve();
 expect(await work).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(cancelled).toBe(1);expect(await f.client.isLoggedIn()).toBe(true);
});
test('late success from a request preceding an incident does not remove the new cooldown',async()=>{
 const gate=deferred<HttpResponse>(),f=fixture();f.replies.push(gate.promise,forbidden(),forbidden());
 const old=f.client.fetchFeedPage({cursor:'older'});await until(()=>f.requests.length===1);
 expect(await f.client.fetchFeedPage({cursor:'incident'})).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
 gate.resolve(response());expect(await old).toMatchObject({ok:true});expect(f.store.values.has(DOUYIN_AUTH403_COOLDOWN_KEY)).toBe(true);
 expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(f.requests).toHaveLength(3);
});
test('failed cooldown persistence still blocks this client and emits no raw storage error',async()=>{
 const store=new Store(),set=store.set.bind(store);store.set=async(key,value)=>{if(key===DOUYIN_AUTH403_COOLDOWN_KEY)throw Error('SYNTHETIC_PRIVATE_STORAGE_FAILURE');await set(key,value);};const f=fixture({},store);f.replies.push(forbidden(),forbidden());
 expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(await f.client.fetchFeedPage()).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
 expect(f.requests).toHaveLength(2);expect(await f.client.isLoggedIn()).toBe(true);
});
test('a non-403 retry result is not reclassified as authentication expiry',async()=>{
 let probes=0;const f=fixture({probe:async()=>{probes++;return 'unauthenticated' as const;}});f.replies.push(forbidden(),response(503,'unavailable'));
 expect(await f.client.fetchFeedPage()).toMatchObject({code:'REQUEST_FAILED'});expect(probes).toBe(0);expect(f.requests).toHaveLength(2);expect(await f.client.isLoggedIn()).toBe(true);
});


test('an asynchronous signature cannot send a new API request after another request starts cooldown',async()=>{
 const gate=deferred<void>(),f=fixture();f.holdSignature(gate.promise);const old=f.client.fetchFeedPage({cursor:'slow-sign'});await until(()=>f.signatures()===1);
 f.replies.push(forbidden(),forbidden());expect(await f.client.fetchFeedPage({cursor:'incident'})).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
 gate.resolve();expect(await old).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(f.requests).toHaveLength(2);
});

test('slow authentication checks cannot erase a newer cooldown or start a duplicate probe',async()=>{
 const gate=deferred<boolean>(),store=new Store();let now=1_000_000,hold=false,checks=0,probes=0;
 const policy=new Douyin403Policy({storage:store,now:()=>now,options:{probe:async()=>{probes++;return 'authenticated' as const;},timer:()=>({result:new Promise(()=>{}),cancel(){}})},metric(){},current:async()=>{checks++;if(hold){hold=false;return gate.promise;}return true;}});
 await policy.resolve('fixture','feed');now+=30000;const version=policy.snapshotVersion();hold=true;const before=checks,success=policy.successful(version);await until(()=>checks>before);
 await policy.resolve('fixture','feed');gate.resolve(true);await success;expect(await policy.cooldown('feed')).toMatchObject({kind:'limited',retryAfterMs:60000});
 now+=60000;const gate2=deferred<boolean>();let slow=true;
 const coalesced=new Douyin403Policy({storage:new Store(),now:()=>now,options:{probe:async()=>{probes++;return 'authenticated' as const;},timer:()=>({result:new Promise(()=>{}),cancel(){}})},metric(){},current:async()=>{if(slow){slow=false;return gate2.promise;}return true;}});
 const earlier=coalesced.resolve('fixture','feed');for(let i=0;i<20;i++)await Promise.resolve();const prior=probes;await coalesced.resolve('fixture','feed');gate2.resolve(true);await earlier;expect(probes-prior).toBe(1);
});


test('cooldown detail requests retain no pending tokens and send no additional API calls',async()=>{
 const f=fixture();f.replies.push(forbidden(),forbidden());await f.client.fetchDetail('initial');
 for(let i=0;i<100;i++)expect(await f.client.fetchDetail('fixture-'+i)).toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
 expect(f.requests).toHaveLength(2);expect(Reflect.get(f.client,'detailRequests').size).toBe(0);
});
