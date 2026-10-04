import {describe,expect,it} from "bun:test";
import {readerReachedBottom,shouldAutoRemoveWatchLater} from "../src/reader/watch-later-completion.ts";

describe("watch-later reader completion",()=>{
  it("uses the native eight-pixel bottom tolerance, including short documents",()=>{
    expect(readerReachedBottom(500,300,192)).toBe(true);
    expect(readerReachedBottom(500,300,191)).toBe(false);
    expect(readerReachedBottom(280,300,0)).toBe(false);
    expect(readerReachedBottom(300,300,0)).toBe(true);
  });
  it("removes only when the reader came from watch later and is still saved there",()=>{
    expect(shouldAutoRemoveWatchLater(true,true,true)).toBe(true);
    expect(shouldAutoRemoveWatchLater(false,true,true)).toBe(false);
    expect(shouldAutoRemoveWatchLater(true,false,true)).toBe(false);
    expect(shouldAutoRemoveWatchLater(true,true,false)).toBe(false);
  });
});
