import { expect, test } from "bun:test";
import { adjacentPlaybackStartVolumeLimit, formatPlaybackStartVolumeLimit, normalizePlaybackStartVolumeLimit, enforcePlaybackStartVolume, playbackStartVolumeTarget, type MediaVolumeState } from "../src/media/start-volume.ts";
import native from "./fixtures/media-start-volume-native.json";

test("settings traverse every native volume option in both directions and wrap unlimited", () => {
  const options = [null, ...Array.from({length:21}, (_, i) => i * 5)];
  for (let i = 0; i < options.length; i++) {
    expect(adjacentPlaybackStartVolumeLimit(options[i], 1)).toBe(options[(i + 1) % options.length]);
    expect(adjacentPlaybackStartVolumeLimit(options[i], -1)).toBe(options[(i + options.length - 1) % options.length]);
    expect(formatPlaybackStartVolumeLimit(options[i])).toBe(i === 0 ? "无限制" : `${options[i]}%`);
  }
  for (const invalid of [-1, 3, 101, 7.5, NaN, Infinity]) {
    expect(normalizePlaybackStartVolumeLimit(invalid)).toBe(10);
    expect(adjacentPlaybackStartVolumeLimit(invalid, -1)).toBe(5);
    expect(adjacentPlaybackStartVolumeLimit(invalid, 1)).toBe(15);
  }
});

test("playback start targets match every captured Kotlin policy decision", () => {
  for (const item of native.cases) {
    expect(playbackStartVolumeTarget(item.limit, {...item, fixed:false})).toBe(item.target);
    expect(playbackStartVolumeTarget(item.limit, {...item, fixed:true})).toBeNull();
  }
});
test("disabled limit does not access host and cancellation after read cannot change system volume", async () => {
  let active=true, reads=0; const writes:number[]=[];
  let resolve!:(state:MediaVolumeState)=>void;
  const port={state:()=>{reads++;return new Promise<MediaVolumeState>(r=>resolve=r);},setIndex:async(index:number)=>{writes.push(index);return {min:0,max:15,current:index,fixed:false};}};
  await enforcePlaybackStartVolume(port,null); expect(reads).toBe(0);
  const pending=enforcePlaybackStartVolume(port,10,()=>active);active=false;
  resolve({min:0,max:15,current:12,fixed:false});await pending;
  expect(writes).toEqual([]);
});
test("new session lowers only a higher volume, with minimum positive step and explicit mute", async () => {
  let state={min:2,max:15,current:12,fixed:false}; const writes:number[]=[];
  const port={state:async()=>state,setIndex:async(index:number)=>{writes.push(index);return state={...state,current:index};}};
  await enforcePlaybackStartVolume(port,5);expect(writes).toEqual([3]);
  await enforcePlaybackStartVolume(port,10);expect(writes).toEqual([3]);
  await enforcePlaybackStartVolume(port,0);expect(writes).toEqual([3,2]);
  await enforcePlaybackStartVolume(port,100);expect(writes).toEqual([3,2]);
});
