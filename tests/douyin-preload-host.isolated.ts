import {test,expect,mock} from 'bun:test';
let producer:any,change:()=>void,windows:any[]=[],clears=0,oldClears=0,registrations:any[]=[];
const result=(value:any)=>({result:Promise.resolve(value),cancel(){}});
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{register:(key:string,url:string,headers:any)=>{registrations.push({key,url,headers});return result({uri:'podjs-media-cache://play/'+key+'.mp4'});},window:(items:any,foregroundBitrate:number)=>{windows.push({items:[...items],foregroundBitrate});return result({});},stats:()=>result({files:2,bytes:2*1024*1024,maxBytes:16*1024*1024}),clear:()=>{clears++;return result({removedBytes:0});}}}));
mock.module('@podjs/framework/services',()=>({discovery:{networkSnapshot:async()=>({active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:true})},onNetworkChange:(fn:()=>void)=>{change=fn;return ()=>{};}}));
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
