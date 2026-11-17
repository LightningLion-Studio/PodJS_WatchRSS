import {test,expect} from 'bun:test';
import {prepareNotePreview} from '../src/notes/preview';import {noteTextRows,noteTableCellText} from '../src/notes/presentation';
// @ts-ignore Shared host-only generator is also executed by Node in the mini suite.
import {cases,SEEDS,COUNT,parseFragment,marked,codes,visible,retains} from './helpers/notes-render-corpus.mjs';
for(const seed of SEEDS)test('generated visible Markdown text and literal code survive seed='+seed.toString(16),()=>{
 const failures:any[]=[];for(const c of cases(seed)){
  const oracle=parseFragment(marked.parse(c.markdown));
  const blocks=prepareNotePreview(c.markdown),rows=blocks.flatMap(b=>b.kind==='rich'?noteTextRows(b.markup,b.html):[]);
  const actual=blocks.map(b=>b.kind==='table'?b.rows.flat().map(noteTableCellText).join(''):b.kind==='image'?b.description:noteTextRows(b.markup,b.html).map(r=>r.text).join('\n')).join('\n');
  const literal=rows.filter(r=>r.role==='code').map(r=>r.text).join('\n');
  const missing=codes(oracle).flatMap((s:string)=>s.split('\n')).filter((s:string)=>s.trim()&&!literal.includes(s.trim()));
  if(!retains(visible(oracle),actual)||missing.length)failures.push({seed,index:c.index,source:c.markdown,actual,missing});
 }
 if(failures.length)console.error(JSON.stringify({seed,count:COUNT,failures:failures.slice(0,3)}));
 expect(failures.length).toBe(0);
});
