import {expect,test} from 'bun:test';
import {BiliDetailPreload,type DetailPreloadClock} from '../../src/bili/detail-preload.ts';
import type {BiliPlayUrl} from '../../src/bili/types.ts';
const source:BiliPlayUrl={acceptQuality:[],acceptDescription:[],durl:[{url:'url',backupUrl:[]}]};
function fixture(resolvePlayback: (input:any)=>Promise<BiliPlayUrl>) {
 let now=0;const jobs=new Set<{at:number;run:()=>void}>();
 const clock:DetailPreloadClock={now:()=>now,schedule:(run,delay)=>{const job={at:now+delay,run};jobs.add(job);return()=>{jobs.delete(job);};}};
 return {preload:new BiliDetailPreload({resolvePlayback},clock),async advance(ms:number){now+=ms;for(const job of [...jobs])if(job.at<=now){jobs.delete(job);job.run();}await Promise.resolve();await Promise.resolve();},jobs};
}
const a={aid:1,cid:10},b={aid:1,cid:20};
test('waits 750ms, caches source for 5 minutes, then resolves again',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return source;});f.preload.select(a);await f.advance(749);expect(calls).toBe(0);await f.advance(1);expect(calls).toBe(1);expect(await f.preload.resolve(a)).toBe(source);expect(calls).toBe(1);await f.advance(300000);await f.preload.resolve(a);expect(calls).toBe(2);f.preload.dispose();
});
test('selection cancels previous timer; dispose cancels all scheduled work',async()=>{
 const calls:number[]=[];const f=fixture(async input=>{calls.push(input.cid);return source;});f.preload.select(a);await f.advance(500);f.preload.select(b);await f.advance(250);expect(calls).toEqual([]);await f.advance(500);expect(calls).toEqual([20]);f.preload.select(a);f.preload.dispose();await f.advance(1000);expect(calls).toEqual([20]);
});
test('in-flight playback coalesces, selection cancellation discards old cache result',async()=>{
 const requests:Array<(source:BiliPlayUrl)=>void>=[];const f=fixture(()=>new Promise(resolve=>requests.push(resolve)));f.preload.select(a);await f.advance(750);const click=f.preload.resolve(a);expect(requests).toHaveLength(1);f.preload.select(b);requests[0]!(source);await click;
 f.preload.select(a);const second=f.preload.resolve(a);expect(requests).toHaveLength(2);requests[1]!(source);await second;await f.advance(1000);expect(requests).toHaveLength(2);f.preload.dispose();
});
test('warmup failure is silent and a click retries',async()=>{
 let calls=0;const f=fixture(async()=>{if(++calls===1)throw Error('offline');return source;});f.preload.select(a);await f.advance(750);expect(await f.preload.resolve(a)).toBe(source);expect(calls).toBe(2);f.preload.dispose();
});

test('default clock constructs without an injected clock (production path)', () => {
  const preload = new BiliDetailPreload({ resolvePlayback: async () => { throw new Error('unused'); } });
  expect(preload.warm({ aid: 1, cid: 2 })).toBeUndefined();
  preload.dispose();
});
