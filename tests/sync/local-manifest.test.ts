import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fixture,seedLocalManifestFixture} from '../helpers/local-manifest-fixture.ts';
import {LocalArticleManifestStore,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {articleMetadataHash,bodyForRequest,type ExportedArticle} from '../../src/sync/article-export.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
const sha256=async(b:Uint8Array)=>new Bun.CryptoHasher('sha256').update(b).digest('hex');
// Exact Android codec captures remove desktop zlib header differences. Actual
// host URI/HTML/codec implementations are exercised by the device harness.
const captured=new Map(fixture.payloads.map(p=>[encodeBodyJson(p.article),new Uint8Array(Buffer.from(p.encodedBase64,'base64'))]));
const codec:SyncBodyCodec={sha256,encode:async b=>captured.get(encodeBodyJson(b))??gzipSync(encodeBodyJson(b)),decode:async b=>gunzipSync(b).toString('utf8')};
const text:SyncTextPort={parseUri:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async html=>{const p=fixture.payloads.find(p=>p.article.contentHtml===html);if(!p)throw new Error('Uncaptured HTML input');return p.article.contentText;}};
// Keep the Android capture intact, but explicitly correct its reproduced
// save-cancellation-as-delete bug. This is a protocol fix, not a new capture.
const correctedNative=(rows:typeof fixture.first)=>rows.map(m=>m.articleId==='77e55e3b6e833521d40af49daafbd6f6b9bf053c1a2c390e2066def9e51e7c44'?{...m,deleted:false,deletedAt:0,metadataHash:'9fb1b4250c4d6e5a99e6738ea9508d50b99bfc5f8f4b312aacc52b8b6d9b4b97'}:m);
async function setup(){const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async list=>{sql.transaction(()=>{for(const s of list)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};const content=new Map<string,string>(),files={storeText:async(k:string,v:string)=>{const m='marker:'+k;content.set(m,v);return m;},hydrate:async(v:string)=>{if(v==='@missing')throw new Error('missing');if(!v.startsWith('marker:'))return v;if(!content.has(v))throw new Error('missing');return content.get(v)!;}};await seedLocalManifestFixture(db,files,text,codec);return {sql,db,files,store:new LocalArticleManifestStore(db,codec,text,files,async()=>{})};}
test('metadata hash matches Android JSONObject for every native exported article',async()=>{for(const row of fixture.articles)expect(await articleMetadataHash(row.article as ExportedArticle,codec)).toBe(row.metadataHash);});
test('real SQL library export preserves native manifests except the fixed save-cancellation deletion bug',async()=>{const f=await setup();try{const first=await f.store.snapshot();expect(first.map(p=>p.manifest)).toEqual(correctedNative(fixture.first));const second=await f.store.snapshot();expect(second.map(p=>p.manifest)).toEqual(correctedNative(fixture.second));
 for(const p of second){if(!p.manifest.bodyAvailable){expect(()=>bodyForRequest(p,{articleId:p.article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false})).toThrow('unavailable');continue;}const materialized=await f.store.materializeRequested(p);const full=bodyForRequest(materialized,{articleId:p.article.articleId,bodyHash:'stale',chunkIndexes:[999],metadataOnly:true});expect(full.metadataOnly).toBe(false);expect(full.chunks.length).toBe(p.manifest.chunkHashes.length);const meta=bodyForRequest(materialized,{articleId:p.article.articleId,bodyHash:p.manifest.bodyHash,chunkIndexes:[],metadataOnly:true});expect(meta.chunks).toEqual([]);expect(meta.metadataOnly).toBe(true);}
 }finally{f.sql.close();}});
test('cached body metadata skips compression until requested and invalidates after a body edit',async()=>{const f=await setup();try{
 let encodes=0;const byArticle=new Map<string,number>();const counting={...codec,encode:async(article:ExportedArticle)=>{encodes++;byArticle.set(article.articleId,(byArticle.get(article.articleId)??0)+1);return codec.encode(article);}};
 const store=new LocalArticleManifestStore(f.db,counting,text,f.files,async()=>{});
 const first=await store.snapshot(),initialEncodes=encodes,firstCounts=new Map(byArticle);expect(initialEncodes).toBeGreaterThan(0);
 const second=await store.snapshot();expect(first.map(row=>row.manifest)).toEqual(correctedNative(fixture.first));expect(second.map(row=>row.manifest)).toEqual(correctedNative(fixture.second));
 const deferred=second.find(row=>row.manifest.bodyAvailable&&row.encodedBody===null);expect(deferred).toBeDefined();
 const deferredId=deferred!.article.articleId;expect(byArticle.get(deferredId)).toBe(firstCounts.get(deferredId));
 const beforeRequest=encodes,materialized=await store.materializeRequested(deferred!);expect(materialized.manifest).toEqual(deferred!.manifest);expect(materialized.encodedBody).not.toBeNull();expect(encodes).toBe(beforeRequest+1);
 await f.db.execute("UPDATE articles SET content='changed body cache input' WHERE id=7");
 await store.snapshot();expect(encodes).toBeGreaterThan(beforeRequest+1);
 }finally{f.sql.close();}});
test('received wire gzip hash is not reused as a locally encoded outgoing body',async()=>{const f=await setup();try{
 const first=await f.store.snapshot(),item=(await f.db.query("SELECT item_id,body_hash FROM article_sync_content WHERE length(body_hash)=64 ORDER BY item_id"))[0],target=first.find(p=>p.manifest.bodyHash===item?.body_hash);
 expect(target).toBeDefined();
 expect(item).toBeDefined();
 const remoteHash='a'.repeat(64),remoteChunk='b'.repeat(64);
 await f.db.execute('UPDATE article_sync_content SET body_hash=?,body_bytes=10,chunk_size=131072,chunk_hashes=? WHERE item_id=?',[remoteHash,JSON.stringify([remoteChunk]),item!.item_id]);
 const next=await f.store.snapshot(),prepared=next.find(p=>p.article.articleId===target!.article.articleId)!;
 expect(prepared.manifest.bodyHash).not.toBe(remoteHash);
 expect(prepared.encodedBody).not.toBeNull();
 expect((await f.store.materializeRequested(prepared)).manifest).toEqual(prepared.manifest);
 const cache=(await f.db.query('SELECT c.body_hash,e.body_hash AS local_hash FROM article_sync_content c JOIN article_sync_encoding_cache e ON e.item_id=c.item_id WHERE c.item_id=?',[item!.item_id]))[0];
 expect(cache).toMatchObject({body_hash:prepared.manifest.bodyHash,local_hash:prepared.manifest.bodyHash});
 }finally{f.sql.close();}});
test('a local edit during snapshot cannot advertise mixed body and saved metadata',async()=>{const f=await setup();try{let changed=false;const store=new LocalArticleManifestStore(f.db,codec,text,{...f.files,hydrate:async v=>{if(!changed){changed=true;await f.db.execute("UPDATE articles SET title='concurrent' WHERE id=7");}return f.files.hydrate(v);}},async()=>{});await expect(store.snapshot()).rejects.toThrow('changed during');expect((await f.db.query('SELECT body_hash FROM article_sync_content WHERE item_id=7'))[0]?.body_hash).toBe('oldcached');}finally{f.sql.close();}});
test('a derived body cache edit during snapshot is detected without a source revision change',async()=>{const f=await setup();try{
 let changed=false;const syncText:SyncTextPort={...text,parseUri:async value=>{
  if(!changed){changed=true;await f.db.execute("UPDATE article_sync_content SET body_hash='concurrent-cache' WHERE item_id=7");}
  return text.parseUri(value);
 }};
 await expect(new LocalArticleManifestStore(f.db,codec,syncText,f.files,async()=>{}).snapshot()).rejects.toThrow('changed during');
 expect(changed).toBe(true);
 }finally{f.sql.close();}});

test('URI host errors cannot silently create a different article identity',async()=>{
 const {stableArticleId}=await import('../../src/sync/local-manifest.ts');
 await expect(stableArticleId('https://example.com/a',async()=>{throw new Error('host unavailable');},codec)).rejects.toThrow('host unavailable');
});
test('only canonical phone TXT chapter URLs bypass Android URI parsing',async()=>{
 const {stableArticleId}=await import('../../src/sync/local-manifest.ts');
 const chapter='https://watchrss.local/import-txt-novel/'+'a'.repeat(32)+'/chapter/0001-'+'b'.repeat(16);
 const expected=await stableArticleId(chapter,text.parseUri,codec);
 expect(await stableArticleId(chapter,async()=>{throw new Error('canonical URL reached host URI');},codec)).toBe(expected);
 for(const value of [chapter+'?page=1',chapter.replace('/0001-','/10001-'),chapter.replace('watchrss.local','WATCHRSS.local')]){
  await expect(stableArticleId(value,async()=>{throw new Error('noncanonical URL reached host URI');},codec)).rejects.toThrow('noncanonical URL reached host URI');
 }
});
test('cache publication leaves a concurrently replaced body untouched and invalidates its hash',async()=>{
 const f=await setup();try{let replaced=false;const db:SqlDatabase={...f.db,transaction:async list=>{if(!replaced&&list.some(s=>s.sql.startsWith('INSERT INTO article_sync_content'))){replaced=true;await f.db.execute("UPDATE articles SET content='newer local body' WHERE id=7");}await f.db.transaction(list);}};
 await expect(new LocalArticleManifestStore(db,codec,text,f.files,async()=>{}).snapshot()).rejects.toThrow();
 expect((await f.db.query('SELECT content FROM articles WHERE id=7'))[0]?.content).toBe('newer local body');expect((await f.db.query('SELECT body_hash FROM article_sync_content WHERE item_id=7'))[0]?.body_hash).toBeUndefined();
 }finally{f.sql.close();}
});
test('staged native hash seeds first manifest and is cleared when the body changes',async()=>{
 const f=await setup();try{
  await f.db.execute('DELETE FROM article_sync_content WHERE item_id=7');
  await f.db.execute('INSERT INTO article_native_sync_hash(item_id,body_hash) VALUES(7,?)',['native-body-hash']);
  const first=await f.store.snapshot();expect(first.some(row=>row.article.contentHash==='native-body-hash')).toBe(true);
  await f.db.execute("UPDATE articles SET content='changed native hash invalidation body' WHERE id=7");
  expect(await f.db.query('SELECT * FROM article_native_sync_hash WHERE item_id=7')).toHaveLength(0);
  expect(await f.db.query('SELECT * FROM article_sync_content WHERE item_id=7')).toHaveLength(0);
 }finally{f.sql.close();}
});
test('ordinary unsaved feed rows do not load bodies while preparing the sync manifest',async()=>{
 const f=await setup();try{
  for(let id=1000;id<1100;id++)await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?)',
   [id,1,`unsaved-${id}`,`body-${id}`,`https://example.test/unsaved-${id}`,`unsaved-${id}`,id]);
  let unsavedBodyReads=0,unsavedUriReads=0,metadataFirstPages=0;const migrated:number[]=[];
  const db:SqlDatabase={...f.db,query:async(sql,params)=>{
   if(sql.includes('SELECT content AS value FROM articles WHERE id=?')&&Number(params?.[0])>=1000)unsavedBodyReads++;
   if(sql.startsWith('SELECT a.id FROM articles a JOIN channels ch')&&params?.at(-1)===0)metadataFirstPages++;
   return f.db.query(sql,params);
  }};
  const syncText={...text,parseUri:async(value:string)=>{if(value.includes('/unsaved-'))unsavedUriReads++;return text.parseUri(value);}};
  const snapshot=await new LocalArticleManifestStore(db,codec,syncText,f.files,async id=>{migrated.push(id);}).snapshot();
  expect(snapshot).toHaveLength(fixture.first.length);
  expect(unsavedBodyReads).toBe(0);
  expect(unsavedUriReads).toBe(0);
  expect(metadataFirstPages).toBe(1);
  expect(migrated.every(id=>id<1000)).toBe(true);
 }finally{f.sql.close();}
});
test('unsaved imported TXT novel chapters are exported with their complete bodies',async()=>{
 const f=await setup();try{
  const source='https://watchrss.local/import-txt-novel/book',url=source+'/chapter/0001';
  await f.db.execute('INSERT INTO channels(id,url,title,created_at) VALUES(?,?,?,?)',[99,source,'测试小说',100]);
  await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?)',
   [3000,99,'第一章','章节正文',url,'chapter-1',99]);
  const nativeBodyHash=(await f.store.snapshot()).find(row=>row.article.url===url)!.manifest.bodyHash;
  await f.db.execute('INSERT INTO article_native_sync_hash(item_id,body_hash) VALUES(?,?)',[3000,nativeBodyHash]);
  let chapterEncodes=0,chapterMetadataHashes=0,chapterIdHashes=0;
  const counting={...codec,sha256:async(bytes:Uint8Array)=>{const value=new TextDecoder().decode(bytes);if(value===url)chapterIdHashes++;if(value.startsWith('{"bodyEncodingVersion":3,')&&value.includes('"title":"第一章"'))chapterMetadataHashes++;return codec.sha256(bytes);},encode:async(article:ExportedArticle)=>{if(article.url===url)chapterEncodes++;return codec.encode(article);}};
  const store=new LocalArticleManifestStore(f.db,counting,text,f.files,async()=>{});
  const exported=await store.snapshot(),chapter=exported.find(row=>row.article.url===url);
  expect(chapter?.article.rssSourceUrl).toBe(source);
  expect(chapter?.article.contentText).toBe('章节正文');
  expect(chapter?.manifest.bodyAvailable).toBe(true);
  expect(chapter?.article.contentHash).toBe(nativeBodyHash);
  expect(exported).toHaveLength(fixture.first.length+1);
  expect(chapterEncodes).toBe(1);
  expect(chapterIdHashes).toBe(1);
  expect(await f.db.query('SELECT item_id,body_hash FROM article_sync_content WHERE item_id=3000')).toEqual([{item_id:3000,body_hash:chapter!.manifest.bodyHash}]);
  chapterMetadataHashes=0;
  const repeated=(await store.snapshot()).find(row=>row.article.url===url)!;
  expect(repeated.encodedBody).toBeNull();
  expect(repeated.manifest.bodyHash).toBe(chapter!.manifest.bodyHash);
  expect(repeated.article.contentHash).toBe(nativeBodyHash);
  expect(chapterEncodes).toBe(1);
  expect(chapterIdHashes).toBe(1);
  expect(chapterMetadataHashes).toBe(1);
  expect((await store.materializeRequested(repeated)).manifest).toEqual(repeated.manifest);
  const changedUrl=url+'-changed';
  await f.db.execute('UPDATE articles SET link=? WHERE id=3000',[changedUrl]);
  const changed=(await store.snapshot()).find(row=>row.article.url===changedUrl);
  expect(changed?.article.articleId).not.toBe(repeated.article.articleId);
 }finally{f.sql.close();}
});
test('a saved entry can still resolve its body from an unsaved source row outside the metadata scan',async()=>{
 const f=await setup();try{
  const url='https://example.com/body-source',id=await (await import('../../src/sync/local-manifest.ts')).stableArticleId(url,text.parseUri,codec);
  await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?)',
   [2000,1,'Saved representative','old body',url,'representative',2000]);
  await f.db.execute('INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?)',
   [2001,1,'Source body','actual body',url,id,1999]);
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(2000,'favorite',1,2000,0)");
  let fallbackReads=0,indexReads=0;const db:SqlDatabase={...f.db,query:async(sql,params)=>{
   if(sql.includes('WHERE ch.url=? AND a.dedup_key=?'))fallbackReads++;if(sql.includes('SELECT a.id,a.dedup_key,ch.url'))indexReads++;
   return f.db.query(sql,params);
  }};
  const result=await new LocalArticleManifestStore(db,codec,text,f.files,async()=>{}).snapshot();
  expect(result.find(row=>row.article.articleId===id)?.article.contentText).toBe('actual body');
  expect(fallbackReads).toBe(0);expect(indexReads).toBe(1);
 }finally{f.sql.close();}
});
test('outgoing requests deduplicate and order chunks while stale hashes request the whole body',async()=>{
 const native=await import('../fixtures/sync-body-android.json'),row=native.default.cases[6]!;
 const {prepareArticle}=await import('../../src/sync/article-export.ts');
 const p=await prepareArticle({...fixture.articles[0]!.article,...row.decoded} as ExportedArticle,{...codec,encode:async()=>new Uint8Array(Buffer.from(row.encodedBase64,'base64'))});
 const request={articleId:p.article.articleId,bodyHash:p.manifest.bodyHash,chunkIndexes:[1,0,1],metadataOnly:false};
 expect(bodyForRequest(p,request).chunks.map(c=>c.index)).toEqual([0,1]);
 expect(()=>bodyForRequest(p,{...request,chunkIndexes:[2]})).toThrow('Invalid requested chunk');
 expect(bodyForRequest(p,{...request,bodyHash:'stale',chunkIndexes:[2]}).chunks.map(c=>c.index)).toEqual([0,1]);
});
