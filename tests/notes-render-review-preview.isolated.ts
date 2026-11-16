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
test('RNR-01 real reading entries retain a fence-like line with trailing code',()=>{
 const text='```html\n```still-code\n<img src="assets/x.png">\n```';
 const entries=notePreviewEntries(text,200);
 expect(entries.some((e:any)=>e.anchor?.renderedText.includes('still-code'))).toBe(true);
});
test('RNR-CONTROL real reading entries keep ordinary code, indentation and blank rows',()=>{
 const text='~~~\n  literal\n\nsecond\n~~~';
 expect(notePreviewEntries(text,200).filter((e:any)=>e.anchor).map((e:any)=>e.anchor.renderedText)).toEqual(['  literal','','second']);
});
