import {expect,test} from "bun:test";
import {availableLoopModes,nextLoopMode,VideoAutoAdvance,VideoLoopPreferences,VideoViewingProgress} from "../src/media/loop-mode.ts";
import {createBiliPlaybackCheckpoint} from "../src/bili/playback.ts";

test("platform modes cycle independently and survive reopening; invalid/unsupported saved modes use off",()=>{
  const data=new Map<string,unknown>(),storage={get:<T>(key:string)=>data.get(key) as T|undefined,set:(key:string,value:unknown)=>data.set(key,value)};
  const prefs=new VideoLoopPreferences(storage),douyin=availableLoopModes("douyin",true),bili=availableLoopModes("bili",true);
  expect(douyin).toEqual(["off","single","next"]);expect(bili).toEqual(["off","single"]);
  expect(availableLoopModes("douyin")).toEqual(bili);
  expect([nextLoopMode("off",douyin),nextLoopMode("single",douyin),nextLoopMode("next",douyin)]).toEqual(["single","next","off"]);
  expect(nextLoopMode("single",bili)).toBe("off");
  prefs.save("douyin","next");prefs.save("bili","single");
  const reopened=new VideoLoopPreferences(storage);
  expect(reopened.load("douyin",douyin)).toBe("next");expect(reopened.load("bili",bili)).toBe("single");
  expect(reopened.load("douyin",bili)).toBe("off");prefs.save("bili","next");expect(reopened.load("bili",bili)).toBe("off");
});

test("native repeats complete one viewing even when the whole short clip loops between polls; seek is not completion",()=>{
  const progress=new VideoViewingProgress(),state={state:"playing",positionMs:700,durationMs:1000,completedLoops:0};
  expect(progress.observe(state).completed).toBe(false);
  expect(progress.observe({...state,positionMs:10}).completed).toBe(false);
  expect(progress.observe({...state,positionMs:20,completedLoops:3})).toMatchObject({completed:true,positionMs:1000});
  expect(progress.observe({...state,positionMs:30,completedLoops:4})).toMatchObject({completed:false,positionMs:1000});
  expect(progress.checkpoint(30,1000)).toEqual({positionMs:1000,durationMs:1000});
  expect(progress.observe({...state,state:"ended"})).toMatchObject({completed:false,firstEnd:true});
  expect(progress.observe({...state,state:"ended"}).firstEnd).toBe(false);
  progress.reset();expect(progress.observe({...state,positionMs:0})).toMatchObject({completed:false,positionMs:0});
});

test("Bili loop playback reports one ready and one completion, never a new lap or a zero resume checkpoint",async()=>{
  const data=new Map<string,string>(),reports:number[]=[];
  const checkpoint=createBiliPlaybackCheckpoint({storage:{get:async k=>data.get(k),set:async(k,v)=>{data.set(k,v);},delete:async k=>{data.delete(k);}},reporter:{reportHistory:async input=>{reports.push(input.progressSeconds!);}},target:{aid:1,cid:2},remoteReportIntervalMs:1000});
  const viewing=new VideoViewingProgress();await checkpoint.onCheckpoint("ready",0,1000);
  for(const completedLoops of [0,1,2,3]){
    const p=viewing.observe({state:"playing",positionMs:50,durationMs:1000,completedLoops});
    if(p.completed)await checkpoint.onCheckpoint("ended",p.positionMs,p.durationMs);
    else if(p.reportProgress)await checkpoint.onProgress(p.positionMs,p.durationMs);
  }
  const p=viewing.checkpoint(10,1000);await checkpoint.onCheckpoint("pause_or_exit",p.positionMs,p.durationMs);
  expect(reports).toEqual([0,1]);expect(data.size).toBe(0);
});

test("off/single do not advance; next claims one end, stops at the tail and resumes for a new source",async()=>{
  const next=new VideoAutoAdvance();let previews=0,advances=0;
  const preview=async()=>{previews++;return true;},advance=async()=>{advances++;};
  await next.ended("off",preview,advance);await next.ended("single",preview,advance);expect(previews).toBe(0);
  await Promise.all([next.ended("next",preview,advance),next.ended("next",preview,advance)]);expect(advances).toBe(1);
  next.reset();await next.ended("next",async()=>false,advance);expect(advances).toBe(1);
  next.reset();await next.ended("next",preview,advance);expect(advances).toBe(2);
});

test("cancel invalidates an outstanding auto-next preview",async()=>{
  const next=new VideoAutoAdvance();let finish!:(value:boolean)=>void,advanced=false;
  const pending=next.ended("next",()=>new Promise(r=>finish=r),async()=>{advanced=true;});
  next.cancel();finish(true);await pending;expect(advanced).toBe(false);
});
