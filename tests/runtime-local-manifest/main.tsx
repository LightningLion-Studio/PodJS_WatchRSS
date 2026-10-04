import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {sqlite,fileChunks,base64ToBytes} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {initializeSchema} from '../../src/core/schema.ts';
import {fixture,seedLocalManifestFixture,clearLocalManifestFixture} from '../helpers/local-manifest-fixture.ts';
import {LocalArticleManifestStore,stableArticleId} from '../../src/sync/local-manifest.ts';
import {articleMetadataHash,bodyForRequest,type ExportedArticle} from '../../src/sync/article-export.ts';
import {hostArticleBodyCodec as codec,hostSyncText as text} from '../../src/sync/article-body-host.ts';
import {ImportedTextStore,importedTextFileName} from '../../src/reader/imported-text.ts';
import {importedTextWriter} from '../../src/reader/imported-text-storage.ts';
import {ReadingProgressStore} from '../../src/reader/progress.ts';
import {SqlReadingProgressStore} from '../../src/reader/sql-progress.ts';
import {selectArticleBodyRequests} from '../../src/sync/manifest.ts';
import {ArticleBatchReceiver} from '../../src/sync/article-batches.ts';
import {SyncArticleReceiver} from '../../src/sync/article-receiver.ts';
import {encodeChunkData} from '../../src/sync/protocol.ts';
const db:SqlDatabase={query:(q,p)=>sqlite.query(q,p as any),execute:(q,p)=>sqlite.execute(q,p as any),transaction:s=>sqlite.transaction(s as any)};
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(v);}
async function run(){const start=Date.now();kv.set('local-manifest-result',{state:'running',phase:'host-primitives'});
 const owned=new Set<string>(),reader=new ImportedTextStore({stat:fileChunks.stat,read:async(p,o,n)=>base64ToBytes((await fileChunks.read(p,o,n)).dataBase64),readText:fileChunks.readText});
 const files={storeText:async(k:string,v:string)=>{const marker=await importedTextWriter.storeText(k,v);owned.add('article_content/'+importedTextFileName(marker));return marker;},hydrate:async(v:string)=>{if(!importedTextFileName(v))return v;const h=await reader.handle(v);check(h,'Missing content file');const parts=[];for(let i=0;i<h.chunkCount;i++){const part=await reader.chunk(h,i);check(part!==null,'Missing content chunk');parts.push(part);}return parts.join('');}};
 await initializeSchema(db);await clearLocalManifestFixture(db);
 const progress=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async k=>kv.get<string>(k)??null,set:async(k,v)=>{kv.set(k,v);}}));
 try{
  for(const row of fixture.urls)check(await stableArticleId(row.value,text.parseUri,codec)===row.articleId,'Native URI identity: '+row.value);
  for(const row of fixture.articles)check(await articleMetadataHash(row.article as ExportedArticle,codec)===row.metadataHash,'Native metadata hash: '+row.article.url);
  const missingMarker=await files.storeText('fixture-missing','missing placeholder');await fileChunks.remove('article_content/'+importedTextFileName(missingMarker));
  await seedLocalManifestFixture(db,files,text,codec,missingMarker);
  const store=new LocalArticleManifestStore(db,codec,text,files,id=>progress.migrate(id));
  kv.set('local-manifest-result',{state:'running',phase:'first-snapshot'});
  const first=await store.snapshot();check(canonical(first.map(p=>p.manifest))===canonical(fixture.first),'First native Room manifest mismatch');
  kv.set('local-manifest-result',{state:'running',phase:'second-snapshot'});
  const second=await store.snapshot();check(canonical(second.map(p=>p.manifest))===canonical(fixture.second),'Repeated native Room manifest mismatch');
  for(const p of second){const expected=fixture.payloads.find(a=>a.article.articleId===p.article.articleId);if(!expected){check(!p.manifest.bodyAvailable,'Missing native payload for available body');continue;}const materialized=await store.materializeRequested(p);const full=bodyForRequest(materialized,{articleId:p.article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false});const bytes=base64ToBytes(expected.encodedBase64);check(materialized.encodedBody?.length===bytes.length&&materialized.encodedBody.every((b,i)=>b===bytes[i]),'Native encoded outgoing body mismatch');check(full.chunks.length===p.manifest.chunkHashes.length,'Full request chunks');}
  // A real nonempty local manifest selects a metadata-only saved article.
  const html=await store.materializeRequested(second.find(p=>p.article.url==='https://example.com/html')!);
  const remote={...html.manifest,updatedAt:html.article.updatedAt+1,metadataHash:'remote-metadata'};
  const requests=selectArticleBodyRequests(second.map(p=>p.manifest),[remote],{supportsMetadataOnly:true});check(requests.length===1&&requests[0]!.metadataOnly,'Nonempty local body reuse selection');
  // The native resolver locates synchronized RSS items by article id. Bind this
  // fixture as a previously received item before applying the selected update.
  const body=bodyForRequest(html,requests[0]!);
  await db.execute('UPDATE articles SET dedup_key=? WHERE id=10',[html.article.articleId]);
  await db.execute('INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,10,?)',[html.article.articleId,html.article.url]);
  await db.execute('INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(10,?,?,?,?,?,?,?)',[html.article.contentHtml,html.article.contentText,html.manifest.bodyHash,html.manifest.bodyByteCount,html.manifest.chunkSize,JSON.stringify(html.manifest.chunkHashes),0]);
  const receiver=new SyncArticleReceiver(db,codec,files,id=>progress.migrate(id));const batch=new ArticleBatchReceiver(requests,p=>receiver.receive(p.article,p.body,'phone'));
  const receipt=await batch.consume({action:'syncLibrary',phase:'articles',articles:[{...html.article,updatedAt:remote.updatedAt,title:'Metadata update',body:{...body,chunks:body.chunks.map(c=>({index:c.index,hash:c.hash,data:encodeChunkData(c.bytes)}))}}]});batch.finish();check(receipt?.committedArticles===1,'Selected metadata update was not committed');
  check((await db.query('SELECT title FROM articles WHERE id=10'))[0]?.title==='Metadata update','Metadata update not visible');
  kv.set('local-manifest-result',{state:'running',phase:'concurrent-change'});
  let changed=false;const racing=new LocalArticleManifestStore(db,codec,text,{...files,hydrate:async v=>{if(!changed){changed=true;await db.execute("UPDATE articles SET title='Concurrent edit' WHERE id=7");}return files.hydrate(v);}},id=>progress.migrate(id));let rejected=false;try{await racing.snapshot();}catch(e){rejected=String(e).includes('changed during');}check(rejected,'Concurrent snapshot was accepted');
  kv.set('local-manifest-result',{state:'passed',nativeManifests:fixture.first.length,repeatedManifest:true,nativeUrls:fixture.urls.length,nativeMetadataHashes:fixture.articles.length,nativeOutgoingBodies:fixture.payloads.length,nonemptyMetadataOnlyTransfer:true,missingFileUnavailable:true,concurrentSnapshotRejected:true,elapsedMs:Date.now()-start});
 }finally{await clearLocalManifestFixture(db);for(const path of owned)await fileChunks.remove(path);}
}
mount(()=><Text>Local manifest verification</Text>);
void run().catch(e=>kv.set('local-manifest-result',{state:'failed',error:String(e),stack:e instanceof Error?e.stack:''}));
