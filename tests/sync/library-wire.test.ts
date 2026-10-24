import {test,expect} from 'bun:test';
import {fixture,wireFixtureParts} from '../helpers/library-wire-fixture.ts';
import {normalizeSessionResponse} from '../helpers/library-session-fixture.ts';
import {buildChunkedResponseFrames,nativeJsonSize,wireProgress} from '../../src/sync/library-wire.ts';
import {javaJsonQuote} from '../../src/sync/article-body.ts';
import {javaUtf8Chunks} from '../../src/reader/imported-text-writer.ts';
for(const row of fixture.cases)test('native outgoing frames: '+row.input.name,()=>{
 const parts=wireFixtureParts(row),build=()=>buildChunkedResponseFrames('watch',parts.prepared,parts.requests,3,2,row.input.batches,()=>1789340000000);
 if(!row.ok)expect(build).toThrow();else expect(normalizeSessionResponse(build())).toEqual(normalizeSessionResponse(row.frames));
});
test('wire progress round-trips captured native Float values',()=>{for(const item of fixture.floatProgress){const b=new ArrayBuffer(4),v=new DataView(b);v.setUint32(0,item.bits,false);expect(Math.fround(wireProgress(v.getFloat32(0,false)))).toBe(Math.fround(item.value));}});
test('JSON frame size keeps Java UTF-8 replacement and escape behavior without allocating the frame bytes',()=>{
 for(const value of ['ASCII '+('x'.repeat(65540)),'中文😀','\ud800','\udc00','\ud800x\udc00','line\nquote"\\slash/']){
  const serialized='{"s":'+javaJsonQuote(value)+'}';
  const expected=[...javaUtf8Chunks(serialized)].reduce((n,c)=>n+c.length,0);
  expect(nativeJsonSize({s:value})).toBe(expected);
 }
 const nested={quote:'a/b\u0001😀\ud800',empty:[],items:[true,false,null,-0,1.25,{中文:'line\n',omit:undefined}]};
 const serialize=(value:unknown):string=>value===null?'null':typeof value==='string'?javaJsonQuote(value):typeof value==='number'?Object.is(value,-0)?'-0':String(value):typeof value==='boolean'?String(value):Array.isArray(value)?'['+value.map(serialize).join(',')+']':'{'+Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).map(([k,v])=>javaJsonQuote(k)+':'+serialize(v)).join(',')+'}';
 expect(nativeJsonSize(nested)).toBe([...javaUtf8Chunks(serialize(nested))].reduce((n,c)=>n+c.length,0));
});

test('R47 compact manifests preserve parser defaults, explicit unread and keep/deletion clocks',async()=>{
 const {fixture}=await import('../helpers/local-manifest-fixture');const {manifestEntry}=await import('../../src/sync/library-wire');const {parseArticleManifest}=await import('../../src/sync/manifest');
 const cases=[...fixture.first,...fixture.second,{...fixture.first[0],deleted:false,deletedAt:4321,readingProgress:0,readingPositionChangedAt:1234,isRead:false,favoriteChangedAt:333,watchLaterChangedAt:444,independentChangedAt:555}];
 for(const m of cases){const verbose=manifestEntry(m),compact=manifestEntry(m,true);expect(parseArticleManifest({articleManifest:[compact]})).toEqual(parseArticleManifest({articleManifest:[verbose]}));expect(nativeJsonSize(compact)).toBeLessThan(nativeJsonSize(verbose));}
 const explicit=manifestEntry(cases.at(-1)!,true);expect(explicit.deleted).toBe(false);expect(explicit.deletedAt).toBe(4321);expect(explicit.readingPositionChangedAt).toBe(1234);expect(explicit.favoriteChangedAt).toBe(333);expect(explicit.watchLaterChangedAt).toBe(444);expect(explicit.independentChangedAt).toBe(555);
});
