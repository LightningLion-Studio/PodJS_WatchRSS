import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {gunzipSync} from "node:zlib";
import {rebuildArticleBody,parseBodyJson,encodeBodyJson,requireMetadataOnlyBody,MAX_BODY_JSON_BYTES,type SyncBodyCodec,type SyncBodyPayload} from "../../src/sync/article-body.ts";
import {javaUtf8Chunks} from "../../src/reader/imported-text-writer.ts";
import native from "../fixtures/sync-body-android.json";
const sha=async(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const codec:SyncBodyCodec={
 sha256:sha,
 encode:async body=>{
  const row=native.cases.find(r=>r.decoded.contentHtml===body.contentHtml&&r.decoded.contentText===body.contentText);
  if(!row)throw new Error("fixture has no native gzip encoding for local body");return new Uint8Array(Buffer.from(row.encodedBase64,"base64"));
 },
 decode:async bytes=>{
  const plain=bytes[0]===31&&bytes[1]===139?gunzipSync(bytes,{maxOutputLength:MAX_BODY_JSON_BYTES}):Buffer.from(bytes);
  return plain.toString("utf8");
 },
};
function payload(index:number):SyncBodyPayload{
 const r=native.cases[index]!,bytes=Buffer.from(r.encodedBase64,"base64");
 return {articleId:`case-${index}`,bodyHash:r.bodyHash,bodyByteCount:r.bodyByteCount,chunkSize:r.chunkSize,chunkHashes:r.chunkHashes,chunks:r.chunkHashes.map((hash,index)=>({index,hash,bytes:new Uint8Array(bytes.subarray(index*r.chunkSize,(index+1)*r.chunkSize))}))};
}
test("encoding JSON bytes and rebuilding native compressed bodies match unchanged Kotlin",async()=>{
 for(let i=0;i<native.cases.length;i++){
  const r=native.cases[i]!;
  expect(Buffer.concat([...javaUtf8Chunks(encodeBodyJson(r.input))]).toString("base64")).toBe(r.jsonBase64);
  expect(await rebuildArticleBody(payload(i),null,codec)).toEqual(r.decoded);
 }
});
test("body parser agrees with native valid, malformed, duplicate, nesting and whitespace corpus",()=>{
 for(const r of native.jsonCases){
  if(r.ok)expect(parseBodyJson(r.text)).toEqual(r.body!);
  else expect(()=>parseBodyJson(r.text)).toThrow();
 }
});
test("matching native local body is reusable without transferred chunks",async()=>{
 for(let i=0;i<native.cases.length;i++)expect(await rebuildArticleBody({...payload(i),chunks:[]},native.cases[i]!.decoded,codec)).toEqual(native.cases[i]!.decoded);
});
test("changed body can reuse an unchanged local chunk while receiving the changed tail",async()=>{
 const original=payload(6),changed=payload(7);
 expect(changed.chunkHashes.length).toBeGreaterThan(1);expect(changed.chunkHashes[0]).toBe(original.chunkHashes[0]);
 expect(await rebuildArticleBody({...changed,chunks:changed.chunks.filter(c=>c.index!==0)},native.cases[6]!.decoded,codec)).toEqual(native.cases[7]!.decoded);
});
test("invalid chunk shape, missing data, wrong chunk bytes and whole hash fail before decoding",async()=>{
 const p=payload(1);let decoded=0;const guarded={...codec,decode:async(b:Uint8Array)=>{decoded++;return codec.decode(b);}};
 const mutations:SyncBodyPayload[]=[
  {...p,bodyByteCount:-1},{...p,chunkSize:0},{...p,chunkSize:0.5},{...p,bodyByteCount:0x80000000},
  {...p,chunkHashes:[]},{...p,chunkHashes:[""]},{...p,chunks:[]},
  {...p,chunks:[{...p.chunks[0]!,index:9}]},{...p,chunks:[{...p.chunks[0]!,bytes:new Uint8Array(1)}]},
  {...p,chunks:[{...p.chunks[0]!,bytes:new Uint8Array(p.chunks[0]!.bytes.length)}]},
  {...p,bodyHash:"f".repeat(64)}, {...p,chunks:[p.chunks[0]!,{...p.chunks[0]!,hash:"0".repeat(64)}]},
 ];
 for(const mutation of mutations)await expect(rebuildArticleBody(mutation,null,guarded)).rejects.toThrow();
 expect(decoded).toBe(0);
});
test("metadata-only transfer requires stored local bytes and an exact regenerated body manifest",async()=>{
 const original=payload(6),p={...original,metadataOnly:true,chunks:[]},local=native.cases[6]!.decoded;
 expect(await requireMetadataOnlyBody(p,local,true,true,codec)).toBe(local);
 for(const [available,stored] of [[false,true],[true,false]])await expect(requireMetadataOnlyBody(p,local,available!,stored!,codec)).rejects.toThrow();
 await expect(requireMetadataOnlyBody(p,null,true,true,codec)).rejects.toThrow();
 for(const changed of [{...p,metadataOnly:false},{...p,chunks:original.chunks},{...p,bodyHash:"0".repeat(64)},{...p,bodyByteCount:p.bodyByteCount+1},{...p,chunkSize:1},{...p,chunkHashes:p.chunkHashes.slice(1)}])await expect(requireMetadataOnlyBody(changed,local,true,true,codec)).rejects.toThrow();
});
