import {test,expect} from 'bun:test';
import {ActivityStateHub} from '../src/navigation/activity-state.ts';
import {ActivityStateHub as OldHub} from './fixtures/upstream-u6/activity-state.ts';
import {ScrollRestoration,validScrollSnapshot} from '../src/navigation/scroll-restoration.ts';
import {ScrollRestoration as OldScroll,validScrollSnapshot as oldValid} from './fixtures/upstream-u6/scroll-restoration.ts';
import {AppLogger,redactSensitiveLogContent,MAX_LOG_BYTES,type LogFile} from '../src/logs/app-logger.ts';
import {AppLogger as OldLogger,redactSensitiveLogContent as oldRedact} from './fixtures/upstream-u6/app-logger.ts';
import type {ActivityState} from '@podjs/framework/services';

test('U6 namespace publication matches oracle with reordered acknowledgements and failures',async()=>{
 async function run(Hub:typeof ActivityStateHub|typeof OldHub){
  const published:ActivityState[]=[],acks:Array<()=>void>=[];
  const hub=new Hub(state=>{published.push(structuredClone(state));return new Promise<void>(resolve=>acks.push(resolve));});
  hub.seed({saved:{startup:{ready:true},content:{page:1}},retained:{content:{draft:'😀'}}});
  const first=hub.write({saved:{content:{page:2}},retained:{}},['content']);
  const second=hub.write({saved:{startup:{ready:false},ignored:1},retained:{startup:'retained'}},['startup']);
  const before=structuredClone(hub.read());acks[1]!();await second;acks[0]!();await first;
  const failed=new Hub(async()=>{throw Error('publish failed');});
  await expect(failed.write({saved:{x:1},retained:{}},['x'])).rejects.toThrow('publish failed');
  return {published,before,after:hub.read(),failed:failed.read()};
 }
 expect(await run(ActivityStateHub)).toEqual(await run(OldHub));
});

test('U6 scroll restoration matches frozen oracle across late rows, cancellation and invalid snapshots',()=>{
 const cases:unknown[]=[null,undefined,[],{},0,{version:1,offset:0,anchor:null},{version:1,offset:NaN,anchor:null},{version:1,offset:4,anchor:{index:2,offset:3}},{version:1,offset:4,anchor:{index:-1,offset:3}}];
 for(const value of cases)expect(validScrollSnapshot(value)).toBe(oldValid(value));
 for(let seed=0;seed<250;seed++){
  const pending=seed%3===0?undefined:seed%3===1?seed*7:{version:1 as const,offset:seed*2,anchor:{index:seed%19,offset:seed%30}};
  const actual=new ScrollRestoration(pending),old=new OldScroll(pending);
  for(let step=0;step<12;step++){
   const rows=Array.from({length:step*3},(_,i)=>({top:8+i*(seed%11+10),height:seed%11+10}));
   const source=step%2?rows:{length:rows.length,at:(index:number)=>rows[index]};
   const max=step===0?NaN:step*40;
   expect(actual.target(max,source)).toEqual(old.target(max,source));
   expect(actual.target(max,source)).toEqual(old.target(max,source));
   expect(actual.snapshot(step*10,source)).toEqual(old.snapshot(step*10,source));
   expect(actual.snapshot(step*10)).toEqual(old.snapshot(step*10));
   if(step===8){actual.cancel();old.cancel();}
  }
 }
});

test('U6 redaction preserves exact old output and idempotence for credential dialects',()=>{
 const keys='access_token api_key apiKey appRefreshToken bili_jct csrf_session_id DedeUserID DedeUserID__ckMd5 msToken n_mh odin_tt passport_csrf_token passport_csrf_token_default refresh_token refreshToken SESSDATA sessionid sessionid_ss sid sid_guard sid_tt sid_ucp_v1 s_v_web_id ssid_ucp_v1 ttwid uid_tt uid_tt_ss watchrss_pair token password secret signature sign a_bogus x_bogus X-Bogus w_rid'.split(' ');
 const inputs=['Cookie: secret\r\nnext','Authorization=Bearer abc==\nnext','X-WatchRSS-Pairing-Auth: abc','https://u:p@host/a?q=v#x','/path?q=x','Bearer a._-+=','plain 中文😀','token=<redacted>'];
 for(const key of keys)for(const value of ['secret','"with spaces"',"'中文 😀'",'<redacted>'])inputs.push(`${key}=${value}`,`{"${key}":${value}}`);
 for(const input of inputs){expect(redactSensitiveLogContent(input)).toBe(oldRedact(input));expect(redactSensitiveLogContent(redactSensitiveLogContent(input))).toBe(oldRedact(oldRedact(input)));}
});

function memory(initial:string,fail=false){
 let text=initial,failed=false;const ops:unknown[]=[],output:unknown[]=[];
 const file:LogFile={read:async()=>{ops.push(['read']);return text||null;},size:async()=>{ops.push(['size']);return Buffer.byteLength(text);},replace:async value=>{ops.push(['replace',value]);text=value;},append:async(value,offset)=>{ops.push(['append',value,offset]);if(fail&&!failed){failed=true;throw Error('write');}expect(offset).toBe(Buffer.byteLength(text));text+=value;}};
 return {file,ops,output,text:()=>text};
}
test('U6 file logger exact FIFO/trim/output/pull differential including failure and legacy scan modes',async()=>{
 async function run(Logger:typeof AppLogger|typeof OldLogger,initial:string,scan:boolean,fail:boolean){
  const m=memory(initial,fail),logger=new Logger(m.file,()=>new Date(2026,0,2,3,4,5,6),(level,line)=>m.output.push([level,line]));
  await logger.init('legacy token=PRIVATE\n',scan);
  logger.v('T','verbose');logger.d('T','token=PRIVATE');logger.i('T','😀');
  const error=Error('secret');error.stack='Error: token=PRIVATE\n at https://x/?private=value';
  logger.w('T','warning',error);logger.e('T','error',42);
  await logger.flush();const read=await logger.readLogs();const pulls=[];for(const size of [1,0,-1,12,1.5,'5','bad'])pulls.push(await logger.pull(size));
  await logger.clearLogs();await logger.flush();
  return {ops:m.ops,output:m.output,read,pulls,final:m.text()};
 }
 const over=Array.from({length:10},(_,i)=>`${i}:`+'中'.repeat(175000)).join('\r\n')+'\r\n';
 for(const [initial,scan,fail] of [['',true,false],['token=PRIVATE\n',true,false],['unchanged\n',false,false],['',false,true],['a'.repeat(MAX_LOG_BYTES-1)+'\n',false,false],[over,false,false]] as const){
  expect(await run(AppLogger,initial,scan,fail)).toEqual(await run(OldLogger,initial,scan,fail));
 }
});
