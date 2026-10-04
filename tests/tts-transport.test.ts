import {expect,test} from 'bun:test';
import {bytesToBase64} from '@podjs/framework/services';
import {createTtsTransport,type TtsTransportPorts} from '../src/tts/transport.ts';

const owned='tts/.pod-write-fixture_123.part';
const request={method:'POST',url:'https://voice.test/speech',headers:{Authorization:'Bearer secret'},body:new TextEncoder().encode('body')};
function fixture(payload:Uint8Array){
 const events:string[]=[],reads:number[]=[];
 const ports:TtsTransportPorts={
  createTemp:async()=>{events.push('create');return {path:owned};},
  remove:async path=>{events.push('remove:'+path);},
  download:async args=>{events.push('download:'+args.path);return {status:200,headers:{'content-type':'audio/mpeg'},url:String(args.url),path:String(args.path),size:payload.length};},
  read:async(_path,offset,maxBytes)=>{reads.push(maxBytes);const end=Math.min(payload.length,offset+maxBytes);return {dataBase64:bytesToBase64(payload.subarray(offset,end)),offset,size:payload.length,eof:end===payload.length};},
 };
 return {ports,events,reads};
}
test('TTS transport downloads and reads a multi-chunk response from only its owned file',async()=>{
 const payload=Uint8Array.from({length:140000},(_,index)=>index%251),f=fixture(payload);
 const response=await createTtsTransport(f.ports).request(request);
 expect(response.status).toBe(200);expect(response.body).toEqual(payload);
 expect(f.reads).toEqual([65536,65536,8928]);
 expect(f.events).toEqual(['create',`remove:${owned}`,`download:${owned}`,`remove:${owned}`]);
});
test('TTS transport never removes an unowned allocation path',async()=>{
 const f=fixture(new Uint8Array(0));f.ports.createTemp=async()=>({path:'tts/other.bin'});
 await expect(createTtsTransport(f.ports).request(request)).rejects.toThrow('语音临时路径无效');
 expect(f.events).toEqual([]);
});
test('TTS transport rejects a mismatched result path or truncated chunk and cleans its owned file',async()=>{
 const f=fixture(new Uint8Array([1,2,3]));f.ports.download=async()=>({status:200,headers:{},url:request.url,path:'tts/unrelated.bin',size:3});
 await expect(createTtsTransport(f.ports).request(request)).rejects.toThrow('语音服务响应大小或路径无效');
 expect(f.events).toEqual(['create',`remove:${owned}`,`remove:${owned}`]);
 const g=fixture(new Uint8Array([1,2,3]));g.ports.read=async()=>({dataBase64:'AQ==',offset:0,size:3,eof:true});
 await expect(createTtsTransport(g.ports).request(request)).rejects.toThrow('语音服务响应下载不完整');
 expect(g.events.at(-1)).toBe(`remove:${owned}`);
});
