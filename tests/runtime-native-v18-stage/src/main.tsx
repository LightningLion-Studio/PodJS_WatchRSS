import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {base64ToBytes,fileChunks,sqlite,uri} from '@podjs/framework/services';
import {SqlLibrarySessionRepository} from '../../../src/sync/library-repository.ts';
import {hostArticleBodyCodec,hostSyncText} from '../../../src/sync/article-body-host.ts';
import {ImportedTextStore,importedTextFileName} from '../../../src/reader/imported-text.ts';
import {importedTextWriter} from '../../../src/reader/imported-text-storage.ts';
import {initializeSchema} from '../../../src/core/schema.ts';
import type {SqlDatabase} from '../../../src/core/types.ts';

mount(()=><View class="absolute inset-0 bg-black items-center justify-center"><Text class="text-sm text-white">原生 v18 阶段验证</Text></View>);
let metadataQueries=0;
const db:SqlDatabase={query:(sql,params)=>{if(sql.startsWith('SELECT a.id,a.channel_id')&&sql.includes(' ORDER BY a.fetched_at'))metadataQueries++;return sqlite.query(sql,params as (string|number|null)[]);},
  execute:(sql,params)=>sqlite.execute(sql,params as (string|number|null)[]),
  transaction:statements=>sqlite.transaction(statements as {sql:string;params?:(string|number|null)[]}[])};
const imported=new ImportedTextStore({stat:fileChunks.stat,
  read:async(path,offset,maxBytes)=>base64ToBytes((await fileChunks.read(path,offset,maxBytes)).dataBase64),
  readText:fileChunks.readText});
async function hydrate(value:string):Promise<string>{
  if(!importedTextFileName(value))return value;
  const handle=await imported.handle(value);if(!handle)throw Error('staged article file is missing');
  const chunks:string[]=[];for(let index=0;index<handle.chunkCount;index++){
    const part=await imported.chunk(handle,index);if(part===null)throw Error('staged article file cannot be read');chunks.push(part);
  }
  return chunks.join('');
}
void (async()=>{
  await initializeSchema(db);
  const articleCountRow=(await db.query('SELECT COUNT(*) AS count FROM articles'))[0];
  if(Number(articleCountRow?.count)!==6006)throw Error('native stage article count mismatch');
  const repository=new SqlLibrarySessionRepository(db,{codec:hostArticleBodyCodec,text:hostSyncText,
    uri:{parseUri:uri.parse,parseAndroid:uri.parse},
    files:{storeText:(key,text)=>importedTextWriter.storeText(key,text),hydrate},
    migrateReading:async()=>{},cleanupRemovedContent:async()=>{}});
  const started=Date.now();
  const cursor=await repository.cursor('native-v18-cache-fixture'),cursorElapsedMs=Date.now()-started;
  const afterCursor=metadataQueries;
  const windowStarted=Date.now(),window=await repository.prepareWindow('native-v18-cache-fixture',0);
  const windowElapsedMs=Date.now()-windowStarted,afterWindow=metadataQueries;
  const sourcesStarted=Date.now(),sources=await repository.exportSources();
  const sourcesElapsedMs=Date.now()-sourcesStarted,afterSources=metadataQueries;
  const firstBody=window.fullArticleManifest.find(row=>row.bodyAvailable);
  if(!firstBody)throw Error('native stage has no exportable body');
  const requestedStarted=Date.now();
  const requested=await repository.exportRequested([{articleId:firstBody.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);
  const requestedElapsedMs=Date.now()-requestedStarted,afterRequested=metadataQueries;
  if(requested.length!==1||afterCursor!==afterWindow||afterWindow!==afterSources||afterSources!==afterRequested)
    throw Error('unchanged stage snapshot was recomputed');
  const hotStarted=Date.now();
  await repository.cursor('native-v18-cache-fixture');
  const hotCursorElapsedMs=Date.now()-hotStarted,hotMetadataQueries=metadataQueries-afterRequested;
  const hotRequestStarted=Date.now();
  const hotRequested=await repository.exportRequested([{articleId:firstBody.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);
  const hotRequestedElapsedMs=Date.now()-hotRequestStarted;
  if(hotRequested.length!==1||hotRequested[0]!.encodedBody===null||
     JSON.stringify(hotRequested[0]!.manifest)!==JSON.stringify(requested[0]!.manifest))
    throw Error('persisted cached body was not materialized exactly');
  const active=window.fullArticleManifest.filter(row=>!row.deleted),available=active.filter(row=>row.bodyAvailable);
  const nativeHashRows=(await db.query('SELECT COUNT(*) AS count FROM article_native_sync_hash'))[0];
  const cachedRows=(await db.query('SELECT COUNT(*) AS count FROM article_sync_content'))[0];
  const integrity=(await db.query('PRAGMA quick_check'))[0];
  const foreignKeys=await db.query('PRAGMA foreign_key_check');
  if(integrity?.quick_check!=='ok'||foreignKeys.length)throw Error('staged database integrity failed');
  kv.set('native-v18-stage-runtime-result',{state:'passed',articleCount:6006,
    manifestEntries:window.fullArticleManifest.length,activeEntries:active.length,bodyAvailable:available.length,
    nativeHashRows:Number(nativeHashRows?.count),cachedBodyRows:Number(cachedRows?.count),
    sourceCount:sources.length,requestedBodies:requested.length,localMaxSeq:cursor.localMaxSeq,
    metadataQueries:afterRequested,cursorElapsedMs,windowElapsedMs,sourcesElapsedMs,requestedElapsedMs,
    hotCursorElapsedMs,hotMetadataQueries,hotRequestedElapsedMs,
    quickCheck:true,foreignKeyErrors:0,elapsedMs:Date.now()-started});
})().catch(error=>kv.set('native-v18-stage-runtime-result',{state:'failed',message:String(error).slice(0,400)}));
