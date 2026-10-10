import {expect,test} from 'bun:test';
import {AcousticExternalRequest,executeAcousticLaunch,parseAcousticLaunch} from '../../src/phoneconnection/external.ts';
import {AcousticConnectionSession,type AcousticPorts} from '../../src/phoneconnection/session.ts';
import {DebugGate} from '../../src/debug/gate.ts';
import {DouyinDebugController} from '../../src/debug/douyin.ts';
import {ExternalDebugActions,DEBUG_ACTION} from '../../src/debug/external.ts';
const text={encode:(value:string)=>new TextEncoder().encode(value),decode:(value:Uint8Array)=>new TextDecoder().decode(value)};
const payload=(ability='REMOTE_INPUT')=>Buffer.from(JSON.stringify({k:'g',a:ability,h:'192.0.2.1',o:8080,t:'fixture'})).toString('base64');
const decode=(value:string)=>new Uint8Array(Buffer.from(value,'base64'));
test('native typed extras, defaults, unknown ability and payload precedence',()=>{
 expect(parseAcousticLaunch({})).toEqual({mode:'SOUND_GUIDED_WIFI',preferredAbility:undefined,autoListen:false,payloadBase64:undefined,returnRemoteUrl:false});
 expect(parseAcousticLaunch({mode:'PURE_SOUND',preferred_ability:'SYNC_WATCH_LATER'}).preferredAbility).toBe('SYNC_WATCH_LATER');
 expect(parseAcousticLaunch({preferred_ability:'r'}).preferredAbility).toBeUndefined();
 expect(parseAcousticLaunch({mode:'PURE_SOUND',debug_auto_listen:true}).mode).toBe('SOUND_GUIDED_WIFI');
 expect(parseAcousticLaunch({mode:'PURE_SOUND',debug_guided_payload_base64:payload(),debug_auto_listen:true,return_remote_url:true}).mode).toBe('SOUND_GUIDED_WIFI');
 for(const extras of [{debug_auto_listen:'true'},{return_remote_url:1},{mode:'BLUETOOTH'},{debug_guided_payload_base64:'?'},{debug_guided_payload_base64:'AAAA'.repeat(4097)},{preferred_ability:2}] as Record<string,string|number|boolean>[])expect(()=>parseAcousticLaunch(extras)).toThrow('invalid_acoustic_input');
});
function harness(request?:AcousticExternalRequest){
 const calls:string[]=[],urls:string[]=[];
 const ports:AcousticPorts={requireDebug(){},text,compression:{gzip:async b=>b,gunzip:async b=>b},fromBase64:decode,toBase64:b=>Buffer.from(b).toString('base64'),savedLinks:async()=>['https://example.com/article'],remoteInput:url=>{if(request)request.remoteUrl(url,value=>urls.push(value));else urls.push(url);},request<T>(method:string){calls.push(method);let value:unknown=null;if(method==='acoustic.requestPermission')value='required';if(method==='acoustic.wifi.connect')value={session:1};if(method==='acoustic.wifi.request')value={success:true,url:'https://example.com/rss'};return {result:Promise.resolve(value as T),cancel(){}};}};
 return {session:new AcousticConnectionSession(ports),calls,urls};
}
test('automatic debug payload uses real session WiFi path, infers ability and bypasses microphone',async()=>{
 const h=harness();const selected=await executeAcousticLaunch(h.session,parseAcousticLaunch({debug_guided_payload_base64:payload('SYNC_FAVORITES'),debug_auto_listen:true}),decode);
 expect(selected).toBe('SYNC_FAVORITES');expect(h.session.state.phase).toBe('success');expect(h.calls).toEqual(['acoustic.wifi.connect','runtime.delay','acoustic.wifi.request','acoustic.wifi.close']);
});
test('preferred ability is enforced; auto listener starts permission path; manual launch only selects',async()=>{
 const mismatch=harness();await executeAcousticLaunch(mismatch.session,parseAcousticLaunch({preferred_ability:'SYNC_FAVORITES',debug_guided_payload_base64:payload()}),decode);expect(mismatch.calls).toEqual([]);expect(mismatch.session.state.phase).toBe('error');
 const auto=harness();const selected=await executeAcousticLaunch(auto.session,parseAcousticLaunch({debug_auto_listen:true,preferred_ability:'SYNC_WATCH_LATER'}),decode);expect(auto.calls).toEqual(['acoustic.requestPermission']);expect(selected).toBe('SYNC_WATCH_LATER');
 const manual=harness();await executeAcousticLaunch(manual.session,parseAcousticLaunch({}),decode);expect(manual.calls).toEqual([]);expect(manual.session.state.phase).toBe('ready');
 const closed=harness();await executeAcousticLaunch(closed.session,parseAcousticLaunch({debug_auto_listen:true}),decode,()=>false);expect(closed.calls).toEqual([]);
});
test('remote URL returns Android RESULT_OK extras or follows normal input handoff, exactly once',async()=>{
 for(const returns of [true,false]){
  const launch=parseAcousticLaunch({debug_guided_payload_base64:payload(),return_remote_url:returns});const request=new AcousticExternalRequest(launch,Date.now()+120000),h=harness(request);
  await executeAcousticLaunch(h.session,launch,decode);request.cancel();request.remoteUrl('late',url=>h.urls.push(url));
  expect(await request.result).toEqual(returns?{code:0,data:'ok',result:{code:-1,extras:{remote_url:'https://example.com/rss'}}}:{code:0,data:'ok',result:{code:0}});
  expect(h.urls).toEqual(returns?[]:['https://example.com/rss']);expect(h.calls.at(-1)).toBe('acoustic.wifi.close');
 }
});
test('route closure cancels pending return without later URL or business handoff',async()=>{
 const request=new AcousticExternalRequest(parseAcousticLaunch({return_remote_url:true}),Date.now()+120000);request.cancel();const urls:string[]=[];request.remoteUrl('late',url=>urls.push(url));expect(await request.result).toEqual({code:1,data:'acoustic_cancelled',result:{code:0}});expect(urls).toEqual([]);
 const expired=new AcousticExternalRequest(parseAcousticLaunch({return_remote_url:false}),Date.now()-1);expired.remoteUrl('late',url=>urls.push(url));expect((await expired.result).result).toEqual({code:0});expect(urls).toEqual([]);
});
test('external action routes parameters, awaits completion and remains debug only',async()=>{
 for(const debug of [false,true]){
  const gate=new DebugGate();await gate.initialize(async()=>({debugBuild:debug}));let opened:AcousticExternalRequest|undefined;
  const actions=new ExternalDebugActions(gate,{douyin:new DouyinDebugController(gate),openDouyin(){},openSummary(){},applyCookie:async()=>({ok:true}),dumpLogs:()=>'',clearLogs(){},openAcoustic:request=>{opened=request;}});
  const event={id:2,deadline:Date.now()+120000,kind:'intent' as const,action:DEBUG_ACTION+'OPEN_ACOUSTIC',extras:{debug_auto_listen:true,return_remote_url:true},args:[]};
  const response=actions.handle(event);if(!debug){await expect(response).rejects.toThrow();expect(opened).toBeUndefined();continue;}
  expect(opened?.launch.autoListen).toBe(true);opened!.remoteUrl('https://example.com/rss',()=>{throw Error('must return');});expect((await response).result).toEqual({code:-1,extras:{remote_url:'https://example.com/rss'}});
  expect((await actions.handle({...event,extras:{debug_auto_listen:'true'} as any})).data).toBe('invalid_acoustic_input');
 }
});
