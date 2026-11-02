import {test,expect,mock} from 'bun:test';
let resultListener:any;let producer:any,change:()=>void,windows:any[]=[],clears=0,oldClears=0,registrations:any[]=[];
const result=(value:any)=>({result:Promise.resolve(value),cancel(){}});
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{onResult:(fn:any)=>{resultListener=fn;return()=>{resultListener=undefined;};},register:(key:string,url:string,headers:any)=>{registrations.push({key,url,headers});return result({uri:'podjs-media-cache://play/'+key+'.mp4'});},window:(items:any,foregroundBitrate:number)=>{windows.push({items:[...items],foregroundBitrate});return result({});},stats:()=>result({files:2,bytes:2*1024*1024,maxBytes:16*1024*1024}),clear:()=>{clears++;return result({removedBytes:0});}}}));
mock.module('@podjs/framework/services',()=>({video:{restoreFrame:async()=>null},discovery:{networkSnapshot:async()=>({active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:true})},onNetworkChange:(fn:()=>void)=>{change=fn;return ()=>{};}}));
mock.module('../src/cache/host.ts',()=>({managedCache:{stats:async()=>({bucketBytes:{'douyin-preload':484675145}}),clearBucket:async()=>{oldClears++;await producer.clear();},registerProducer:(_name:string,p:any)=>{producer=p;}}}));
const {createHostDouyinPreload}=await import('../src/douyin/preload-host.ts');
const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};
const items=['a','b','c','d'].map(awemeId=>({awemeId,playUrl:'https://fixture/'+awemeId,durationMs:60000,variants:[]}));
const client={resolvePlayback:async(id:string)=>({ok:true,data:items.find(x=>x.awemeId===id)}),buildPlaybackHeaders:async()=>({Cookie:'fixture',Referer:'https://www.douyin.com/'})};
test('production factory cleans whole files once, preserves pre-READY consent, bounds proxy window and clears on logout',async()=>{
 const host=createHostDouyinPreload(client as any),a={},b={};host.allowBluetooth(true,a);host.start(a,items as any,'a','active');await flush();
 expect(oldClears).toBe(1);expect(registrations).toHaveLength(3);expect(registrations[0]).toMatchObject({headers:{Cookie:'fixture'}});expect(windows.at(-1).items.map((x:any)=>x.prefetchBytes)).toEqual([2097152,1572864,1048576]);
 expect(await host.lookup('a')).toBeUndefined();expect(await host.playback(items[0] as any,{})).toBe('podjs-media-cache://play/a.mp4');expect(oldClears).toBe(1);
 const before=windows.length;for(let i=0;i<10;i++)change();await flush();expect(windows).toHaveLength(before);
 host.start(b,items as any,'a','active');await flush();expect(windows.at(-1).items).toEqual([]);host.allowBluetooth(true,b);await flush();expect(windows.at(-1).items).toHaveLength(3);
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

test('DYFIX backward proxy entries register without detail resolution or prefetch bytes',async()=>{
 windows=[];registrations=[];const resolved:string[]=[];
 const localClient={buildPlaybackHeaders:async()=>({}),resolvePlayback:async(id:string)=>{resolved.push(id);return {ok:true,data:items.find(item=>item.awemeId===id)};}};
 const host=createHostDouyinPreload(localClient as any),owner={};host.allowBluetooth(true,owner);host.start(owner,items as any,'c','active');await flush();
 expect(resolved).toEqual(['c','d']);expect(registrations.map(r=>r.key)).toEqual(['c','d','b','a']);expect(windows.at(-1).items.slice(2).map((v:any)=>v.prefetchBytes)).toEqual([0,0]);host.stop(owner);
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
