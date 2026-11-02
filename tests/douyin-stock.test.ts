import {test,expect} from 'bun:test';
import {DouyinStock,stockNetworkAllowed,stockContentKey,type StockPorts} from '../src/douyin/stock.ts';
import type {DouyinItem} from '../src/douyin/types.ts';
const item=(id:string):DouyinItem=>({awemeId:id,playUrl:`https://cdn.test/${id}?x-expires=9999999999`,description:id,createdAtSeconds:0,authorId:'author',authorName:'fixture',durationMs:30000,likeCount:0,commentCount:0,shareCount:0,collectCount:0,variants:[]});
function fixture(){
 let disk:unknown=[],now=1000,allowed=true,feedCalls=0,prepareCalls=0,network=0,watched:string[]=[];
 const bytes=new Map<string,Uint8Array>(),frames=new Set<string>();
 const ports:StockPorts={read:()=>structuredClone(disk),write:e=>{disk=structuredClone(e);},now:()=>now,allowed:async()=>allowed,watched:async()=>watched,feed:async()=>{feedCalls++;network++;return ['a','b','c','d','e'].map(item);},prepare:async i=>{prepareCalls++;network++;bytes.set(i.awemeId,new Uint8Array([1,2,3,4]));frames.add(i.awemeId);return {ready:true,prefixBytes:4,tailBytes:0};},lookup:async e=>bytes.has(e.item.awemeId)&&frames.has(e.item.awemeId)?`cache:${e.item.awemeId}`:undefined,cancel:()=>{}};
 return {ports,bytes,frames,setNow:(n:number)=>now=n,setAllowed:(v:boolean)=>allowed=v,setWatched:(v:string[])=>watched=v,counts:()=>({feedCalls,prepareCalls,network}),disk:()=>disk};
}
test('restart restores three complete stock entries and serves bytes without feed or prepare',async()=>{
 const f=fixture();await new DouyinStock(f.ports).resume();expect((f.disk() as any[])).toHaveLength(3);
 const before=f.counts();f.setAllowed(false);const restarted=new DouyinStock(f.ports);
 expect((await restarted.restore()).map(i=>i.awemeId)).toEqual(['a','b','c']);expect(await restarted.lookup('a')).toBe('cache:a');expect(f.bytes.get('a')).toEqual(new Uint8Array([1,2,3,4]));expect(f.counts()).toEqual(before);
});
test('expiry skips offline; online replenishes exclusively through feed',async()=>{
 const f=fixture();await new DouyinStock(f.ports).resume();f.setNow(9999999999000);f.setAllowed(false);
 const stock=new DouyinStock(f.ports);expect(await stock.restore()).toEqual([]);expect(await stock.lookup('a')).toBeUndefined();await stock.resume();expect(f.counts().feedCalls).toBe(1);
 f.setNow(1000);f.setAllowed(true);await stock.resume();expect(f.counts().feedCalls).toBe(2);
});
test('traffic disabled and foreground suspension stop admissions and fence late completions',async()=>{
 const f=fixture();f.setAllowed(false);const stock=new DouyinStock(f.ports);await stock.resume();expect(f.counts().network).toBe(0);
 let finish!:(v:any)=>void;f.setAllowed(true);f.ports.prepare=()=>new Promise(r=>finish=r);
 const running=stock.resume();while(!finish)await Promise.resolve();stock.suspend();finish({ready:true,prefixBytes:4,tailBytes:0});await running;expect(f.disk()).toEqual([]);
});
test('consumed and watched items leave stock and refill stays bounded',async()=>{
 const f=fixture();const stock=new DouyinStock(f.ports);await stock.resume();stock.consume('a');f.setWatched(['a','b']);await stock.resume();
 expect((await stock.restore()).map(i=>i.awemeId)).toEqual(['c','d','e']);expect((f.disk() as any[])).toHaveLength(3);
});
test('no decoded poster or evicted bytes means no stock admission',async()=>{
 const f=fixture();f.ports.prepare=async()=>({ready:false,prefixBytes:4,tailBytes:0});const stock=new DouyinStock(f.ports);await stock.resume();expect(await stock.restore()).toEqual([]);
 const g=fixture();await new DouyinStock(g.ports).resume();g.bytes.delete('a');g.frames.delete('b');expect((await new DouyinStock(g.ports).restore()).map(i=>i.awemeId)).toEqual(['c']);
});
test('Wi-Fi unmetered default, explicit transport opt-in, and traffic saving',()=>{
 const wifi={active:true,internet:true,validated:true,wifi:true,cellular:false,bluetooth:false,metered:false};
 expect(stockNetworkAllowed(wifi,false)).toBe(true);expect(stockNetworkAllowed(wifi,true)).toBe(false);expect(stockNetworkAllowed({...wifi,metered:true},false)).toBe(false);expect(stockNetworkAllowed({...wifi,metered:undefined},false)).toBe(false);expect(stockNetworkAllowed({...wifi,wifi:false,cellular:true},false)).toBe(false);expect(stockNetworkAllowed({...wifi,wifi:false,cellular:true},false,false)).toBe(true);
});
test('content key ignores rotating signature while rendition changes invalidate bytes',()=>{
 const a=item('a');a.variants=[{playUrl:a.playUrl,codec:'h264',width:320,height:240,bitrate:100000}];
 const b={...a,playUrl:'https://other.test/refreshed?token=2',variants:[{...a.variants[0],playUrl:'https://other.test/refreshed?token=2'}]};
 expect(stockContentKey(a)).toBe(stockContentKey(b));expect(stockContentKey({...b,variants:[{...b.variants[0],bitrate:200000}]})).not.toBe(stockContentKey(a));
});

test('unchanged admitted network publications preserve one in-flight preparation; actual loss cancels',async()=>{
 const f=fixture();let finish!:()=>void,cancels=0,prepares=0;
 f.ports.cancel=()=>{cancels++;};f.ports.prepare=async()=>{prepares++;await new Promise<void>(yes=>finish=yes);return {ready:true,prefixBytes:4,tailBytes:0};};
 const stock=new DouyinStock(f.ports),running=stock.resume();while(!finish)await Promise.resolve();
 const updates=Array.from({length:5},()=>stock.networkChanged());for(let i=0;i<20;i++)await Promise.resolve();
 expect(cancels).toBe(0);expect(prepares).toBe(1);f.setAllowed(false);await stock.networkChanged();expect(cancels).toBe(1);
 finish();await Promise.all([running,...updates]);expect(f.disk()).toEqual([]);
});
test('a network check that resolves after leaving home cannot restart stock',async()=>{
 const f=fixture();let yes!:(v:boolean)=>void;f.ports.allowed=()=>new Promise(r=>yes=r);const stock=new DouyinStock(f.ports);
 const pending=stock.networkChanged();stock.suspend();yes(true);await pending;expect(f.counts().network).toBe(0);
});

test('concurrent persisted readiness reads retain feed order and a consumed late result is rejected',async()=>{
 const f=fixture();await new DouyinStock(f.ports).resume();const completions=new Map<string,(value:string)=>void>();f.ports.lookup=entry=>new Promise(yes=>completions.set(entry.item.awemeId,yes));
 const stock=new DouyinStock(f.ports),pending=stock.restore();while(completions.size<3)await Promise.resolve();
 completions.get('c')!('cache:c');completions.get('b')!('cache:b');completions.get('a')!('cache:a');expect((await pending).map(i=>i.awemeId)).toEqual(['a','b','c']);
 const late=stock.ready('b');while(!completions.get('b'))await Promise.resolve();stock.consume('b');completions.get('b')!('cache:b');expect(await late).toBeUndefined();
});
