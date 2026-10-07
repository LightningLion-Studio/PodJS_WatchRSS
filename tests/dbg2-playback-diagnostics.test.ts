import {expect,test} from 'bun:test';
import {DebugGate} from '../src/debug/gate.ts';
import {DouyinDebugController} from '../src/debug/douyin.ts';
import {ExternalDebugActions} from '../src/debug/external.ts';
import {playbackDiagnosticLines,type PlaybackCacheDiagnostics} from '../src/debug/playback-diagnostics.ts';
const caches:PlaybackCacheDiagnostics={managed:{bytes:125,limitBytes:512,bucketBytes:{images:5,'bili-preview':120,'douyin-preload':0,'rss-offline':0},files:[],jobs:[{path:'managed-cache/images/a.img',refs:1,started:true,cancelled:false}],pinnedPaths:['a'],activeWorkers:1,queuedRequests:2,downloadHandles:1},preview:{indexScope:'bili-preview',clearing:false,records:[{path:'a',size:100,offset:20,complete:false,updated:1},{path:'b',size:100,offset:100,complete:true,updated:1}],jobs:[{active:true,cancelled:false,pinnedPaths:['a']}],queuedJobs:1}};
const session:any={generation:3,standbyReady:true,standbyPreparing:false,capabilities:{maxSessions:2,decoderLimit:2,decoderInUse:2,targetBufferBytesPerSession:6,targetBufferBytesTotal:12},slots:[{role:'active',sessionId:'dy1a',awemeId:'1',bound:true,state:{state:'playing',positionMs:100,durationMs:1000,width:10,height:20,prewarming:false,presented:true,hasRenderedFirstFrame:true,targetBufferBytes:6}}]};
const queue={index:0,itemCount:2,hasMore:false,generation:1,previewGeneration:2,quarantinedAwemeIds:['3']};
async function controller(debug=true){const gate=new DebugGate();await gate.initialize(async()=>({debugBuild:debug}));return new DouyinDebugController(gate);}
test('provider reports typed disk/index/session/queue measurements and preserves unavailable native concepts',async()=>{
 const gate=new DebugGate();await gate.initialize(async()=>({debugBuild:true}));const dy=new DouyinDebugController(gate);dy.updateContext('1','2',true,{diagnostics:()=>queue});dy.bindSessions(async()=>session);dy.poison('2');let reads=0;
 const actions=new ExternalDebugActions(gate,{douyin:dy,openDouyin(){},openSummary(){},applyCookie:async()=>({ok:true}),dumpLogs:()=>'',clearLogs(){},playbackDiagnostics:async()=>{reads++;return caches;}});
 const result=await actions.handle({id:1,kind:'dump',action:'',args:['--douyin-playback'],extras:{}});
 expect(result.data).toContain('"bytes":125');expect(result.data).toContain('"partialFileBytes":20');expect(result.data).toContain('"indexedCompleteBytes":100');expect(result.data).toContain('"decoderInUse":2');expect(result.data).toContain('"awemeIds":["3"]');expect(result.data).toContain('injectedFaults=2');expect(result.data).toContain('RAM=unavailable');expect(result.data).toContain('DouyinPreviewDL=unavailable');expect(reads).toBe(1);
 const hostile={...caches,headers:{Cookie:'fixture_cookie'},url:'https://secret.test'};expect(playbackDiagnosticLines(hostile,queue,session).join('\n')).not.toContain('fixture_cookie');expect(playbackDiagnosticLines(hostile,queue,session).join('\n')).not.toContain('https://secret.test');
});
test('release and inactive flows do not read host, index or disk diagnostics',async()=>{
 let reads=0;const read=async()=>{reads++;return caches;},release=await controller(false);release.bindSessions(async()=>{reads++;return session;});release.updateContext('1','2',true);await expect(release.dumpPlayback(read)).rejects.toThrow();const idle=await controller();expect(await idle.dumpPlayback(read)).toBe('DOUYIN_PLAYBACK_DEBUG\nstate=unavailable');expect(reads).toBe(0);
});
test('stale playback and disposed session bindings cannot answer with prior owner data',async()=>{
 const dy=await controller();dy.updateContext('1','2',true);let finish!:(v:any)=>void;const stop=dy.bindSessions(()=>new Promise(r=>finish=r));const pending=dy.dumpPlayback();stop();finish(session);expect(await pending).toContain('owner changed');
 const oldStop=dy.bindSessions(async()=>session);dy.bindSessions(async()=>({...session,generation:4}));oldStop();expect(await dy.dumpPlayback()).toContain('"generation":4');
 let done!:(v:any)=>void;const pending2=dy.dumpPlayback(()=>new Promise(r=>done=r));dy.updateContext('2','3',true);done(caches);expect(await pending2).toContain('owner changed');
});
