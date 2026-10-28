import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {prepareArticle,bodyForRequest,type ExportedArticle,type PreparedArticle} from '../../src/sync/article-export';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body';
import {LibrarySyncSession} from '../../src/sync/session';
import {selectArticleBodyRequests,parseArticleManifest} from '../../src/sync/manifest';
import {parseBodyRequests,parseChunkedArticles} from '../../src/sync/article-batches';
import {combineManifestFrames} from '../../src/sync/library-wire';
import {encodeFrame,decodeFrame,type JsonObject} from '../../src/sync/protocol';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {enabled} from '../cloud/k2-crypto';
import {cloudCrypto} from '../cloud/library-fixture';
import {article,parseUri,sha} from './ble-v2-fixture';

function codec(os:number):SyncBodyCodec{return {sha256:async bytes=>sha(bytes),encode:async body=>{const zipped=new Uint8Array(gzipSync(encodeBodyJson(body),{level:6}));zipped[9]=os;return zipped;},decode:async bytes=>gunzipSync(bytes).toString('utf8')};}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'wrss-body-hash-')),path=join(root,'library.db');let sql=new Database(path);
 // Test logical persistence and cold reopen, not power-loss/fsync latency.
 sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>ss.forEach(s=>sql.query(s.sql).run(...(s.params??[]) as any[])))();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{sql.query(s.sql).run(...(s.params??[]) as any[]);return Number((sql.query('SELECT changes() n').get() as any).n);} ))()};
 await initializeSchema(db,{seedBuiltinChannels:false});await new SyncSavedStateStore(db).initializeDevice('watch');
 const ports={codec:codec(0),text:{parseUri,htmlText:async(s:string)=>s.replace(/<[^>]*>/g,'')},uri:{parseUri,parseAndroid:parseUri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:()=>1000};
 const make=()=>new SqlLibrarySessionRepository(db,ports);
 return {db,make,reopen:()=>{sql.close();sql=new Database(path);sql.exec('PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON');return make();},close:async()=>{sql.close();await rm(root,{recursive:true,force:true});}};
}
const clone=(frame:JsonObject)=>decodeFrame(encodeFrame(frame));
/** Production watch phase coordinator and codecs; an in-process phone wire
 * harness supplies real requested gzip chunks and an explicit applied ACK. */
async function exchange(repo:SqlLibrarySessionRepository,phone:PreparedArticle[],acked=0){
 const sent:JsonObject[]=[],manifest:JsonObject[]=[];let reads=0,incomingBytes=0,outgoingBytes=0;
 const session=new LibrarySyncSession({readFrame:async()=>{
  if(++reads===1)return clone({version:14,action:'syncLibrary',phase:'manifest',deviceId:'phone',supportsChunkedBodies:true,supportsChangeSequences:true,supportsMetadataOnlyArticles:true,supportsFullMetadataOnlyArticles:true,supportsManifestBatches:true,supportsArticleBatches:true,articleManifest:phone.map(p=>p.manifest),rssSources:[],fullSnapshot:true,changeSeqRange:{fromExclusive:0,toInclusive:phone.length},syncCursor:{localMaxSeq:phone.length,lastRemoteSeqApplied:acked,lastLocalSeqAckedByPeer:0}});
  if(reads===2){const remote=combineManifestFrames(manifest),selected=parseBodyRequests(remote),requests=selectArticleBodyRequests(phone.map(p=>p.manifest),parseArticleManifest(remote),{supportsMetadataOnly:true,supportsFullMetadataOnly:true}),byId=new Map(phone.map(p=>[p.article.articleId,p]));
   const articles=selected.map(r=>{const p=byId.get(r.articleId)!;const {contentHtml:_html,contentText:_text,...metadata}=p.article,body=bodyForRequest(p,r);incomingBytes+=body.chunks.reduce((n,c)=>n+c.bytes.length,0);return {...metadata,body:{...body,chunks:body.chunks.map(c=>({index:c.index,hash:c.hash,data:Buffer.from(c.bytes).toString('base64')}))}};});
   return clone({version:14,action:'syncLibrary',phase:'articles',articles,bodyRequests:requests});
  }
  if(reads===3)return {action:'ack',success:true,phase:'applied',applied:true};throw Error('unexpected peer read');
 },writeFrame:async raw=>{const frame=clone(raw);sent.push(frame);if(frame.phase==='manifest')manifest.push(frame);if(frame.phase==='complete')for(const entry of parseChunkedArticles(frame)){outgoingBytes+=entry.body.chunks.reduce((n,c)=>n+c.bytes.length,0);const old=phone.find(p=>p.article.articleId===entry.article.articleId);if(old){const updated={...old.article,...entry.article};const p=await prepareArticle(updated,codec(255),true,old.manifest.bodyHash);phone[phone.indexOf(old)]=p;}}},close:async()=>{}},repo,{capabilities:{supportsFullMetadataOnlyArticles:true}});
 const results=await session.run();expect(results).toHaveLength(1);expect(results[0]!.response.success).toBe(true);expect(results[0]!.libraryApplied).toBe(true);
 const frame=combineManifestFrames(manifest),range=frame.changeSeqRange as JsonObject;
 return {incomingBytes,outgoingBytes,sent,acked:Number(range.toInclusive)};
}

for(const count of [1,500])test('real SQLite BLE → cloud archive → cold BLE twice retains wire hashes and sends zero body bytes: '+count,async()=>{
 const f=await fixture();try{
  const rows:ExportedArticle[]=Array.from({length:count},(_,i)=>{const url='https://fixture.invalid/body/'+i;return article({articleId:sha(url),url,title:'Fixture '+i,contentHtml:('<p>正文/🙂 '+i+'</p>').repeat(25),contentText:('正文/🙂 '+i+'\n').repeat(25),contentHash:sha('content-'+i),readingProgress:.25,readingPositionChangedAt:200,readingPositionBytes:10,readingPositionContentHash:'logical',favoriteSaved:true,favoriteChangedAt:150,favoriteSortOrder:150});});
  const phone=await Promise.all(rows.map(a=>prepareArticle(a,codec(255))));let repo=f.make();const first=await exchange(repo,phone);expect(first.incomingBytes).toBeGreaterThan(0);
  const initial=await f.db.query('SELECT * FROM article_sync_content ORDER BY item_id');
  await f.db.execute('UPDATE article_reading_state SET progress=?,changed_at=900,position_bytes=132161,position_hash=\'logical\',state_json=\'{"offset":77}\' WHERE article_id=1',[Math.fround(.7925)]);await f.db.execute('UPDATE articles SET reading_progress=?,is_read=1 WHERE id=1',[Math.fround(.7925)]);
  const reading=await f.db.query('SELECT * FROM article_reading_state ORDER BY article_id'),saved=await f.db.query('SELECT * FROM article_saved_states ORDER BY article_id,save_type');
  const producer=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:rows,stateArticles:rows,sources:[]}),mergeCloud:async()=>0},'phone',cloudCrypto,enabled),archive=await producer.exportPayloads(true);
  expect(archive.objects.map(o=>o.name)).toEqual(['private-library.wrss']);
  const consumer=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);const restored=await consumer.restorePayloads(new Map(archive.objects.map(o=>[o.name,o.bytes])),'phone');expect(restored.pending).toBe(0);expect(restored.abandoned).toBe(0);
  expect(await f.db.query('SELECT * FROM article_sync_content ORDER BY item_id')).toEqual(initial);expect(await f.db.query('SELECT * FROM article_reading_state ORDER BY article_id')).toEqual(reading);expect(await f.db.query('SELECT * FROM article_saved_states ORDER BY article_id,save_type')).toEqual(saved);
  repo=f.reopen();const second=await exchange(repo,phone,first.acked),third=await exchange(repo,phone,second.acked);
  expect(second.incomingBytes).toBe(0);expect(second.outgoingBytes).toBe(0);expect(third.incomingBytes).toBe(0);expect(third.outgoingBytes).toBe(0);
  expect(await f.db.query('SELECT * FROM article_sync_content ORDER BY item_id')).toEqual(initial);expect(await f.db.query('PRAGMA foreign_key_check')).toEqual([]);
  console.info('body-hash-stability.metrics',JSON.stringify({articles:count,unique:initial.length,firstBodyBytes:first.incomingBytes,secondBodyBytes:second.incomingBytes+second.outgoingBytes,thirdBodyBytes:third.incomingBytes+third.outgoingBytes}));
 }finally{await f.close();}
},30000);

test('legacy OS 0/3/255 hashes survive cloud restore, but genuinely changed text requires real chunks',async()=>{
 for(const os of [0,3,255]){const f=await fixture();try{
  let repo=f.make();const a=article({contentHtml:null,contentText:'before /\n'.repeat(100),readingProgress:.5,readingPositionChangedAt:500});const old=await prepareArticle(a,codec(os));await repo.receiveArticle({article:a,body:bodyForRequest(old,{articleId:a.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]})},'phone',false);
  await repo.mergeCloud([], [a], 'phone');expect((await f.db.query('SELECT body_hash FROM article_sync_content'))[0]!.body_hash).toBe(old.manifest.bodyHash);
  const changed={...a,contentText:'different real body',updatedAt:1000,contentHash:sha('changed')};await repo.mergeCloud([], [changed], 'phone');repo=f.reopen();const window=await repo.prepareWindow('phone',0),requests=selectArticleBodyRequests([old.manifest],window.fullArticleManifest,{supportsMetadataOnly:true,supportsFullMetadataOnly:true});
  expect(requests).toHaveLength(1);expect(requests[0]!.metadataOnly).toBe(false);expect(requests[0]!.chunkIndexes.length).toBeGreaterThan(0);expect(window.fullArticleManifest[0]!.bodyHash).not.toBe(old.manifest.bodyHash);
  const actual=await repo.exportRequested(requests);expect(gunzipSync(actual[0]!.encodedBody!).toString('utf8')).toBe(encodeBodyJson(changed));
 }finally{await f.close();}}
});

test('cloud metadata-only placeholder preserves real cached body; corrupt or missing advertised BLE body is rejected',async()=>{
 const f=await fixture();try{
  const repo=f.make(),a=article(),old=await prepareArticle(a,codec(255)),request={articleId:a.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]},body=bodyForRequest(old,request);
  await repo.receiveArticle({article:a,body},'phone',false);const before=await f.db.query('SELECT * FROM article_sync_content');
  await repo.mergeCloud([], [{...a,contentHtml:null,contentText:''}], 'cloud-records');expect(await f.db.query('SELECT * FROM article_sync_content')).toEqual(before);
  await expect(repo.receiveArticle({article:a,body:{...body,bodyHash:'0'.repeat(64),metadataOnly:true,chunks:[]}},'phone',false)).rejects.toThrow();expect(await f.db.query('SELECT * FROM article_sync_content')).toEqual(before);
  await expect(repo.receiveArticle({article:a,body:{...body,bodyHash:'0'.repeat(64)}},'phone',false)).rejects.toThrow();expect(await f.db.query('SELECT * FROM article_sync_content')).toEqual(before);
  await f.db.execute('DELETE FROM article_sync_content');await repo.receiveArticle({article:a,body:{...body,metadataOnly:true,chunks:[]}},'phone',false);expect((await f.db.query('SELECT body_hash FROM article_sync_content'))[0]!.body_hash).toBe(body.bodyHash);
  await f.db.transaction([{sql:'DELETE FROM article_sync_content'},{sql:'DELETE FROM article_original_chunks'},{sql:'DELETE FROM article_body_chunks'},{sql:'UPDATE articles SET content=NULL'}]);
  await expect(repo.receiveArticle({article:a,body:{...body,metadataOnly:true,chunks:[]}},'phone',false)).rejects.toThrow();expect(await f.db.query('SELECT * FROM article_sync_content')).toEqual([]);
 }finally{await f.close();}
});

test('a verified existing single-chunk body reuses its proven digest without a duplicate native hash call',async()=>{
 const a=article(),base=codec(255),previous=await prepareArticle(a,base);let hashes=0;
 const current=await prepareArticle(a,{...base,sha256:async b=>{hashes++;return base.sha256(b);}},true,previous.manifest.bodyHash);
 expect(current.manifest).toEqual(previous.manifest);expect(hashes).toBe(2); // complete body proof + metadata, no duplicate body/chunk hash.
});
