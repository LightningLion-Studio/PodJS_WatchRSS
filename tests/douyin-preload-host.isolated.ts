import {test,expect,mock} from 'bun:test';
let resultListener:any;let producer:any,change:()=>void,windows:any[]=[],clears=0,oldClears=0,registrations:any[]=[],oldStatsFails=false,legacyBytes=484675145;
const realServices=await import('@podjs/framework/services');
const result=(value:any)=>({result:Promise.resolve(value),cancel(){}});
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{onResult:(fn:any)=>{resultListener=fn;return()=>{resultListener=undefined;};},register:(key:string,url:string,headers:any,persistent=false,alternates:string[]=[])=>{registrations.push({key,url,headers,persistent,alternates});return result({uri:'podjs-media-cache://play/'+key+'.mp4'});},window:(items:any,foregroundBitrate:number)=>{windows.push({items:[...items],foregroundBitrate});return result({});},stats:()=>result({files:2,bytes:2*1024*1024,maxBytes:16*1024*1024}),clear:()=>{clears++;return result({removedBytes:0});}}}));
mock.module('@podjs/framework/services',()=>({...realServices,video:{restoreFrame:async()=>null},discovery:{networkSnapshot:async()=>({active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:true})},onNetworkChange:(fn:()=>void)=>{change=fn;return ()=>{};}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{stats:async()=>{if(oldStatsFails)throw Error('fixture old-cache access');return {bucketBytes:{'douyin-preload':legacyBytes}};},clearBucket:async()=>{oldClears++;await producer.clear();},registerProducer:(_name:string,p:any)=>{producer=p;}}}));
const {createHostDouyinPreload}=await import('../src/douyin/preload-host.ts');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
const items=['a','b','c','d'].map(awemeId=>({awemeId,playUrl:'https://fixture/'+awemeId,durationMs:60000,variants:[]}));
const client={resolvePlayback:async(id:string)=>({ok:true,data:items.find(x=>x.awemeId===id)}),buildPlaybackHeaders:async()=>({Cookie:'fixture',Referer:'https://www.douyin.com/'})};
test('production factory cleans whole files once, preserves pre-READY consent, bounds proxy window and clears on logout',async()=>{
 const host=createHostDouyinPreload(client as any),a={},b={};host.allowBluetooth(true,a);host.start(a,items as any,'a','active');await flush();
 expect(oldClears).toBe(1);expect(registrations).toHaveLength(4);expect(registrations[0]).toMatchObject({headers:{Cookie:'fixture'}});expect(windows.at(-1).items.map((x:any)=>x.prefetchBytes)).toEqual([0,229376,229376,229376]);
 expect(await host.lookup('a')).toBeUndefined();expect(await host.playback(items[0] as any,{})).toBe('podjs-media-cache://play/a.mp4');expect(oldClears).toBe(1);
 const before=windows.length;for(let i=0;i<10;i++)change();await flush();expect(windows).toHaveLength(before);
 host.start(b,items as any,'a','active');await flush();expect(windows.at(-1).items).toEqual([]);host.allowBluetooth(true,b);await flush();expect(windows.at(-1).items).toHaveLength(4);
 host.stop(a);const stable=windows.length;host.allowBluetooth(true,b);change();await flush();expect(windows).toHaveLength(stable);
 await producer.clear();expect(clears).toBe(1);host.stop();
 const count=registrations.length;(client as any).resolvePlayback=async()=>({ok:false,code:'REQUEST_FAILED',message:'请求失败，状态码：403'});await expect(host.playback(items[0] as any,{})).rejects.toThrow('403');expect(registrations).toHaveLength(count);
});


test('route exit empties proxy window and late resolution cannot restart prefetch',async()=>{
 windows=[];registrations=[];let resolve!:(value:any)=>void;
 const slow={buildPlaybackHeaders:client.buildPlaybackHeaders,resolvePlayback:()=>new Promise(r=>resolve=r)};
 const host=createHostDouyinPreload(slow as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'a','active');await flush();
 expect(resolve).toBeDefined();host.stop(owner);const stopped=windows.length;expect(windows.at(-1).items).toEqual([]);
 resolve({ok:true,data:items[0]});await flush();change();await flush();
 expect(windows).toHaveLength(stopped);expect(registrations).toHaveLength(0);
});

test('production prefetch event consumer forces one refresh, isolates only neighbours and ignores retired bindings',async()=>{
 windows=[];registrations=[];const forces:string[]=[],removed:string[]=[],refreshed:string[]=[];
 const client={buildPlaybackHeaders:async()=>({Cookie:'fixture'}),resolvePlayback:async(id:string,options?:{forceRefresh?:boolean})=>{if(options?.forceRefresh)forces.push(id);return {ok:true,data:items.find(item=>item.awemeId===id)};}};
 const host=createHostDouyinPreload(client as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'a','active',{isForeground:id=>id==='a',sourceRefreshed:id=>{refreshed.push(id);},quarantine:async id=>{removed.push(id);return id!=='a';}});await flush();
 const old=windows.at(-1).items[1];resultListener({...old,result:'failure',httpStatus:403,category:'http_403'});await flush();expect(forces).toEqual(['b']);expect(refreshed).toEqual(['b']);
 const fresh=windows.at(-1).items[1];resultListener({...old,result:'failure',httpStatus:403,category:'http_403'});await flush();expect(removed).toEqual([]);
 resultListener({...fresh,result:'failure',httpStatus:403,category:'http_403'});await flush();expect(forces).toEqual(['b']);expect(removed).toEqual(['b']);expect(host.failures()[0]).toMatchObject({id:'b',count:2,reason:'http_403'});
 const current=windows.at(-1).items[0];for(let i=0;i<3;i++){resultListener({...current,result:'failure',httpStatus:0,category:'transport'});await flush();}expect(removed).toEqual(['b']);host.stop(owner);
});

test('backward entries fetch bounded prefixes without detail resolution',async()=>{
 windows=[];registrations=[];const resolved:string[]=[];
 const localClient={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(id:string)=>{resolved.push(id);return {ok:true,data:items.find(item=>item.awemeId===id)};}};
 const host=createHostDouyinPreload(localClient as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'c','active');await flush();
 expect(resolved).toEqual(['c','d']);expect(registrations.map(r=>r.key)).toEqual(['c','d','b','a']);expect(windows.at(-1).items.slice(2).map((v:any)=>v.prefetchBytes)).toEqual([229376,229376]);host.stop(owner);
});

test('DYERR foreground resolution preserves the code and cooldown without registering a failed source',async()=>{
 const failures={resolvePlayback:async()=>({ok:false,code:'TEMPORARILY_UNAVAILABLE',message:'抖音暂时不可用，请稍后重试',retryAfterMs:45000}),buildPlaybackHeaders:async()=>({})};
 const host=createHostDouyinPreload(failures as any),before=registrations.length;
 await expect(host.playback(items[0] as any,{})).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE',retryAfterMs:45000});
 expect(registrations).toHaveLength(before);
});

test('persistent stock enters the title window and playback without detail or prefix downloads',async()=>{
 windows=[];registrations=[];let resolutions=0;
 const client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>{resolutions++;throw Error('network forbidden before first frame');}};
 const stock={lookup:async(id:string)=>`podjs-media-cache://play/stock-${id}.mp4`};
 const host=createHostDouyinPreload(client as any,stock as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'a','entry');await flush();
 expect(resolutions).toBe(0);expect(registrations).toHaveLength(0);expect(windows.at(-1).items.every((i:any)=>i.prefetchBytes===0)).toBe(true);
 expect(await host.playback(items[0] as any,{})).toBe('podjs-media-cache://play/stock-a.mp4');expect(resolutions).toBe(0);host.stop(owner);
});

test('fresh feed opens production proxy and warms forward and backward sources without detail',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');const {utf8Encode}=await import('../src/cloud/types.ts');
 windows=[];registrations=[];const paths:string[]=[],store=new Map([['douyin.cookie','fixture']]);
 const real=new DouyinClient({secureStorage:{get:async k=>store.get(k)??null,set:async(k,v)=>{store.set(k,v);},remove:async k=>{store.delete(k);}},signer:{sign:()=> 'fixture'},transport:{request:async r=>{paths.push(new URL(r.url).pathname);return {status:200,headers:{},body:utf8Encode(JSON.stringify({aweme_list:['a','b','c','d'].map(id=>({aweme_id:id,video:{play_addr:{url_list:['https://fixture.invalid/'+id,'https://mirror.invalid/'+id]}}}))}))};}}});
 const page=await real.fetchFeedPage();if(!page.ok)throw Error('feed failed');
 const host=createHostDouyinPreload(real),owner={};host.allowBluetooth(true,owner);host.start(owner,page.data.items,'b','active');
 const end=Date.now()+2000;while(registrations.length<4&&Date.now()<end)await new Promise(r=>setTimeout(r,1));
 expect(await host.playback(page.data.items[1]!,{})).toBe('podjs-media-cache://play/b.mp4');
 expect(registrations.map(r=>r.key)).toContain('a');expect(registrations.map(r=>r.key)).toContain('c');
 expect(windows.at(-1).items.length).toBeGreaterThanOrEqual(3);expect(paths).toEqual(['/aweme/v2/web/module/feed/']);expect(registrations.find(r=>r.key==='b').alternates).toEqual(['https://mirror.invalid/b']);host.stop(owner);
});

test('legacy whole-file cleanup failure never blocks fresh feed playback or deletes persistent prefixes',async()=>{
 const host=createHostDouyinPreload({resolvePlayback:async()=>({ok:true,data:items[0]}),buildPlaybackHeaders:async()=>({})}as any);
 const beforeClears=clears;oldStatsFails=true;
 try{expect(await host.playback(items[0]as any,{})).toBe('podjs-media-cache://play/a.mp4');expect(clears).toBe(beforeClears);}finally{oldStatsFails=false;host.stop();}
});
test('an empty legacy bucket does not run its producer clear or touch persistent stock',async()=>{
 const host=createHostDouyinPreload({resolvePlayback:async()=>({ok:true,data:items[0]}),buildPlaybackHeaders:async()=>({})}as any);const before=oldClears;legacyBytes=0;
 try{expect(await host.playback(items[0]as any,{})).toBe('podjs-media-cache://play/a.mp4');expect(oldClears).toBe(before);}finally{legacyBytes=484675145;host.stop();}
});

test('consuming the visible stock item preserves cached current and previous window without detail',async()=>{
 const {DouyinStock}=await import('../src/douyin/stock.ts');
 windows=[];registrations=[];legacyBytes=0;const resolved:string[]=[];let headerReads=0;
 let disk:any=items.slice(0,3).map(item=>({item,expiresAt:Date.now()+60000,prefixBytes:1024,tailBytes:512}));
 const ports={read:()=>structuredClone(disk),write:(entries:any)=>{disk=structuredClone(entries);},now:Date.now,allowed:async()=>false,watched:async()=>[],feed:async()=>[],prepare:async()=>{throw Error('unexpected prepare');},lookup:async(entry:any)=>({uri:`podjs-media-cache://play/stock-${entry.item.awemeId}.mp4`,frame:{available:true as const,kind:'actual_frame' as const,path:'video-frames/fixture.jpg',width:16,height:16,positionMs:0,capturedAt:1,capturedGeneration:0}}),cancel(){}};
 const stock=new DouyinStock(ports),client={buildPlaybackHeaders:async()=>{headerReads++;return {};},resolvePlayback:async(id:string)=>{resolved.push(id);return {ok:false,code:'REQUEST_FAILED',message:'network forbidden'};}};
 const host=createHostDouyinPreload(client as any,stock),owner={};host.allowBluetooth(true,owner);
 try{
  expect((await stock.restore()).map(item=>item.awemeId)).toEqual(['a','b','c']);
  expect((await host.readySource(items[0] as any,{}))?.url).toBe('podjs-media-cache://play/stock-a.mp4');
  stock.consume('a');host.start(owner,items.slice(0,3) as any,'a','active');await flush();
  expect(resolved).toEqual([]);expect(windows.at(-1).items.map((value:any)=>value.uri)).toEqual(['a','b','c'].map(id=>`podjs-media-cache://play/stock-${id}.mp4`));
  expect(windows.at(-1).items.every((value:any)=>value.prefetchBytes===0)).toBe(true);
  stock.consume('b');host.start(owner,items.slice(0,3) as any,'b','active');await flush();
  expect(resolved).toEqual([]);expect(windows.at(-1).items.map((value:any)=>value.uri)).toContain('podjs-media-cache://play/stock-a.mp4');
  expect(registrations).toHaveLength(0);expect((await new DouyinStock(ports).restore()).map(item=>item.awemeId)).toEqual(['c']);
  for(let i=0;i<200;i++){const id=i%2?'a':'b';stock.consume(id);host.start(owner,items.slice(0,3)as any,id,'active');await flush();expect(await host.playback(items.find(v=>v.awemeId===id)as any,{})).toBe('podjs-media-cache://play/stock-'+id+'.mp4');}
  expect(resolved).toEqual([]);expect(headerReads).toBe(1);console.log('DYSWIPE3_STOCK_MODEL '+JSON.stringify({swipes:200,resolutions:0,detail:0,headerReads}));
 }finally{host.stop(owner);legacyBytes=484675145;}
});

 test('progressive publication retains a still-wanted in-flight neighbour while resolution waits',async()=>{
  windows=[];registrations=[];let slow=false,release!:(value:any)=>void;
  const local={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(id:string)=>slow&&id==='d'?await new Promise(r=>release=r):({ok:true,data:items.find(x=>x.awemeId===id)})};
  const host=createHostDouyinPreload(local as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'b','active');await flush();
  const oldD=windows.at(-1).items.find((x:any)=>x.uri.endsWith('/d.mp4'));expect(oldD).toBeDefined();
  slow=true;host.start(owner,items as any,'c','active');await flush();expect(release).toBeDefined();
  expect(windows.at(-1).items.some((x:any)=>x.uri===oldD.uri)).toBe(true);
  release({ok:true,data:items[3]});await flush();host.stop(owner);
 });

test('DYNEXT media registration metadata stays within the native cache window over 200 distinct sources',async()=>{
 const client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(_id:string,o:any)=>({ok:true,data:o.feedItem})};
 const host=createHostDouyinPreload(client as any);
 for(let i=0;i<200;i++){
  const item={...items[0],awemeId:String(i),playUrl:`https://fixture.invalid/${i}`,description:'fixture'.repeat(1000),variants:[]};
  await host.playback(item as any,{});
 }
 const retained=Array.from({length:200},(_,i)=>host.sourceFor(`podjs-media-cache://play/${i}.mp4`)).filter(Boolean);
 expect(retained).toHaveLength(16);
 expect(host.sourceFor('podjs-media-cache://play/199.mp4')?.awemeId).toBe('199');
 host.stop();expect(host.sourceFor('podjs-media-cache://play/199.mp4')).toBeUndefined();
});
