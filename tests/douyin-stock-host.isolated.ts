import {test,expect,mock} from 'bun:test';
let saved:unknown;let online=true,network=0,prepares=0,registered:any[]=[],frameReads=0,headerReads=0,version=0,missingRegistration=false,missingBytes=false,changeDuringFrame=false;
const value=(v:any)=>({result:Promise.resolve(v),cancel(){}});
mock.module('@podjs/framework/watch',()=>({kv:{get:(key:string)=>key==='watchrss.douyin.stock.v1'?saved:undefined,set:(key:string,v:unknown)=>{if(key==='watchrss.douyin.stock.v1')saved=structuredClone(v);}}}));
mock.module('@podjs/framework/services',()=>({video:{restoreFrame:async()=>{frameReads++;if(changeDuringFrame){changeDuringFrame=false;version++;}return ({available:true,path:'video-frames/frame.jpg'});}},discovery:{networkSnapshot:async()=>({active:online,internet:online,validated:online,wifi:true,metered:false})}}));
mock.module('../src/media/video-opt.ts',()=>({videoOptEnabled:()=>false,preserveSelectedDouyinItem:(v:any)=>v}));
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{register:(...args:any[])=>{registered.push(args);return value({uri:'podjs-media-cache://play/'+args[0]});},prepare:()=>{prepares++;return value({ready:true,prefixBytes:512*1024,tailBytes:512*1024});},inspect:()=>{if(missingRegistration){missingRegistration=false;throw Error('media_cache_registration_missing');}return value({prefixBytes:missingBytes?0:512*1024,tailBytes:512*1024});},window:()=>value({}),stats:()=>value({maxBytes:6*1024*1024})}}));
const {createHostDouyinStock}=await import('../src/douyin/stock-host.ts');
test('real host adapter persists only metadata, restores stock without feed or media transfer',async()=>{
 const client={playbackAuthorizationVersion:()=>version,isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>{headerReads++;return {Cookie:'private-cookie'};},fetchFeedPage:async()=>{network++;return {ok:true,data:{items:['a','b','c'].map(awemeId=>({awemeId,playUrl:`https://example.test/${awemeId}?x-expires=9999999999`,variants:[],durationMs:30000}))}};}};
 await createHostDouyinStock(client as any).resume();expect(prepares).toBe(3);expect(network).toBe(1);expect(registered.every(r=>r[3]===true)).toBe(true);
 expect(JSON.stringify(saved)).not.toContain('private-cookie');expect(JSON.stringify(saved)).not.toContain('podjs-media-cache:');
 online=false;const restart=createHostDouyinStock(client as any);expect((await restart.restore()).map(i=>i.awemeId)).toEqual(['a','b','c']);expect(await restart.lookup('a')).toStartWith('podjs-media-cache:');expect(prepares).toBe(3);expect(network).toBe(1);
 const before={headerReads,frameReads,registered:registered.length};const ready=await restart.ready('a',{Cookie:'current-cookie'});
 expect(ready?.uri).toStartWith('podjs-media-cache:');expect(ready?.frame?.path).toBe('video-frames/frame.jpg');
 expect(headerReads).toBe(before.headerReads);expect(frameReads-before.frameReads).toBe(1);expect(registered.length-before.registered).toBe(1);
 expect(JSON.stringify(saved)).not.toContain('current-cookie');expect(JSON.stringify(saved)).not.toContain('video-frames');
 const current={headerReads,registered:registered.length};await restart.ready('a');expect(headerReads).toBe(current.headerReads);expect(registered.length).toBe(current.registered);
 version++;await restart.ready('a');expect(headerReads).toBe(current.headerReads+1);expect(registered.length).toBe(current.registered+1);
 missingRegistration=true;await restart.ready('a');expect(headerReads).toBe(current.headerReads+2);expect(registered.length).toBe(current.registered+2);
 missingBytes=true;const reads=frameReads;expect(await restart.ready('a')).toBeUndefined();expect(frameReads).toBe(reads);missingBytes=false;
 changeDuringFrame=true;expect(await restart.ready('a')).toBeUndefined();

});
