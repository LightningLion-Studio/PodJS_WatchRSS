import {expect,test} from "bun:test";
import {AutoScrollAwakeLease,type AutoScrollAwakeState} from "../../src/reader/keep-awake.ts";
const running:AutoScrollAwakeState={enabled:true,scrolling:true,active:true,foreground:true};

test("display lease exists only for enabled, running, visible foreground auto-scroll",async()=>{
  const calls:boolean[]=[],lease=new AutoScrollAwakeLease(async(_owner,active)=>{calls.push(active);});
  for(const field of ["enabled","scrolling","active","foreground"] as const){
    await lease.update({...running,[field]:false});expect(calls.at(-1)).not.toBe(true);
    await lease.update(running);expect(calls.at(-1)).toBe(true);
    await lease.update({...running,[field]:false});expect(calls.at(-1)).toBe(false);
  }
  await lease.update(running);await lease.update(running);await lease.close();
  expect(calls.slice(-2)).toEqual([true,false]);
  await lease.update(running);expect(calls.at(-1)).toBe(false);
});

test("pause/background/exit while acquire is pending always releases after the late acquire",async()=>{
  for(const field of ["scrolling","foreground","active","close"]){
    const calls:boolean[]=[];let finish!:()=>void;
    const lease=new AutoScrollAwakeLease(async(_owner,active)=>{calls.push(active);if(active)await new Promise<void>(r=>finish=r);});
    const acquire=lease.update(running);
    const release=field==="close"?lease.close():lease.update({...running,[field]:false});
    finish();await Promise.all([acquire,release]);expect(calls).toEqual([true,false]);
  }
});

test("failed/uncertain acquire still attempts release, and reader owners stay independent",async()=>{
  let finish!:()=>void;const calls:boolean[]=[],errors:unknown[]=[];
  const a=new AutoScrollAwakeLease(async(_owner,active)=>{calls.push(active);if(active){await new Promise<void>(r=>finish=r);throw Error("transport");}},e=>errors.push(e));
  const b=new AutoScrollAwakeLease(async()=>{});expect(a.owner).not.toBe(b.owner);
  const task=a.update(running),closed=a.close();finish();await Promise.all([task,closed]);
  expect(calls).toEqual([true,false]);expect(errors).toHaveLength(1);
});

test("unmount retries a transient release failure without depending on another render",async()=>{
  const calls:boolean[]=[];let failed=false;
  const lease=new AutoScrollAwakeLease(async(_owner,active)=>{calls.push(active);if(!active&&!failed){failed=true;throw Error("transient");}});
  await lease.update(running);await lease.close();expect(calls).toEqual([true,false,false]);
});

test("release queued between acquire continuation and drain finalization is not lost",async()=>{
  const calls:boolean[]=[];let finish!:()=>void;
  const lease=new AutoScrollAwakeLease(async(_owner,active)=>{calls.push(active);if(active)await new Promise<void>(r=>finish=r);});
  const acquired=lease.update(running);finish();
  const close=Promise.resolve().then(()=>Promise.resolve()).then(()=>lease.close());
  await Promise.all([acquired,close]);expect(calls).toEqual([true,false]);
});
