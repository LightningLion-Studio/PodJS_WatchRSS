import {expect,mock,test} from 'bun:test';
import {createRoot,createSignal} from 'solid-js';
const timers:{cancelled:boolean;fire:()=>void}[]=[];let network:(()=>void)|undefined;
mock.module('@podjs/framework/services',()=>({delay:()=>{let resolve!:()=>void;const row={cancelled:false,fire:()=>resolve()};timers.push(row);return {result:new Promise<void>(yes=>resolve=yes),cancel(){row.cancelled=true;}};},onNetworkChange:(fn:()=>void)=>{network=fn;return()=>{network=undefined;};}}));
mock.module('../src/logs/app-logger.ts',()=>({appLogger:{w(){}}}));
const {bindDouyinStockIdle}=await import('../src/douyin/stock-lifecycle.ts');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('unchanged home-idle truth does not cancel a refill when channel/status objects are republished',async()=>{
 let dispose!:()=>void,resumes=0,suspends=0;const [channels,setChannels]=createSignal([{id:1,url:'builtin:douyin'}]),[busy,setBusy]=createSignal(false);
 const stock={resume:async()=>{resumes++;},suspend(){suspends++;}};
 createRoot(stop=>{dispose=stop;bindDouyinStockIdle(stock as any,()=>!busy()&&channels().some(c=>c.url==='builtin:douyin'));});
 expect(timers).toHaveLength(1);for(let i=0;i<5;i++)setChannels([{id:i+2,url:'builtin:douyin'}]);expect(timers).toHaveLength(1);expect(suspends).toBe(0);expect(timers[0].cancelled).toBe(false);
 timers[0].fire();await flush();expect(resumes).toBe(1);setChannels([{id:9,url:'builtin:douyin'}]);expect(suspends).toBe(0);expect(resumes).toBe(1);
 setBusy(true);expect(suspends).toBe(1);expect(timers[0].cancelled).toBe(true);expect(network).toBeUndefined();setBusy(false);expect(timers).toHaveLength(2);timers[1].fire();await flush();expect(resumes).toBe(2);dispose();expect(suspends).toBe(2);
});

test('repeated admitted network callbacks do not discard an in-flight native prefix',async()=>{
 const {DouyinStock}=await import('../src/douyin/stock.ts');let complete!:(v:any)=>void,cancelled=0,prepared=0,dispose!:()=>void;
 const [idle,setIdle]=createSignal(true);
 const stock=new DouyinStock({read:()=>[],write(){},now:()=>1000,allowed:async()=>true,watched:async()=>[],lookup:async()=>undefined,feed:async()=>[{awemeId:'fixture',playUrl:'https://fixture.invalid/v?x-expires=9999999999',durationMs:30000,variants:[]} as any],prepare:()=>{prepared++;return new Promise(yes=>complete=yes);},cancel(){cancelled++;}});
 createRoot(stop=>{dispose=stop;bindDouyinStockIdle(stock,idle);});timers.at(-1)!.fire();await flush();expect(prepared).toBe(1);
 for(let i=0;i<5;i++){network!();await flush();}expect(cancelled).toBe(0);expect(prepared).toBe(1);
 setIdle(false);expect(cancelled).toBe(1);complete({ready:true,prefixBytes:4,tailBytes:0});await flush();dispose();
});
