import {test,expect} from 'bun:test';
import {prepareNotePreview} from '../src/notes/preview';

for(const indent of ['    ','\t','  \t']){
 test('RNR3-02 pipe table stops before indented code '+JSON.stringify(indent),()=>{
  const blocks=prepareNotePreview('A | B\n---|---\n'+indent+'CODE | TEXT');
  expect(blocks).toEqual([{kind:'table',rows:[['A','B']],headerRows:1,alignments:['Start','Start']},{kind:'rich',markup:indent+'CODE | TEXT',html:false}]);
 });
 test('RNR3-02 tab table stops before indented code '+JSON.stringify(indent),()=>{
  const blocks=prepareNotePreview('A\tB\tC\n'+indent+'CODE\tTEXT');
  expect(blocks).toEqual([{kind:'table',rows:[['A','B','C']],headerRows:1,alignments:['Start','Start','Start']},{kind:'rich',markup:indent+'CODE\tTEXT',html:false}]);
 });
}
for(const cp of ['\u2028','\u2029'])for(const marker of ['```','~~~'])test('RNR3-04 Unicode info stays inside fence '+JSON.stringify([marker,cp]),()=>{
 const source=marker+'lang'+cp+'x\n<img src="assets/x.png">\n'+marker;
 expect(prepareNotePreview(source)).toEqual([{kind:'rich',markup:source,html:false}]);
});
test('RNR3-02 aligned and degraded rows cannot consume code',()=>{
 for(const input of ['A  B  C\na  b  c\n    CODE  TEXT  END','Option  Type  Default  Meaning\n`a`  string  empty  body\n    `b` string empty CODE']){
  const blocks=prepareNotePreview(input);
  expect(blocks.length).toBe(2);
  expect(blocks[0].kind).toBe('table');
  expect(blocks[1]).toEqual({kind:'rich',markup:input.split('\n')[2],html:false});
 }
});
