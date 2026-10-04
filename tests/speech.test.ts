import { expect, test } from "bun:test";
import { ReaderSpeech, speechChunks } from "../src/reader/speech.ts";
test("long speech preserves all content without splitting surrogate pairs",()=>{
  const text="开头。"+"文".repeat(2995)+"😀"+"后一段！".repeat(1600);
  const chunks=speechChunks(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(c=>c.length<=3000&&!/[\uD800-\uDBFF]$/.test(c))).toBe(true);
});
test("speech initializes then waits for each chunk and forwards saved rate",async()=>{
  const calls:string[]=[];let polls=0;
  const reader=new ReaderSpeech({initialize:async()=>{calls.push("init");},speak:async(text,rate)=>{calls.push(`${text.length}:${rate}`);polls=0;},state:async()=>({state:++polls<2?"speaking":"ready"}),stop:async()=>{}},async()=>{});
  await reader.speak("字".repeat(6500),1.4);
  expect(calls).toEqual(["init","3000:1.4","3000:1.4","500:1.4"]);
});
test("stop during engine initialization prevents deferred playback",async()=>{
  let initialized!:()=>void,started=0,stopped=0;
  const reader=new ReaderSpeech({initialize:()=>new Promise<void>(r=>initialized=r),speak:async()=>{started++;},state:async()=>({state:"ready"}),stop:async()=>{stopped++;}},async()=>{});
  const pending=reader.speak("文章");await reader.stop();initialized();await pending;
  expect(started).toBe(0);expect(stopped).toBe(1);
});
test("stop during playback prevents all remaining chunks",async()=>{
  let release!:()=>void,started=0;
  const reader=new ReaderSpeech({initialize:async()=>{},speak:async()=>{started++;},state:async()=>({state:"speaking"}),stop:async()=>{}},()=>new Promise<void>(r=>release=r));
  const pending=reader.speak("字".repeat(7000));await Promise.resolve();await Promise.resolve();await reader.stop();release();await pending;expect(started).toBe(1);
});
test("engine failure rejects instead of silently skipping the failed paragraph",async()=>{
  let started=0;
  const reader=new ReaderSpeech({initialize:async()=>{},speak:async()=>{started++;},state:async()=>({state:"error"}),stop:async()=>{}},async()=>{});
  await expect(reader.speak("字".repeat(7000))).rejects.toThrow("朗读引擎");expect(started).toBe(1);
});

test("early range callbacks are scoped by utterance id and removed after cancellation",async()=>{
  let listener:((event:any)=>void)|undefined,waiter!:()=>void,removed=0;
  const seen:unknown[]=[];
  const reader=new ReaderSpeech({initialize:async()=>{},speak:async(_text,_rate,id)=>{listener?.({type:"start",utteranceId:id});listener?.({type:"range",utteranceId:id,start:2,end:4});listener?.({type:"range",utteranceId:"stale",start:0,end:1});},onProgress:handler=>{listener=handler;return()=>{removed++;listener=undefined;};},state:async()=>({state:"speaking"}),stop:async()=>{}},()=>new Promise<void>(resolve=>waiter=resolve));
  const pending=reader.speak("正文测试",1,undefined,event=>seen.push(event));await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(seen).toEqual([{type:"start",elapsedMs:undefined},{type:"range",start:2,end:4}]);
  await reader.stop();listener?.({type:"range",utteranceId:"reader-1-0",start:0,end:1});waiter();await pending;
  expect(seen).toHaveLength(2);expect(removed).toBe(1);
});
