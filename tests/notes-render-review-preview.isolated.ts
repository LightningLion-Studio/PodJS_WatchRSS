/** NA-17. Real production preview generator; native IO is replaced by inert host ports.
 * Run in its own Bun process: module mocks must not leak into other UI suites. */
import {test,expect,mock} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
plugin({name:'notes-adversarial-preview',setup(b){b.onLoad({filter:/\/NotePreview\.tsx$/},async a=>({contents:require('@babel/core').transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const root=process.env.NOTES_SOURCE_ROOT??new URL('../',import.meta.url).pathname;
let measurements=0;
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>{measurements++;return s.length*8;}})}));
mock.module('@pocketjs/framework/components',()=>({View:()=>null,Text:()=>null}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>{}}));
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:()=>({})}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:()=>{}}));
mock.module('@pocketjs/framework/renderer',()=>({createComponent:()=>null,mergeProps:Object.assign}));
mock.module('@podjs/framework/text',()=>({SystemTextLine:()=>null}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({physicalWidth:233,logicalWidth:233}),hasCapability:()=>false}));
mock.module(root+'/src/ui/RemoteImage.tsx',()=>({RemoteImage:()=>null}));
const {notePreviewEntries,notePreviewEntrySteps}=await import(root+'/src/ui/NotePreview.tsx') as typeof import('../src/ui/NotePreview.tsx');
const {prepareNotePreview,noteBlockSourceOffsets}=await import(root+'/src/notes/preview.ts') as typeof import('../src/notes/preview.ts');
test('RNR-01 real reading entries retain a fence-like line with trailing code',()=>{
 const text='```html\n```still-code\n<img src="assets/x.png">\n```';
 const entries=notePreviewEntries(text,200);
 expect(entries.some((e:any)=>e.anchor?.renderedText.includes('still-code'))).toBe(true);
});
test('RNR-CONTROL real reading entries keep ordinary code, indentation and blank rows',()=>{
 const text='~~~\n  literal\n\nsecond\n~~~';
 expect(notePreviewEntries(text,200).filter((e:any)=>e.anchor).map((e:any)=>e.anchor.renderedText)).toEqual(['  literal','','second']);
});

for(const cp of ['\u2028','\u2029'])test('RNR3-04 real reading entries keep Unicode-info code '+JSON.stringify(cp),()=>{
 const entries=notePreviewEntries('```lang'+cp+'x\n<img src="assets/x.png">\n```',200);
 expect(entries.some((e:any)=>e.anchor?.renderedText.includes('<img'))).toBe(true);
});

test('RNR4-01 reader retains literal code after a table',()=>{
 const entries=notePreviewEntries('A | B\n---|---\n```lang|x\nCODE | TEXT\n```',200);
 expect(entries.some((e:any)=>e.anchor?.renderedText==='CODE | TEXT')).toBe(true);
});
test('RNR4-02 reader retains literal image in a list fence',()=>{
 const entries=notePreviewEntries('- ```\n  <img src="assets/x.png">\n  ```',200);
 expect(entries.some((e:any)=>e.anchor?.renderedText.includes('<img src="assets/x.png">'))).toBe(true);
});

function layout(source:string,blocks=prepareNotePreview(source)){
 const offsets=noteBlockSourceOffsets(source,blocks);
 const rows=notePreviewEntries(source,2000,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{blocks,offsets});
 let top=0;
 return rows.flatMap(entry=>{
  const position=top;
  top+=entry.height;
  return entry.anchor?[{text:entry.anchor.renderedText,top:position}]:[];
 });
}

test('FIX2 P2: consecutive Markdown quotes bound the first layout step',()=>{
 const lines=Array.from({length:1500},(_,index)=>'> '+index.toString().padStart(4,'0')+' '+'引用内容'.repeat(37));
 const source=lines.join('\n'),blocks=prepareNotePreview(source);
 const offsets=noteBlockSourceOffsets(source,blocks);
 measurements=0;
 const first=notePreviewEntrySteps(source,199,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{blocks,offsets}).next();
 expect(first.done).toBe(false);
 expect({firstBlock:blocks[0]?.kind==='rich'?blocks[0].markup.length:0,measurements}).toEqual({
  firstBlock:1091,measurements:1071
 });
 expect(layout(source,blocks)).toEqual(layout(source,[{kind:'rich',markup:source,html:false}]));
});

test('FIX2 P3: the first row of an HTML chunk retains nonbreaking spaces',()=>{
 const source='<p>A</p><p>B</p><p>C</p><p>D</p><p>&nbsp;&nbsp;Indented</p>';
 const blocks=prepareNotePreview(source);
 expect(blocks).toHaveLength(2);
 const whole=layout(source,[{kind:'rich',markup:source,html:true}]);
 expect(whole[4]?.text).toBe('\u00a0\u00a0Indented');
 expect(layout(source,blocks)).toEqual(whole);
});

test('FIX2 P3: an image inside an ordered list keeps the following ordinal',()=>{
 const path='assets/fixture.png';
 const source=`<ol start="3"><li>Third</li><li><img src="${path}" alt="Inside">Fourth</li><li>Fifth</li></ol>`;
 expect(prepareNotePreview(source).map(block=>block.kind)).toEqual(['rich','image','rich']);
 expect(layout(source).map(row=>row.text)).toEqual(['3. Third','4.','Fourth','5. Fifth']);
});
