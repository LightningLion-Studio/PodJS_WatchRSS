import { expect, test } from "bun:test";
import { homeChannelAtLongPress, homeEntryAtLongPress, movableHomeEntries, shouldShowHomeEmptyState, type HomeHitEntry } from "../src/ui/home-model.ts";
import type { Channel } from "../src/ui/service.ts";

const channel=(id:string,sortOrder:number,isPinned=false):Channel=>({id,title:id,url:`https://example.test/${id}`,sortOrder,isPinned});

test("home movable entries match native pinned and descending sort order including notes",()=>{
  const entries=movableHomeEntries([
    channel("older",10),channel("pinned-older",20,true),channel("newer",30),channel("pinned-newer",40,true),
  ],{sortOrder:25,isPinned:false});
  expect(entries.map(entry=>entry.kind==="notes"?"notes":entry.channel.id)).toEqual([
    "pinned-newer","pinned-older","newer","notes","older",
  ]);
});

test("home long press resolves only channel cards with scroll offset and native gaps",()=>{
  const first=channel("first",10),second=channel("second",20);
  const entries:HomeHitEntry[]=[{height:73},{height:65},{height:84,channel:first},{height:84,channel:second},{height:65}];
  expect(homeChannelAtLongPress(entries,100,18+73+6+65+6,233,0)).toBe(first);
  expect(homeChannelAtLongPress(entries,100,18+73+6+65+6+84,233,0)).toBeNull();
  expect(homeChannelAtLongPress(entries,100,18+73+6+65+6,233,90)).toBe(second);
  expect(homeChannelAtLongPress(entries,17,200,233,0)).toBeNull();
});

test("home long press also resolves the movable notes entry like native ChannelActions",()=>{
  const first=channel("first",10);
  const entries:HomeHitEntry[]=[{height:73},{height:65,notes:true},{height:84,channel:first},{height:65}];
  expect(homeEntryAtLongPress(entries,100,18+73+6,233,0)).toEqual({kind:"notes"});
  expect(homeEntryAtLongPress(entries,100,18+73+6+65+6,233,0)).toEqual({kind:"channel",channel:first});
  expect(homeEntryAtLongPress(entries,100,18,233,0)).toBeNull();
  expect(homeEntryAtLongPress(entries,17,120,233,0)).toBeNull();
});

test("home empty state appears only after the loaded channel collection is empty",()=>{
  expect(shouldShowHomeEmptyState([])).toBe(true);
  expect(shouldShowHomeEmptyState([channel("builtin",1)])).toBe(false);
});
