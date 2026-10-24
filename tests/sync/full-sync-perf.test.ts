import {test,expect} from 'bun:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fixture,article,sha} from './ble-v2-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {DOMAIN_ENCODERS} from '../../src/sync/domain-definitions';
import {articleState} from '../../src/sync/article-provenance';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body';
import {selectArticleBodyRequests} from '../../src/sync/manifest';

test('2135 owned originals survive encoder upgrade: five body edits request only five bodies within budget',async()=>{
 const f=await fixture(),encoder=DOMAIN_ENCODERS.library;let queries=0,emptyQueries=0,transactions=0,encodes=0;
 const db={...f.db,query:async(q:string,p:readonly unknown[]=[])=>{queries++;if(q==='SELECT 1')emptyQueries++;return f.db.query(q,p);},transaction:async(ss:Parameters<typeof f.db.transaction>[0])=>{transactions++;return f.db.transaction(ss);}};
 const body={contentHtml:'<p>Wire original 中文🙂 '+('synthetic '.repeat(80))+'</p>',contentText:'Wire original 中文🙂 '+('synthetic '.repeat(80))};
 const bytes=new Uint8Array(gzipSync(encodeBodyJson(body)));bytes[9]=255;const bodyHash=sha(bytes);
 const codec:SyncBodyCodec={sha256:f.codec.sha256,decode:async b=>gunzipSync(b).toString(),encode:async b=>{encodes++;const v=new Uint8Array(gzipSync(encodeBodyJson(b)));v[9]=0;return v;}};
 const create=()=>{const repo=new SqlLibrarySessionRepository(db,{...f.ports,codec,migrateReadingMany:async()=>{}});repo.configurePeer('phone',{supportsRssCanonicalIds:true});return repo;};
 try{
  const repo=create();await repo.prepareFastProjection();
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','独立文章',1)");
  const ss:Parameters<typeof f.db.transaction>[0]=[];
  for(let i=1;i<=2135;i++){
   const url='https://scale.test/item/'+i,id=sha(url),a=article({...body,articleId:id,url,title:'Item '+i,excerpt:'preview',contentHash:bodyHash});
   ss.push({sql:'INSERT INTO articles(id,channel_id,title,description,content,link,guid,dedup_key,fetched_at) VALUES(?,1,?,?,?,?,?,?,100)',params:[i,a.title,a.excerpt,'Reader-derived content deliberately differs',url,id,id]},
    {sql:'INSERT INTO sync_article_ids VALUES(?,?,?)',params:[id,i,url]},
    {sql:'INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(?,?,?,?,?,131072,?,?)',params:[i,body.contentHtml,body.contentText,bodyHash,bytes.length,JSON.stringify([bodyHash]),Buffer.byteLength(body.contentHtml)]},
    {sql:'INSERT INTO article_sync_encoding_cache(item_id,body_hash,content_hash,source_device_id,updated_at,imported_at,metadata_state,site_name,rss_source_title) VALUES(?,?,?,?,?,?,?,?,NULL)',params:[i,bodyHash,bodyHash,'phone',100,100,articleState(a),'独立文章']});
  }
  await f.db.transaction(ss);
  const before=await repo.prepareWindow('phone',0);expect(before.fullArticleManifest).toHaveLength(2135);
  await repo.markSuccess({remoteDeviceId:'phone',localSeqToInclusive:before.toSeqInclusive,remoteSeqToInclusive:0,remoteProtocolVersion:14,fullSnapshot:true,projectionGeneration:before.projectionGeneration});
  queries=emptyQueries=transactions=encodes=0;DOMAIN_ENCODERS.library++;
  const started=performance.now(),upgraded=create(),after=await upgraded.prepareWindow('phone',before.toSeqInclusive);
  const elapsedMs=performance.now()-started;
  expect(after.fullSnapshot).toBe(true);expect(after.fallbackReason).toBe('projectionChanged');expect(encodes).toBe(2135);
  expect(after.fullArticleManifest.map(m=>m.bodyHash)).toEqual(before.fullArticleManifest.map(m=>m.bodyHash));
  expect(selectArticleBodyRequests(before.fullArticleManifest,after.fullArticleManifest,{supportsMetadataOnly:true})).toHaveLength(0);
  expect(emptyQueries).toBeLessThan(400);expect(transactions).toBeLessThan(100);expect(elapsedMs).toBeLessThan(10000);
  // Real body changes invalidate accepted content; they cannot retain an old hash.
  await f.db.transaction(Array.from({length:5},(_,i)=>({sql:'UPDATE articles SET content=?,fetched_at=200 WHERE id=?',params:['Changed original '+i,i+1]})));
  const changed=await upgraded.prepareWindow('phone',before.toSeqInclusive);
  const requested=selectArticleBodyRequests(before.fullArticleManifest,changed.fullArticleManifest,{supportsMetadataOnly:true});
  expect(requested).toHaveLength(5);expect(requested.every(r=>!r.metadataOnly&&r.chunkIndexes.length===1)).toBe(true);
  expect((await upgraded.exportRequested(requested,'phone'))).toHaveLength(5);
  console.log('R47 full-scale '+JSON.stringify({items:2135,elapsedMs,queries,emptyQueries,transactions,encodes,bodyRequests:requested.length}));
 }finally{DOMAIN_ENCODERS.library=encoder;f.sql.close();}
},60000);

test('native re-encoding batches do not hydrate or re-encode text in JS, preserve ownership and never publish a failed generation',async()=>{
 const f=await fixture(),encoder=DOMAIN_ENCODERS.library;const {matchGzipHash}=await import('@podjs/framework/crypto');
 try{
  for(let i=0;i<65;i++){const url='https://native-scale.test/'+i;await f.repo.receiveArticle(await f.packet(article({url,articleId:sha(url),contentText:'Text '+i,contentHtml:'<p>Text '+i+'</p>'})),'phone',false);}
  const before=await f.repo.prepareWindow('phone',0),original=await f.db.query('SELECT item_id,body_hash,content_html,content_text FROM article_sync_content ORDER BY item_id');
  await f.repo.markSuccess({remoteDeviceId:'phone',localSeqToInclusive:before.toSeqInclusive,remoteSeqToInclusive:0,remoteProtocolVersion:14,fullSnapshot:true,projectionGeneration:before.projectionGeneration});
  let calls=0;DOMAIN_ENCODERS.library++;
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,codec:{...f.codec,encode:async()=>{throw Error('JS body encoding forbidden in native projection');}},files:{...f.ports.files,hydrate:async()=>{throw Error('JS body hydration forbidden in native projection');}},reencodeStoredBodies:async ids=>{
   calls++;expect(ids.length).toBeLessThanOrEqual(32);const result=[];
   for(const id of ids){const r=(await f.db.query('SELECT * FROM article_sync_content WHERE item_id=?',[id]))[0]!;const encoded=new Uint8Array(gzipSync(encodeBodyJson({contentHtml:r.content_html as string,contentText:r.content_text as string})));encoded[9]=0;const bytes=await matchGzipHash(encoded,String(r.body_hash),f.codec.sha256)??encoded,hash=sha(bytes);result.push({itemId:id,bodyHash:hash,bodyByteCount:bytes.length,chunkSize:131072,chunkHashes:[hash]});}return result;
  }});
  const upgraded=await repo.prepareWindow('phone',before.toSeqInclusive);expect(upgraded.fullSnapshot).toBe(true);expect(upgraded.fallbackReason).toBe('projectionChanged');expect(calls).toBe(3);expect(selectArticleBodyRequests(before.fullArticleManifest,upgraded.fullArticleManifest)).toHaveLength(0);
  expect(await f.db.query('SELECT item_id,body_hash,content_html,content_text FROM article_sync_content ORDER BY item_id')).toEqual(original);
  const peers=await f.db.query('SELECT * FROM sync_peer_state');DOMAIN_ENCODERS.library++;
  const failed=new SqlLibrarySessionRepository(f.db,{...f.ports,reencodeStoredBodies:async()=>{throw Error('native cancelled');}});
  await expect(failed.prepareWindow('phone',before.toSeqInclusive)).rejects.toThrow('native cancelled');expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual(peers);expect(await f.db.query('SELECT * FROM sync_fast_encoded_cache')).toEqual([]);
  expect(await f.db.query('SELECT item_id,body_hash,content_html,content_text FROM article_sync_content ORDER BY item_id')).toEqual(original);
 }finally{DOMAIN_ENCODERS.library=encoder;f.sql.close();}
});

test('R47 exchange cursor returns actual published journal state; only the post-source manifest window freezes and acknowledges new signatures',async()=>{
 const f=await fixture();try{
  await f.repo.receiveArticle(await f.packet(),'phone',false);const before=f.counts().encodes,peer=await f.db.query('SELECT * FROM sync_peer_state');
  const cursor=await f.repo.exchangeCursor('phone');expect(f.counts().encodes).toBe(before);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual(peer);
  const item=(await f.db.query('SELECT id FROM articles'))[0]!;await f.db.execute('UPDATE articles SET title=? WHERE id=?',['Edited after cursor',item.id]);
  const window=await f.repo.prepareWindow('phone',cursor.lastRemoteSeqApplied);expect(window.fullSnapshot).toBe(true);expect(window.fullArticleManifest).toHaveLength(1);expect(window.toSeqInclusive).toBeGreaterThan(cursor.localMaxSeq);expect(await f.db.query('SELECT * FROM sync_peer_state')).toEqual(peer);
  expect(await f.repo.canSkipLibrary('phone')).toBe(false);
 }finally{f.sql.close();}
});
