import {test,expect} from 'bun:test';
import {__pumpPodEvents} from '@podjs/framework/watch';
import {delay} from '@podjs/framework/services';
import {ManifestContention} from '../../src/sync/manifest-contention';
const nativeSetTimeout=globalThis.setTimeout;
test('default contention wait uses the actual runtime.timer bridge with no JS timer globals',async()=>{
 const previous=(globalThis as any).pod,seen:any[]=[],events:any[]=[];let ticks=0;
 (globalThis as any).pod={capabilities:()=> '["runtime.timer"]',emit:(raw:string)=>{const request=JSON.parse(raw);seen.push(request);nativeSetTimeout(()=>{events.push({t:'service.result',id:request.id,ok:true,value:null});__pumpPodEvents();},request.args.milliseconds);},takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined};
 const saved=globalThis.setTimeout;(globalThis as any).setTimeout=undefined;
 try{
  const db={query:async()=>{ticks++;return [{revision:1,projection_seq:1}];},execute:async()=>{},transaction:async()=>{}};
  const contention=new ManifestContention(db,()=>delay(16).result);await contention.settle(1);
  expect(ticks).toBeGreaterThan(1);expect(seen.length).toBeGreaterThan(0);expect(seen.every(r=>r.method==='runtime.delay'&&r.args.milliseconds===16)).toBe(true);
 }finally{globalThis.setTimeout=saved;(globalThis as any).pod=previous;}
});
