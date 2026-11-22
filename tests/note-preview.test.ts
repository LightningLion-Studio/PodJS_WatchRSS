import {test,expect} from 'bun:test';
import {prepareNotePreview,noteBlockSourceOffsets,type NotePreviewBlock} from '../src/notes/preview.ts';
import {noteTextRows} from '../src/notes/presentation.ts';
import {memoPlainText,notePreviewPlainText} from '../src/notes/text.ts';
import {notePreviewCases} from './fixtures/note-preview-cases.ts';
test('preview blocks match the native cases with product corrections',()=>{
 for(const c of notePreviewCases){
  const blocks=prepareNotePreview(c.input);expect(blocks,JSON.stringify(c.input)).toEqual(c.blocks);
  expect(noteBlockSourceOffsets(c.input,blocks)).toEqual(c.offsets);
 }
});

function markdownRows(blocks:NotePreviewBlock[]){
 return blocks.flatMap(block=>block.kind==='rich'?noteTextRows(block.markup,block.html):[])
  .map(({text,role,size,lineHeight})=>({text,role,size,lineHeight}));
}

test('Markdown keeps the blank row between two 700-character paragraphs',()=>{
 const lines=['A'.repeat(700),'','B'.repeat(700)];
 const blocks=prepareNotePreview(lines.join('\n'));
 expect(blocks).toHaveLength(2);
 expect(markdownRows(blocks).map(row=>row.text)).toEqual(lines);
});

for(const newline of ['\n','\r\n','\r'])test('Markdown chunks preserve paragraph rows with '+JSON.stringify(newline),()=>{
 const lines=['A'.repeat(700),'','B'.repeat(700),'','', '7. Seventh','8) Eighth','31.look',''];
 const source=lines.join(newline);
 const split=prepareNotePreview(source),whole=prepareNotePreview(source,source.length);
 expect(split.length).toBeGreaterThan(1);
 expect(whole).toHaveLength(1);
 expect(markdownRows(whole).map(row=>row.text)).toEqual(lines);
 expect(markdownRows(split)).toEqual(markdownRows(whole));
 const offsets=noteBlockSourceOffsets(source,split);
 expect(offsets).toEqual([0,lines[0].length+2*newline.length,1400+5*newline.length]);
 for(const [index,block] of split.entries()){
  if(block.kind!=='rich')throw new Error('Expected a Markdown block');
  const start=offsets[index]!;
  expect(source.slice(start,start+block.markup.length)).toBe(block.markup);
  for(const row of noteTextRows(block.markup,false)){
   const from=start+row.sourceStart;
   const end=source.indexOf(newline,from);
   expect(source.slice(from,end<0?source.length:end)).toBe(row.sourceMarkup);
  }
 }
});

test('Markdown chunks preserve indentation and fenced code in list continuations',()=>{
 const item='123. '+'A'.repeat(1190);
 const source=[item,'     ```text','     literal','','     ```','after'].join('\r\n');
 const split=prepareNotePreview(source),whole=prepareNotePreview(source,source.length);
 expect(split.length).toBeGreaterThan(1);
 expect(markdownRows(whole).map(row=>row.text)).toEqual([item,'literal','','after']);
 expect(markdownRows(split)).toEqual(markdownRows(whole));
 expect(noteBlockSourceOffsets(source,split)).toEqual([0,source.lastIndexOf('after')]);
});

test('HTML list numbering uses actual attributes outside quoted values',()=>{
 expect(notePreviewPlainText('<ol class="foo reversed bar"><li>First</li><li>Second</li></ol>')).toBe('1. First\n2. Second');
 const ascending='<ol class="foo reversed bar" title="ignored start=9 "><li class="foo value=8 bar">First</li><li>Second</li></ol>';
 const descending=`<ol class='foo' ReVeRsEd="false" start=5><li>First</li><li VALUE='3'>Second</li><li>Third</li></ol>`;
 expect(notePreviewPlainText(ascending)).toBe('1. First\n2. Second');
 expect(notePreviewPlainText(descending)).toBe('5. First\n3. Second\n2. Third');
 expect(memoPlainText(ascending)).toBe('First\nSecond');
});

test('presentation preserves code literals and resolves synced asset paths without rewriting remote URLs',async()=>{const {noteTextRows,noteImageSource}=await import('../src/notes/presentation.ts');expect(noteTextRows('# 标题\n- 内容\n> 引用\n```html\n<p>literal</p>\n```',false)).toMatchObject([{text:'标题',role:'heading'},{text:'• 内容',role:'body'},{text:'引用',role:'quote'},{text:'<p>literal</p>',role:'code'}]);expect(noteImageSource('assets/a.png')).toEqual({url:'assets/a.png',filePath:'notes/assets/a.png'});expect(noteImageSource('https://example.com/a.png')).toEqual({url:'https://example.com/a.png'});});

test('note preview images keep native aspect ratio within the watch height bounds',async()=>{
 const {noteImageDisplayHeight}=await import('../src/notes/presentation.ts');
 expect(noteImageDisplayHeight(205,1000,500)).toBe(102.5);
 expect(noteImageDisplayHeight(205,1000,100)).toBe(96);
 expect(noteImageDisplayHeight(205,100,1000)).toBe(260);
 expect(noteImageDisplayHeight(205,0,100)).toBe(260);
});

test('native body layout excludes code rendered separately by NotePreview',async()=>{
 const {noteBodyLayoutBlocks}=await import('../src/notes/native-layout-input.ts');
 const one='前文\n```text\n代码\n```\n后文',many='前文\n```text\n代码甲\n代码乙\n```\n后文';
 expect(noteBodyLayoutBlocks(one).map(block=>block.text)).toEqual(['前文','后文']);
 expect(noteBodyLayoutBlocks(many).map(block=>block.text)).toEqual(['前文','后文']);
});

test('table cells preserve literal Markdown while unwrapping native inline-code delimiters',async()=>{
 const {noteTableCellText,noteTableCellPresentation,noteTableCodeFragments}=await import('../src/notes/presentation.ts');
 expect(noteTableCellText('**粗体** 和 `代码` [链接](url)')).toBe('**粗体** 和 代码 [链接](url)');
 expect(noteTableCellText('`未闭合 和 `跨\n行`')).toBe('未闭合 和 跨\n行`');
 expect(noteTableCellPresentation('前`码`后 + `😀`')).toEqual({text:'前码后 + 😀',codes:[{start:1,end:2},{start:6,end:8}]});
 expect(noteTableCodeFragments(['前码','字后'],[{start:1,end:3}])).toEqual([{line:0,start:1,text:'码'},{line:1,start:0,text:'字'}]);
});
