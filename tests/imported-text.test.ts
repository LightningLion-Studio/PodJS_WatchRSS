import {expect,test} from "bun:test";
import {ImportedTextStore,importedTextFileName} from "../src/reader/imported-text.ts";
import native from "./fixtures/imported-text-native.json";

test("marker validation matches the unchanged native file store",()=>{
 for(const row of native.markers)expect(importedTextFileName(row.value)!==null).toBe(row.valid);
});
test("UTF-8 chunk boundaries, empty files and out-of-range reads match native storage",async()=>{
 for(const row of native.cases){
  const bytes=new TextEncoder().encode(row.text),reads:{offset:number;size:number}[]=[];
  const store=new ImportedTextStore({stat:async()=>({file:true,size:bytes.length}),read:async(path,offset,size)=>{expect(path).toBe(`article_content/${importedTextFileName(row.marker)}`);reads.push({offset,size});return bytes.slice(offset,offset+size);},decode:bytes=>new TextDecoder().decode(bytes)});
  const handle=await store.handle(row.marker,row.chunkBytes);expect(handle).toMatchObject({byteLength:row.byteLength,chunkCount:row.chunkCount});
  const chunks=[];for(let index=-1;index<=handle!.chunkCount;index++)chunks.push(await store.chunk(handle!,index));
  expect(chunks).toEqual(row.chunksFromMinusOne);expect(chunks.filter(value=>value!==null).join("")).toBe(row.text);
  expect(reads.every(read=>read.size<=row.chunkBytes+3||read.size<=4)).toBe(true);
 }
});
test("invalid markers never access files, missing paths have no handle",async()=>{
 let stats=0;
 const store=new ImportedTextStore({stat:async()=>{stats++;return {file:false,size:0};},read:async()=>new Uint8Array(),decode:()=>""});
 expect(await store.handle("watchrss-watch-content:../secret.txt")).toBeNull();expect(stats).toBe(0);
 expect(await store.handle("watchrss-watch-content:a.txt",0)).toBeNull();expect(stats).toBe(0);
 expect(await store.handle("watchrss-watch-content:a.txt")).toBeNull();expect(stats).toBe(1);
});
test("native text decoding receives the complete aligned range; short reads and IO failures return null",async()=>{
 const bytes=new TextEncoder().encode("A汉B"),seen:number[][]=[];
 let short=false,fail=false;
 const store=new ImportedTextStore({stat:async()=>({file:true,size:bytes.length}),read:async(_,offset,size)=>bytes.slice(offset,offset+size),readText:async(_,offset,size)=>{seen.push([offset,size]);if(fail)throw new Error("gone");return {text:"native decoded",bytesRead:short?size-1:size};}});
 const handle=(await store.handle("watchrss-watch-content:a.txt",2))!;
 expect(await store.chunk(handle,0)).toBe("native decoded");expect(seen).toEqual([[0,1]]);
 expect(await store.chunk(handle,1)).toBe("native decoded");expect(seen[1]).toEqual([1,3]);
 short=true;expect(await store.chunk(handle,1)).toBeNull();short=false;fail=true;expect(await store.chunk(handle,1)).toBeNull();
 const inaccessible=new ImportedTextStore({stat:async()=>{throw new Error("gone");},read:async()=>{throw new Error("gone");}});
 expect(await inaccessible.handle(handle.marker)).toBeNull();expect(await inaccessible.chunk(handle,0)).toBeNull();
});
