import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {deriveNoteTitle} from '../../src/notes/title';
import {memoTitle} from '../../src/notes/text';
const vectors=JSON.parse(readFileSync(new URL('../fixtures/notes-title-vectors.json',import.meta.url),'utf8')) as {name:string;plainText:string;expected:string}[];

// Identical vectors in the mini tests; includes the phone NoteTitleTest cases.
for(const mode of ['native','missing','no-intl','throws'] as const){
 test('shared three-word vectors: '+mode,()=>{
  const original=globalThis.Intl;
  try{
   if(mode==='no-intl')Object.defineProperty(globalThis,'Intl',{value:undefined,configurable:true,writable:true});
   else if(mode!=='native')Object.defineProperty(globalThis,'Intl',{value:{...original,Segmenter:mode==='missing'?undefined:class{constructor(){throw Error('unavailable');}}},configurable:true,writable:true});
   for(const v of vectors)expect(deriveNoteTitle(v.plainText),v.name).toBe(v.expected);
  }finally{Object.defineProperty(globalThis,'Intl',{value:original,configurable:true,writable:true});}
 });
}
test('a segmenter without a Han dictionary splits long runs into two-character words',()=>{
 const original=Intl.Segmenter;
 try{
  Object.defineProperty(Intl,'Segmenter',{value:class{segment(line:string){return [{segment:line,index:0}];}},configurable:true,writable:true});
  expect(deriveNoteTitle('天地玄黃宇宙洪荒')).toBe('天地玄黃宇宙');
  expect(deriveNoteTitle('你好世界')).toBe('你好世界');
 }finally{Object.defineProperty(Intl,'Segmenter',{value:original,configurable:true,writable:true});}
});
test('memoTitle derives from existing plain text and retains the unnamed fallback',()=>{
 expect(memoTitle('\n<p>Hello, <b>big</b> world again</p>')).toBe('Hello, big world');
 expect(memoTitle(' \n\t')).toBe('未命名笔记');
});
