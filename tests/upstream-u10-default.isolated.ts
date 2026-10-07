import {expect,mock,test} from 'bun:test';
import {oracle} from './upstream-u10-loader.ts';
const events:any[]=[],emitted:any[]=[],codec:any[]=[];
(globalThis as any).pod={capabilities:()=>JSON.stringify(['host.lifecycle','data.files.chunks','net.download']),takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,emit:(line:string)=>emitted.push(JSON.parse(line)),encodeBase64:(v:Uint8Array)=>{codec.push([...v]);return Buffer.from(v).toString('base64');}};
mock.module('@pocketjs/framework/gesture',()=>({cancelActiveTouches(){}}));
mock.module('@pocketjs/framework/input',()=>({dispatchAccessibilityAction(){}}));
mock.module('@pocketjs/framework/services',()=>({registerServicePump(){}}));
mock.module(Bun.resolveSync('../src/logs/app-logger.ts',import.meta.dir),()=>({appLogger:{d(){},i(){},e(){}}}));
const {__pumpPodEvents}=await import('@podjs/framework/watch');
const {application}=await import('@podjs/framework/services');
const current=await import('../src/tts/transport.ts'),old=await oracle('tts/transport.ts');
const gate=await import('../src/debug/gate.ts'),oldGate=await oracle('debug/gate.ts');
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
async function reply(value:any,ok=true){events.push({t:'service.result',id:emitted.at(-1).id,ok,value,...(!ok?{error:{code:'host_error',message:'fixture failure'}}:{})});__pumpPodEvents();await settle();}
test('production createTtsTransport() and exported singleton use actual default service/file ports and native codec',async()=>{
 async function run(api:any,singleton:boolean){emitted.length=0;codec.length=0;const transport=singleton?api.ttsTransport:api.createTtsTransport();
  const request=transport.request({method:'POST',url:'https://voice.test/',headers:{},body:Uint8Array.of(9)});await settle();expect(emitted.at(-1)).toMatchObject({method:'file.createTemp',args:{directory:'tts'}});await reply({path:'tts/.pod-write-default.part'});
  expect(emitted.at(-1).method).toBe('file.delete');await reply({});expect(emitted.at(-1)).toMatchObject({method:'http.download',args:{path:'tts/.pod-write-default.part',bodyBase64:'CQ==',maxBytes:8388608,timeoutMs:15000,readTimeoutMs:60000,temporary:true,acceptHttpErrors:true}});
  await reply({path:'tts/.pod-write-default.part',size:3,status:200,headers:{}});expect(emitted.at(-1)).toMatchObject({method:'file.read',args:{offset:0,maxBytes:3}});await reply({dataBase64:'AQID',offset:0,size:3,eof:true});expect(emitted.at(-1).method).toBe('file.delete');await reply({});const result=await request;
  return {result,codec:[...codec],calls:emitted.map(({method,args})=>({method,args}))};
 }
 for(const singleton of [false,true])expect(await run(current,singleton)).toEqual(await run(old,singleton));
});
test('production DebugGate initializes from application.buildInfo and fails closed on unsupported host errors',async()=>{
 for(const debugBuild of [false,true]){
  async function run(api:any){const g=new api.DebugGate(),waiting=g.initialize(()=>application.buildInfo());expect(g.allowed).toBe(false);await settle();expect(emitted.at(-1).method).toBe('app.buildInfo');await reply({debugBuild});return {result:await waiting,allowed:g.allowed};}
  expect(await run(gate)).toEqual(await run(oldGate));
 }
 async function run(api:any){const g=new api.DebugGate(),waiting=g.initialize(()=>application.buildInfo());await settle();await reply(null,false);return {result:await waiting,allowed:g.allowed,second:await g.initialize(()=>application.buildInfo())};}
 expect(await run(gate)).toEqual(await run(oldGate));
});
