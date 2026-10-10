import {afterEach,expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
import {AcousticExternalRequest,parseAcousticLaunch} from '../../src/phoneconnection/external.ts';
import {AcousticConnectionProtocol} from '../../src/phoneconnection/protocol.ts';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'acoustic-launch-solid',setup(builder){builder.onLoad({filter:/\/ui\/AcousticConnectionScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>({View:(props:any)=>props,Text:(props:any)=>props}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(text:string)=>text.length*7})}));
mock.module('../../src/debug/host.ts',()=>({debugGate:{require(){}}}));
let life:(state:string)=>void=()=>{},expire:()=>void=()=>{},timerCancelled=false,url:(url:string)=>void=()=>{},calls:string[]=[];
mock.module('../../src/ui/round-rows.tsx',()=>({chunkLines:(lines:string[])=>[lines]}));
mock.module('@podjs/framework/watch',()=>({onLifecycleChange:(callback:typeof life)=>{life=callback;return ()=>{};}}));
mock.module('@podjs/framework/services',()=>({base64ToBytes:(value:string)=>new Uint8Array(Buffer.from(value,'base64')),delay:()=>({result:new Promise<void>(resolve=>{expire=resolve;}),cancel(){timerCancelled=true;}})}));
mock.module('../../src/phoneconnection/host.ts',()=>({createAcousticConnection:(_changed:any,onUrl:typeof url)=>{url=onUrl;return {protocol:new AcousticConnectionProtocol({encode:value=>new TextEncoder().encode(value),decode:value=>new TextDecoder().decode(value)}),select:async()=>{calls.push('select');},start:async()=>{calls.push('start');},debugGuidedPayload:async()=>{calls.push('payload');},cancel:async()=>{calls.push('cancel');}};}}));
mock.module('../../src/ui/ScrollEntries.tsx',()=>({ScrollEntries:()=>null}));
mock.module('../../src/ui/WatchProgressIndicator.tsx',()=>({WatchProgressIndicator:()=>null}));
const {AcousticConnectionScreen}=await import('../../src/ui/AcousticConnectionScreen.tsx');
const disposers:(()=>void)[]=[];afterEach(()=>{for(const stop of disposers.splice(0))stop();});
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function mount(activeInitially:boolean){
 calls=[];timerCancelled=false;const request=new AcousticExternalRequest(parseAcousticLaunch({debug_auto_listen:true,return_remote_url:true}),Date.now()+120000);
 const [active,setActive]=createSignal(activeInitially);let dispose!:()=>void;
 createRoot(stop=>{dispose=stop;disposers.push(stop);return AcousticConnectionScreen({width:233,height:233,active,entry:{page:'debug-tools',acousticRequest:request},services:{} as any,onUrl:()=>{throw Error('return must bypass inbox');}});});
 return {request,setActive,dispose};
}
test('cold launch waits for active page, then executes once and returns URL through its own request',async()=>{
 const f=mount(false);life('inactive');await tick();expect(calls).toEqual([]);expect(f.request.closed).toBe(false);
 f.setActive(true);await tick();expect(calls).toEqual(['select','start']);url('https://example.com/rss');expect((await f.request.result).result).toEqual({code:-1,extras:{remote_url:'https://example.com/rss'}});
 f.setActive(true);await tick();expect(calls.filter(value=>value==='start')).toHaveLength(1);f.dispose();expect(timerCancelled).toBe(true);
});
test('deactivation and deadline close owner; later URL cannot return success',async()=>{
 for(const deadline of [false,true]){const f=mount(true);await tick();if(deadline){expire();await tick();}else f.setActive(false);await tick();url('late');expect((await f.request.result).result).toEqual({code:0});expect(calls).toContain('cancel');f.dispose();expect(timerCancelled).toBe(true);}
});
