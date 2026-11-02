import {describe,expect,test} from "bun:test";
import type {VideoSessionState} from "@podjs/framework/services";
import {
  DouyinVideoSessionPool,
  douyinDecoderProfile,
  douyinPagerProgress,
  douyinPagerSettleProgress,
  shouldFallbackFromVideoSessions,
  shouldSettleDouyinPager,
  shouldUseDouyinVideoSessions,
  type DouyinPreparedSource,
} from "../../src/ui/douyin/video-sessions.ts";

const source=(key:string):DouyinPreparedSource=>({key,source:{immersive:true,awemeId:key,url:`https://video/${key}`,posterUrl:`https://cover/${key}`,title:key,platform:"douyin"}});
const sessionState=(sessionId:string,prewarming=false):VideoSessionState=>({ok:true,sessionId,state:prewarming?"prewarmed":"ready",positionMs:0,durationMs:1000,width:1080,height:1920,muted:prewarming,volume:1,prewarming,presented:!prewarming,hasRenderedFirstFrame:true,targetBufferBytes:6291456});
const bounds={x:0,y:0,width:240,height:240};

function fakePort(decoderLimit=2){
  const calls:{method:string;sessionId?:string;progress?:number;loop?:boolean}[]=[];
  let transitionGate:Promise<void>|undefined;
  return {
    calls,
    async capabilities(){return {capability:"media.video.sessions",maxSessions:2,decoderLimit,decoderInUse:0,targetBufferBytesPerSession:6291456,targetBufferBytesTotal:6291456*decoderLimit,prewarmTimeoutMs:2500,prewarmMode:"hidden_first_frame",surfacePromotion:decoderLimit>=2,verticalTransition:decoderLimit>=2,surfaceComposition:"android_texture_view",backgroundPlayback:false};},
    gateTransition(gate:Promise<void>){transitionGate=gate;},
    prepare(options:any){calls.push({method:options.prewarm?"prewarm":"prepare",sessionId:options.sessionId,loop:options.loop});return {cancel(){calls.push({method:"cancel",sessionId:options.sessionId});},result:Promise.resolve(sessionState(options.sessionId,options.prewarm))};},
    async play(id:string){calls.push({method:"play",sessionId:id});return sessionState(id);},
    async pause(id:string){calls.push({method:"pause",sessionId:id});return sessionState(id);},
    async seek(id:string){return sessionState(id);},async stop(id:string){return sessionState(id);},
    async release(id:string){calls.push({method:"release",sessionId:id});return {sessionId:id,released:true};},
    async setBounds(id:string){return sessionState(id);},async state(id:string){return sessionState(id);},
    async setLoop(id:string,loop:boolean){calls.push({method:"setLoop",sessionId:id,loop});return {...sessionState(id),loop};},
    async setTransform(id:string){return sessionState(id);},async setVolume(id:string){return sessionState(id);},
    async promote(id:string){calls.push({method:"promote",sessionId:id});return {...sessionState(id),state:"playing"};},
    async transition(options:any){calls.push({method:"transition",sessionId:options.toSessionId,progress:options.progress});if(transitionGate){const gate=transitionGate;transitionGate=undefined;await gate;}return {fromSessionId:options.fromSessionId,toSessionId:options.toSessionId,progress:options.progress,direction:options.direction,fromOffsetYPx:0,toOffsetYPx:0,composited:true as const};},
  };
}

describe("Douyin video sessions",()=>{
  test("keeps the complete legacy path on old or non-immersive hosts",()=>{
    expect(shouldUseDouyinVideoSessions(source("1").source,false)).toBe(false);
    expect(shouldUseDouyinVideoSessions({...source("1").source,immersive:false},true)).toBe(false);
    expect(shouldUseDouyinVideoSessions(source("1").source,true)).toBe(true);
  });

  test("rejects the two-player path when the host reports one decoder",async()=>{
    const single=new DouyinVideoSessionPool(fakePort(1) as any);
    expect(await single.supportsPrewarm()).toBe(false);
    const dual=new DouyinVideoSessionPool(fakePort(2) as any);
    expect(await dual.supportsPrewarm()).toBe(true);
  });

  test("passes the selected Douyin codec and dimensions to the host probe",()=>{
    const item={awemeId:"1",description:"",createdAtSeconds:0,authorId:"",authorName:"",likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:"h264",durationMs:0,variants:[
      {playUrl:"h264",codec:"h264" as const,bitrate:1,width:720,height:1280},
      {playUrl:"hevc",codec:"h265" as const,bitrate:1,width:1080,height:1920},
    ]};
    expect(douyinDecoderProfile(item)).toEqual({videoMime:"video/avc",videoWidth:720,videoHeight:1280});
    expect(douyinDecoderProfile(item,"hevc")).toEqual({videoMime:"video/hevc",videoWidth:1080,videoHeight:1920});
  });

  test("matches native positional/velocity settle and cancellation rebound",()=>{
    expect(douyinPagerProgress(-43.2,240)).toBeCloseTo(.18);
    expect(shouldSettleDouyinPager(.179,0,"up")).toBe(false);
    expect(shouldSettleDouyinPager(.18,0,"up")).toBe(true);
    expect(shouldSettleDouyinPager(.05,-125,"up")).toBe(true);
    expect(shouldSettleDouyinPager(.8,125,"up")).toBe(false);
    expect(douyinPagerSettleProgress(.6,0,220)).toBe(0);
  });

  test("coalesces rapid drag updates and promotes by swapping/reusing two slots",async()=>{
    const port=fakePort(),pool=new DouyinVideoSessionPool(port as any);
    await pool.prepare(source("1"),{...source("1").source,bounds}).result;
    await pool.prewarm(source("2"),{...source("2").source,bounds});
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);port.gateTransition(gate);
    const first=pool.transition(.1,"up",bounds),second=pool.transition(.5,"up",bounds),third=pool.transition(.9,"up",bounds);
    await Promise.resolve();release();await Promise.all([first,second,third]);
    expect(port.calls.filter(call=>call.method==="transition").map(call=>call.progress)).toEqual([.1,.9]);
    const promoted=await pool.promote("up",bounds);expect(promoted.source.key).toBe("2");
    await pool.prewarm(source("3"),{...source("3").source,bounds});
    const prepares=port.calls.filter(call=>call.method==="prepare"||call.method==="prewarm");
    expect(prepares[0]!.sessionId).toBe(prepares[2]!.sessionId);
    expect(new Set(prepares.map(call=>call.sessionId)).size).toBe(2);
  });

  test("classifies service errors for legacy degradation and releases every slot",async()=>{
    expect(shouldFallbackFromVideoSessions(new Error("video_decoder_limit"))).toBe(true);
    expect(shouldFallbackFromVideoSessions(new Error("cancelled"))).toBe(false);
    const port=fakePort(),pool=new DouyinVideoSessionPool(port as any);
    await pool.prepare(source("1"),{...source("1").source,bounds}).result;
    await pool.releaseAll();
    expect(port.calls.filter(call=>call.method==="release")).toHaveLength(3);
    expect(new Set(port.calls.filter(call=>call.method==="release").map(call=>call.sessionId)).size).toBe(2);
  });
});

test('session diagnostics follow real slot roles, host states, promotion and owner generation',async()=>{
 const port=fakePort(),pool=new DouyinVideoSessionPool(port as any);
 await pool.prepare(source('101'),{url:'https://video/101',bounds} as any).result;
 await pool.prewarm(source('102'),{url:'https://video/102',bounds} as any);
 const initial=await pool.diagnostics();expect(initial?.slots.map(s=>[s.role,s.awemeId,s.bound])).toEqual([['active','101',true],['standby','102',true]]);expect(initial?.standbyReady).toBe(true);expect(initial?.capabilities?.targetBufferBytesTotal).toBe(12582912);
 await pool.promote('up',bounds);const promoted=await pool.diagnostics();expect(promoted?.slots[0]?.sessionId).toBe(initial?.slots[1]?.sessionId);expect(promoted?.slots[0]?.awemeId).toBe('102');expect(promoted?.slots[1]?.awemeId).toBe('101');expect(promoted?.slots[1]?.bound).toBe(true);
 let finish!:(value:any)=>void;port.capabilities=()=>new Promise(r=>finish=r);const stale=pool.diagnostics();await pool.releaseAll();finish({});expect(await stale).toBeUndefined();expect(port.calls.filter(c=>c.method==='play')).toEqual([]);
});

 test("loop mode is applied to active, prewarmed and promoted slots without preparing them again",async()=>{
  const port=fakePort(),pool=new DouyinVideoSessionPool(port as any);
  await pool.prepare(source("1"),{bounds,loop:false}).result;
  await pool.prewarm(source("2"),{bounds,loop:true});
  expect(port.calls.filter(c=>c.method==="prewarm")[0]?.loop).toBe(false);
  const prepares=port.calls.filter(c=>c.method==="prepare"||c.method==="prewarm").length;
  await pool.setLoop(true);expect(port.calls.slice(-2).map(c=>c.loop)).toEqual([true,true]);
  await pool.promote("up",bounds);await pool.setLoop(false);
  expect(port.calls.at(-1)).toMatchObject({method:"setLoop",loop:false});
  await pool.prewarm(source("3"),{bounds,loop:true});expect(port.calls.filter(c=>c.method==="prewarm").at(-1)?.loop).toBe(false);
  expect(port.calls.filter(c=>c.method==="prepare"||c.method==="prewarm")).toHaveLength(prepares+1);
 });
 test("a mode change while prewarm is pending is applied before it can be promoted",async()=>{
  const port=fakePort(),pool=new DouyinVideoSessionPool(port as any);
  await pool.prepare(source("1"),{bounds,loop:false}).result;
  let finish!:(value:VideoSessionState)=>void;let id="";
  port.prepare=(options:any)=>{id=options.sessionId;return {cancel(){},result:new Promise(r=>finish=r)};};
  const pending=pool.prewarm(source("2"),{bounds,loop:false});await pool.setLoop(true);
  finish(sessionState(id,true));await pending;
  expect(port.calls.at(-1)).toMatchObject({method:"setLoop",sessionId:id,loop:true});expect(pool.hasStandby("2")).toBe(true);
 });

 test("a loop toggle during standby setLoop acknowledgment cannot publish a slot with stale repeat mode",async()=>{
  const port=fakePort(),pool=new DouyinVideoSessionPool(port as any);await pool.prepare(source("1"),{bounds,loop:false}).result;
  let finish!:()=>void;const nativeSetLoop=port.setLoop;let deferred=true;
  port.setLoop=async(id,loop)=>{const value=await nativeSetLoop(id,loop);if(deferred&&id.endsWith("b")){deferred=false;await new Promise<void>(r=>finish=r);}return value;};
  const pending=pool.prewarm(source("2"),{bounds,loop:false});for(let i=0;i<5;i++)await Promise.resolve();
  await pool.setLoop(true);finish();await pending;
  expect(port.calls.at(-1)).toMatchObject({method:"setLoop",loop:true});expect(pool.hasStandby("2")).toBe(true);
 });
