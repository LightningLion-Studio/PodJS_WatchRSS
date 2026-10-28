import {afterEach,expect,mock,test} from 'bun:test';
const realServices=await import('@podjs/framework/services');
const realWatch=await import('@podjs/framework/watch');
const values=new Map<string,unknown>();let supported=true,probes=0;
mock.module('@podjs/framework/watch',()=>({...realWatch,kv:{get:(key:string)=>values.get(key),set:(key:string,value:unknown)=>values.set(key,value)},hasCapability:()=>true}));
mock.module('@podjs/framework/services',()=>({...realServices,videoSessions:{capabilities:async()=>{probes++;return {decoderSizeSupported:supported};}},delay:()=>({result:new Promise(()=>{}),cancel(){}})}));
const {videoOptEnabled,observeVideoFeedback,clearVideoFeedback,decodableDouyinItem,invalidateVideoNetwork,VideoPlaybackTrace}=await import('../src/media/video-opt.ts');
const {AppLogger,installAppLogger}=await import('../src/logs/app-logger.ts');
const {videoResponseBudget,boundedVideoPageSize}=await import('../src/media/traffic-policy.ts');
const {BiliDetailPreload}=await import('../src/bili/detail-preload.ts');
const {createBiliPlaybackRetry,biliPlaybackCandidates}=await import('../src/playback.ts');
const {BiliClient}=await import('../src/bili/client.ts');
const {createMediaTransport}=await import('../src/media/transport.ts');
const item={awemeId:'synthetic',playUrl:'https://fixture/mid',variants:[{playUrl:'https://fixture/mid',codec:'h264',bitrate:900000,width:960,height:540},{playUrl:'https://fixture/low',codec:'h264',bitrate:200000,width:640,height:360},{playUrl:'https://fixture/hevc',codec:'h265',bitrate:100000,width:640,height:360}]} as any;
afterEach(()=>{values.clear();clearVideoFeedback();probes=0;supported=true;installAppLogger(undefined);});
const enable=(feature:string)=>{values.set('watchrss.video-opt.v1',{[feature]:true,percent:100});values.set('watchrss.video-opt.bucket',5000);};
test('all features fail closed and stable installation cohort controls rollout',()=>{
 expect(videoOptEnabled('recovery')).toBe(false);values.set('watchrss.video-opt.v1',{recovery:true,percent:50});values.set('watchrss.video-opt.bucket',5000);expect(videoOptEnabled('recovery')).toBe(false);
 values.set('watchrss.video-opt.bucket',4999);expect(videoOptEnabled('recovery')).toBe(true);expect(videoOptEnabled('adaptive')).toBe(false);
 values.set('watchrss.video-opt.v1',{recovery:true,percent:NaN});expect(videoOptEnabled('recovery')).toBe(false);
});
test('measured throughput selects AVC only after decoder support, network change clears feedback',async()=>{
 enable('adaptive');observeVideoFeedback({throughputBps:1000000,rebufferCount:1});expect((await decodableDouyinItem(item)).playUrl).toBe('https://fixture/low');expect(probes).toBeGreaterThan(0);
 supported=false;expect((await decodableDouyinItem(item)).playUrl).toBe(item.playUrl);
 supported=true;invalidateVideoNetwork();expect((await decodableDouyinItem(item)).playUrl).toBe(item.playUrl);
});
test('numeric telemetry allowlist rejects arbitrary labels, headers, IDs, NaN and signed URLs',async()=>{
 enable('metrics');let log='';const logger=new AppLogger({read:async()=>log,size:async()=>log.length,replace:async s=>{log=s;},append:async s=>{log+=s;}});installAppLogger(logger);
 const trace=new VideoPlaybackTrace('bili');trace.event('api',{apiMs:15,url:'https://secret/?sign=private',Cookie:'private',token:'private',width:NaN});trace.event('prepare');
 trace.sample({hasRenderedFirstFrame:false,metrics:{bytesLoaded:100,throughputBps:1000000}});trace.sample({hasRenderedFirstFrame:true,metrics:{firstFrameMs:200}});
 await logger.flush();expect(log).toContain('first_frame');expect(log).toContain('"apiMs":15');expect(log).not.toMatch(/private|secret|Cookie|token|NaN|https:/);
});
test('preloaded Bili URL expires early and network changes invalidate warm and in-flight entries',async()=>{
 enable('recovery');let now=1800000000000,calls=0,finish!:(v:any)=>void;
 const source={acceptQuality:[],acceptDescription:[],durl:[{url:'https://fixture/v?deadline=1800000040',backupUrl:[]}]};
 const preload=new BiliDetailPreload({resolvePlayback:async()=>{calls++;return source;}},{now:()=>now,schedule:()=>()=>{}}),target={cid:1};
 await preload.resolve(target);now+=9999;expect(preload.warm(target)).toBeDefined();now++;expect(preload.warm(target)).toBeUndefined();await preload.resolve(target);expect(calls).toBe(2);
 invalidateVideoNetwork();expect(preload.warm(target)).toBeUndefined();
 const slow=new BiliDetailPreload({resolvePlayback:()=>new Promise(r=>finish=r)},{now:()=>now,schedule:()=>()=>{}});const work=slow.resolve(target);invalidateVideoNetwork();expect(slow.warm(target)).toBeUndefined();finish(source);await expect(work).rejects.toThrow('network_changed');expect(slow.warm(target)).toBeUndefined();preload.dispose();slow.dispose();
});
test('Bili has a total budget, one refresh across route changes, and a fixed candidate ceiling',async()=>{
 let now=0,network=0,calls=0;const source={acceptQuality:[],acceptDescription:[],durl:[{url:'https://fixture/a',backupUrl:['https://fixture/b']}]};
 const retry=createBiliPlaybackRetry(source,async()=>{calls++;return {...source,durl:[{url:'https://fixture/fresh',backupUrl:[]}]};},'',{},undefined,undefined,{enabled:true,now:()=>now,networkEpoch:()=>network});
 expect((await retry()).url).toBe('https://fixture/b');network++;expect((await retry()).url).toBe('https://fixture/fresh');network++;
 await expect(retry()).rejects.toThrow();expect(calls).toBe(1);
 const timed=createBiliPlaybackRetry(source,async()=>source,'',{},undefined,undefined,{enabled:true,now:()=>now});await timed();now=30001;await expect(timed()).rejects.toThrow('deadline');
 await expect(timed({manual:true,error:{status:403}})).rejects.toThrow('not_retryable');
 expect(biliPlaybackCandidates({acceptQuality:[],acceptDescription:[],durl:[],dash:{video:[{baseUrl:'v',codecId:7,backupUrl:Array.from({length:100},(_,i)=>'v'+i)}],audio:[{baseUrl:'a',backupUrl:Array.from({length:100},(_,i)=>'a'+i)}]}},'',{})).toHaveLength(16);
 expect(biliPlaybackCandidates({acceptQuality:[],acceptDescription:[],durl:[],dash:{video:[{baseUrl:'hevc',codecId:12,backupUrl:[]}],audio:[]}},'',{})).toEqual([]);
});
test('list budgets reach the real download adapter and outgoing history page request',async()=>{
 enable('traffic');expect(videoResponseBudget('https://fixture/x/web-interface/history/cursor?token=private',true)).toBe(2*1024*1024);expect(videoResponseBudget('https://fixture/playurl',true)).toBe(8*1024*1024);
 expect(boundedVideoPageSize(1000,true)).toBe(12);expect(boundedVideoPageSize(20,false)).toBe(20);
 let downloaded:any;const transport=createMediaTransport({download:async args=>{downloaded=args;return {url:String(args.url),path:String(args.path),size:0,status:200,headers:{}};},read:async()=>new Uint8Array(),remove:async()=>{},base64:()=>''});
 await transport.request({method:'GET',url:'https://fixture/x/web-interface/history/cursor',headers:{}});expect(downloaded.maxBytes).toBe(2*1024*1024);
 let requested='';const client=new BiliClient({transport:{request:async request=>{requested=request.url;return {status:200,headers:{},body:new TextEncoder().encode('{"code":0,"data":{"cursor":{"ps":1000},"list":[]}}')};}}});
 await client.history({pageSize:1000});expect(new URL(requested).searchParams.get('ps')).toBe('12');
});
