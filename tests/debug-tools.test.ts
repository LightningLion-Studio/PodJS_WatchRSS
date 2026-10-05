import {expect,test} from 'bun:test';
import {DebugGate} from '../src/debug/gate.ts';
import {DebugBluetoothSession,summarizePayload,type DebugBluetoothPorts} from '../src/debug/bluetooth.ts';
import {DouyinDebugController} from '../src/debug/douyin.ts';
import {buildLargeArticle,buildLargeList} from '../src/debug/perf.ts';
const allowed=async()=>{const gate=new DebugGate();await gate.initialize(async()=>({debugBuild:true}));return gate;};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('release, missing/old host, malformed flags and rejected build query all fail closed',async()=>{
 for(const value of [undefined,null,{},true,{debugBuild:false},{debugBuild:1},{debugBuild:'true'}]){const gate=new DebugGate();expect(gate.allowed).toBe(false);await gate.initialize(async()=>value);expect(gate.allowed).toBe(false);expect(()=>gate.require()).toThrow();}
 const gate=new DebugGate();await gate.initialize(async()=>{throw Error('unsupported');});await gate.initialize(async()=>({debugBuild:true}));expect(gate.allowed).toBe(false);
});
test('pending host query cannot enable debug and is performed once',async()=>{let done!:(v:unknown)=>void,calls=0;const gate=new DebugGate(),read=()=>{calls++;return new Promise(resolve=>done=resolve);};const first=gate.initialize(read),second=gate.initialize(read);await flush();expect(gate.allowed).toBe(false);done({debugBuild:true});await first;await second;expect(calls).toBe(1);expect(gate.allowed).toBe(true);});
test('release operations cannot open Bluetooth, poison video, switch or import cookie',async()=>{
 const gate=new DebugGate();let effects=0;const bt=new DebugBluetoothSession(gate,{acquire:async()=>{effects++;return ()=>{};},listener:()=>{effects++;throw Error();},keepAwake:async()=>{effects++;}});
 expect(()=>bt.run()).toThrow();const dy=new DouyinDebugController(gate);expect(()=>dy.armNext()).toThrow();expect(()=>dy.poison('2')).toThrow();expect(()=>dy.requestAdvance()).toThrow();expect(()=>dy.setAuto(20)).toThrow();await expect(dy.importCookie('secret',async()=>{effects++;return {ok:true};})).rejects.toThrow();await dy.tick(100,true,async()=>{effects++;});expect(dy.fail('2',true)).toBe(false);expect(effects).toBe(0);
});
test('payload summary follows native fields without leaking payload bodies or cookies',()=>{
 const text=summarizePayload('request',{action:'syncLibrary',phase:'push',version:14,articles:[{body:'SECRET'}],articleManifest:[1,2],bodyRequests:[1],rssSources:[],batchIndex:1,batchCount:3,changeSeqRange:{fromExclusive:3,toInclusive:8},cookie:'SECRET'});
 expect(text).toBe('request: action=syncLibrary phase=push version=14 success=true articleManifest=2 articles=1 bodyRequests=1 rssSources=0 batch=2/3 seq=3..8');expect(text).not.toContain('SECRET');expect(summarizePayload('response',{})).toContain('batch=-');
});
test('Bluetooth acquires exclusivity before listen, forwards timeout, releases on success',async()=>{
 const calls:string[]=[];const ports:DebugBluetoothPorts={acquire:async()=>{calls.push('exclusive');return ()=>{calls.push('release');};},listener:()=>({start:async options=>{expect(options.acceptTimeoutMs).toBe(2345);calls.push('listen');options.onPeer?.({remoteName:'phone',remoteAddress:'address'});return [{request:{action:'probe'},response:{success:true},ack:null,libraryApplied:false}];},stop(){calls.push('stop');}}),keepAwake:async active=>{calls.push(`awake:${active}`);}};
 const session=new DebugBluetoothSession(await allowed(),ports);const text=await session.run(2345);expect(text).toContain('remote=phone address');expect(calls).toEqual(['exclusive','listen','awake:true','awake:false','release']);await session.close();
});
test('Bluetooth navigation cancellation while ownership pending never creates a listener',async()=>{
 let grant!:(value:()=>void)=>void,listeners=0,releases=0;
 const session=new DebugBluetoothSession(await allowed(),{acquire:()=>new Promise(resolve=>grant=resolve),listener:()=>{listeners++;throw Error();},keepAwake:async()=>{}});
 const run=session.run();void run.catch(()=>{});const closing=session.close();grant(()=>{releases++;});await closing;await expect(run).rejects.toThrow('cancelled');expect(listeners).toBe(0);expect(releases).toBe(1);
});
test('Bluetooth close cancels pending connection and releases screen/ownership after failure',async()=>{
 let reject!:(e:Error)=>void,stops=0,releases=0;const awake:boolean[]=[];
 const session=new DebugBluetoothSession(await allowed(),{acquire:async()=>()=>{releases++;},listener:()=>({start:()=>new Promise((_,r)=>reject=r),stop:()=>{stops++;reject(Error('cancelled'));}}),keepAwake:async active=>{awake.push(active);}});
 expect(()=>session.run(0)).toThrow();const job=session.run();void job.catch(()=>{});await flush();expect(()=>session.run()).toThrow();await session.close();await expect(job).rejects.toThrow('cancelled');expect(stops).toBe(1);expect(releases).toBe(1);expect(awake.at(-1)).toBe(false);
});
test('native perf fixtures preserve size, mixed images, read state and long title',()=>{
 const list=buildLargeList();expect(list.length).toBe(10000);expect(list[0].read).toBe(true);expect(list[1].read).toBe(false);expect(list[12].imageUrl).toContain('/1025/');expect(list[11].imageUrl).toBeUndefined();const article=buildLargeArticle();expect(article.content.length).toBeGreaterThanOrEqual(100000);expect(article.content).toContain('<img');expect(article.title).toContain('English words');
});
test('Douyin next poison is one target, automatic advance is active-only, cookie import validated',async()=>{
 const dy=new DouyinDebugController(await allowed());dy.armNext();expect(dy.fail('current')).toBe(false);expect(dy.fail('next',true)).toBe(true);expect(dy.fail('other',true)).toBe(false);expect(dy.fail('next')).toBe(true);
 let advances=0;dy.setAuto(100);await dy.tick(100,true,async()=>{advances++;});await dy.tick(200,true,async()=>{advances++;});await dy.tick(400,false,async()=>{advances++;});expect(advances).toBe(1);
 dy.requestAdvance();await dy.tick(401,true,async()=>{advances++;});expect(advances).toBe(2);
 await expect(dy.importCookie('',async()=>({ok:true}))).rejects.toThrow('missing_cookie');await expect(dy.importCookie('x',async()=>({ok:false,message:'invalid'}))).rejects.toThrow('invalid');expect(await dy.importCookie(' x ',async raw=>{expect(raw).toBe('x');return {ok:true};})).toBe('Cookie 已导入');dy.reset();expect(dy.fail('next')).toBe(false);expect(dy.interval).toBe(0);
});
test('debug TTS engine defaults, account validation, status and connectivity',async()=>{
 const {DebugTts}=await import('../src/debug/tts.ts');
 let config:import('../src/tts/config-store.ts').TtsConfig={engine:'local',model:'',voiceId:'',baseUrl:'',speed:1.4},saved=0,requests=0,account:import('../src/tts/cloud-synth.ts').TtsAccount|null=null;
 const store={read:()=>config,publicConfig:async()=>({...config,apiKey:'****1234'}),apiKey:async()=>'test-key',selectDebugEngine:(engine:typeof config.engine,defaults:Pick<typeof config,'model'|'voiceId'|'baseUrl'>)=>{saved++;config={...config,...defaults,engine};return config;}};
 const transport={request:async()=>{requests++;return {status:200,headers:{'content-type':'audio/mpeg'},body:new TextEncoder().encode(JSON.stringify({audio:'0102'}))};}};
 const release=new DebugTts(new DebugGate(),store,transport,async()=>account);await expect(release.select('local')).rejects.toThrow();await expect(release.test()).rejects.toThrow();await expect(release.status()).rejects.toThrow();expect(saved+requests).toBe(0);
 const tts=new DebugTts(await allowed(),store,transport,async()=>account);expect(await tts.test()).toContain('本地 TTS');expect(requests).toBe(0);
 await tts.select('minimax');expect(config).toMatchObject({model:'speech-2.8-hd',voiceId:'male-qn-qingse',speed:1.4});expect(await tts.status()).toContain('API Key 已配置');expect(await tts.status()).not.toContain('1234');
 await expect(tts.select('backend_default')).rejects.toThrow('登录');expect(config.engine).toBe('minimax');
 account={backendBaseUrl:'https://backend.invalid',watchDeviceToken:'test-token'};await tts.select('backend_default');expect(config).toMatchObject({engine:'backend_default',model:'',voiceId:''});expect(await tts.test()).toContain('连接成功');expect(requests).toBe(1);
 await tts.select('local');expect(config.engine).toBe('local');
});
test('Douyin injection uses native invalid media URI and leaves real source URLs untouched',async()=>{
 const released=new DouyinDebugController(new DebugGate());expect(released.playbackUrl('2','https://real/2',true)).toBe('https://real/2');
 const debug=new DouyinDebugController(await allowed());debug.updateContext('1','2',true);debug.armNext();const source={id:'2',url:'https://real/2'};
 expect(debug.playbackUrl('1','https://real/1')).toBe('https://real/1');expect(debug.playbackUrl(source.id,source.url,true)).toBe('watchrss-debug://douyin/force-fail/2');expect(source.url).toBe('https://real/2');expect(debug.playbackUrl('3','https://real/3',true)).toBe('https://real/3');
});
test('failed Bluetooth ownership acquisition cannot release another session wake lease',async()=>{
 let wakeChanges=0;const session=new DebugBluetoothSession(await allowed(),{acquire:async()=>{throw Error('already owned');},listener:()=>{throw Error('must not listen');},keepAwake:async()=>{wakeChanges++;}});
 await expect(session.run()).rejects.toThrow('already owned');expect(wakeChanges).toBe(0);await session.close();
});
