import {expect,test} from "bun:test";
import {RawTextHistory} from "../src/notes/raw-text-history.ts";

test("nearby typed characters group; separated edits and undo/redo retain text",()=>{
  let now=0;
  const history=new RawTextHistory("",()=>now);
  history.record("一");now=100;history.record("一二");
  expect(history.undo()).toBe("");
  expect(history.redo()).toBe("一二");
  now=1000;history.record("一二三");
  expect(history.undo()).toBe("一二");
  expect(history.undo()).toBe("");
  history.record("新");
  expect(history.canRedo).toBe(false);
});

test("distant replacement and deletion have separate history steps",()=>{
  let now=0;
  const history=new RawTextHistory("abcdef",()=>now);
  history.record("xbcdef");now=50;history.record("xbcdey");
  expect(history.undo()).toBe("xbcdef");
  expect(history.undo()).toBe("abcdef");
  now=100;history.record("abcde");now=150;history.record("abcd");
  expect(history.undo()).toBe("abcdef");
});
