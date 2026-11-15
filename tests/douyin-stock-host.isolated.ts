import {test,expect,mock} from 'bun:test';
let online=true,feed=0,prepares=0,registered:any[]=[],stored:any[]=[],config:any,prepareGate:(()=>Promise<void>)|undefined;
const value=(v:any)=>({result:Promise.resolve(v),cancel(){}});
mock.module('@podjs/framework/watch',()=>({kv:{get:()=>undefined,set(){}}}));
mock.module('@podjs/framework/services',()=>({delay:()=>({result:new Promise(()=>{}),cancel(){}}),discovery:{networkSnapshot:async()=>({active:online,internet:online,validated:online,wifi:true,metered:false})}}));
mock.module('../src/media/video-opt.ts',()=>({videoOptEnabled:()=>false,preserveSelectedDouyinItem:(v:any)=>v,decodableDouyinItem:async(v:any)=>v,VideoPlaybackTrace:class{event(){}},registerVideoResolution(){}}));
mock.module('@podjs/framework/media-prefix-cache',()=>({mediaPrefixCache:{register:(...args:any[])=>{registered.push(args);return value({uri:'podjs-media-cache://play/'+args[0]});}},localMediaStore:{configure:(c:any)=>{config=c;return value(undefined);},list:()=>value({items:stored}),lookup:(key:string)=>value({item:stored.find(v=>v.key===key)}),prepare:(key:string,_uri:string,metadata:any)=>{prepares++;const item={key,metadata,audioTracks:1,videoTracks:1,uri:'file:///complete/'+metadata.awemeId+'.mp4',watched:false,bytes:1000,frame:{available:true,path:'frame.jpg'}};const gate=prepareGate?.();return {result:Promise.resolve(gate).then(()=>{stored.push(item);return {ready:true,item};}),cancel(){}};},watched:(key:string)=>{stored.find(v=>v.key===key).watched=true;return value(undefined);},cancel:()=>value(undefined),clear:()=>value(undefined)}}));
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
