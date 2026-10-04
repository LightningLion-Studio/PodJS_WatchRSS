import {expect,test} from 'bun:test';
import {readRemoteHttpRequest,routeRemoteHttp,serveRemoteHttp,remoteInputQrContent,REMOTE_INPUT_ABILITY} from '../src/remote-input/http.ts';
import {stringToUtf8,utf8ToString} from '@podjs/framework/bytes';
import type {SyncByteStream} from '../src/sync/stream.ts';
import {RemoteInputServer} from '../src/remote-input/server.ts';
function wire(text:string,fragment=7){let bytes=stringToUtf8(text),at=0,closed=false;const written:Uint8Array[]=[];const stream:SyncByteStream={read:async(max)=>{if(closed||at===bytes.length)return null;const n=Math.min(max,fragment,bytes.length-at),part=bytes.slice(at,at+n);at+=n;return part;},write:async(value)=>{written.push(value.slice());},close:async()=>{closed=true;}};return {stream,written,closed:()=>closed,text:()=>written.map(b=>utf8ToString(b)).join('')};}
function request(body:string,headers='Content-Type: application/json',target='/remoteEnterRSSURL'){return `POST ${target} HTTP/1.1\r\n${headers}\r\nContent-Length: ${stringToUtf8(body).length}\r\n\r\n${body}`;}
test('native remote input routes negotiate only RSS input and accept JSON, plain, query and form URLs',async()=>{
 for(const [body,headers,target,url] of [
  ['{"url":" https://example.com/中文.xml "}','Content-Type: application/json','/remoteEnterRSSURL',' https://example.com/中文.xml '],
  ['https://example.com/feed','Content-Type: text/plain','/remoteEnterRSSURL','https://example.com/feed'],
  ['url=https%3A%2F%2Fexample.com%2Fx%3Fa%3D1%26b%3D2','Content-Type: application/x-www-form-urlencoded','/remoteEnterRSSURL','https://example.com/x?a=1&b=2'],
  ['','','/remoteEnterRSSURL?url=https%3A%2F%2Fexample.com%2Ffeed','https://example.com/feed'],
 ] as const){const w=wire(request(body,headers||'X-Test: 1',target));const response=routeRemoteHttp(await readRemoteHttpRequest(w.stream));expect(response.status).toBe(200);expect(response.url).toBe(url);}
 const route=(target:string)=>routeRemoteHttp({target,headers:{},body:''});
 expect(JSON.parse(route('/getCurrentActivationAbility').body)).toEqual(REMOTE_INPUT_ABILITY);
 expect(JSON.parse(route('/getAbilities').body)).toEqual({status:'ok',abilities:[REMOTE_INPUT_ABILITY]});
 expect(JSON.parse(route('/health').body)).toEqual({status:'ok'});
 expect(route('/getFavorites').status).toBe(404);expect(route('/getTtsConfig').status).toBe(404);expect(route('/setLLMSummaryConfig').status).toBe(410);
 expect(route('/remoteEnterRSSURL').status).toBe(400);
 expect(route('/').body).toContain('请使用腕上RSS手机版App扫码');
 expect(remoteInputQrContent('192.168.1.2',12345)).toBe('http://192.168.1.2:12345/#请将手机和手表连上同一个WiFi再扫码');
});
test('fragmented chunked body preserves UTF-8 and delivers only after successful complete response',async()=>{
 const body='{"url":"https://example.com/中文"}';const w=wire(`POST /remoteEnterRSSURL HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n${stringToUtf8(body).length.toString(16)}\r\n${body}\r\n0\r\nX-Complete: 1\r\n\r\n`,1);const urls:string[]=[];
 await serveRemoteHttp(w.stream,()=>true,url=>{expect(w.text()).toContain('操作成功');urls.push(url);});expect(urls).toEqual(['https://example.com/中文']);expect(w.closed()).toBe(true);
 const response=w.text(),[header,content]=response.split('\r\n\r\n');expect(header).toContain('Content-Length: '+stringToUtf8(content).length);
 const fail=wire(request('{"url":"x"}'));fail.stream.write=async()=>{throw Error('Disconnected');};await expect(serveRemoteHttp(fail.stream,()=>true,url=>urls.push(url))).rejects.toThrow('Disconnected');expect(urls).toHaveLength(1);expect(fail.closed()).toBe(true);
});
test('ambiguous framing, oversized input, truncated bodies and a whole-request deadline are rejected',async()=>{
 for(const input of [
  'POST /remoteEnterRSSURL HTTP/1.1\r\nContent-Length: 65537\r\n\r\n',
  'POST /remoteEnterRSSURL HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx',
  'POST /remoteEnterRSSURL HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx',
  'POST /remoteEnterRSSURL HTTP/1.1\r\nContent-Length: 10\r\n\r\nx',
  'GET /health HTTP/1.1\r\nX: '+ 'a'.repeat(17000)+'\r\n\r\n',
 ])await expect(readRemoteHttpRequest(wire(input).stream)).rejects.toThrow();
 let time=0;await expect(readRemoteHttpRequest(wire('GET /health HTTP/1.1\r\n\r\n',1).stream,()=>time+=1000)).rejects.toThrow();
 const w=wire(request('{"url":"x"}'));let called=false;await serveRemoteHttp(w.stream,()=>false,()=>{called=true;});expect(called).toBe(false);expect(w.written).toHaveLength(0);expect(w.closed()).toBe(true);
});
test('disposing before a listener resolves closes the late handle without accepting connections',async()=>{
 let resolve!:(value:{id:string;port:number})=>void,cancelled=0;const closed:string[]=[];
 const server=new RemoteInputServer(()=>{throw Error('Unexpected URL');},()=>{}, {tcp:{listen:()=>({result:new Promise(r=>resolve=r),cancel:()=>{cancelled++;}}),addresses:async()=>({addresses:[]}),accept:()=>{throw Error('Unexpected accept');},close:async id=>{closed.push(id);return {closed:true};}},streams:{} as never});
 const ending=server.dispose();resolve({id:'late',port:1});await ending;expect(cancelled).toBe(1);expect(closed).toEqual(['late']);
});

test('Bluetooth validates without opening UI before completion and preserves native optString trimming',async()=>{
 const {createApplicationActionHandler}=await import('../src/sync/application-actions.ts');
 const {takeRemoteInput,clearRemoteInput,completeRemoteInput,remoteInputUrl}=await import('../src/remote-input/inbox.ts');clearRemoteInput();
 const handle=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'',notesChanged:()=>{throw Error('Unexpected write');}});
 expect(await handle({action:'remoteInput',url:'   '})).toEqual({success:false,message:'缺少 RSS URL'});
 const request={action:'remoteInput',url:' https://example.invalid/中文 '},response=await handle(request);expect(response).toEqual({success:true,action:'remoteInput'});expect(takeRemoteInput()).toBeUndefined();
 completeRemoteInput({request,response:{success:false}});expect(takeRemoteInput()).toBeUndefined();completeRemoteInput({request,response});expect(takeRemoteInput()).toBe('https://example.invalid/中文');expect(takeRemoteInput()).toBeUndefined();
 expect(remoteInputUrl(null)).toBe('null');expect(remoteInputUrl('\u001c')).toBe('');expect(remoteInputUrl('\ufeff')).toBe('\ufeff');clearRemoteInput();
});
