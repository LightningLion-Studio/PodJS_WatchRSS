import {test,expect} from 'bun:test';
import {prepareNotePreview,noteBlockSourceOffsets,type NotePreviewBlock} from '../src/notes/preview.ts';
import native from './fixtures/note-preview-native.json';
test('preview blocks, tables, fences, chunking and source offsets match native Kotlin',()=>{for(const c of native.cases){const blocks=prepareNotePreview(c.input);expect(blocks,JSON.stringify(c.input)).toEqual(c.blocks as NotePreviewBlock[]);expect(noteBlockSourceOffsets(c.input,blocks)).toEqual(c.offsets);}});

test('presentation preserves code literals and resolves synced asset paths without rewriting remote URLs',async()=>{const {noteTextRows,noteImageSource}=await import('../src/notes/presentation.ts');expect(noteTextRows('# 标题\n- 内容\n> 引用\n```html\n<p>literal</p>\n```',false)).toMatchObject([{text:'标题',role:'heading'},{text:'• 内容',role:'body'},{text:'引用',role:'quote'},{text:'<p>literal</p>',role:'code'}]);expect(noteImageSource('assets/a.png')).toEqual({url:'assets/a.png',filePath:'notes/assets/a.png'});expect(noteImageSource('https://example.com/a.png')).toEqual({url:'https://example.com/a.png'});});

test('note preview images keep native aspect ratio within the watch height bounds',async()=>{
 const {noteImageDisplayHeight}=await import('../src/notes/presentation.ts');
 expect(noteImageDisplayHeight(205,1000,500)).toBe(102.5);
 expect(noteImageDisplayHeight(205,1000,100)).toBe(96);
 expect(noteImageDisplayHeight(205,100,1000)).toBe(260);
 expect(noteImageDisplayHeight(205,0,100)).toBe(260);
});

test('native note preview collapses fenced code to one measured blank row without changing source text',async()=>{
 const {noteBodyLayoutBlocks}=await import('../src/notes/native-layout-input.ts');
 const one='前文\n```text\n代码\n```\n后文',many='前文\n```text\n代码甲\n代码乙\n```\n后文';
 expect(noteBodyLayoutBlocks(one).map(block=>block.text)).toEqual(['前文','后文',' ']);
 expect(noteBodyLayoutBlocks(many).map(block=>block.text)).toEqual(['前文','后文',' ']);
});

test('table cells preserve literal Markdown while unwrapping native inline-code delimiters',async()=>{
 const {noteTableCellText,noteTableCellPresentation,noteTableCodeFragments}=await import('../src/notes/presentation.ts');
 expect(noteTableCellText('**粗体** 和 `代码` [链接](url)')).toBe('**粗体** 和 代码 [链接](url)');
 expect(noteTableCellText('`未闭合 和 `跨\n行`')).toBe('未闭合 和 跨\n行`');
 expect(noteTableCellPresentation('前`码`后 + `😀`')).toEqual({text:'前码后 + 😀',codes:[{start:1,end:2},{start:6,end:8}]});
 expect(noteTableCodeFragments(['前码','字后'],[{start:1,end:3}])).toEqual([{line:0,start:1,text:'码'},{line:1,start:0,text:'字'}]);
});
