import {test,expect} from "bun:test";
import {selectArticleBodyRequests,parseArticleManifest,meaningfulProgressAhead,type ArticleManifest} from "../../src/sync/manifest.ts";
import {parseWireJson} from "../../src/sync/wire-json.ts";
const entry=(p:Partial<ArticleManifest>={}):ArticleManifest=>({articleId:"a",sourceDeviceId:"phone",contentHash:"c",updatedAt:100,independentChangedAt:0,favoriteChangedAt:0,watchLaterChangedAt:0,deletedAt:0,deleted:false,bodyHash:"body",bodyByteCount:2,chunkSize:1,chunkHashes:["one","two"],metadataHash:"meta",bodyAvailable:true,bodySyncMode:"full",readingProgress:0,readingPositionBytes:0,readingPositionContentHash:"",readingPositionChangedAt:0,isRead:false,...p});
test("selector requests new bodies and reuses only available matching local chunks",()=>{
 expect(selectArticleBodyRequests([], [entry()])[0]?.chunkIndexes).toEqual([0,1]);
 expect(selectArticleBodyRequests([entry()], [entry()])).toEqual([]);
 expect(selectArticleBodyRequests([entry()], [entry({bodyHash:"changed",chunkHashes:["one","changed"]})])[0]?.chunkIndexes).toEqual([1]);
 expect(selectArticleBodyRequests([entry({bodyAvailable:false})], [entry()])[0]?.chunkIndexes).toEqual([0,1]);
 expect(selectArticleBodyRequests([entry()], [entry({bodyHash:"changed",bodySyncMode:"saved"})])[0]?.chunkIndexes).toEqual([0,1]);
 expect(selectArticleBodyRequests([], [entry({bodyAvailable:false})])).toEqual([]);
});
test("metadata-only requires saved mode, actual body equality and peer capability",()=>{
 const r=entry({updatedAt:101,bodySyncMode:"saved"});expect(selectArticleBodyRequests([entry()], [r],{supportsMetadataOnly:true})[0]).toMatchObject({metadataOnly:true,chunkIndexes:[]});
 expect(selectArticleBodyRequests([entry()], [r])[0]?.metadataOnly).toBe(false);
 expect(selectArticleBodyRequests([entry()], [entry({updatedAt:101})],{supportsMetadataOnly:true})[0]?.metadataOnly).toBe(false);
 expect(selectArticleBodyRequests([entry()], [entry({metadataHash:"other"})])).toEqual([]);
});
test("deleted state selection and native float epsilon preserve metadata rules",()=>{
 expect(selectArticleBodyRequests([], [entry({deleted:true,bodyHash:"",bodyByteCount:-1,chunkHashes:[]})])[0]?.chunkIndexes).toEqual([]);
 expect(selectArticleBodyRequests([entry({deleted:true})], [entry({deleted:true,isRead:true,readingPositionChangedAt:100})])).toEqual([]);
 expect(meaningfulProgressAhead(.501,.5)).toBe(false);expect(meaningfulProgressAhead(.501001,.5)).toBe(true);
 expect(selectArticleBodyRequests([entry()], [entry({readingProgress:.001})])).toEqual([]);
 expect(selectArticleBodyRequests([entry()], [entry({isRead:true})])).toHaveLength(1);
});
test("native budget keeps first oversized article whole and retains zero-chunk requests",()=>{
 const remote=[entry(),entry({articleId:"b"}),entry({articleId:"deleted",deleted:true}),entry({articleId:"small",bodyByteCount:1,chunkHashes:["one"]})];
 expect(selectArticleBodyRequests([],remote,{maxChunks:1}).map(r=>r.articleId)).toEqual(["a","deleted"]);
 expect(selectArticleBodyRequests([],remote,{maxChunks:0}).map(r=>r.articleId)).toEqual(["deleted"]);
 expect(selectArticleBodyRequests([],remote,{maxChunks:3}).map(r=>r.articleId)).toEqual(["a","deleted","small"]);
});
test("wire manifest parser retains strict integer types and rejects invalid needed shape",()=>{
 const raw=JSON.stringify({articleManifest:[entry()]});expect(parseArticleManifest(parseWireJson(raw))).toEqual([entry()]);
 expect(()=>parseArticleManifest(parseWireJson(raw.replace('"chunkSize":1','"chunkSize":1.0')))).toThrow();
 expect(()=>selectArticleBodyRequests([], [entry({bodyByteCount:3})])).toThrow("shape");
});

import native from "../fixtures/manifest-selection-android.json";
test("manifest selection matches actual Android production results",()=>{
 for(const row of native.cases){
  let ok=true,value:unknown;
  try{value=selectArticleBodyRequests(parseArticleManifest(parseWireJson(row.local)),parseArticleManifest(parseWireJson(row.remote)),{maxChunks:row.limit,supportsMetadataOnly:row.support});}catch{ok=false;}
  expect({name:row.name,ok}).toEqual({name:row.name,ok:row.ok});
  if(ok)expect(value).toEqual((row as {requests?:unknown}).requests);
 }
});
