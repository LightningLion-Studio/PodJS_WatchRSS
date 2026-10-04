import { expect, test } from "bun:test";
import { applyCrownVolumeGuard, scaledCrownVolumeDelta, CrownVolumeController, type CrownVolumeDisplay } from "../src/media/crown-volume.ts";
import native from "./fixtures/crown-volume-native.json";
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const f=Math.fround;

test("every continuous guard decision matches unchanged Kotlin including exact idle boundary",()=>{
  for(const row of native.cases){
    expect(scaledCrownVolumeDelta(row.raw,row.min,row.max)).toBe(f(row.delta));
    const previous={...row.previous,cap:row.previous.cap===null?null:f(row.previous.cap)};
    const result=applyCrownVolumeGuard(f(row.current),f(row.delta),row.min,row.max,row.enabled,previous,row.eventMs);
    expect(result).toEqual({target:f(row.target),state:{...row.next,cap:row.next.cap===null?null:f(row.next.cap)},notify:row.notify});
  }
});
function harness(){
  let actual={min:0,max:15,current:0,fixed:false};const writes:number[]=[],display:CrownVolumeDisplay[]=[];
  let notified=0,reads=0,hidden:(()=>void)|undefined;const timers:number[]=[];
  const controller=new CrownVolumeController({state:async()=>{reads++;return actual;},setIndex:async(index)=>{writes.push(index);return actual={...actual,current:index};}},
    {after:(ms,callback)=>{timers.push(ms);hidden=callback;return()=>{if(hidden===callback)hidden=undefined;};}},
    value=>display.push(value),()=>notified++);
  return {controller,writes,display,timers,notified:()=>notified,reads:()=>reads,set:(patch:Partial<typeof actual>)=>{actual={...actual,...patch};},hide:()=>hidden?.()};
}
test("burst retains every guard transition but coalesces host writes and shows virtual 21 percent",async()=>{
  const h=harness();for(let i=0;i<100;i++)h.controller.adjust(-10,i,true);await settle();
  expect(h.writes).toEqual([3]);expect(h.reads()).toBe(1);expect(h.notified()).toBe(1);
  expect(h.display.at(-1)).toEqual({visible:true,percent:21});expect(h.timers).toEqual([1200]);
  h.controller.adjust(-400,699,true);await settle();expect(h.notified()).toBe(1);expect(h.writes).toEqual([3]);
  h.controller.adjust(-400,1300,true);await settle();expect(h.writes).toEqual([3,7]);expect(h.display.at(-1)?.percent).toBe(45);
  h.hide();expect(h.display.at(-1)?.visible).toBe(false);
});
test("reverse motion and external system changes reset the guard session",async()=>{
  const h=harness();h.controller.adjust(-400,0,true);await settle();
  h.controller.adjust(100,10,true);await settle();h.controller.adjust(-400,20,true);await settle();expect(h.notified()).toBe(2);
  h.set({current:8});h.controller.adjust(-100,30,true);await settle();expect(h.writes.at(-1)).toBe(9);expect(h.notified()).toBe(2);
});
test("fixed volume shows fractional motion without writes and reset hides pending UI",async()=>{
  const h=harness();h.set({fixed:true});h.controller.adjust(-10,0,false);await settle();expect(h.writes).toEqual([]);
  expect(h.display.at(-1)).toEqual({visible:true,percent:1});h.controller.reset();h.hide();expect(h.display.at(-1)?.visible).toBe(false);
});
test("leaving the page while reading volume drops the write and notification",async()=>{
  let resolve!:(value:{min:number;max:number;current:number;fixed:boolean})=>void;
  let writes=0,notifications=0;
  const controller=new CrownVolumeController({state:()=>new Promise(r=>resolve=r),setIndex:async()=>{writes++;return {min:0,max:15,current:3,fixed:false};}},
    {after:()=>()=>{}},()=>{},()=>notifications++);
  controller.adjust(-500,0,true);controller.reset();resolve({min:0,max:15,current:0,fixed:false});await settle();
  expect(writes).toBe(0);expect(notifications).toBe(0);
});
test("a slow host write keeps new events ordered and a failed read permits retry",async()=>{
  let current=0,fail=true,release:(()=>void)|undefined;const writes:number[]=[],errors:unknown[]=[];
  const controller=new CrownVolumeController({state:async()=>{if(fail){fail=false;throw new Error("read failed");}return {min:0,max:15,current,fixed:false};},setIndex:async(index)=>{writes.push(index);await new Promise<void>(r=>release=r);current=index;return {min:0,max:15,current,fixed:false};}},
    {after:()=>()=>{}},()=>{},()=>{},error=>errors.push(error));
  controller.adjust(-100,0,false);await settle();expect(errors).toHaveLength(1);
  controller.adjust(-100,1,false);await settle();expect(writes).toEqual([1]);
  controller.adjust(-100,2,false);release?.();await settle();expect(writes).toEqual([1,2]);release?.();await settle();
});
