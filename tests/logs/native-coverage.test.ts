import {afterEach,beforeEach,expect,test} from 'bun:test';
import {AppLogger,installAppLogger,createLogConsole,redactSensitiveLogContent} from '../../src/logs/app-logger.ts';
import {ActivityLog} from '../../src/logs/activity.ts';
import {DouyinLoginLog} from '../../src/logs/douyin-login.ts';
import {loggedSyncSilence} from '../../src/logs/sync-media.ts';
import {SyncEventLog} from '../../src/logs/sync-events.ts';
import {createBiliClient} from '../../src/bili/client.ts';
import {SummarySession} from '../../src/llm/summary.ts';
import {ConfiguredSpeechPort} from '../../src/tts/speech-port.ts';
import {DebugGate} from '../../src/debug/gate.ts';
import {DebugTts} from '../../src/debug/tts.ts';
import {DouyinDebugController} from '../../src/debug/douyin.ts';
import {observeInternet} from '../../src/onboarding/network.ts';
import {douyinBrowserAvailable} from '../../src/douyin/browser.ts';
import {routeRemoteExportHttp} from '../../src/remote-input/http.ts';
import {routeTtsConfigHttp} from '../../src/tts/config-http.ts';
import {fixture,replaySessionFixture} from '../helpers/library-session-fixture.ts';
import type {RouteEntry} from '../../src/ui/routes/types.ts';
import type {TtsConfig} from '../../src/tts/config-store.ts';

const secret='PRIVATE_SENTINEL_正文_用户输入';
let logger:AppLogger,file:string,output:string[];
beforeEach(()=>{
 file='';output=[];
 logger=new AppLogger({read:async()=>file||null,size:async()=>Buffer.byteLength(file),replace:async value=>{file=value;},append:async(value,offset)=>{expect(offset).toBe(Buffer.byteLength(file));file+=value;}},undefined,(_level,line)=>output.push(line));
 installAppLogger(logger);
});
afterEach(async()=>{await logger.flush();installAppLogger(undefined);expect(file).not.toContain(secret);expect(output.join('\n')).not.toContain(secret);});
const logs=()=>output.map(line=>line.replace(/^\[[^\]]+\] /,''));
const reply=(data:unknown)=>({status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(data))});
const enabled=async()=>{const gate=new DebugGate();await gate.initialize(async()=>({debugBuild:true}));return gate;};

test('search logs native pagination lifecycle without keyword, title, cookie or server message',async()=>{
 const values=new Map([['watchrss.bili.session.v1.wbi',JSON.stringify({imgKey:'7cd084941338484aae1ad9425b84077c',subKey:'4932caff0ff746eab6f01bf08b70ac45'})]]);
 let requestUrl='';
 const client=createBiliClient({secureStore:{get:async key=>values.get(key)??null,set:async(key,value)=>{values.set(key,value);},delete:async key=>{values.delete(key);}},transport:{request:async request=>{requestUrl=request.url;return reply({code:0,message:secret,data:{numPages:4,result:[{result_type:'video',data:[{title:secret,aid:2}]}]}});}}});
 const page=await client.search(secret,2);
 expect(new URL(requestUrl).searchParams.get('keyword')).toBe(secret);
 expect(page.results[0]).toMatchObject({kind:'video',title:secret});
 expect(logs()).toContain('[D] [SearchPagingSource] Loading page 2 for keyword: <redacted>');
 expect(logs()).toContain('[D] [SearchPagingSource] Search result - isSuccess: true, code: 0, message: <redacted>');
 expect(logs()).toContain('[D] [SearchPagingSource] Loaded 1 items, numPages: 4, current page: 2');
});
test('search transport/API failure retains original rejection, logs native failure category',async()=>{
 for(const api of [false,true]){
  const failure=Error(secret);
  const client=createBiliClient({secureStore:{get:async key=>key.endsWith('.wbi')?JSON.stringify({imgKey:'7cd084941338484aae1ad9425b84077c',subKey:'4932caff0ff746eab6f01bf08b70ac45'}):null,set:async()=>{},delete:async()=>{}},transport:{request:async()=>{if(!api)throw failure;return reply({code:-101,message:secret,data:null});}}});
  await expect(client.search(secret)).rejects.toMatchObject({message:secret,kind:api?'auth':'transport'});
 }
 expect(logs()).toContain('[E] [SearchPagingSource] Exception during search');
 expect(logs()).toContain('[E] [SearchPagingSource] Search failed: <redacted>');
});
test('summary failure logs the native tag once without source, account or backend error text',async()=>{
 const session=new SummarySession({source:async()=>({title:secret,content:secret}),account:async()=>({backendBaseUrl:'https://unused.invalid',watchDeviceToken:secret} as never),freshAccount:async account=>account,transport:{request:async()=>reply({not:'used'})},recordUsage:async()=>{}},()=>1,()=>{});
 // Return valid state first; a separate failed request must not leak error.message.
 await session.start();expect(session.state.status).toBe('done');expect(output).toHaveLength(0);
 const failed=new SummarySession({source:async()=>({title:secret,content:secret}),account:async()=>{throw Error(secret);},freshAccount:async account=>account,transport:{request:async()=>{throw Error('must not request');}},recordUsage:async()=>{}},()=>1,()=>{});
 await failed.start();expect(failed.state.error).toBe(secret);
 expect(logs()).toEqual(['[E] [LlmSummaryVM] Summary generation failed']);
});
test('local TTS initialization failure keeps rejection and uses LocalTtsEngine',async()=>{
 const error=Error(secret);
 const port=new ConfiguredSpeechPort({read:()=>({engine:'local'})} as never,{} as never,async()=>null,{initializeLocal:async()=>{throw error;}} as never);
 await expect(port.initialize()).rejects.toBe(error);
 expect(logs()).toContain('[E] [LocalTtsEngine] TTS prepare failed');
});
test('each debug cloud TTS test and default voice failure uses native tag, release gate emits nothing',async()=>{
 for(const [engine,message] of [['backend_default','Backend default'],['minimax','MiniMax'],['azure','Azure'],['doubao','Doubao']] as const){
  const config:TtsConfig={engine,model:'',voiceId:'',baseUrl:'',speed:1};
  const store={updateDebugField:()=>config,setDebugApiKey:async()=>{},read:()=>config,publicConfig:async()=>({...config,apiKey:secret}),apiKey:async()=>{throw Error(secret);},selectDebugEngine:()=>config};
  const release=new DebugTts(new DebugGate(),store,{} as never,async()=>null),before=output.length;
  await expect(release.test()).rejects.toThrow();expect(output.length).toBe(before);
  const debug=new DebugTts(await enabled(),store,{} as never,async()=>null);
  await expect(debug.test()).rejects.toThrow(secret);
  expect(logs()).toContain(`[E] [TtsSettingsVM] ${message} TTS test failed`);
  if(engine==='backend_default'){await expect(debug.select(engine)).rejects.toThrow();expect(logs()).toContain('[E] [TtsSettingsVM] Apply default voice failed');}
 }
});
test('HTTP export failure retains native response status and logs only its matching handler',async()=>{
 for(const [path,mode,method,message] of [
  ['/getFavorites','favorite','readSavedLinks','handleGetFavorites failed'],
  ['/getWatchlaterList','watchLater','readSavedLinks','handleGetWatchLater failed'],
  ['/getBiliWatchHistory','bili','history','handleGetBiliWatchHistory failed'],
  ['/getBiliPlaybackProgress','bili','playbackProgress','handleGetBiliPlaybackProgress failed'],
 ] as const){
  const response=await routeRemoteExportHttp({target:path,headers:{},body:''},{mode,source:{[method]:async()=>{throw Error(secret);}}} as never);
  expect(response.status).toBe(method==='history'?200:500);
  expect(logs()).toContain(`[E] [LocalHttpServer] ${message}`);
 }
});
test('TTS config GET/SET failures log no decrypted input or validation exception',async()=>{
 const pairing={authenticate:async()=>true,encryptResponse:async()=>'',decryptRequest:async()=>JSON.stringify({apiKey:secret}),claimWrite:()=>true};
 const get=await routeTtsConfigHttp({method:'GET',target:'/getTtsConfig',headers:{},body:''},pairing as never,{publicConfig:async()=>{throw Error(secret);}} as never);
 expect(get.status).toBe(500);expect(logs()).toContain('[E] [LocalHttpServer] handleGetTtsConfig failed');
 const set=await routeTtsConfigHttp({method:'POST',target:'/setTtsConfig',headers:{},body:'cipher'},pairing as never,{validate:async()=>{throw Error(secret);}} as never);
 expect(set.status).toBe(400);expect(logs()).toContain('[E] [LocalHttpServer] handleSetTtsConfig failed');
});
test('network subscription errors are logged without swallowing the existing throw',()=>{
 const failure=Error(secret);
 expect(()=>observeInternet({subscribe:()=>{throw failure;},snapshot:async()=>({} as never)},()=>{})).toThrow(secret);
 const stop=observeInternet({subscribe:()=>()=>{throw failure;},snapshot:async()=>({active:false} as never)},()=>{});
 expect(stop).toThrow(secret);
 expect(logs()).toContain('[E] [InternetAvailabilityMonitor] Failed to register default network callback');
 expect(logs()).toContain('[E] [InternetAvailabilityMonitor] Failed to unregister default network callback');
});
test('browser probe unavailable and probe error have distinct native diagnostics',async()=>{
 const base={hasCapability:()=>true,clearSiteData:()=>({result:Promise.resolve([])})};
 expect(await douyinBrowserAvailable({...base,availability:()=>({result:Promise.resolve({status:'unavailable'} as never)})})).toBe(false);
 const error=Error(secret);
 await expect(douyinBrowserAvailable({...base,availability:()=>({result:Promise.reject(error)})})).rejects.toBe(error);
 expect(logs()).toEqual(['[W] [WebViewSupport] No WebView provider available on device','[E] [WebViewSupport] Failed to resolve WebView provider']);
});
test('media keepalive logs actual playing transitions, never a lease success alone',async()=>{
 let playing=false;
 const port=loggedSyncSilence({setEnabled:async()=>({playing}),lease:async()=>({playing})});
 await port.lease(secret,true);expect(output).toHaveLength(0);
 playing=true;await port.lease(secret,true);await port.lease(secret,false);
 expect(logs()).toEqual(['[I] [WatchRSS_SyncMediaKeepAlive] 同步媒体保活已启动']);
 playing=false;await port.setEnabled(false);
 expect(logs().at(-1)).toBe('[I] [WatchRSS_SyncMediaKeepAlive] 同步媒体保活已停止');
 const error=Error(secret),broken=loggedSyncSilence({setEnabled:async()=>{throw error;},lease:async()=>{throw error;}});
 await expect(broken.lease(secret,true)).rejects.toBe(error);
 expect(logs().at(-1)).toBe('[W] [WatchRSS_SyncMediaKeepAlive] 同步媒体保活启动失败');
});
test('activity logs only creation, route owner changes and actual foreground resume',()=>{
 const home:RouteEntry={page:'home'},reader:RouteEntry={page:'reader',readerArticle:{title:secret} as never};
 const log=new ActivityLog();
 for(let i=0;i<1000;i++)log.update([home],true);
 expect(logs()).toEqual(['[D] [Activity] 启动: HomeFeedListActivity','[D] [Activity] 活跃: HomeFeedListActivity']);
 log.update([home,reader],true);log.update([home,reader],false);log.update([home,reader],true);log.update([home],true);
 expect(logs().filter(line=>line.includes('启动: DetailActivity'))).toHaveLength(1);
 expect(logs().filter(line=>line.includes('活跃: DetailActivity'))).toHaveLength(2);
 expect(logs().at(-1)).toBe('[D] [Activity] 活跃: HomeFeedListActivity');
});
test('login observer deduplicates host events and never serializes QR bytes',()=>{
 let now=0;const log=new DouyinLoginLog(()=>now);
 for(let i=0;i<1000;i++)log.status({type:'qr',kind:'login',mime:'image/png',imageBase64:secret} as never);
 now=2000;log.status({type:'pageState',loading:false,loginPanelVisible:true});
 now=2500;log.completed();log.completed();log.dispose();log.dispose();
 expect(logs()).toEqual([
  '[D] [DouyinLogin] 检测到登录二维码',
  '[D] [DouyinLogin] 第1段loading状态持续: 2000ms (2.0秒)',
  '[D] [DouyinLogin] 登录耗时: 500ms (0.5秒)',
  '[D] [DouyinLogin] 第2段不loading状态持续: 500ms (0.5秒) [组件销毁]',
 ]);
});
test('debug commands are build-gated and frame/context loops do not log',async()=>{
 const release=new DouyinDebugController(new DebugGate());
 await expect(release.importCookie(secret,async()=>({ok:true}))).rejects.toThrow();
 expect(()=>release.requestAdvance()).toThrow();expect(output).toHaveLength(0);
 const debug=new DouyinDebugController(await enabled());
 for(let i=0;i<1000;i++){debug.updateContext(secret,secret,true);await debug.tick(i,false,async()=>{});}
 expect(output).toHaveLength(0);
 debug.requestAdvance();debug.armNext();
 await debug.importCookie(secret,async()=>({ok:true}));
 await expect(debug.importCookie(secret,async()=>({ok:false,message:secret}))).rejects.toThrow(secret);
 expect(logs().some(line=>line.startsWith('[D] [DouyinPlaybackDebug] request advance'))).toBe(true);
 expect(logs().at(-1)).toBe('[W] [DouyinPlaybackDebug] import cookie broadcast failed message=<redacted>');
});
test('native library fixture emits committed peer state only after applied ACK',async()=>{
 const row=fixture.cases.find(row=>row.peer)!;
 const result=await replaySessionFixture(row);
 expect(result.peer).toEqual(row.peer);
 const lines=logs(),ack=lines.findIndex(line=>line.includes('event="ack.read.success"')),mark=lines.findIndex(line=>line.includes('event="library.peerState.mark.success"'));
 expect(ack).toBeGreaterThanOrEqual(0);expect(mark).toBeGreaterThan(ack);
 expect(lines.some(line=>line.includes('event="library.manifest.handle.complete"'))).toBe(true);
 expect(lines.some(line=>line.includes('frame.read')||line.includes('frame.write'))).toBe(false);
 output=[];
 await expect(replaySessionFixture(row,repo=>{repo.markSuccess=async()=>{throw Error(secret);};})).rejects.toThrow(secret);
 expect(logs().some(line=>line.includes('[E] [BtSyncDebug] event="library.peerState.mark.failed"'))).toBe(true);
 expect(logs().some(line=>line.includes('event="library.peerState.mark.success"'))).toBe(false);
});
test('untrusted diagnostic fields and bare signature parameters are redacted at both sinks',()=>{
 new SyncEventLog().event(secret,{message:secret,body:secret,success:true});
 createLogConsole('Safe').warn('Operation failed',Error(secret),{body:secret});
 for(const key of ['signature','sign','a_bogus','x_bogus','X-Bogus','w_rid']){
  const raw=`${key}="${secret}"`,safe=redactSensitiveLogContent(raw);
  expect(safe).not.toContain(secret);expect(redactSensitiveLogContent(safe)).toBe(safe);
  logger.d('Signed',raw);
 }
});
test('cloud TTS player failure logs native message and still removes the temporary audio',async()=>{
 const removed:string[]=[],failure=Error(secret);
 const port=new ConfiguredSpeechPort({read:()=>({engine:'backend_default',model:'',voiceId:'',speed:1,baseUrl:''}),apiKey:async()=>''} as never,
  {request:async()=>reply({audio:'4d5033'})},async()=>({backendBaseUrl:'https://unused.invalid',watchDeviceToken:secret}),
  {temp:async()=>secret,write:async()=>{},remove:async(path:string)=>{removed.push(path);},play:async()=>{throw failure;}} as never);
 await port.initialize();await expect(port.speak(secret,1)).rejects.toBe(failure);
 expect(removed).toEqual([secret]);expect(logs()).toContain('[E] [ExoPlayerTtsAudioPlayer] ExoPlayer error');
});
test('null search data does not emit a misleading loaded event',async()=>{
 const client=createBiliClient({secureStore:{get:async key=>key.endsWith('.wbi')?JSON.stringify({imgKey:'7cd084941338484aae1ad9425b84077c',subKey:'4932caff0ff746eab6f01bf08b70ac45'}):null,set:async()=>{},delete:async()=>{}},transport:{request:async()=>reply({code:0,data:null})}});
 expect((await client.search(secret)).results).toEqual([]);
 expect(logs()).toContain('[E] [SearchPagingSource] Search data is null');
 expect(logs().some(line=>line.includes('Loaded '))).toBe(false);
});
test('volume limiter logs fixed, unchanged rounded target and below-limit cases without writes',async()=>{
 const {enforcePlaybackStartVolume}=await import('../../src/media/start-volume.ts');
 let writes=0;
 for(const state of [{min:0,max:15,current:10,fixed:true},{min:0,max:16,current:2,fixed:false},{min:0,max:15,current:0,fixed:false}])
  await enforcePlaybackStartVolume({state:async()=>state,setIndex:async()=>{writes++;return state;}},10);
 expect(writes).toBe(0);
 expect(logs()).toEqual([
  '[D] [PlaybackStartVolume] setStreamVolume skipped target=2 current=10 fixed=true',
  '[D] [PlaybackStartVolume] setStreamVolume skipped target=2 current=2 fixed=false',
  '[D] [PlaybackStartVolume] skip playback start volume limit current=0 limitPercent=10',
 ]);
});
