import {test,expect,mock} from 'bun:test';
let resultListener:any;let producer:any,change:()=>void,windows:any[]=[],clears=0,oldClears=0,registrations:any[]=[],removed:string[]=[],registrationFailure:any,oldStatsFails=false,legacyBytes=484675145;
const realServices=await import('@podjs/framework/services');
const result=(value:any)=>({result:Promise.resolve(value),cancel(){}});
mock.module('@podjs/framework/media-prefix-cache',()=>({localMediaStore:{stopTraffic:()=>result({})},mediaPrefixCache:{remove:(uri:string)=>{removed.push(uri);return result({});},onResult:(fn:any)=>{resultListener=fn;return()=>{resultListener=undefined;};},register:(key:string,url:string,headers:any,persistent=false,alternates:string[]=[],expiresAt?:number,audioUrl?:string,_maxVideoShortEdge?:number,replacesUri?:string)=>{if(registrationFailure)throw registrationFailure;registrations.push({key,url,headers,persistent,alternates,expiresAt,maxVideoShortEdge:_maxVideoShortEdge,replacesUri,...(audioUrl?{audioUrl}: {})});const uri='podjs-media-cache://play/'+(key==='review'?key+'-'+new URL(url).pathname.split('/').at(-1):key)+'.mp4';if(replacesUri&&replacesUri!==uri)removed.push(replacesUri);return result({uri});},window:(items:any,foregroundBitrate:number)=>{windows.push({items:[...items],foregroundBitrate});return result({});},stats:()=>result({files:2,bytes:2*1024*1024,maxBytes:16*1024*1024}),clear:()=>{clears++;return result({removedBytes:0});}}}));
mock.module('@podjs/framework/services',()=>({...realServices,video:{restoreFrame:async()=>null},discovery:{networkSnapshot:async()=>({active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:true})},onNetworkChange:(fn:()=>void)=>{change=fn;return ()=>{};}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{stats:async()=>{if(oldStatsFails)throw Error('fixture old-cache access');return {bucketBytes:{'douyin-preload':legacyBytes}};},clearBucket:async()=>{oldClears++;await producer.clear();},registerProducer:(_name:string,p:any)=>{producer=p;}}}));
const {createHostDouyinPreload}=await import('../src/douyin/preload-host.ts');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
const items=['a','b','c','d'].map(awemeId=>({awemeId,description:'fixture',createdAtSeconds:0,authorId:'fixture',authorName:'fixture',likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:'https://fixture/'+awemeId,durationMs:60000,variants:[]}));
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

test('403 cools prefetch without poisoning explicit playback or retrying',async()=>{
 windows=[];registrations=[];let forced=0,stops=0;
 const client={stopMediaTraffic:()=>{stops++;},buildPlaybackHeaders:async()=>({}),resolvePlayback:async(id:string,options?:{forceRefresh?:boolean})=>{if(options?.forceRefresh)forced++;return {ok:true,data:items.find(i=>i.awemeId===id)};}};
 const host=createHostDouyinPreload(client as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'a','active');await flush();
 const old=windows.at(-1).items[1];resultListener({...old,result:'failure',httpStatus:403,category:'http_403'});await flush();expect(forced).toBe(0);expect(stops).toBe(0);expect(windows.at(-1).items).toEqual([]);
 const before=registrations.length;host.start(owner,items as any,'a','active');await flush();expect(registrations.length).toBe(before);expect(await host.playback(items[0] as any,{})).toContain('podjs-media-cache:');host.stop(owner);
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


test('DYFAST reuses registration only for the same rendition and authorization',async()=>{
 let authorization=1,item={...items[0]};
 const local={playbackAuthorizationVersion:()=>authorization,resolvePlayback:async()=>({ok:true,data:item}),buildPlaybackHeaders:async()=>({})};
 const host=createHostDouyinPreload(local as any),before=registrations.length;
 await host.playback(item as any,{Cookie:'fixture-one'});
 await host.playback(item as any,{Cookie:'fixture-one'});
 expect(registrations.length-before).toBe(1);
 await host.playback(item as any,{Cookie:'fixture-two'});expect(registrations.length-before).toBe(2);
 authorization++;await host.playback(item as any,{Cookie:'fixture-two'});expect(registrations.length-before).toBe(3);
 item={...item,playUrl:'https://fixture/changed'};await host.playback(item as any,{Cookie:'fixture-two'});expect(registrations.length-before).toBe(4);
 host.stop();await host.playback(item as any,{Cookie:'fixture-two'});expect(registrations.length-before).toBe(5);
 host.stop();
});

test('DYMEM3 returning decoded neighbours enter the window before a slow stock lookup',async()=>{
 windows=[];registrations=[];legacyBytes=0;let blocked=false,release!:()=>void;
 const many=Array.from({length:15},(_,i)=>({...items[0],awemeId:String(i),playUrl:`https://fixture.invalid/${i}`,description:'fixture'.repeat(30000)}));
 const local={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(_id:string,o:any)=>({ok:true,data:o.feedItem})};
 const stock={lookup:async()=>{if(blocked)await new Promise<void>(r=>release=r);return undefined;}};
 const host=createHostDouyinPreload(local as any,stock as any),owner={};host.allowBluetooth(true,owner);
 try{
  host.start(owner,many as any,'4','active');await flush();
  host.start(owner,many as any,'8','active');await flush();
  expect(windows.at(-1).items.some((x:any)=>x.uri.endsWith('/3.mp4'))).toBe(false);
  blocked=true;host.start(owner,many as any,'6','active');await flush();expect(release).toBeDefined();
  expect(windows.at(-1).items.slice(0,5).map((x:any)=>x.uri)).toEqual([6,7,5,4,3].map(id=>`podjs-media-cache://play/${id}.mp4`));
  // Cancel the waiting generation before releasing it: no late window may return.
  host.stop(owner);const count=windows.length;blocked=false;release();await flush();expect(windows.length).toBe(count);
 }finally{host.stop(owner);legacyBytes=484675145;}
});

test('DYMEM3 early window reuse rejects changed authorization, headers, rendition and expiry',async()=>{
 const now=Date.now;
 for(const reason of ['authorization','headers','rendition','expiry']){
  windows=[];registrations=[];legacyBytes=0;let blocked=false,release!:()=>void,authorization=1;const headers={Cookie:'one'};
  const many=Array.from({length:15},(_,i)=>({...items[0],awemeId:String(i),playUrl:`https://fixture.invalid/${i}?x-expires=${Math.floor(now()/1000)+600}`}));
  const local={playbackAuthorizationVersion:()=>authorization,buildPlaybackHeaders:async()=>headers,resolvePlayback:async(_id:string,o:any)=>({ok:true,data:o.feedItem})};
  const stock={lookup:async()=>{if(blocked)await new Promise<void>(r=>release=r);return undefined;}};
  const host=createHostDouyinPreload(local as any,stock as any),owner={};host.allowBluetooth(true,owner);
  try{
   host.start(owner,many as any,'4','active');await flush();host.start(owner,many as any,'8','active');await flush();
   if(reason==='authorization')authorization++;
   if(reason==='headers')headers.Cookie='two';
   if(reason==='rendition')many[3]={...many[3]!,playUrl:'https://fixture.invalid/changed'};
   if(reason==='expiry')Date.now=()=>now()+700000;
   blocked=true;host.start(owner,many as any,'6','active');await flush();expect(release).toBeDefined();
   expect(windows.at(-1).items.some((x:any)=>x.uri.endsWith('/3.mp4'))).toBe(false);
   host.stop(owner);blocked=false;release();await flush();
  }finally{Date.now=now;host.stop(owner);legacyBytes=484675145;}
 }
});

test('DYMEM3 a failed resolution removes its early seeded window target',async()=>{
 windows=[];registrations=[];legacyBytes=0;let fail=false;
 const local={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(id:string)=>fail&&id==='c'?{ok:false,code:'REQUEST_FAILED'}:{ok:true,data:items.find(item=>item.awemeId===id)}};
 const host=createHostDouyinPreload(local as any),owner={};host.allowBluetooth(true,owner);
 try{
  host.start(owner,items as any,'b','active');await flush();fail=true;
  host.start(owner,items as any,'b','active');await flush();
  expect(windows.at(-1).items.some((x:any)=>x.uri.endsWith('/c.mp4'))).toBe(false);
 }finally{host.stop(owner);legacyBytes=484675145;}
});

test('DASH registration carries its companion into the native pixel identity',async()=>{
 const before=registrations.length;const item={...items[0],awemeId:'dash-binding',playUrl:'https://fixture.invalid/dash',variants:[{playUrl:'https://fixture.invalid/dash',format:'dash',audioUrl:'https://fixture.invalid/audio',codec:'h264',width:480,height:480,bitrate:100}]} as any;
 const client={resolvePlayback:async()=>({ok:true,data:item}),playbackAuthorizationVersion:()=>0} as any;
 const host=createHostDouyinPreload(client);await host.playback(item,{});expect(registrations[before]?.audioUrl).toBe('https://fixture.invalid/audio');
 item.variants[0].audioUrl='https://fixture.invalid/changed-audio';await host.playback(item,{});expect(registrations).toHaveLength(before+2);expect(registrations[before+1].audioUrl).toBe('https://fixture.invalid/changed-audio');
});

test('native resolution rejection immediately quarantines the exact unknown prefetch',async()=>{
 windows=[];registrations=[];const quarantined:string[]=[];
 const mockClient={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(id:string)=>({ok:true,data:items.find(item=>item.awemeId===id)})};
 const host=createHostDouyinPreload(mockClient as any),owner={};host.allowBluetooth(true,owner);
 host.start(owner,items as any,'a','active',{isForeground:id=>id==='a',sourceRefreshed(){},rejectSource(binding){quarantined.push(binding.id);return false;},quarantine(){return false;}});
 await flush();const rejected=windows.at(-1).items.find((x:any)=>x.uri.endsWith('/b.mp4'));
 resultListener({...rejected,result:'failure',httpStatus:0,category:'resolution_limit'});
 await flush();
 expect(quarantined).toEqual(['b']);
 expect(windows.at(-1).items.some((x:any)=>x.uri===rejected.uri)).toBe(false);
 expect(host.sourceFor(rejected.uri)).toBeUndefined();
 host.stop(owner);
});

test('RVRESCAP2-04 replacing an unknown source revokes its bytes before metadata arrives',async()=>{
  windows=[];registrations=[];removed=[];
  const client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(_id:string,options:any)=>({ok:true,data:options.feedItem})};
  const host=createHostDouyinPreload(client as any),owner={};
  const old={awemeId:'review',playUrl:'https://review.invalid/1080',durationMs:1000,variants:[]};
  const high={playUrl:old.playUrl,width:1080,height:1920,bitrate:100,codec:'h264'};
  const safe={playUrl:'https://review.invalid/480',width:480,height:854,bitrate:100,codec:'h264'};
  host.allowBluetooth(true,owner);
  host.start(owner,[items[0],old] as any,'a','active');
  await flush();
  const previous=windows.at(-1).items.find((v:any)=>v.uri.endsWith('/review-1080.mp4')).uri;
  host.start(owner,[items[0],{...old,playUrl:safe.playUrl,variants:[safe]}] as any,'a','active');
  await flush();
  expect(windows.at(-1).items.some((v:any)=>v.uri.endsWith('/review-480.mp4'))).toBe(true);
  expect(removed).toContain(previous);
  host.start(owner,[items[0],{...old,playUrl:safe.playUrl,variants:[high,safe]}] as any,'a','active');
  await flush();
  expect(host.sourceFor(previous)).toBeUndefined();
  expect(removed).toContain(previous);
  host.stop(owner);
});

test('generated late completions cannot register a superseded source',async()=>{
 let seed=0x04f9a11;
 const random=(max:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed>>>8)%max;};
 for(let n=0;n<18;n++){
  windows=[];removed=[];registrations=[];
  const oldUrl='https://review.invalid/old-'+n,safeUrl='https://review.invalid/safe-'+n;
  const old={...items[1],awemeId:'review',playUrl:oldUrl,variants:[]};
  const edge=[360,480,540,720][random(4)]!;
  const safe={playUrl:safeUrl,codec:'h264',width:edge,height:edge*2,bitrate:100};
  const high={playUrl:oldUrl.replace('review.invalid','REVIEW.invalid:443'),codec:'h264',width:1080,height:1920,bitrate:100};
  const updated={...old,playUrl:safeUrl,variants:random(2)?[safe]:[safe,high]};
  let release:(()=>void)|undefined;
  const fixture={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(_id:string,{feedItem,prefetch}:any)=>{
    if(!prefetch)await new Promise<void>(resolve=>{release=resolve;});
    return {ok:true,data:feedItem};
  }};
  const host=createHostDouyinPreload(fixture as any),owner={};
  host.allowBluetooth(true,owner);host.start(owner,[items[0],old] as any,'a','active');await flush();
  const prior=windows.at(-1).items.find((v:any)=>v.uri.endsWith('/review-old-'+n+'.mp4')).uri;
  const pending=host.playback(old as any,{}).then(()=>'ok',error=>error.code);
  await flush();expect(release).toBeDefined();
  const before=random(2)===0;
  if(before)release!();
  host.start(owner,[items[0],updated] as any,'a','active');
  await flush();
  if(!before)release!();
  expect(await pending).toBe('CANCELLED');
  if(updated.variants.length===1)host.start(owner,[items[0],{...updated,variants:[safe,high]}] as any,'a','active');
  await flush();
  expect(removed).toContain(prior);
  expect(host.sourceFor(prior)).toBeUndefined();
  const next=windows.at(-1).items.find((v:any)=>v.uri.endsWith('/review-safe-'+n+'.mp4'));
  expect(host.sourceFor(next.uri)?.playUrl).toBe(safeUrl);
  host.stop(owner);
 }

});

test('NOPLAY a five-minute metadata TTL never becomes a native stream deadline',async()=>{
 registrations=[];const item={...items[0],durationMs:45*60*1000,playUrl:'https://fixture/long-opaque?signature=opaque'};
 const local={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>({ok:true,data:item})};
 const host=createHostDouyinPreload(local as any);
 await host.playback(item as any,{});expect(registrations.at(-1).expiresAt).toBeUndefined();expect(registrations.at(-1).maxVideoShortEdge).toBe(720);host.stop();
});
test('NOPLAY explicit CDN expiry still bounds native requests with the existing margin',async()=>{
 registrations=[];const unix=Math.floor(Date.now()/1000)+86400,item={...items[0],playUrl:'https://fixture/long?x-expires='+unix};
 const local={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>({ok:true,data:item})};
 const host=createHostDouyinPreload(local as any);
 await host.playback(item as any,{});expect(registrations.at(-1).expiresAt).toBe(unix*1000-30000);expect(registrations.at(-1).maxVideoShortEdge).toBe(720);host.stop();
});


test('NOPLAY local cache registration failure preserves the same authorized HTTP source',async()=>{
 const item={...items[0],playUrl:'https://fixture/valid-source'},client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>({ok:true,data:item})};
 for(const code of ['cache_error','media_cache_error','resource_exhausted','invalid_argument']){
  const host=createHostDouyinPreload(client as any);registrationFailure={code};
  try{expect(await host.playback(item as any,{})).toBe(item.playUrl);expect(host.sourceFor(item.playUrl)).toBe(item);}finally{registrationFailure=undefined;host.stop();}
 }
});
test('NOPLAY cache lookup and preview failures cannot block ordinary foreground resolution',async()=>{
 const item=items[0]!,client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>({ok:true,data:item})};
 const host=createHostDouyinPreload(client as any,{playbackReady:async()=>{throw {code:'cache_error'};},lookup:async()=>{throw {code:'cache_error'};}} as any);
 expect(await host.readySource(item as any)).toBeUndefined();expect(await host.previewFrame(item as any)).toBeUndefined();expect(await host.lookup(item.awemeId)).toBeUndefined();
 expect(await host.playback(item as any,{})).toStartWith('podjs-media-cache:');host.stop();
});
test('NOPLAY cache fallback never replays a denied, expired or cancelled source',async()=>{
 const item=items[0]!,client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>({ok:true,data:item})};
 for(const code of ['permission_denied','restricted','source_expired','network_error','cancelled','media_traffic_stopped','resolution_limit']){
  const host=createHostDouyinPreload(client as any);registrationFailure={code};
  try{await expect(host.playback(item as any,{})).rejects.toMatchObject({code});}finally{registrationFailure=undefined;host.stop();}
 }
});


test('NOPLAY direct fallback retains explicit URL deadlines and audio source validation',async()=>{
 const video='https://fixture/video';
 for(const item of [{...items[0],playUrl:video+'?x-expires=1000000000'},
  {...items[0],playUrl:video,variants:[{playUrl:video,format:'dash',codec:'h264',width:960,height:540,bitrate:1000,audioUrl:'https://user:password@fixture/audio'}]},
  {...items[0],playUrl:video,variants:[{playUrl:video,format:'dash',codec:'h264',width:960,height:540,bitrate:1000,audioUrl:'file:///private'}]}]){
  const client={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>({ok:true,data:item})},host=createHostDouyinPreload(client as any);registrationFailure={code:'cache_error'};
  try{await expect(host.playback(item as any,{})).rejects.toMatchObject({code:'cache_error'});}finally{registrationFailure=undefined;host.stop();}
 }
});

test('NOPLAY a late optional cache failure cannot publish a replaced foreground source',async()=>{
 let rejectLookup!:(error:unknown)=>void,requests=0;
 const local={buildPlaybackHeaders:async()=>({}),resolvePlayback:async()=>{requests++;return {ok:true,data:items[0]};}};
 const stock={lookup:()=>new Promise<string|undefined>((_resolve,reject)=>{rejectLookup=reject;})};
 const host=createHostDouyinPreload(local as any,stock as any),owner={};
 host.start(owner,items as any,'a','entry');await flush();
 const pending=host.playback(items[0] as any,{});await flush();
 host.start(owner,[{...items[0],playUrl:'https://fixture/replacement'}] as any,'a','entry');
 rejectLookup({code:'cache_error'});
 await expect(pending).rejects.toMatchObject({code:'CANCELLED'});
 expect(requests).toBe(0);expect(host.sourceFor(items[0].playUrl)).toBeUndefined();host.stop();
});
