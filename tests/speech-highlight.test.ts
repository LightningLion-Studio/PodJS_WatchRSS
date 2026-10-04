import {expect,test} from "bun:test";
import native from "./fixtures/speech-highlight-native.json";
import {fallbackSpeechUnits,fallbackReadableOffset,fallbackHighlightOffsets,fallbackDurationMs,segmentHighlight} from "../src/reader/speech-highlight.ts";
import {speechSegmentSlices} from "../src/reader/speech-segments.ts";
test("600 cases match unchanged Kotlin fallback offsets, windows, mixed speech units and duration",()=>{
  for(const item of native.cases){
    const {text,progress,rate}=item.input;
    expect(fallbackSpeechUnits(text)).toBeCloseTo(item.units,10);
    expect(fallbackReadableOffset(text,progress)).toBe(item.offset);
    expect(fallbackHighlightOffsets(text,progress)).toEqual({start:item.start,end:item.end});
    expect(fallbackDurationMs(text,rate)).toBe(item.durationMs);
  }
});
test("engine range maps normalized whitespace and sentence joins to original source",()=>{
  const segment={...speechSegmentSlices("  甲\r\n 乙。 丙！")[0]!,contentBlockIndex:3};
  const highlight=segmentHighlight(segment,"article",true,2,2,4,false);
  expect(highlight).toMatchObject({articleId:"article",useOriginalContent:true,segmentIndex:2,start:2,end:4,sourceStart:6,sourceEnd:7,contentBlockIndex:3,isFallback:false});
});

import {SpeechPlayback,type SpeechHighlightClock} from "../src/reader/speech-playback.ts";
import type {SpeechProgress} from "../src/reader/speech-highlight.ts";
import {contentHighlightRects,titleHighlightRects,highlightCenter} from "../src/reader/speech-highlight-layout.ts";
import {layoutContent} from "../src/reader/content-layout.ts";
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
test("real ranges replace 900ms fallback and stale segments cannot alter the active highlight",async()=>{
  let now=0,scheduled:(()=>void)|undefined,interval=0;
  const clock:SpeechHighlightClock={now:()=>now,after:(ms,callback)=>{interval=ms;scheduled=callback;return()=>{if(scheduled===callback)scheduled=undefined;};}};
  const utterances:{progress:(event:SpeechProgress)=>void;done:()=>void}[]=[];
  const article={id:"a",channelId:"c",title:"长标题验证内容甲乙丙丁",content:"正文第一句。第二句足够长。"};
  const controller=new SpeechPlayback({listArticles:async()=>[article],getArticle:async()=>article,getOriginalArticle:async()=>article,stopSpeech:async()=>{},speak:async(_text,_rate,started,progress)=>{started?.();await new Promise<void>(resolve=>utterances.push({progress:progress!,done:resolve}));}},()=>{},clock);
  const pending=controller.start(article);await settle();
  expect(controller.state.highlight).toMatchObject({start:0,end:6,isFallback:true,isTitle:true});
  expect(scheduled).toBeUndefined();
  utterances[0]!.progress({type:"start"});expect(interval).toBe(900);
  now=900;scheduled?.();expect(controller.state.highlight!.start).toBeGreaterThan(0);
  utterances[0]!.progress({type:"range",start:5,end:7});expect(controller.state.highlight).toMatchObject({start:5,end:7,isFallback:false});expect(scheduled).toBeUndefined();
  utterances[0]!.progress({type:"done",elapsedMs:1800});utterances[0]!.done();await settle();
  expect(controller.state.highlight).toMatchObject({isTitle:false,contentBlockIndex:0});
  const current=controller.state.highlight;utterances[0]!.progress({type:"range",start:1,end:2});expect(controller.state.highlight).toBe(current);
  utterances[1]!.progress({type:"start"});expect(scheduled).toBeDefined();
  utterances[1]!.progress({type:"stop"});await settle();expect(controller.state.playing).toBe(false);expect(controller.state.phase).toBe("ready");expect(scheduled).toBeUndefined();
  utterances[1]!.progress({type:"range",start:2,end:4});expect(controller.state.highlight).toEqual(current);
  await controller.stop();utterances[1]!.done();await pending;expect(controller.state.highlight).toBeUndefined();
});
test("highlight geometry maps raw CRLF and title whitespace; unrelated rows are never measured",()=>{
  const blocks=[{type:"text" as const,style:"body" as const,text:"甲乙\r\n丙丁"},{type:"text" as const,style:"body" as const,text:"无关正文".repeat(10000)}];
  const measure=(s:string)=>s.length*10;
  const layout=layoutContent(blocks,40,14,measure),highlight=segmentHighlight({...speechSegmentSlices(blocks[0].text)[0]!,contentBlockIndex:0},"a",false,1,3,5,false);
  let calls=0;const rects=contentHighlightRects(layout,highlight,40,s=>{calls++;return measure(s);});
  expect(rects.size).toBe(1);expect(calls).toBeLessThan(5);
  expect(Array.from(rects.values())[0]).toMatchObject({left:0,width:20});
  const title=segmentHighlight({...speechSegmentSlices("  中文 标题 甲乙")[0]!,isTitle:true},"a",false,1,3,5,true);
  const titleRects=titleHighlightRects("  中文 标题 甲乙",["中文标题","甲乙"],title,100,{fontSlot:1,scale:1,lineHeight:18},measure);
  expect(titleRects).toEqual([{left:50,top:0,width:20,height:18}]);expect(highlightCenter(titleRects)).toBe(9);
});

test("title highlights follow unequal native first and last line boxes",()=>{
 const title=segmentHighlight({...speechSegmentSlices("甲乙丙丁")[0]!,isTitle:true},"a",false,0,0,4,false);
 const rects=titleHighlightRects("甲乙丙丁",["甲乙","丙丁"],title,100,{fontSlot:1,scale:1,lineHeight:18},text=>text.length*10,[{top:0,height:27},{top:27,height:22}]);
 expect(rects).toEqual([{left:40,top:0,width:20,height:27},{left:40,top:27,width:20,height:22}]);
 expect(highlightCenter(rects)).toBe(24.5);
});
