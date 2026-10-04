import {mount} from "@pocketjs/framework/solid";
import {Text} from "@pocketjs/framework/components";
import {kv} from "@podjs/framework/watch";
import {sqlite,fileChunks,base64ToBytes} from "@podjs/framework/services";
import {ArticleBatchReceiver,parseChunkedArticleFrames,validateArticleRequestFrame,type RequestedArticleBody,type ArticleBatchReceipt} from "../../src/sync/article-batches.ts";
import {parseWireJson} from "../../src/sync/wire-json.ts";
import {FrameDecoder,encodeFrame,encodeChunkData,decodeChunkData} from "../../src/sync/protocol.ts";
import {SyncArticleReceiver} from "../../src/sync/article-receiver.ts";
import {hostArticleBodyCodec as codec} from "../../src/sync/article-body-host.ts";
import {SyncSavedStateStore} from "../../src/sync/saved-state.ts";
import {initializeSchema} from "../../src/core/schema.ts";
import {WatchRssRepository} from "../../src/core/repository.ts";
import type {SqlDatabase} from "../../src/core/types.ts";
import {ImportedTextStore,importedTextFileName} from "../../src/reader/imported-text.ts";
import {importedTextWriter} from "../../src/reader/imported-text-storage.ts";
import {SqlReadingProgressStore} from "../../src/reader/sql-progress.ts";
import {ReadingProgressStore} from "../../src/reader/progress.ts";
import {parseArticleManifest,selectArticleBodyRequests} from "../../src/sync/manifest.ts";
import manifests from "../fixtures/manifest-selection-android.json";
import corpus from "../fixtures/article-batches-android.json";
import bodies from "../fixtures/sync-body-android.json";
const db:SqlDatabase={query:(q,p)=>sqlite.query(q,p as any),execute:(q,p)=>sqlite.execute(q,p as any),transaction:s=>sqlite.transaction(s as any)};
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==="object")return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(v);}
async function run(){
 const started=Date.now();kv.set("sync-batches-result",{state:"running",phase:"native-corpus"});
 for(const row of corpus.articles){let ok=true,value:unknown;try{value=parseChunkedArticleFrames(row.frames.map(parseWireJson)).map(p=>({...p,body:{...p.body,chunks:p.body.chunks.map(c=>({index:c.index,hash:c.hash,data:encodeChunkData(c.bytes)}))}}));}catch{ok=false;}check(ok===row.ok,`native parser status ${row.name}`);if(ok)check(canonical(value)===canonical((row as any).parsed),`native parser value ${row.name}`);}
 for(const row of corpus.batches){let ok=true,value;try{value=validateArticleRequestFrame(parseWireJson(row.frame),row.index,row.count??undefined);}catch{ok=false;}check(ok===row.ok,`native batch ${row.frame}`);if(ok)check(value===(row as any).result,"native batch count");}
 for(const row of corpus.base64){let ok=true,value;try{value=encodeChunkData(decodeChunkData(row.input));}catch{ok=false;}check(ok===row.ok,"native base64 status");if(ok)check(value===(row as any).encoded,"native base64 bytes");}
 for(const row of manifests.cases){let ok=true,value:unknown;try{value=selectArticleBodyRequests(parseArticleManifest(parseWireJson(row.local)),parseArticleManifest(parseWireJson(row.remote)),{maxChunks:row.limit,supportsMetadataOnly:row.support});}catch{ok=false;}check(ok===row.ok,`native manifest status ${row.name}`);if(ok)check(canonical(value)===canonical((row as {requests?:unknown}).requests),`native manifest requests ${row.name}`);}
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice("local");
 const reset=()=>db.transaction(["DELETE FROM sync_saved_states","DELETE FROM sync_article_ids","DELETE FROM channels"].map(sql=>({sql})));
 await reset();const filesOwned=new Set<string>(),reader=new ImportedTextStore({stat:fileChunks.stat,read:async(p,o,n)=>base64ToBytes((await fileChunks.read(p,o,n)).dataBase64),readText:fileChunks.readText});
 const files={storeText:async(k:string,v:string)=>{const m=await importedTextWriter.storeText(k,v);filesOwned.add(`article_content/${importedTextFileName(m)}`);return m;},hydrate:async(v:string)=>{if(!importedTextFileName(v))return v;const h=await reader.handle(v);check(h,"file missing");const out=[];for(let i=0;i<h.chunkCount;i++){const t=await reader.chunk(h,i);check(t!==null,"chunk missing");out.push(t);}return out.join("");}};
 const progress=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async k=>kv.get<string>(k)??null,set:async(k,v)=>{kv.set(k,v);}})),receiver=new SyncArticleReceiver(db,codec,files,id=>progress.migrate(id)),repo=new WatchRssRepository(db,async()=>"",files.hydrate);
 const large=bodies.cases[6]!,small=bodies.cases[1]!;
 function wire(id:string,row:typeof large,indexes:number[]){const bytes=base64ToBytes(row.encodedBase64);return {articleId:id,url:`https://example/${id}`,title:id,sourceDeviceId:"phone",favoriteSaved:true,favoriteChangedAt:100,favoriteSortOrder:100,readingProgress:.25,readingPositionChangedAt:100,body:{bodyHash:row.bodyHash,bodyByteCount:row.bodyByteCount,chunkSize:row.chunkSize,chunkHashes:row.chunkHashes,chunks:indexes.map(index=>({index,hash:row.chunkHashes[index]!,data:encodeChunkData(bytes.subarray(index*row.chunkSize,(index+1)*row.chunkSize)).replace(/=+$/,"")}))}};}
 function manifest(id:string,row:typeof large){return {articleId:id,bodyHash:row.bodyHash,bodyByteCount:row.bodyByteCount,chunkSize:row.chunkSize,chunkHashes:row.chunkHashes,bodyAvailable:true,bodySyncMode:"saved",favoriteChangedAt:100};}
 function request(id:string,row:typeof large):RequestedArticleBody{return selectArticleBodyRequests([],parseArticleManifest({articleManifest:[manifest(id,row)]}),{supportsMetadataOnly:true})[0]!;}
 check((await db.query("SELECT count(*) n FROM articles"))[0]?.n===0,"selection baseline must be empty");
 const selected=selectArticleBodyRequests([],parseArticleManifest(parseWireJson(JSON.stringify({articleManifest:[manifest("large",large),manifest("small",small)]}))),{supportsMetadataOnly:true});
 const frames=[{action:"syncLibrary",phase:"articles",batchIndex:0,batchCount:3,articles:[wire("large",large,[0])]},{action:"syncLibrary",phase:"articles",batchIndex:1,batchCount:3,articles:[wire("large",large,[1])]},{action:"syncLibrary",phase:"articles",batchIndex:2,batchCount:3,articles:[wire("small",small,[0])],bodyRequests:[{articleId:"return-article",bodyHash:"return-hash",chunkIndexes:[0]}]}];
 const committed:string[]=[],batch=new ArticleBatchReceiver(selected,async p=>{await receiver.receive(p.article,p.body,"phone");committed.push(p.article.articleId);});const decoder=new FrameDecoder();let receipt:ArticleBatchReceipt|null|undefined,fragments=0;
 try{
  kv.set("sync-batches-result",{state:"running",phase:"fragmented-receive"});
  for(let i=0;i<frames.length;i++){
   const bytes=encodeFrame(frames[i]!);for(let offset=0;offset<bytes.length;offset+=13){fragments++;for(const frame of decoder.push(bytes.subarray(offset,offset+13)))receipt=await batch.consume(frame);}
   if(i<2){check(receipt===null,"premature batch receipt");check((await db.query("SELECT count(*) n FROM articles"))[0]?.n===0,"premature article publication");}
  }
  decoder.finish();batch.finish();const finalReceipt=receipt as ArticleBatchReceipt|null|undefined;check(finalReceipt?.committedArticles===2&&finalReceipt.bodyRequests.length===1,"batch receipt");check(committed.join(',')==="large,small","commit order");
  const a=(await db.query("SELECT id FROM articles WHERE dedup_key='large'"))[0]!;check(await repo.getArticleBody(Number(a.id))===large.decoded.contentText,"large body reader mismatch");
  kv.set("sync-batches-result",{state:"running",phase:"failure-gates"});
  await db.execute("CREATE TRIGGER fail_batch BEFORE INSERT ON articles BEGIN SELECT RAISE(ABORT,'injected'); END");
  const failing=new ArticleBatchReceiver([request("failure",small)],p=>receiver.receive(p.article,p.body,"phone"));let rejected=false;
  try{await failing.consume({action:"syncLibrary",phase:"articles",articles:[wire("failure",small,[0])]});}catch{rejected=true;}finally{await db.execute("DROP TRIGGER fail_batch");}
  check(rejected,"failed DB accepted");let finished=true;try{failing.finish();}catch{finished=false;}check(!finished,"failed DB produced completion");check((await db.query("SELECT count(*) n FROM articles"))[0]?.n===2,"failed DB changed articles");
  const truncated=new ArticleBatchReceiver([request("large",large)],p=>receiver.receive(p.article,p.body,"phone"));await truncated.consume(frames[0]!);finished=true;try{truncated.finish();}catch{finished=false;}check(!finished,"truncated transfer completed");
  kv.set("sync-batches-result",{state:"passed",nativeManifestCases:manifests.cases.length,manifestSelectedTransfer:true,nativeArticleCases:corpus.articles.length,nativeBatchCases:corpus.batches.length,nativeBase64Cases:corpus.base64.length,fragments,committedArticles:2,largeTextLength:large.decoded.contentText.length,readerRoundTrip:true,noPrematureCompletion:true,databaseFailureGate:true,truncatedTransferGate:true,elapsedMs:Date.now()-started});
 }finally{await reset();for(const path of filesOwned)await fileChunks.remove(path);}
}
mount(()=><Text>Sync batch verification</Text>);
void run().catch(error=>kv.set("sync-batches-result",{state:"failed",error:String(error),stack:error instanceof Error?error.stack:""}));
