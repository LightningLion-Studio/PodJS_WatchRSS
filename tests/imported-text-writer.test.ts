import {test,expect} from "bun:test";
import {mkdtemp,readFile,writeFile,appendFile,stat,rename,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {ImportedTextWriter,javaUtf8Chunks,type ImportedTextWritePort} from "../src/reader/imported-text-writer.ts";
import native from "./fixtures/imported-text-native.json";

async function harness(){
 const root=await mkdtemp(join(tmpdir(),"watchrss-writer-"));let sequence=0,maxChunk=0;
 const path=(p:string)=>join(root,p.replace("article_content/",""));
 const hash=async(p:string)=>{const bytes=await readFile(path(p));return {size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};};
 const port:ImportedTextWritePort={
  createTemp:async()=>{const p=`article_content/.pod-write-${++sequence}.part`;await writeFile(path(p),"");return {path:p};},
  write:async(p,b)=>{maxChunk=Math.max(maxChunk,b.length);await writeFile(path(p),b);return {size:b.length};},
  append:async(p,b,offset)=>{expect((await stat(path(p))).size).toBe(offset);maxChunk=Math.max(maxChunk,b.length);await appendFile(path(p),b);return {size:offset+b.length};},
  hash,
  commit:async(p,target,size,digest)=>{expect(await hash(p)).toEqual({size,sha256:digest});await rename(path(p),path(target));return {path:target,size,sha256:digest,reused:false};},
  remove:async(p)=>{await rm(path(p),{force:true});},
 };
 return {root,path,port,writer:new ImportedTextWriter(port),maxChunk:()=>maxChunk,cleanup:()=>rm(root,{recursive:true,force:true})};
}
test("file names and bytes match unchanged native store, including invalid UTF-16 and chunk boundaries",async()=>{
 const h=await harness();try{
  for(let i=0;i<native.cases.length;i++){
   const row=native.cases[i]!;expect(await h.writer.storeText(`case-${i}`,row.text)).toBe(row.marker);
  }
  for(const row of native.writerCases){
   const marker=await h.writer.storeText(row.key,row.text);expect(marker).toBe(row.marker);
   expect((await readFile(h.path(marker.replace("watchrss-watch-content:","article_content/")))).toString("base64")).toBe(row.dataBase64);
  }
  expect(h.maxChunk()).toBeLessThanOrEqual(98304);
  expect((await readdir(h.root)).every(n=>n.endsWith(".txt"))).toBe(true);
 }finally{await h.cleanup();}
});
test("updated content preserves old published file and concurrent writers do not share staging paths",async()=>{
 const h=await harness();try{
  const [first,second]=await Promise.all([h.writer.storeText("same","old"),h.writer.storeText("same","new")]);
  expect(first).not.toBe(second);
  expect(await readFile(h.path(first.replace("watchrss-watch-content:","article_content/")),"utf8")).toBe("old");
  expect(await readFile(h.path(second.replace("watchrss-watch-content:","article_content/")),"utf8")).toBe("new");
  expect((await readdir(h.root)).length).toBe(2);
 }finally{await h.cleanup();}
});
test("cancel, short writes, hash mismatch and commit errors never replace previously published data",async()=>{
 for(const mode of ["cancel","short","hash","commit"]){
  const h=await harness();try{
   const old=await h.writer.storeText("id","old");let cancel=false;
   if(mode==="cancel"||mode==="short"){
    const append=h.port.append;h.port.append=async(...args)=>{const r=await append(...args);cancel=mode==="cancel";return mode==="short"?{size:r.size-1}:r;};
   }else if(mode==="hash"){const hash=h.port.hash;h.port.hash=async p=>({...await hash(p),size:999});}
   else h.port.commit=async()=>{throw new Error("disk failure");};
   await expect(h.writer.storeText("id","new",()=>cancel)).rejects.toThrow();
   expect(await readFile(h.path(old.replace("watchrss-watch-content:","article_content/")),"utf8")).toBe("old");
   expect((await readdir(h.root)).length).toBe(1);
  }finally{await h.cleanup();}
 }
});
test("late cancellation leaves a complete unreferenced file and returns no marker",async()=>{
 const h=await harness();try{
  let cancelled=false;const commit=h.port.commit;
  h.port.commit=async(...args)=>{const r=await commit(...args);cancelled=true;return r;};
  await expect(h.writer.storeText("key","complete",()=>cancelled)).rejects.toThrow("已取消");
  const names=await readdir(h.root);expect(names.length).toBe(1);expect(names[0]).toEndWith(".txt");
  expect(await readFile(join(h.root,names[0]!),"utf8")).toBe("complete");
 }finally{await h.cleanup();}
});
test("UTF-8 generator preserves supplementary characters across every relevant chunk edge",()=>{
 for(const offset of [32766,32767,32768,32769]){
  const value="a".repeat(offset)+"😀汉👩‍💻";
  expect(Buffer.concat([...javaUtf8Chunks(value)]).equals(Buffer.from(value))).toBe(true);
 }
});
