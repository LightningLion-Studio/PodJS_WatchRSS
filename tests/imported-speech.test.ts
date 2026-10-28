import { expect, test } from "bun:test";
import native from "./fixtures/imported-speech-native.json";
import { ImportedSpeechSegmentSource } from "../src/reader/speech-source.ts";
import type { SpeechSegment } from "../src/reader/speech-segments.ts";

const deferred = <T>() => { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };

test("imported title, anchored chunks, offsets and lazy read order match the native source", async()=>{
 for(const {input,segments,reads,segmentCount} of native.cases){
  const actualReads:number[]=[],source=new ImportedSpeechSegmentSource(input.title,input.chunks.length,async index=>{actualReads.push(index);return input.chunks[index]!;},{importedChunkIndex:input.chunk??undefined,importedCharOffset:input.offset});
  expect(actualReads).toEqual([]);expect(source.segmentCount).toBe(segmentCount);
  const actual:SpeechSegment[]=[];
  for(let segment=await source.peek();segment;segment=await source.peek()){
   expect(await source.peek()).toBe(segment);actual.push(segment);source.consume();
  }
  expect(actual).toEqual(segments);expect(actualReads).toEqual(reads);
 }
});
test("concurrent peeks share a read; consuming does not eagerly read the next chunk",async()=>{
 const chunk=deferred<string|null>(),reads:number[]=[];
 const source=new ImportedSpeechSegmentSource("",2,index=>{reads.push(index);return index===0?chunk.promise:Promise.resolve("第二块");});
 const a=source.peek(),b=source.peek();expect(a).toBe(b);expect(reads).toEqual([0]);
 chunk.resolve("第一块");expect(await a).toBe(await b);
 expect((await source.peek())?.text).toBe("第一块");source.consume();expect(reads).toEqual([0]);
 expect((await source.peek())?.text).toBe("第二块");source.consume();expect(await source.peek()).toBeNull();expect(reads).toEqual([0,1]);
});
test("failed chunk can be retried at the same coordinate",async()=>{
 let calls=0;const reads:number[]=[];
 const source=new ImportedSpeechSegmentSource("",1,async index=>{reads.push(index);if(++calls===1)throw new Error("temporary");return "跳过 从这里";},{importedChunkIndex:0,importedCharOffset:3});
 await expect(source.peek()).rejects.toThrow("temporary");expect((await source.peek())?.text).toBe("从这里");expect(reads).toEqual([0,0]);expect((await source.peek())?.sourceOffsets).toEqual([3,4,5]);
});

test("repository resolves local TXT only, preferring the original marker with bounded SQL",async()=>{
 const {Database}=await import("bun:sqlite");const {initializeSchema}=await import("../src/core/schema.ts");
 const {ImportedTextStore}=await import("../src/reader/imported-text.ts");const {importedSpeechSource}=await import("../src/reader/imported-speech.ts");
 const raw=new Database(":memory:"),queries:string[]=[];
 const db={query:async(sql:string,params:readonly unknown[]=[])=>{queries.push(sql);return raw.query(sql).all(...params as any[]) as Record<string,unknown>[];},execute:async(sql:string,params:readonly unknown[]=[])=>{raw.query(sql).run(...params as any[]);},transaction:async(statements:{sql:string;params?:readonly unknown[]}[])=>{raw.transaction(()=>{for(const s of statements)raw.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 try{
  await initializeSchema(db);raw.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'local','导入',0)");
  raw.run("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'标题','watchrss-watch-content:body.txt',' HTTPS://WATCHRSS.LOCAL/import-content/txt/1 ','key',0)");
  const files:string[]=[],store=new ImportedTextStore({stat:async path=>{files.push(path);return {file:true,size:6};},read:async()=>new Uint8Array(6),decode:()=>"导入正文"});
  const article={id:"1",title:"标题",content:"preview"};
  const first=await importedSpeechSource(db,store,article,{importedChunkIndex:0});expect((await first?.peek())?.text).toBe("导入正文");expect(files).toEqual(["article_content/body.txt"]);
  raw.run("INSERT INTO article_original_chunks(article_id,chunk_index,body) VALUES(1,0,'watchrss-watch-content:original.txt')");
  const original=await importedSpeechSource(db,store,article);expect(original?.segmentCount).toBe(0);expect(files.at(-1)).toBe("article_content/original.txt");expect((await original?.peek())?.text).toBe("标题。");
  // A large CLI book chapter has the same managed marker and must use bounded
  // chunk reads rather than displaying the marker or loading the entire body.
  raw.run("UPDATE articles SET link=?",['watchrss://import/online-v1/'+'a'.repeat(64)]);
  const cli=await importedSpeechSource(db,store,article,{importedChunkIndex:0});
  expect((await cli?.peek())?.text).toBe("导入正文");expect(files.at(-1)).toBe("article_content/original.txt");
  for(const link of ['https://remote.test/article','https://watchrss.local/import-content/pdf/1']){raw.run("UPDATE articles SET link=?",[link]);const before=files.length;expect(await importedSpeechSource(db,store,article)).toBeNull();expect(files.length).toBe(before);}
  expect(queries.filter(q=>q.includes('FROM articles a WHERE')).every(q=>q.includes('substr(content,1,512)'))).toBe(true);
 }finally{raw.close();}
});
test("closing an in-flight source prevents further file scans",async()=>{
 const first=deferred<string|null>(),reads:number[]=[];
 const source=new ImportedSpeechSegmentSource("",100,index=>{reads.push(index);return first.promise;});
 const pending=source.peek();source.close();first.resolve("  ");expect(await pending).toBeNull();expect(await source.peek()).toBeNull();expect(reads).toEqual([0]);
});
