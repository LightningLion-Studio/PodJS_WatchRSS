import {test,expect} from 'bun:test';
import {prepareNotePreview} from '../src/notes/preview';
import {noteTextRows} from '../src/notes/presentation';
import {deriveNoteTitle} from '../src/notes/title';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const rows=(source:string)=>prepareNotePreview(source).flatMap(b=>b.kind==='rich'?noteTextRows(b.markup,b.html):[]);

for(const mark of ['```','~~~'])test('RNR-01 trailing content does not close '+mark+' fence',()=>{
  const source=mark+'html\n'+mark+'still-code\n<img src="assets/x.png">\n'+mark;
  expect(prepareNotePreview(source).some(b=>b.kind==='image')).toBe(false);
  expect(rows(source).map(r=>r.text)).toEqual([mark+'still-code','<img src="assets/x.png">']);
});
test('RNR-02 four-space indented code does not become an image',()=>{
 const source='    <img src="assets/x.png">';
 expect(prepareNotePreview(source).some(b=>b.kind==='image')).toBe(false);
 expect(rows(source).some(r=>r.role==='code'&&r.text.includes('<img'))).toBe(true);
});
test('RNR-04 a backtick in opener info does not silently hide that source line',()=>{
 expect(rows('```not`a-fence\nkeep').some(r=>r.text.includes('not'))).toBe(true);
});
test('RNR-05 combining letters keep the same first three words without Intl',()=>{
 const source='e\u0301cole cafe noir suite',expected=deriveNoteTitle(source),saved=Intl.Segmenter;
 try {Object.defineProperty(Intl,'Segmenter',{value:undefined,configurable:true,writable:true});expect(deriveNoteTitle(source)).toBe(expected);}
 finally {Object.defineProperty(Intl,'Segmenter',{value:saved,configurable:true,writable:true});}
});
test('RNR-CONTROL closed, unclosed, shorter and mismatched code fences remain literal',()=>{
 for(const source of ['```html\n<img src="x">\n```','~~~html\n<img src="x">\n~~~','````html\n```\n~~~\n<img src="x">','   ```\n<img src="x">']){
  expect(prepareNotePreview(source).some(b=>b.kind==='image')).toBe(false);
  expect(rows(source).some(r=>r.role==='code'&&r.text.includes('<img'))).toBe(true);
 }
});
test('RNR-07 80-code-point limit retreats to a complete grapheme',()=>{
 expect(deriveNoteTitle('.'.repeat(78)+'👨‍👩‍👧‍👦')).toBe('.'.repeat(78));
 expect(deriveNoteTitle('a'.repeat(79)+'e\u0301')).toBe('a'.repeat(79));
});
test.skipIf(!process.env.RENDER_PHONE_MAIN||!process.env.RENDER_PHONE_HOTFIX||!process.env.RENDER_MINI_ROOT)('RNR-06 expanded title vectors agree across both phone branches, watch and mini',()=>{
 const phone=JSON.parse(readFileSync(process.env.RENDER_PHONE_MAIN!,'utf8'));
 const hotfix=JSON.parse(readFileSync(process.env.RENDER_PHONE_HOTFIX!,'utf8'));
 const mini=createRequire(import.meta.url)(process.env.RENDER_MINI_ROOT+'/miniprogram/lib/notes-title').deriveNoteTitle;
 const saved=Intl.Segmenter;
 const matrix=phone.map((v:any,i:number)=>{
  const out={input:v.input,phone:v.title,hotfix:hotfix[i].title,watch:deriveNoteTitle(v.input),mini:mini(v.input),watchFallback:'',miniFallback:''};
  try {Object.defineProperty(Intl,'Segmenter',{value:undefined,configurable:true,writable:true});out.watchFallback=deriveNoteTitle(v.input);out.miniFallback=mini(v.input);}finally{Object.defineProperty(Intl,'Segmenter',{value:saved,configurable:true,writable:true});}
  return out;
 });
 if(process.env.RENDER_MATRIX)writeFileSync(process.env.RENDER_MATRIX,JSON.stringify(matrix,null,2)+'\n');
 for(const v of matrix){expect(new Set(Object.entries(v).filter(([k])=>k!=='input').map(([,value])=>value)).size).toBe(1);}
});
