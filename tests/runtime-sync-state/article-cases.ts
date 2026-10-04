import {fileChunks,base64ToBytes} from "@podjs/framework/services";
import {kv} from "@podjs/framework/watch";
import type {SqlDatabase} from "../../src/core/types.ts";
import {SyncArticleReceiver,type IncomingArticle} from "../../src/sync/article-receiver.ts";
import {hostArticleBodyCodec as codec} from "../../src/sync/article-body-host.ts";
import type {SyncBodyPayload} from "../../src/sync/article-body.ts";
import {importedTextWriter} from "../../src/reader/imported-text-storage.ts";
import {ImportedTextStore,importedTextFileName} from "../../src/reader/imported-text.ts";
import {SqlReadingProgressStore} from "../../src/reader/sql-progress.ts";
import {ReadingProgressStore} from "../../src/reader/progress.ts";
import {WatchRssRepository} from "../../src/core/repository.ts";
import fixtures from "../fixtures/article-merge-native.json";
const incoming=(p:Partial<IncomingArticle>={}):IncomingArticle=>({articleId:"one",sourceDeviceId:"phone",url:"https://article/a",title:"Article",siteName:"Site",excerpt:"excerpt",imageUrl:null,importedAt:100,updatedAt:100,rssSourceUrl:null,rssSourceTitle:null,favoriteSaved:true,favoriteChangedAt:100,favoriteSortOrder:100,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,readingProgress:.25,readingPositionBytes:2,readingPositionContentHash:"body",readingPositionChangedAt:100,isRead:false,deleted:false,...p});
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
export async function runArticleCases(db:SqlDatabase){
 const reader=new ImportedTextStore({stat:fileChunks.stat,read:async(p,o,n)=>base64ToBytes((await fileChunks.read(p,o,n)).dataBase64),readText:fileChunks.readText});
 const published=new Set<string>();
 const files={storeText:async(k:string,t:string)=>{const marker=await importedTextWriter.storeText(k,t);published.add(`article_content/${importedTextFileName(marker)}`);return marker;},hydrate:async(t:string)=>{if(!importedTextFileName(t))return t;const h=await reader.handle(t);check(h,"missing body file");const parts=[];for(let i=0;i<h.chunkCount;i++){const part=await reader.chunk(h,i);check(part!==null,"missing chunk");parts.push(part);}return parts.join("");}};
 const progress=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async k=>kv.get<string>(k)??null,set:async(k,v)=>{kv.set(k,v);}}));
 const receiver=new SyncArticleReceiver(db,codec,files,id=>progress.migrate(id),()=>500),repo=new WatchRssRepository(db,async()=>"",files.hydrate);
 const payloads=new Map<string,SyncBodyPayload>();
 async function payload(text:string){let p=payloads.get(text);if(p)return p;const bytes=await codec.encode({contentHtml:null,contentText:text}),hash=await codec.sha256(bytes);p={articleId:"one",bodyHash:hash,bodyByteCount:bytes.length,chunkSize:131072,chunkHashes:[],chunks:[]};
  const hashes:string[]=[],chunks=[];for(let index=0;index<Math.max(1,Math.ceil(bytes.length/131072));index++){const b=bytes.subarray(index*131072,(index+1)*131072),h=await codec.sha256(b);hashes.push(h);chunks.push({index,hash:h,bytes:b});}p.chunkHashes=hashes;p.chunks=chunks;payloads.set(text,p);return p;}
 async function reset(){await db.transaction(["DELETE FROM sync_saved_states","DELETE FROM sync_article_ids","DELETE FROM channels"].map(sql=>({sql})));}
 const row=async()=>(await db.query("SELECT * FROM articles WHERE dedup_key='one'"))[0]!;
 try{
  let i=0;
  for(const r of fixtures.cases){
   await reset();const old=await payload("old body");await receiver.receive(incoming({isRead:true,readingProgress:.5,readingPositionBytes:4,readingPositionContentHash:"old-position-hash",readingPositionChangedAt:r.oldTime}),old,"phone");
   const next=await payload(r.body);await receiver.receive(incoming({readingProgress:r.progress,readingPositionBytes:9,readingPositionContentHash:"incoming-position-hash",readingPositionChangedAt:r.newTime}),next,"phone",r.authoritative);
   const a=await row(),e=r.expected,s=(await db.query("SELECT * FROM article_reading_state WHERE article_id=?",[a.id]))[0]!;
   check(a.content===e.content&&a.reading_progress===e.progress&&a.is_read===(e.isRead?1:0),`native article ${i}`);
   check(s.position_bytes===e.positionBytes&&s.position_hash===e.positionHash&&s.changed_at===e.changedAt,`native position ${i}`);
   check((await db.query("SELECT body FROM article_original_chunks"))[0]?.body===e.originalContent,`native original ${i}`);
   check((await db.query("SELECT body_hash FROM article_sync_content"))[0]?.body_hash===(e.bodyHash==="old"?old.bodyHash:next.bodyHash),`native hash ${i}`);
   if(++i%8===0)kv.set("sync-state-result",{state:"running",articleCase:i});
  }
  await reset();const text="汉😀".repeat(18000),p=await payload(text);await receiver.receive(incoming(),p,"phone");let a=await row();check(await repo.getArticleBody(Number(a.id))===text,"large reader round trip");
  await progress.save(Number(a.id),1,.2505,{character:1,fraction:0});check((await progress.load(Number(a.id))).progress===.25&&(await progress.load(Number(a.id))).updatedAt===100,"native progress threshold");
  await progress.save(Number(a.id),12,.75,{character:42,fraction:.3});await repo.setSaved(Number(a.id),false);
  await receiver.receive(incoming({title:"metadata-only"}),{...p,metadataOnly:true,chunks:[]},"phone");a=await row();check(a.is_saved===0&&a.reading_progress===.75,"local write protection");check((await progress.load(Number(a.id))).textAnchor?.character===42,"local anchor lost");
  const before=JSON.stringify(a);let rejected=false;try{await receiver.receive(incoming({title:"corrupt"}),{...p,bodyHash:"invalid"},"phone");}catch{rejected=true;}check(rejected&&JSON.stringify(await row())===before,"corruption changed article");
  await db.execute("CREATE TRIGGER reject_article_merge BEFORE UPDATE ON sync_saved_states BEGIN SELECT RAISE(ABORT,'injected'); END");rejected=false;
  try{await receiver.receive(incoming({favoriteChangedAt:Date.now()+1,title:"must rollback"}),await payload("changed body"),"phone");}catch{rejected=true;}finally{await db.execute("DROP TRIGGER reject_article_merge");}
  check(rejected&&JSON.stringify(await row())===before,"article transaction rollback");
  await db.execute("DELETE FROM article_reading_state WHERE article_id=?",[a.id]);kv.set(`watchrss.reader.progress.${a.id}`,JSON.stringify({offset:12,progress:.8,updatedAt:200,textAnchor:{character:55,fraction:.4}}));check((await progress.load(Number(a.id))).textAnchor?.character===55,"legacy migration");check((await row()).reading_progress===Math.fround(.8),"legacy progress projection");
  await receiver.receive(incoming({readingPositionChangedAt:201,readingProgress:.4}),{...p,metadataOnly:true,chunks:[]},"phone");check((await progress.load(Number(a.id))).textAnchor===undefined,"remote anchor reset");
  const future=Date.now()+86400000;await receiver.receive(incoming({readingPositionChangedAt:future}),{...p,metadataOnly:true,chunks:[]},"phone");
  await Promise.all([progress.save(Number(a.id),1,.4,{character:4,fraction:0}),progress.save(Number(a.id),2,.6,{character:6,fraction:0})]);
  const local=await progress.load(Number(a.id));check(local.progress===Math.fround(.6)&&local.textAnchor?.character===6&&local.updatedAt<future,"local clock/order");
  return {nativeArticleCases:i,largeTextUtf16:text.length,largeBodyReaderRoundTrip:true,articleRollback:true,corruptBodyRejected:true,legacyMigration:true,remoteProgressVisible:true};
 }finally{await reset();for(const path of published)await fileChunks.remove(path);}
}
