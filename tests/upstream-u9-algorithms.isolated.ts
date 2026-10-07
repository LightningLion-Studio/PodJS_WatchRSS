import {expect,test} from 'bun:test';
import {oracle} from './upstream-u9-loader.ts';
import * as anchors from '../src/reader/text-anchor.ts';
import * as theme from '../src/reader/theme-schedule.ts';
import * as numbers from '../src/sync/wire-json.ts';
import {readRemoteHttpRequest} from '../src/remote-input/http.ts';
import * as logs from '../src/debug/log-buffer.ts';
const oldAnchor=await oracle('reader/text-anchor.ts'),oldTheme=await oracle('reader/theme-schedule.ts'),oldNumbers=await oracle('sync/wire-json.ts'),oldHttp=await oracle('remote-input/http.ts'),oldLogs=await oracle('debug/log-buffer.ts');
const outcome=async(fn:()=>unknown)=>{try{return {value:await fn()};}catch(e){return {error:{name:(e as Error).name,message:(e as Error).message}};}};
let seed=0x23190812;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
test('source anchors match oracle for repeats, missing lines, CRLF, Unicode and clamping',()=>{
 const corpus=['','中文😀\r\n重复\r重复','same same\nsame','👩‍👧e\u0301\n尾'];
 for(let i=0;i<100;i++)corpus.push(Array.from({length:rand()%55},()=>['中','\n','a','😀','\r',' '][rand()%6]).join(''));
 for(const text of corpus)for(const lines of [[],text.replace(/\r\n?/g,'\n').split('\n'),['same','same','missing'],Array.from(text)]){
  const a=anchors.lineStarts(text,lines),b=oldAnchor.lineStarts(text,lines);expect(a).toEqual(b);
  for(const offset of [-300,0,.5,7,99999])for(const height of [0,1,12,18.5]){
   const anchor=anchors.anchorAtOffset(offset,height,a);expect(anchor).toEqual(oldAnchor.anchorAtOffset(offset,height,b));
   for(const maximum of [0,20,Infinity])for(const fraction of [-1,0,.5,1,4])expect(anchors.offsetForAnchor({...anchor,fraction},height,a,maximum)).toEqual(oldAnchor.offsetForAnchor({...anchor,fraction},height,b,maximum));
  }
 }
});
test('sunrise/sunset, date/zone edge cases and overnight schedules match frozen oracle',()=>{
 const days=[{year:2024,month:2,day:29},{year:2025,month:2,day:29},{year:2026,month:3,day:8},{year:2026,month:11,day:1},{year:2026,month:6,day:21},{year:2026,month:12,day:21},{year:2026,month:13,day:1}];
 for(const day of days)for(const lat of [-91,-90,-66,0,40.7,66,90,NaN])for(const lon of [-181,-180,-74,0,180,NaN]){
  for(const zone of [()=>0,()=>300,(t:number)=>t%86400000<12*3600000?300:240]){
   expect(theme.sunTimes(day,lat,lon,zone)).toEqual(oldTheme.sunTimes(day,lat,lon,zone));
   for(const [light,dark] of [[420,1140],[1140,420],[420,420]])for(const mode of ['FIXED_TIME','SUNRISE_SUNSET'] as const){
    const s={...theme.DEFAULT_THEME_SCHEDULE,mode,latitude:lat,longitude:lon,lightStartMinutes:light,darkStartMinutes:dark};
    for(const minutes of [0,419,420,1140,1439])expect(theme.scheduledDark(s,day,minutes,zone)).toBe(oldTheme.scheduledDark(s,day,minutes,zone));
   }
  }
 }
 // Default timezone dependency and explicit date, as used by production.
 const day={year:2026,month:10,day:7};expect(theme.sunTimes(day,40.7,-74)).toEqual(oldTheme.sunTimes(day,40.7,-74));
 expect(theme.scheduledDarkNow(theme.DEFAULT_THEME_SCHEDULE,new Date(2026,9,7,13))).toBe(oldTheme.scheduledDarkNow(theme.DEFAULT_THEME_SCHEDULE,new Date(2026,9,7,13)));
});
test('lexical numeric metadata and duplicate-key traversal match oracle recursively',async()=>{
 const samples=['{}','{"i":1,"d":1.0,"e":1e0,"negative":-0,"large":9007199254740992}','{"x":1.0,"x":1,"y":2,"y":null,"a":[2,2.0,1e0],"escaped\\u006b":3.0}','{"__proto__":{"x":1},"constructor":1,"quote":"\\\"{} \\\\"}','[]','null','1','{bad}', '{"x":'+ '['.repeat(129)+'0'+']'.repeat(129)+'}'];
 for(let i=0;i<100;i++){const n=rand()%99;samples.push(`{"number":${n}${['','.0','e0'][rand()%3]},"rows":[${n}.0,{"n":-${n}}],"text":"中文😀"}`);}
 function visit(api:any,obj:any):any{if(!obj||typeof obj!=='object')return obj;return Object.keys(obj).map(key=>[key,api.wireNumberToken(obj,key),api.isWireInteger(obj,key),visit(api,obj[key])]);}
 for(const text of samples){const a=await outcome(()=>numbers.parseWireJson(text)),b=await outcome(()=>oldNumbers.parseWireJson(text));expect(a).toEqual(b);if('value'in a&&'value'in b)expect(visit(numbers,a.value)).toEqual(visit(oldNumbers,b.value));}
 const external={n:1,d:1.0};expect(numbers.isWireInteger(external,'d')).toBe(oldNumbers.isWireInteger(external,'d'));
});
test('HTTP parser exact byte reads, deadlines, results and error text match oracle',async()=>{
 const encoder=new TextEncoder(),body='中😀\0尾';
 const payloads=[
  'GET /health HTTP/1.0\r\n\r\n',`POST /x?q=1 HTTP/1.1\r\nContent-Length: ${encoder.encode(body).length}\r\n\r\n${body}`,
  'POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=yes\r\ntest\r\n0\r\nX-Trailer: yes\r\n\r\n',
  'GET / HTTP/1.1\n\n','GET https://x HTTP/1.1\r\n\r\n','GET / HTTP/2.0\r\n\r\n',
  'GET / HTTP/1.1\r\nbad\r\n\r\n','GET / HTTP/1.1\r\nBAD KEY: a\r\n\r\n',
  'GET / HTTP/1.1\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx',
  'GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\nx',
  'GET / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n','POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n',
  'POST / HTTP/1.1\r\nContent-Length: 65537\r\n\r\n','POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nx',
  'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n-1\r\n',
  'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n',
  'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx!\r\n',
  'GET / HTTP/1.1\r\nX: '+'a'.repeat(16384)+'\r\n\r\n',
  'POST / HTTP/1.1\r\nContent-Length: 65536\r\n\r\n'+'a'.repeat(65536),
 ];
 async function run(fn:any,text:string,fragment:number,mode:string){const bytes=encoder.encode(text),trace:any[]=[];let at=0,time=0;const stream={read:async(max:number,deadline:number)=>{trace.push([max,deadline]);if(mode==='late')time+=16000;if(mode==='empty')return new Uint8Array();if(mode==='overread')return new Uint8Array(max+1);if(at>=bytes.length)return null;const part=bytes.slice(at,at+Math.min(fragment,max));at+=part.length;return part;},write:async()=>{},close:async()=>{}};return {result:await outcome(()=>fn(stream,()=>time)),trace};}
 for(const text of payloads)for(const fragment of [1,7,4096])expect(await run(readRemoteHttpRequest,text,fragment,'normal')).toEqual(await run(oldHttp.readRemoteHttpRequest,text,fragment,'normal'));
 for(const mode of ['late','empty','overread'])expect(await run(readRemoteHttpRequest,payloads[0],1,mode)).toEqual(await run(oldHttp.readRemoteHttpRequest,payloads[0],1,mode));
 // Constructor/function default: production Date.now is not injected.
 const text='GET / HTTP/1.1\r\n\r\n';const stream=()=>({read:async()=>encoder.encode(text),write:async()=>{},close:async()=>{}});
 expect(await readRemoteHttpRequest(stream())).toEqual(await oldHttp.readRemoteHttpRequest(stream()));
});
test('debug line/char bounds, disabled append and retained buffers match oracle',async()=>{
 async function run(api:any){const result:any[]=[];api.enableDebugLogBuffer(true);api.debugLogBuffer.clear();for(let i=0;i<600;i++){api.debugLogBuffer.append(i%3?'中😀 '+i:'x'.repeat(i%2?8000:4100));if(i%30===0)result.push(api.debugLogBuffer.dump());}
  api.enableDebugLogBuffer(false);api.debugLogBuffer.append('ignored');result.push(await outcome(()=>api.debugLogBuffer.dump()),await outcome(()=>api.debugLogBuffer.clear()));api.enableDebugLogBuffer(true);result.push(api.debugLogBuffer.dump());api.debugLogBuffer.clear();result.push(api.debugLogBuffer.dump());api.enableDebugLogBuffer(false);return result;}
 expect(await run(logs)).toEqual(await run(oldLogs));
});
