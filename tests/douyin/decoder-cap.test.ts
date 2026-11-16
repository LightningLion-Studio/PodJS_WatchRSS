import {expect,test} from 'bun:test';
import {DouyinVideoSessionPool,shouldFallbackFromVideoSessions} from '../../src/ui/douyin/video-sessions.ts';

test('Douyin keeps one neighbour even when the native host offers independent frames and extra sessions',async()=>{
 const released:string[]=[];
 const pool=new DouyinVideoSessionPool({
  capabilities:async()=>({decoderLimit:3,maxSessions:4,independentKeyframes:true,keyframeCache:true,surfacePromotion:true,verticalTransition:true}),
  release:async(id:string)=>{released.push(id);return {sessionId:id,released:true};},
 } as any);
 expect(await pool.supportsPrewarm()).toBe(true);
 expect(pool.neighbourCapacity).toBe(1);
 await pool.warmNeighbourhood([async()=>{throw Error('must not decode distant frames');}]);
});

// Same offered capacity and concurrent directions as the DYSWIPE review probe.
// Visibility never deletes a player: only an acknowledged release does.
function residentPort(){
 const live=new Map<string,any>(),released:string[]=[];let peak=0;
 const state=(id:string,warm=false)=>({ok:true,sessionId:id,state:warm?'prewarmed':'ready',positionMs:0,durationMs:1000,width:240,height:240,volume:1,prewarming:warm,presented:!warm,hasRenderedFirstFrame:true,hasCachedFirstFrame:false,targetBufferBytes:6291456});
 const port:any={
  capabilities:async()=>({decoderLimit:3,maxSessions:4,independentKeyframes:true,keyframeCache:true,surfacePromotion:true,verticalTransition:true}),
  prepare:(options:any)=>{
   if(!live.has(options.sessionId)&&live.size>=3)throw Error('fourth physical decoder');
   const value=state(options.sessionId,options.prewarm);live.set(options.sessionId,value);peak=Math.max(peak,live.size);
   return {result:Promise.resolve(value),cancel(){}};
  },
  state:async(id:string)=>live.get(id),setLoop:async(id:string)=>live.get(id),
  setBounds:async(id:string,options:any)=>{Object.assign(live.get(id),{presented:options.visible!==false});return live.get(id);},
  retire:async(id:string)=>{const value=live.get(id);if(value)Object.assign(value,{prewarming:true,presented:false});return value;},
  promote:async(id:string,options:any)=>{const old=live.get(options.replaceSessionId);if(old)Object.assign(old,{prewarming:true,presented:false});const value=live.get(id);Object.assign(value,{prewarming:false,presented:true});return {...value,replacedHasRenderedFirstFrame:true};},
  transition:async(options:any)=>({...options,composited:true,fromOffsetYPx:0,toOffsetYPx:0}),
  release:async(id:string)=>{released.push(id);return {sessionId:id,released:live.delete(id)};},
 };
 return {live,port,released,peak:()=>peak};
}
const bounds={x:0,y:0,width:233,height:233};
const source=(key:string)=>({key,source:{title:key,url:`local/${key}.mp4`,platform:'douyin' as const,immersive:true}});

test('DECAP concurrent next/previous preparation settles with exactly two resident players',async()=>{
 const f=residentPort(),pool=new DouyinVideoSessionPool(f.port);
 try{
  await pool.supportsPrewarm();await pool.prepare(source('current'),{...source('current').source,bounds}).result;
  const current=[...f.live.keys()][0]!;
  const results=await Promise.allSettled([
   pool.prewarm(source('next'),{...source('next').source,bounds},'next'),
   pool.prewarm(source('previous'),{...source('previous').source,bounds},'prev'),
  ]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1); // Superseded reservation.
  expect(pool.neighbourCapacity).toBe(1);expect(f.live.size).toBe(2);expect(f.live.has(current)).toBe(true);
  expect([...f.live.values()].filter(v=>v.prewarming)).toHaveLength(1);expect(f.peak()).toBeLessThanOrEqual(3);
  expect(f.released).not.toContain(current);
 }finally{await pool.releaseAll();expect(f.live.size).toBe(0);}
});

test('DECAP fifty alternating selections return to current plus one next decoder at every rest',async()=>{
 const f=residentPort(),pool=new DouyinVideoSessionPool(f.port);let selected=100;
 const warm=async(id:number,direction:'next'|'prev')=>pool.prewarm(source(String(id)),{...source(String(id)).source,bounds},direction);
 try{
  await pool.supportsPrewarm();await pool.prepare(source(String(selected)),{...source(String(selected)).source,bounds}).result;
  await warm(selected+1,'next');expect(f.live.size).toBe(2);
  for(let i=0;i<50;i++){
   const sign=i%2===0?1:-1;await warm(selected+sign,sign>0?'next':'prev');
   await pool.transition(.6,sign>0?'up':'down',bounds);const result=await pool.promote(sign>0?'up':'down',bounds);
   selected+=sign;expect(result.source.key).toBe(String(selected));
   pool.retainNeighbours([String(selected+1)]);await warm(selected+1,'next');
   expect(f.live.size).toBe(2);expect([...f.live.values()].filter(v=>!v.prewarming)).toHaveLength(1);
   expect([...f.live.values()].filter(v=>v.prewarming)).toHaveLength(1);
  }
  expect(f.peak()).toBeLessThanOrEqual(3);
 }finally{await pool.releaseAll();expect(f.live.size).toBe(0);}
});

test('DECAP transient admission refusal never requests legacy playback fallback',()=>{
 expect(shouldFallbackFromVideoSessions({code:'decoder_admission_deferred'})).toBe(false);
});
