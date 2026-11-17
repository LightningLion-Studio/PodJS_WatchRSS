import {test,expect} from 'bun:test';
import {prepareNotePreview} from '../src/notes/preview';import {noteTextRows,noteTableCellText} from '../src/notes/presentation';
// @ts-ignore Shared host-only generator is also executed by Node in the mini suite.
import {cases,SEEDS,COUNT,parseFragment,markdownOracles,codes,visible,retains,codeImagePaths,codeImageEffects} from './helpers/notes-render-corpus.mjs';
type NoteCase={seed:number;index:number;html:string;markdown:string};
for(const seed of SEEDS){const corpus=Array.from(cases(seed)) as NoteCase[],references=markdownOracles(seed);
for(let from=0;from<corpus.length;from+=256)test('generated visible Markdown text and literal code survive seed='+seed.toString(16)+' range='+from,()=>{
 const failures:any[]=[];for(const c of corpus.slice(from,from+256)){
  const oracle=parseFragment(references[c.index]);
  const blocks=prepareNotePreview(c.markdown),rows=blocks.flatMap(b=>b.kind==='rich'?noteTextRows(b.markup,b.html):[]);
  const actual=blocks.map(b=>b.kind==='table'?b.rows.flat().map(noteTableCellText).join(''):b.kind==='image'?b.description:noteTextRows(b.markup,b.html).map(r=>r.text).join('\n')).join('\n');
  const literal=rows.filter(r=>r.role==='code').map(r=>r.text).join('\n');
  const missing=codes(oracle).flatMap((s:string)=>s.split('\n')).filter((s:string)=>s.trim()&&!literal.includes(s.trim()));
  // Body atoms exclude Markdown syntax which the hybrid reader intentionally renders.
  const atoms=visible(oracle).match(/K[0-9a-f]+Z[0-9a-f]+X文é😀/g)||[];
  const effects=codeImageEffects(codeImagePaths(oracle),blocks.filter(b=>b.kind==='image').map(b=>b.path));
  if(!retains(atoms.join(''),actual)||missing.length||effects.images.length)failures.push({seed,index:c.index,source:c.markdown,actual,missing,effects});
 }
 if(failures.length)console.error(JSON.stringify({seed,count:COUNT,failures:failures.slice(0,3)}));
 expect(failures.length).toBe(0);
});
}

test('P3 generated predicate rejects an extra image beside preserved literal code',()=>{
 const source='- ```\n  <img src="assets/code-only.png">\n  ```',paths=new Set(['assets/code-only.png']);
 const blocks=prepareNotePreview(source),images=blocks.filter(b=>b.kind==='image').map(b=>b.path);
 expect(codeImageEffects(paths,images).images).toEqual([]);
 expect(codeImageEffects(paths,[...images,'assets/code-only.png']).images).toEqual(['assets/code-only.png']);
 expect(codeImageEffects(paths,['assets/ordinary.png']).images).toEqual([]);
});
