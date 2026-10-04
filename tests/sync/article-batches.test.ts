import {test,expect} from "bun:test";
import {ArticleBatchReceiver,parseChunkedArticles,validateArticleRequestFrame,type RequestedArticleBody} from "../../src/sync/article-batches.ts";
import {parseWireJson,isWireInteger} from "../../src/sync/wire-json.ts";
import {encodeFrame,FrameDecoder,decodeChunkData,encodeChunkData,mergeVerifiedChunks} from "../../src/sync/protocol.ts";
const request=(id="a"):RequestedArticleBody=>({articleId:id,bodyHash:"body",chunkIndexes:[0,1],metadataOnly:false});
const article=(id="a",index=0,data="AA==")=>({articleId:id,url:"https://example/"+id,title:"Title",body:{bodyHash:"body",bodyByteCount:2,chunkSize:1,chunkHashes:["chunk","chunk"],chunks:[{index,hash:"chunk",data}]}});
const frame=(index:number,count:number,articles:unknown[])=>({action:"syncLibrary",phase:"articles",batchIndex:index,batchCount:count,articles});
test("arbitrary wire fragments preserve native integer tokens without quadratic frame copies",()=>{
 const raw='{"action":"syncLibrary","phase":"articles","batchIndex":0,"batchCount":1,"articles":[{"articleId":"a","url":"u","body":{"bodyByteCount":1,"chunkSize":1.0,"chunkHashes":["h"]}}]}';
 const body=new TextEncoder().encode(raw),bytes=new Uint8Array(body.length+4);new DataView(bytes.buffer).setInt32(0,body.length);bytes.set(body,4);
 const decoder=new FrameDecoder(),results:Record<string,unknown>[]=[];for(const b of bytes)results.push(...decoder.push(Uint8Array.of(b)));decoder.finish();expect(()=>parseChunkedArticles(results[0]!)).toThrow("chunkSize");
 const parsed=parseWireJson('{"i":1,"d":1.0,"e":1e0,"nested":[2,2.0],"dupe":1.0,"dupe":1,"text":"{} \\\""}');expect(isWireInteger(parsed,"i")).toBe(true);expect(isWireInteger(parsed,"d")).toBe(false);expect(isWireInteger(parsed,"e")).toBe(false);expect(isWireInteger(parsed,"dupe")).toBe(true);expect(isWireInteger(parsed.nested as object,"1")).toBe(false);
});
test("Java base64 accepts unpadded/equivalent bits but checksums are case-sensitive",async()=>{
 expect(decodeChunkData("AA")).toEqual(Uint8Array.of(0));expect(decodeChunkData("AB==")).toEqual(Uint8Array.of(0));expect(encodeChunkData(decodeChunkData("AAA"))).toBe("AAA=");
 for(const data of ["A","AA=","AAAA="," AA==","AA\n"])expect(()=>decodeChunkData(data)).toThrow();
 await expect(mergeVerifiedChunks([{index:0,data:"AA==",hash:"ab"},{index:0,data:"AA",hash:"ab"}],async()=>"ab")).resolves.toHaveLength(1);
 await expect(mergeVerifiedChunks([{index:0,data:"AA==",hash:"AB"}],async()=>"ab")).rejects.toThrow("checksum");
});
test("batches hold an article across frames and receipt waits for commit",async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),committed:string[]=[];
 const receiver=new ArticleBatchReceiver([request()],async item=>{expect(item.body.chunks).toHaveLength(2);await gate;committed.push(item.article.articleId);});
 expect(await receiver.consume(frame(0,2,[article()]))).toBeNull();expect(committed).toHaveLength(0);
 let finished=false;const pending=receiver.consume(frame(1,2,[article("a",1)])).then(value=>{finished=true;return value;});await Promise.resolve();expect(finished).toBe(false);expect(()=>receiver.finish()).toThrow();
 release();expect(await pending).toMatchObject({frameCount:2,receivedArticles:1,committedArticles:1});receiver.finish();expect(committed).toEqual(["a"]);
});
test("commit failure, abort and truncated batches never produce completion",async()=>{
 const failed=new ArticleBatchReceiver([request()],async()=>{throw new Error("database failed");});await expect(failed.consume(frame(0,1,[article(),article("a",1)]))).rejects.toThrow("database failed");expect(()=>failed.finish()).toThrow();await expect(failed.consume(frame(0,1,[]))).rejects.toThrow();
 let release!:()=>void;const stopped=new ArticleBatchReceiver([request()],()=>new Promise<void>(r=>{release=r;}));const pending=stopped.consume(frame(0,1,[article()]));await Promise.resolve();stopped.abort();release();await expect(pending).rejects.toThrow("aborted");expect(()=>stopped.finish()).toThrow();
 const truncated=new ArticleBatchReceiver([request()],async()=>{});await truncated.consume(frame(0,2,[article()]));expect(()=>truncated.finish()).toThrow("truncated");
});
test("rejects unsolicited, repeated noncontiguous and conflicting body fragments",async()=>{
 for(const [frames,pattern] of [
  [[frame(0,1,[article("b")])],"unsolicited"],
  [[frame(0,3,[article()]),frame(1,3,[article("b")]),frame(2,3,[article()])],"noncontiguous"],
  [[frame(0,2,[article()]),frame(1,2,[article("a",0,"AQ")])],"conflicting"],
  [[frame(0,2,[article()]),frame(1,2,[{...article(),body:{...article().body,bodyByteCount:3,chunkHashes:["chunk","chunk","chunk"]}}])],"conflicting"],
 ] as const){const receiver=new ArticleBatchReceiver(pattern==="noncontiguous"?[request(),request("b")]:[request()],async()=>{});let error:unknown;try{for(const f of frames)await receiver.consume(f);}catch(e){error=e;}expect(String(error)).toContain(pattern);expect(()=>receiver.finish()).toThrow();}
});
test('watch-as-source counts parsed incoming articles without requiring local body requests',async()=>{
 const ignored:string[]=[];
 const receiver=new ArticleBatchReceiver([],async entry=>{ignored.push(entry.article.articleId);},{ignoreIncoming:true});
 expect(await receiver.consume(frame(0,1,[article('from-phone')]))).toMatchObject({receivedArticles:1,committedArticles:1});
 receiver.finish();expect(ignored).toEqual(['from-phone']);
 const invalid=new ArticleBatchReceiver([],async()=>{},{ignoreIncoming:true});
 await invalid.consume(frame(0,3,[article('a')]));
 await invalid.consume(frame(1,3,[article('b')]));
 await expect(invalid.consume(frame(2,3,[article('a')]))).rejects.toThrow('noncontiguous');
});
test("native batch field defaults/coercion and serial consume call ordering",async()=>{
 expect(validateArticleRequestFrame({action:"syncLibrary",phase:"articles"},0)).toBe(1);
 expect(validateArticleRequestFrame({action:"syncLibrary",phase:"articles",batchIndex:.9,batchCount:1.9},0)).toBe(1);
 const receiver=new ArticleBatchReceiver([request()],async()=>{});const a=receiver.consume(frame(0,2,[article()])),b=receiver.consume(frame(1,2,[article("a",1)]));expect(await a).toBeNull();expect((await b)?.committedArticles).toBe(1);
 const decoder=new FrameDecoder();decoder.push(encodeFrame({ok:true}).slice(0,5));expect(()=>decoder.finish()).toThrow("truncated");
});
import native from "../fixtures/article-batches-android.json";
import {parseChunkedArticleFrames} from "../../src/sync/article-batches.ts";
test("actual Android production parser corpus matches raw wire parsing",()=>{
 for(const row of native.articles){const call=()=>parseChunkedArticleFrames(row.frames.map(parseWireJson)).map(p=>({...p,body:{...p.body,chunks:p.body.chunks.map(c=>({index:c.index,hash:c.hash,data:encodeChunkData(c.bytes)}))}}));
  if(row.ok)expect(call(),row.name).toEqual((row as any).parsed);else expect(call,row.name).toThrow();
 }
 for(const row of native.batches){const call=()=>validateArticleRequestFrame(parseWireJson(row.frame),row.index,row.count??undefined);if(row.ok)expect(call()).toBe((row as any).result);else expect(call).toThrow();}
 for(const row of native.base64){const call=()=>encodeChunkData(decodeChunkData(row.input));if(row.ok)expect(call()).toBe((row as any).encoded);else expect(call).toThrow();}
});
