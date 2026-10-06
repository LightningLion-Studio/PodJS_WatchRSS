import {expect,test} from "bun:test";
import {createEffect,createRoot,createSignal} from "solid-js";
import {updateSystemCarets} from "../src/reader/system-carets.ts";

test("repeated raster cleanup and identical caret delivery do not invalidate reader observers",()=>{
  const row={},other={};let dispose=()=>{};
  const [carets,setCarets]=createSignal<ReadonlyMap<object,readonly number[]>>(new Map());
  const observed:(readonly number[]|undefined)[]=[];
  createRoot(stop=>{dispose=stop;createEffect(()=>{observed.push(carets().get(row));});});
  const deliver=(key:object,positions:readonly number[]|undefined)=>setCarets(previous=>updateSystemCarets(previous,key,positions));
  for(let i=0;i<250;i++)deliver(row,undefined);
  expect(observed).toEqual([undefined]);
  deliver(row,[0,8,18]);
  for(let i=0;i<250;i++)deliver(row,[0,8,18]);
  expect(observed).toEqual([undefined,[0,8,18]]);
  deliver(other,[0,12]);deliver(row,[0,9,20]);
  expect(carets().get(row)).toEqual([0,9,20]);expect(carets().get(other)).toEqual([0,12]);
  expect(observed.length).toBe(4);
  deliver(row,undefined);
  for(let i=0;i<250;i++)deliver(row,undefined);
  expect(observed.at(-1)).toBeUndefined();expect(observed.length).toBe(5);
  expect(carets().get(other)).toEqual([0,12]);dispose();
});
