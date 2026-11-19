import {test,expect,mock} from 'bun:test';
let online=true,feed=0,prepares=0,registered:any[]=[],stored:any[]=[],config:any,prepareGate:(()=>Promise<void>)|undefined,registrationGate:(()=>Promise<void>)|undefined,operationCancels=0;
let verifiedLists=0,verifiedLookups=0;
let listGate:(()=>Promise<void>)|undefined,lookupGate:((key:string)=>Promise<void>|undefined)|undefined;
const listStock=()=>{
 verifiedLists++;
 const gate=listGate?.(),items=stored.slice();
 return gate?{result:gate.then(()=>({items})),cancel(){}}:value({items});
};
const lookupStock=(key:string)=>{
 verifiedLookups++;
 const gate=lookupGate?.(key),item=stored.find(row=>row.key===key);
 return gate?{result:gate.then(()=>({item})),cancel(){}}:value({item});
};
const value=(v:any)=>({result:Promise.resolve(v),cancel(){}});
mock.module('@podjs/framework/watch',()=>({kv:{get:()=>undefined,set(){}}}));
mock.module('@podjs/framework/services',()=>({delay:()=>({result:new Promise(()=>{}),cancel(){}}),discovery:{networkSnapshot:async()=>({active:online,internet:online,validated:online,wifi:true,metered:false})}}));
mock.module('../src/media/video-opt.ts',()=>({videoOptEnabled:()=>false,decodableDouyinItem:async(v:any)=>v,VideoPlaybackTrace:class{event(){}},registerVideoResolution(){}}));
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{remove:()=>value(undefined),register:(...args:any[])=>{registered.push(args);const gate=registrationGate?.();return {result:Promise.resolve(gate).then(()=>({uri:'podjs-media-cache://play/'+args[0]})),cancel(){operationCancels++;}};}},localMediaStore:{remove:(key:string)=>{stored=stored.filter(v=>v.key!==key);return value(undefined);},configure:(c:any)=>{config=c;return value(undefined);},list:listStock,lookup:lookupStock,prepare:(key:string,_uri:string,metadata:any)=>{prepares++;const item={key,metadata,audioTracks:1,videoTracks:1,uri:'file:///complete/'+metadata.awemeId+'.mp4',watched:false,bytes:1000,frame:{available:true,path:'frame.jpg'}};const gate=prepareGate?.();return {result:Promise.resolve(gate).then(()=>{stored.push(item);return {ready:true,item};}),cancel(){operationCancels++;}};},watched:(key:string)=>{stored.find(v=>v.key===key).watched=true;return value(undefined);},cancel:()=>value(undefined),clear:()=>value(undefined)}}));
const {createHostDouyinStock}=await import('../src/douyin/stock-host.ts');
test('complete stock uses browsing candidates, survives restart offline, and never reads expired URLs',async()=>{
 const client={stockAuthorizationScope:async()=> 'fixture-scope',isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({Cookie:'private-cookie'}),fetchFeedPage:async()=>{feed++;throw Error('extra feed forbidden');}};
 const items=['expired','a','b','c','d'].map(awemeId=>({awemeId,description:'title',authorName:'author',playUrl:`https://fixture.invalid/${awemeId}?x-expires=${awemeId==='expired'?1000000000:9999999999}`,variants:[],durationMs:30000}));
 const host=createHostDouyinStock(client as any);await host.resume();expect(prepares).toBe(0);host.offer!(items as any);await host.resume();expect(prepares).toBe(3);expect(feed).toBe(0);expect(config.count).toBe(3);expect(config.entryBytes).toBe(32*1024*1024);expect(registered.every(v=>v[0].includes('expired')===false)).toBe(true);
 expect(JSON.stringify(stored)).not.toContain('private-cookie');expect(JSON.stringify(stored)).not.toContain('https:');
 online=false;const restart=createHostDouyinStock(client as any);expect((await restart.restore()).map(i=>i.awemeId)).toEqual(['a','b','c']);expect((await restart.ready('a'))?.uri).toBe('file:///complete/a.mp4');restart.consume('a');expect((await restart.restore()).map(i=>i.awemeId)).toEqual(['b','c']);expect((await restart.playbackReady('a'))?.frame?.available).toBe(true);await restart.resume();expect(prepares).toBe(3);expect(feed).toBe(0);
});

test('a consumed in-flight completion is watched and the latest browsing window refills',async()=>{
 online=true;stored=[];registered=[];prepares=0;
 let release!:()=>void,started=false;
 prepareGate=()=>{prepareGate=undefined;started=true;return new Promise<void>(resolve=>release=resolve);};
 const client={stockAuthorizationScope:async()=> 'fixture-scope',isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const item=(awemeId:string)=>({awemeId,description:'title',authorName:'author',playUrl:`https://fixture.invalid/${awemeId}?x-expires=9999999999`,variants:[],durationMs:30000});
 const host=createHostDouyinStock(client as any);host.offer!([item('old')] as any);
 for(let n=0;!started&&n<50;n++)await new Promise(r=>setTimeout(r,1));expect(started).toBe(true);
 host.consume('old');host.offer!(['new1','new2','new3'].map(item) as any);release();
 for(let n=0;stored.filter(v=>!v.watched).length<3&&n<100;n++)await new Promise(r=>setTimeout(r,1));
 expect(stored.find(v=>v.metadata.awemeId==='old')?.watched).toBe(true);
 expect((await host.restore()).map(v=>v.awemeId)).toEqual(['new1','new2','new3']);host.suspend();
});

test('DYWAIT-C passes only the selected DASH companion and skips expired audio',async()=>{
 online=true;stored=[];registered=[];prepares=0;
 const client={stockAuthorizationScope:async()=> 'fixture-scope',isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const item=(id:string,audioExpires:number)=>({awemeId:id,description:'title',authorName:'author',playUrl:`https://fixture.invalid/${id}?x-expires=9999999999`,variants:[{playUrl:`https://fixture.invalid/${id}?x-expires=9999999999`,audioUrl:`https://fixture.invalid/audio?x-expires=${audioExpires}`,format:'dash',width:540,height:960,bitrate:200000,codec:'h264'}],durationMs:60000});
 const host=createHostDouyinStock(client as any);host.offer!([item('expired-audio',1000000000),item('valid',9999999999)] as any);await host.resume();
 expect(registered).toHaveLength(1);expect(registered[0][6]).toBe('https://fixture.invalid/audio?x-expires=9999999999');expect(prepares).toBe(1);expect(config.minFreeBytes).toBe(512*1024*1024);expect(config.totalBytes).toBe(128*1024*1024);host.suspend();
});

test('R12 replacing authorization hides legacy stock and fences a late old preparation',async()=>{
 online=true;stored=[];prepares=0;registered=[];let scope='owner-a',listener:(state:string)=>void=()=>{};
 const client={stockAuthorizationScope:async()=>scope,subscribeAuth:(fn:any)=>{listener=fn;},isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const item=(id:string)=>({awemeId:id,description:id,authorName:'author',playUrl:`https://fixture.invalid/${id}?x-expires=9999999999`,variants:[],durationMs:1000});
 const host=createHostDouyinStock(client as any);host.offer!([item('old')] as any);await host.resume();expect((await host.restore()).map(v=>v.awemeId)).toEqual(['old']);
 scope='owner-b';listener('unknown');expect(await host.restore()).toEqual([]);expect(await host.ready('old')).toBeUndefined();expect(await host.playbackReady('old')).toBeUndefined();
 const restart=createHostDouyinStock(client as any);expect(await restart.restore()).toEqual([]);
 let release!:()=>void,started=false;prepareGate=()=>{prepareGate=undefined;started=true;return new Promise<void>(resolve=>release=resolve);};
 restart.offer!([item('late')] as any);for(let n=0;!started&&n<50;n++)await new Promise(r=>setTimeout(r,1));expect(started).toBe(true);
 scope='owner-c';listener('unknown');release();await restart.resume();expect(await restart.restore()).toEqual([]);restart.suspend();host.suspend();
});

test('R01/R04 production client plus stock keeps explicit detail available and stores public media headers',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');online=true;stored=[];registered=[];prepares=0;const requests:any[]=[];
 const values=new Map<string,string>([['douyin.cookie','offline-session']]);
 const client=new DouyinClient({secureStorage:{get:async key=>values.get(key)??null,set:async(key,value)=>{values.set(key,value);},remove:async key=>{values.delete(key);}},signer:{sign:()=> 'offline'},transport:{request:async request=>{requests.push(request);return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(request.url.includes('/detail/')?{status_code:0,aweme_detail:{aweme_id:'42',video:{play_addr:{url_list:['https://fixture.invalid/main']},duration:1000}}}:{status_code:0,aweme_list:[],has_more:0}))};}}});
 const host=createHostDouyinStock(client);expect((await client.fetchDetail('42',{forceRefresh:true})).ok).toBe(true);expect((await client.fetchFeedPage()).ok).toBe(true);expect(requests).toHaveLength(2);
 host.offer!([{awemeId:'clip',description:'offline',authorName:'fixture',playUrl:'https://fixture.invalid/main?x-expires=9999999999',durationMs:1000,variants:[]}] as any);await host.resume();
 expect(registered).toHaveLength(1);expect(Object.keys(registered[0][2]).map(k=>k.toLowerCase())).not.toContain('cookie');host.suspend();
});

test('P2-03 a registration arriving after Cookie replacement cannot submit complete storage',async()=>{
 online=true;stored=[];registered=[];prepares=0;operationCancels=0;let scope='old',listener:(state:string)=>void=()=>{},started=false,release!:()=>void;
 registrationGate=()=>{registrationGate=undefined;started=true;return new Promise<void>(resolve=>release=resolve);};
 const client={stockAuthorizationScope:async()=>scope,subscribeAuth:(fn:any)=>listener=fn,isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const host=createHostDouyinStock(client as any);host.offer!([{awemeId:'late-register',description:'fixture',authorName:'fixture',playUrl:'https://fixture.invalid/media?x-expires=9999999999',durationMs:1000,variants:[]}] as any);
 const pending=host.resume();for(let n=0;!started&&n<100;n++)await Promise.resolve();expect(started).toBe(true);expect(prepares).toBe(0);
 scope='new';listener('unknown');expect(operationCancels).toBe(1);release();await pending;expect(prepares).toBe(0);expect(stored).toEqual([]);host.suspend();
});
test('P2-03 Cookie replacement cancels a submitted native prepare operation',async()=>{
 online=true;stored=[];registered=[];prepares=0;operationCancels=0;let scope='old',listener:(state:string)=>void=()=>{},started=false,release!:()=>void;
 prepareGate=()=>{prepareGate=undefined;started=true;return new Promise<void>(resolve=>release=resolve);};
 const client={stockAuthorizationScope:async()=>scope,subscribeAuth:(fn:any)=>listener=fn,isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const host=createHostDouyinStock(client as any);host.offer!([{awemeId:'late-prepare',description:'fixture',authorName:'fixture',playUrl:'https://fixture.invalid/media?x-expires=9999999999',durationMs:1000,variants:[]}] as any);
 const pending=host.resume();for(let n=0;!started&&n<100;n++)await Promise.resolve();expect(started).toBe(true);expect(prepares).toBe(1);
 scope='new';listener('unknown');expect(operationCancels).toBe(1);release();await pending;expect(await host.restore()).toEqual([]);expect(prepares).toBe(1);host.suspend();
});

test('stored portrait metadata is excluded even if the native inventory still lists it',async()=>{
 online=false;stored=[{key:'portrait',uri:'file:///portrait.mp4',metadata:{awemeId:'portrait',description:'fixture',authorName:'fixture',durationMs:1000,stockAuthorization:'fixture-scope',width:1080,height:1920},audioTracks:1,videoTracks:1,bytes:100,frame:{available:true}}];
 const client={stockAuthorizationScope:async()=> 'fixture-scope',listWatchedIds:async()=>[]};
 const host=createHostDouyinStock(client as any);
 expect(await host.restore()).toEqual([]);
 expect(await host.playbackReady('portrait')).toBeUndefined();
 expect(stored).toEqual([]);
});

const {admitDouyinItem}=await import('../src/douyin/playback-ingress.ts');

test('RVRESCAP-07 cancels the active 1080 stock transfer and stores the 480 replacement',async()=>{
  online=true;stored=[];registered=[];prepares=0;operationCancels=0;
  let release!:()=>void,started=false;
  prepareGate=()=>{prepareGate=undefined;started=true;return new Promise<void>(resolve=>release=resolve);};
  const offline={stockAuthorizationScope:async()=> 'review-scope',isLoggedIn:async()=>true,
    listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
  const old={awemeId:'review',description:'review',authorName:'review',
    playUrl:'https://review.invalid/1080',variants:[],durationMs:1000};
  const high={playUrl:old.playUrl,width:1080,height:1920,bitrate:100,codec:'h264'};
  const safe={playUrl:'https://review.invalid/480',width:480,height:854,bitrate:100,codec:'h264'};
  const host=createHostDouyinStock(offline as any);
  host.offer!([old] as any);
  const pending=host.resume();
  for(let i=0;!started&&i<100;i++)await Promise.resolve();
  expect(started).toBe(true);
  expect(registered[0][1]).toBe(high.playUrl);
  host.offer!([admitDouyinItem({...old,playUrl:safe.playUrl,variants:[high,safe]} as any)!]);
  expect(operationCancels).toBe(1);
  release();
  await pending;
  for(let i=0;!stored.length&&i<100;i++)await Promise.resolve();
  await host.resume();
  expect(registered.map(values=>values[1])).toEqual([high.playUrl,safe.playUrl]);
  expect(stored.map(value=>value.metadata.width)).toEqual([480]);
  host.suspend();
});


test('one verified inventory serves concurrent and serial misses, while hits and changed authorizations are rechecked',async()=>{
 const asset=(id:string,scope:string)=>({key:scope+'-'+id,uri:'file:///'+scope+'/'+id+'.mp4',
  metadata:{awemeId:id,description:'fixture',authorName:'fixture',durationMs:1000,stockAuthorization:scope},
  audioTracks:1,videoTracks:1,frame:{available:true}});
 let scope='owner-a';
 const host=createHostDouyinStock({stockAuthorizationScope:async()=>scope} as any);
 stored=[asset('shared',scope),asset('b',scope),asset('c',scope)];
 verifiedLists=0;verifiedLookups=0;
 const misses=Array.from({length:20},(_,i)=>'absent-'+i);
 for(const id of misses.slice(0,10))expect(await host.playbackReady(id)).toBeUndefined();
 expect(await Promise.all(misses.slice(10).map(id=>host.lookup(id)))).toEqual(Array(10).fill(undefined));
 expect(verifiedLists).toBe(1);
 expect((await host.ready('shared'))?.uri).toBe('file:///owner-a/shared.mp4');
 stored=stored.filter(value=>value.metadata.awemeId!=='shared');
 expect(await host.playbackReady('shared')).toBeUndefined();
 expect(verifiedLookups).toBe(2);

 scope='owner-b';
 stored.push(asset('shared',scope));
 expect(await host.lookup('shared')).toBe('file:///owner-b/shared.mp4');
 expect(await host.lookup('b')).toBeUndefined();
 expect(verifiedLists).toBe(2);

 host.suspend();
 stored.push(asset('new',scope));
 const readsBefore=verifiedLists;
 const requested=['new','missing-one','missing-two'].map(id=>host.lookup(id));
 expect(await Promise.all(requested)).toEqual(['file:///owner-b/new.mp4',undefined,undefined]);
 expect(verifiedLists-readsBefore).toBe(1);
});

test('a newly completed prepare is visible after a miss in the same stock generation',async()=>{
 online=true;stored=[];
 let release!:()=>void,started=false;
 prepareGate=()=>{prepareGate=undefined;started=true;return new Promise<void>(resolve=>release=resolve);};
 const client={stockAuthorizationScope:async()=>'owner',isLoggedIn:async()=>true,
  listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const host=createHostDouyinStock(client as any);
 host.offer!([{awemeId:'next',description:'fixture',authorName:'fixture',durationMs:1000,
  playUrl:'https://fixture.invalid/next',variants:[]}] as any);
 const work=host.resume();
 for(let i=0;!started&&i<100;i++)await Promise.resolve();
 expect(started).toBe(true);
 expect(await host.lookup('next')).toBeUndefined();
 release();await work;
 expect(await host.lookup('next')).toBe('file:///complete/next.mp4');
 host.suspend();
});


function manualGate(){
 let entered!:()=>void,release!:()=>void;
 const reached=new Promise<void>(resolve=>entered=resolve);
 const resume=new Promise<void>(resolve=>release=resolve);
 return {reached,release,wait(){entered();return resume;}};
}

for(const late of ['lookup','list'] as const)test('a late '+late+' cannot replace a newer rendition in the same authorization and epoch',async()=>{
 const scope='owner',oldKey='asset-a',freshUri='file:///complete/x.mp4';
 stored=[{key:oldKey,uri:'file:///old.mp4',metadata:{awemeId:'x',description:'old',authorName:'fixture',
  durationMs:1000,stockAuthorization:scope,width:240,height:420},frame:{available:true},
  audioTracks:1,videoTracks:1,watched:false,bytes:1000}];
 online=true;
 const client={stockAuthorizationScope:async()=>scope,isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({})};
 const host=createHostDouyinStock(client as any),preparing=manualGate(),reading=manualGate();
 prepareGate=()=>{prepareGate=undefined;return preparing.wait();};
 try{
  const playUrl='https://fixture.invalid/480';
  host.offer!([{awemeId:'x',description:'new',authorName:'fixture',playUrl,durationMs:1000,
   variants:[{playUrl,codec:'h264',width:480,height:854,bitrate:200000}]}] as any);
  const writing=host.resume();await preparing.reached;
  if(late==='lookup')lookupGate=key=>{if(key===oldKey){lookupGate=undefined;return reading.wait();}};
  else listGate=()=>{listGate=undefined;return reading.wait();};
  const older=late==='lookup'?host.lookup('x'):host.restore();
  await reading.reached;
  preparing.release();await writing;
  expect(await host.lookup('x')).toBe(freshUri);
  if(late==='list')stored.reverse();
  reading.release();
  const result=await older;
  expect(Array.isArray(result)?result.map(item=>item.playUrl):result).toEqual(late==='list'?[freshUri]:freshUri);
  expect(await host.lookup('x')).toBe(freshUri);
  stored=stored.filter(row=>row.key!==oldKey);
  expect(await host.lookup('x')).toBe(freshUri);
 }finally{
  lookupGate=undefined;listGate=undefined;prepareGate=undefined;reading.release();preparing.release();host.suspend();
 }
});

test('an old lookup and inventory cannot publish after the authorized owner changes',async()=>{
 const entry=(scope:string)=>({key:scope,uri:'file:///'+scope+'.mp4',metadata:{awemeId:'x',description:scope,authorName:'fixture',
  durationMs:1000,stockAuthorization:scope},frame:{available:true},audioTracks:1,videoTracks:1,watched:false,bytes:1000});
 let scope='old',changeAuth:(state:string)=>void=()=>{};
 const host=createHostDouyinStock({stockAuthorizationScope:async()=>scope,listWatchedIds:async()=>[],
  subscribeAuth:(listener:typeof changeAuth)=>{changeAuth=listener;}} as any);
 stored=[entry(scope)];
 expect(await host.lookup('x')).toBe('file:///old.mp4');
 const lookup=manualGate(),list=manualGate();
 lookupGate=key=>{if(key==='old'){lookupGate=undefined;return lookup.wait();}};
 listGate=()=>{listGate=undefined;return list.wait();};
 try{
  const oldLookup=host.lookup('x'),oldList=host.restore();
  await Promise.all([lookup.reached,list.reached]);
  scope='new';changeAuth('unknown');stored.push(entry(scope));
  expect(await host.lookup('x')).toBe('file:///new.mp4');
  lookup.release();list.release();
  expect(await oldLookup).toBeUndefined();
  expect(await oldList).toEqual([]);
  expect(await host.lookup('x')).toBe('file:///new.mp4');
 }finally{
  lookupGate=undefined;listGate=undefined;lookup.release();list.release();host.suspend();
 }
});
