import {expect,test} from "bun:test";
import {requiresSystemText,systemTextOptions} from "../src/reader/system-text.ts";
import {lineHighlightRect} from "../src/reader/speech-highlight-layout.ts";
import {pressedSpeechAnchor} from "../src/reader/speech-segments.ts";
import type {ReaderRow} from "../src/reader/content-layout.ts";
test("emoji sequences use system shaping while ordinary CJK keeps the existing atlas path",()=>{
 for(const text of ['😀','👩‍💻','🇨🇳','👍🏽','©️','1️⃣','❤️'])expect(requiresSystemText(text)).toBe(true);
 for(const text of ['普通中文','A short sentence','123'])expect(requiresSystemText(text)).toBe(false);
});
test("physical baseline and alpha color follow native line metrics",()=>{
 const row:ReaderRow & {kind:'text'}={kind:'text',text:'汉😀文',top:0,height:25,gap:6,blockIndex:0,character:0,sourceStart:0,fontSlot:34,scale:1,color:'#f2f2f280',lineHeight:19,nativeBaseline:16};
 expect(systemTextOptions(row,'body',14,205,2)).toMatchObject({text:'汉😀文',widthPx:410,heightPx:38,baselinePx:32,fontSizePx:28,colorArgb:0x80f2f2f2});
});
test("system caret positions control both highlight width and touched UTF-16 coordinate",()=>{
 const row:ReaderRow & {kind:'text'}={kind:'text',text:'汉😀文',top:0,height:20,gap:0,blockIndex:0,character:0,sourceStart:0,fontSlot:34,scale:1,color:'#ffffffff',lineHeight:20};
 const positions=[0,14,14,42,56];
 expect(lineHighlightRect(row.text,205,row,1,3,()=>1,positions)).toMatchObject({left:14,width:28});
 expect(pressedSpeechAnchor({rows:[row],height:20,textLength:4},[{type:'text',style:'body',text:row.text}],14+43,10,0,0,233,()=>1,14,new Map([[row,positions]]))).toEqual({contentBlockIndex:0,contentCharOffset:3});
});
