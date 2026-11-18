import {expect,test} from 'bun:test';
import {VideoReloadPolicy,VideoBufferedStallWait,videoSourceExpired} from '../src/ui/video-reload.ts';
import {freshVideoSource} from '../src/media/reload-source.ts';
import {createBiliPlaybackRetry} from '../src/playback.ts';
import {DouyinRssRecovery} from '../src/douyin/rss-recovery.ts';
test('reload budget applies exponential backoff, survives first frames and cancels stale replies',()=>{
 const p=new VideoReloadPolicy(),source={platform:'bili',title:'same',url:'old'};p.select(source);
 const a=p.begin(false)!;expect(a.waitMs).toBe(350);expect(p.begin(false)).toBeUndefined();p.finish(a);
 p.select({...source,url:'new'});p.observe(1,100,true);p.observe(1,101,true);
 const b=p.begin(false)!;expect(b.waitMs).toBe(700);p.finish(b);expect(p.begin(false)).toBeUndefined();
 const manual=p.begin(true)!;expect(manual.waitMs).toBe(0);p.cancel();expect(p.current(manual)).toBe(false);
 expect(p.begin(false)?.waitMs).toBe(350);
});
test('only sustained position progress or a new video resets the automatic budget',()=>{
 const p=new VideoReloadPolicy();p.select({title:'one'});
 for(let i=0;i<2;i++){const t=p.begin(false)!;p.finish(t);}
 p.observe(1,100,true);p.observe(2,20_000,true);expect(p.begin(false)).toBeUndefined();
 p.observe(2,30_000,true);const t=p.begin(false)!;expect(t.waitMs).toBe(350);p.finish(t);
 p.select({title:'two'});expect(p.begin(false)?.waitMs).toBe(350);
});
test('expiry uses known URL fields for video and audio, accepts explicit source expiry, ignores opaque tokens',()=>{
 const now=1_700_000_000_000;
 for(const field of ['deadline','expires','x-expires'])expect(videoSourceExpired({title:'x',url:`https://fixture/?${field}=1700000000`},now)).toBe(true);
 expect(videoSourceExpired({title:'x',url:'https://fixture/?token=opaque'},now)).toBe(false);
 expect(videoSourceExpired({title:'x',videoUrl:'v',audioUrl:'https://fixture/?expires=1700000000'},now)).toBe(true);
 expect(videoSourceExpired({title:'x',expiresAtMs:now},now)).toBe(true);
});
test('fresh resolution removes stale DASH and error metadata but keeps view metadata and position',()=>{
 const v=freshVideoSource({title:'video',url:'old',audioUrl:'old-audio',headers:{Cookie:'synthetic'},previewOnly:true,recoveryDeadlineMs:1,preparationError:{code:'timeout'}},{url:'new',headers:{}},12345);
 expect(v).toMatchObject({url:'new',title:'video',resumePositionMs:12345,bypassCache:true,previewOnly:false});expect(v.audioUrl).toBeUndefined();expect(v.recoveryDeadlineMs).toBeUndefined();expect(v.preparationError).toBeUndefined();
});
test('strict Bili retry resolves again, rejects resolver failure instead of preparing old address',async()=>{
 const initial={acceptQuality:[],acceptDescription:[],durl:[{url:'old',backupUrl:['old-backup']}]};let calls=0;
 const retry=createBiliPlaybackRetry(initial,async()=>{if(++calls===1)throw Error('offline');return {...initial,durl:[{url:'new',backupUrl:[]}]};},'video',{});
 await expect(retry({manual:true,freshOnly:true})).rejects.toThrow('offline');
 expect((await retry({manual:true,freshOnly:true})).url).toBe('new');expect(calls).toBe(2);
});
test('RSS Douyin reload force resolves each time and drops stale audio even with recovery flag off',async()=>{
 let calls=0;const r=new DouyinRssRecovery({resolvePlayback:async(_id,options)=>{expect(options?.forceRefresh).toBe(true);return {ok:true,data:{awemeId:'fixture',playUrl:`new-${++calls}`,variants:[]}} as any;},buildPlaybackHeaders:async()=>({})},'fixture');
 const a=await r.reload({title:'rss',url:'old',audioUrl:'old-audio'},()=>true);
 expect(a?.url).toBe('new-1');expect(a?.audioUrl).toBeUndefined();expect((await r.reload(a!,()=>true))?.url).toBe('new-2');
});
test('immersive reload uses feed only and rejects a stale completion',async()=>{
 const {reloadDouyinPlayback}=await import('../src/douyin/reload-playback.ts');let calls=0;
 const item={awemeId:'selected',playUrl:'old-url',variants:[]} as any;
 const client={resolvePlayback:async(id:string,options:any)=>{calls++;expect(id).toBe('selected');expect(options).toEqual({forceRefresh:true,allowDetail:false,freshRequest:true,feedItem:item});return {ok:true,data:{awemeId:id,playUrl:'new-url',variants:[]}} as any;},buildPlaybackHeaders:async()=>({})};
 expect((await reloadDouyinPlayback(client,'selected',()=>true,item))?.item.playUrl).toBe('new-url');
 expect(await reloadDouyinPlayback(client,'selected',()=>false,item)).toBeUndefined();expect(calls).toBe(2);
 const unavailable={...client,resolvePlayback:async()=>({ok:false,code:'TEMPORARILY_UNAVAILABLE',message:'not in refreshed feed'} as any)};
 await expect(reloadDouyinPlayback(unavailable,'selected',()=>true,item)).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
});
test('strict Bili reload does not join an abandoned resolution still pending at the retry boundary',async()=>{
 const initial={acceptQuality:[],acceptDescription:[],durl:[{url:'old',backupUrl:[]}]};const releases:Array<(v:any)=>void>=[];
 const retry=createBiliPlaybackRetry(initial,()=>new Promise(yes=>releases.push(yes)),'video',{});
 const a=retry({manual:true,freshOnly:true}),b=retry({manual:true,freshOnly:true});const count=releases.length;
 releases.forEach((yes,index)=>yes({...initial,durl:[{url:`fresh-${index}`,backupUrl:[]}]}));await Promise.all([a,b]);expect(count).toBe(2);
});
test('wake bounces before the resolver starts do not consume request budget',()=>{
 const p=new VideoReloadPolicy();p.select({title:'fixture'});
 for(let i=0;i<5;i++){const t=p.begin(false)!;expect(t.waitMs).toBe(350);p.cancel();}
 for(let i=0;i<2;i++){const t=p.begin(false)!;p.markRequest(t);p.cancel();}
 expect(p.begin(false)).toBeUndefined();
});

test('REVIEW RSS refresh drops the former explicit expiry and decoder metadata',async()=>{
 const r=new DouyinRssRecovery({resolvePlayback:async()=>({ok:true,data:{awemeId:'fixture',playUrl:'new',variants:[]}} as any),buildPlaybackHeaders:async()=>({})},'fixture');
 const result=await r.reload({title:'RSS',url:'old',expiresAtMs:1,videoMime:'video/hevc',videoWidth:1920,videoHeight:1080},()=>true);
 expect(result?.url).toBe('new');expect(result?.expiresAtMs).toBeUndefined();
 const fresh=freshVideoSource({title:'RSS',url:'old',videoMime:'video/hevc',videoWidth:1920,videoHeight:1080},result!,321);
 expect(fresh.videoMime).toBeUndefined();expect(fresh.videoWidth).toBeUndefined();expect(fresh.resumePositionMs).toBe(321);
});


test('buffered-stall guard respects loading, user pause, foreground and generation fences',async()=>{
 const guard=new VideoBufferedStallWait();const jobs:Array<{fire:()=>void;cancelled:boolean}>=[];let expired:any;
 const timer=(_ms:number)=>{let fire!:()=>void;const job={fire:()=>fire(),cancelled:false};jobs.push(job);return{result:new Promise<void>(yes=>{fire=yes;}),cancel(){job.cancelled=true;}};};
 const s={positionMs:1,bufferedMs:4156,nativePlaybackState:2,playWhenReady:true,loading:false,hasRenderedFirstFrame:true,sourceGeneration:2};
 for(const bad of [{...s,loading:true},{...s,playWhenReady:false},{...s,hasRenderedFirstFrame:false},{...s,bufferedMs:10},{...s,nativePlaybackState:3}])guard.observe(bad,1,true,timer,t=>{expired=t;});
 expect(jobs).toHaveLength(0);guard.observe(s,1,false,timer,t=>{expired=t;});expect(jobs).toHaveLength(0);
 guard.observe(s,1,true,timer,t=>{expired=t;});guard.observe({...s},1,true,timer,t=>{expired=t;});expect(jobs).toHaveLength(1);
 jobs[0].fire();await Promise.resolve();expect(guard.matches(expired,s,1,true)).toBe(true);expect(guard.matches(expired,{...s,positionMs:500},1,true)).toBe(false);expect(guard.matches(expired,s,2,true)).toBe(false);
 guard.cancel();expect(guard.current(expired)).toBe(false);
});
test('buffer progress restarts the bounded stall wait and cancels the former timer',async()=>{
 const guard=new VideoBufferedStallWait();const jobs:Array<{fire:()=>void;cancelled:boolean}>=[];let calls=0;
 const timer=(_ms:number)=>{let release!:()=>void;const job={fire:()=>release(),cancelled:false};jobs.push(job);return{result:new Promise<void>(yes=>{release=yes;}),cancel(){job.cancelled=true;}};};
 const s={positionMs:1,bufferedMs:2000,nativePlaybackState:2,playWhenReady:true,loading:false,hasRenderedFirstFrame:true,sourceGeneration:2};
 guard.observe(s,1,true,timer,()=>{calls++;});guard.observe({...s,bufferedMs:3000},1,true,timer,()=>{calls++;});expect(jobs[0].cancelled).toBe(true);jobs[0].fire();await Promise.resolve();expect(calls).toBe(0);jobs[1].fire();await Promise.resolve();expect(calls).toBe(1);guard.cancel();
});
