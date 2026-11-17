import {test,expect} from 'bun:test';
import {prepareNotePreview} from '../src/notes/preview';
import {noteTextRows} from '../src/notes/presentation';
for(const mark of ['```','~~~'])test('RNR4-01 table lookahead stops at a fence '+mark,()=>{
 const source='A | B\n---|---\n'+mark+'lang|x\nCODE | TEXT\n'+mark;
 const blocks=prepareNotePreview(source);
 expect(blocks[0]).toEqual({kind:'table',rows:[['A','B']],headerRows:1,alignments:['Start','Start']});
 expect(blocks.flatMap(b=>b.kind==='rich'?noteTextRows(b.markup,b.html):[]).some(r=>r.role==='code'&&r.text==='CODE | TEXT')).toBe(true);
});
for(const prefix of ['- ','> '])for(const mark of ['```','~~~'])test('RNR4-02 container fence protects literal HTML '+prefix+mark,()=>{
 const next=prefix==='- '?'  ':'> ',source=prefix+mark+'\n'+next+'<img src="assets/x.png">\n'+next+mark;
 const blocks=prepareNotePreview(source);
 expect(blocks.some(b=>b.kind==='image')).toBe(false);
 expect(blocks.flatMap(b=>b.kind==='rich'?noteTextRows(b.markup,b.html):[]).some(r=>r.role==='code'&&r.text.includes('<img src="assets/x.png">'))).toBe(true);
});
