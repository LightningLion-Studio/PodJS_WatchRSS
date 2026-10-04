import {test,expect} from 'bun:test';
import {mapNoteTextAnchorOffset,noteEditorAnchor,type NoteAnchorEntry} from '../src/notes/editor-anchor.ts';
import {noteTextRows} from '../src/notes/presentation.ts';

test('native-style anchor maps visible formatted text back to its Markdown occurrence',()=>{
  const markdown='# 标题\n前文\n**这里是刚才读到的位置**\n后文';
  const raw='**这里是刚才读到的位置**',visible='这里是刚才读到的位置';
  expect(mapNoteTextAnchorOffset(visible,raw,visible.indexOf('刚才'))).toBe(raw.indexOf('刚才'));
  const start=markdown.indexOf(raw);
  const entries:NoteAnchorEntry[]=[{height:32},{height:22},{height:22,anchor:{renderedText:visible,mappingText:visible,renderedStart:0,sourceMarkup:raw,sourceStart:start,fontSlot:1,inset:0}}];
  const offset=noteEditorAnchor(entries,markdown,0,233,233,(text)=>text.length*10);
  expect(offset).toBeGreaterThanOrEqual(start+2);
  expect(offset).toBeLessThanOrEqual(start+raw.length-2);
});

test('repeated lines retain their own raw source offset and empty notes fall back to zero',()=>{
  const raw='重复内容\n中间内容\n重复内容',rows=noteTextRows(raw,false);
  expect(rows.map(row=>row.sourceStart)).toEqual([0,5,10]);
  expect(noteEditorAnchor([{height:30}],raw,0,233,233,()=>0)).toBe(0);
  const final=rows[2]!;
  const entry:NoteAnchorEntry={height:20,anchor:{renderedText:final.text,mappingText:final.mappingText,renderedStart:0,sourceMarkup:final.sourceMarkup,sourceStart:final.sourceStart,fontSlot:1,inset:0}};
  expect(noteEditorAnchor([entry],raw,0,233,233,text=>text.length*10)).toBe(raw.length);
});

test('table cell nearest screen center follows horizontal table scroll',()=>{
  const markdown='| 左侧唯一词 | 右侧唯一词 |';
  let horizontal=0;
  const words=['左侧唯一词','右侧唯一词'];
  const entries:NoteAnchorEntry[]=[{height:36,positionedAnchors:()=>words.map((word,column)=>({
    anchor:{renderedText:word,mappingText:word,renderedStart:0,sourceMarkup:word,sourceStart:null,fontSlot:1,inset:0},
    x:column*128+8-horizontal,y:0,width:112,height:20
  }))}];
  const initial=noteEditorAnchor(entries,markdown,0,233,40,text=>text.length*10);
  expect(initial).toBeGreaterThanOrEqual(markdown.indexOf(words[0]));
  expect(initial).toBeLessThanOrEqual(markdown.indexOf(words[0])+words[0].length);
  horizontal=100;
  const scrolled=noteEditorAnchor(entries,markdown,0,233,40,text=>text.length*10);
  expect(scrolled).toBeGreaterThanOrEqual(markdown.indexOf(words[1]));
  expect(scrolled).toBeLessThanOrEqual(markdown.indexOf(words[1])+words[1].length);
});

test('preset font scaling keeps the reader-center edit caret on the visible glyph',()=>{
  const markdown='abcdef';
  const entry:NoteAnchorEntry={height:20,anchor:{renderedText:markdown,mappingText:markdown,renderedStart:0,sourceMarkup:markdown,sourceStart:0,fontSlot:1,scale:2,inset:0}};
  expect(noteEditorAnchor([entry],markdown,0,100,40,text=>text.length*10)).toBe(2);
});

test('reader content inset is used when locating the center caret',()=>{
  const markdown='abcdef';
  const entry:NoteAnchorEntry={height:20,anchor:{renderedText:markdown,mappingText:markdown,renderedStart:0,sourceMarkup:markdown,sourceStart:0,fontSlot:1,inset:0}};
  const measure=(text:string)=>text.length*10;
  expect(noteEditorAnchor([entry],markdown,0,100,40,measure,{top:22,gap:0,horizontalInset:14})).toBe(4);
  expect(noteEditorAnchor([entry],markdown,0,100,40,measure)).toBe(3);
});
