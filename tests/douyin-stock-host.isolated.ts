import {test,expect,mock} from 'bun:test';
let saved:unknown;let online=true,network=0,prepares=0,registered:any[]=[];
const value=(v:any)=>({result:Promise.resolve(v),cancel(){}});
mock.module('@podjs/framework/watch',()=>({kv:{get:(key:string)=>key==='watchrss.douyin.stock.v1'?saved:undefined,set:(key:string,v:unknown)=>{if(key==='watchrss.douyin.stock.v1')saved=structuredClone(v);}}}));
mock.module('@podjs/framework/services',()=>({video:{restoreFrame:async()=>({available:true,path:'video-frames/frame.jpg'})},discovery:{networkSnapshot:async()=>({active:online,internet:online,validated:online,wifi:true,metered:false})}}));
mock.module('../src/media/video-opt.ts',()=>({videoOptEnabled:()=>false,preserveSelectedDouyinItem:(v:any)=>v}));
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{register:(...args:any[])=>{registered.push(args);return value({uri:'podjs-media-cache://play/'+args[0]});},prepare:()=>{prepares++;return value({ready:true,prefixBytes:512*1024,tailBytes:512*1024});},inspect:()=>value({prefixBytes:512*1024,tailBytes:512*1024}),window:()=>value({}),stats:()=>value({maxBytes:6*1024*1024})}}));
const {createHostDouyinStock}=await import('../src/douyin/stock-host.ts');
test('real host adapter persists only metadata, restores stock without feed or media transfer',async()=>{
 const client={isLoggedIn:async()=>true,listWatchedIds:async()=>[],buildPlaybackHeaders:async()=>({Cookie:'private-cookie'}),fetchFeedPage:async()=>{network++;return {ok:true,data:{items:['a','b','c'].map(awemeId=>({awemeId,playUrl:`https://example.test/${awemeId}?x-expires=9999999999`,variants:[],durationMs:30000}))}};}};
 await createHostDouyinStock(client as any).resume();expect(prepares).toBe(3);expect(network).toBe(1);expect(registered.every(r=>r[3]===true)).toBe(true);
 expect(JSON.stringify(saved)).not.toContain('private-cookie');expect(JSON.stringify(saved)).not.toContain('podjs-media-cache:');
 online=false;const restart=createHostDouyinStock(client as any);expect((await restart.restore()).map(i=>i.awemeId)).toEqual(['a','b','c']);expect(await restart.lookup('a')).toStartWith('podjs-media-cache:');expect(prepares).toBe(3);expect(network).toBe(1);
});
