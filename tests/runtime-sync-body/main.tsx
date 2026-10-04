import {mount} from "@pocketjs/framework/solid";
import {Text} from "@pocketjs/framework/components";
import {kv} from "@podjs/framework/watch";
import {fileChunks,base64ToBytes,bytesToBase64} from "@podjs/framework/services";
import {hostArticleBodyCodec as codec} from "../../src/sync/article-body-host.ts";
import {rebuildArticleBody,requireMetadataOnlyBody,parseBodyJson,type SyncBodyPayload} from "../../src/sync/article-body.ts";
import {importedTextWriter} from "../../src/reader/imported-text-storage.ts";
import {ImportedTextStore,importedTextFileName} from "../../src/reader/imported-text.ts";
import fixtures from "./fixtures.json";
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const store=new ImportedTextStore({stat:fileChunks.stat,read:async(p,o,n)=>base64ToBytes((await fileChunks.read(p,o,n)).dataBase64),readText:fileChunks.readText});
function payload(index:number):SyncBodyPayload {
 const r=fixtures[index]!,bytes=base64ToBytes(r.encodedBase64);
 return {articleId:`harness-${index}`,bodyHash:r.bodyHash,bodyByteCount:r.bodyByteCount,chunkSize:r.chunkSize,chunkHashes:r.chunkHashes,chunks:r.chunkHashes.map((hash,index)=>({index,hash,bytes:bytes.subarray(index*r.chunkSize,(index+1)*r.chunkSize)}))};
}
async function run(){
 kv.set("sync-body-result",{state:"running"});const started=Date.now(),results=[];
 for(let i=0;i<fixtures.length;i++){
  kv.set("sync-body-result",{state:"running",case:i});const row=fixtures[i]!,p=payload(i);
  const encoded=await codec.encode(row.decoded);check(bytesToBase64(encoded)===row.encodedBase64,`native gzip bytes differ in case ${i}`);
  const body=await rebuildArticleBody(p,null,codec);check(JSON.stringify(body)===JSON.stringify(row.decoded),`rebuild differs ${i}`);
  const reused=await requireMetadataOnlyBody({...p,chunks:[],metadataOnly:true},row.decoded,true,true,codec);check(reused===row.decoded,"metadata-only did not reuse local body");
  const marker=await importedTextWriter.storeText(`sync-harness-${i}`,body.contentText),path=`article_content/${importedTextFileName(marker)}`;
  try{
   const handle=await store.handle(marker);check(handle,"reader did not accept writer marker");const parts=[];
   for(let index=0;index<handle.chunkCount;index++)parts.push(await store.chunk(handle,index));
   check(parts.join("")===body.contentText,`reader round trip differs ${i}`);
   results.push({index:i,gzipBytes:encoded.length,bodyHash:await codec.sha256(encoded),textBytes:handle.byteLength,readerChunks:handle.chunkCount});
  }finally{await fileChunks.remove(path);}
 }
 const changed=payload(2);check(changed.chunkHashes[0]===payload(1).chunkHashes[0],"fixture lacks reusable chunk");
 const rebuilt=await rebuildArticleBody({...changed,chunks:changed.chunks.filter(c=>c.index!==0)},fixtures[1]!.decoded,codec);
 check(rebuilt.contentText===fixtures[2]!.decoded.contentText,"partial local reuse differs");
 let rejected=false;try{parseBodyJson('{"contentText":"a","contentText":"b"}');}catch{rejected=true;}check(rejected,"duplicate body key accepted");
 kv.set("sync-body-result",{state:"passed",cases:results,partialLocalReuse:true,duplicateFieldRejected:true,elapsedMs:Date.now()-started});
}
mount(()=><Text>Sync body verification</Text>);
void run().catch(error=>{kv.set("sync-body-result",{state:"failed",error:String(error),stack:error instanceof Error?error.stack:""});});
