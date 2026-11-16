/** NA-17. Real production preview generator; native IO is replaced by inert host ports.
 * Run in its own Bun process: module mocks must not leak into other UI suites. */
import {test,expect,mock} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
plugin({name:'notes-adversarial-preview',setup(b){b.onLoad({filter:/\/NotePreview\.tsx$/},async a=>({contents:require('@babel/core').transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const root=process.env.NOTES_SOURCE_ROOT??new URL('../',import.meta.url).pathname;
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:(s:string)=>s.length*8})}));
mock.module('@pocketjs/framework/components',()=>({View:()=>null,Text:()=>null}));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>{}}));
mock.module('@pocketjs/framework/kinetics',()=>({createScroller:()=>({})}));
mock.module('@pocketjs/framework/lifecycle',()=>({onFrame:()=>{}}));
mock.module('@pocketjs/framework/renderer',()=>({createComponent:()=>null,mergeProps:Object.assign}));
mock.module('@podjs/framework/text',()=>({SystemTextLine:()=>null}));
mock.module('@podjs/framework/watch',()=>({getDisplayMetrics:()=>({physicalWidth:233,logicalWidth:233}),hasCapability:()=>false}));
mock.module(root+'/src/ui/RemoteImage.tsx',()=>({RemoteImage:()=>null}));
const {notePreviewEntries}=await import(root+'/src/ui/NotePreview.tsx');
test('NA-CONTROL ordinary text produces a visible text row',()=>{expect(notePreviewEntries('literal',200).some((r:any)=>r.anchor?.renderedText==='literal')).toBe(true)});
test('NA-17 fenced code produces visible text instead of only blank spacers',()=>{
 const rows=notePreviewEntries('```\nliteral\n```',200);
 expect(rows.some((r:any)=>r.anchor?.renderedText==='literal')).toBe(true);
});
test('NA-17 multiline code retains indentation, blanks and source anchors',()=>{
 const source='```html\n  <img src="x">\n\nsecond\n```';
 const anchors=notePreviewEntries(source,200).flatMap((r:any)=>r.anchor?[r.anchor]:[]);
 expect(anchors.map((a:any)=>a.renderedText)).toEqual(['  <img src="x">','','second']);
 for(const a of anchors)expect(source.slice(a.sourceStart,a.sourceStart+a.sourceMarkup.length)).toBe(a.sourceMarkup);
});
test('NA-17 wrapped code retains all characters with native body metrics present',()=>{
 const source='```\nabcdefghijklmnop\n```';
 const native=new Map([[' ',[{height:88}]]]) as any;
 const rows=notePreviewEntries(source,40,undefined,undefined,native).filter((r:any)=>r.anchor);
 expect(rows.map((r:any)=>r.anchor.renderedText).join('')).toBe('abcdefghijklmnop');
 expect(rows.every((r:any)=>r.height===19)).toBe(true);
});
