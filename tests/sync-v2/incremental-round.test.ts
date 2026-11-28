import {expect,test,spyOn} from 'bun:test';
import {sha256Hex} from '@podjs/framework/crypto';
import {bookIdInput} from '../../src/books/protocol';
import {initializeSchema} from '../../src/core/schema';
import {WatchRssRepository} from '../../src/core/repository';
import {rssDedupKey} from '../../src/core/rss-dedup-key';
import {SqlReadingProgressStore} from '../../src/reader/sql-progress';
import {LocalArticleManifestStore} from '../../src/sync/local-manifest';
import {DIRTY_LIMIT,businessRevision,installBusinessRevision} from '../../src/sync-v2/business-revision';
import {BUSINESS_FIELDS,fromWire} from '../../src/sync-v2/business';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {ProjectionGate} from '../../src/sync-v2/gate';
import {localProjectionCipher} from '../../src/sync-v2/host';
import {SyncV2Http} from '../../src/sync-v2/http';
import {watchMaterializer} from '../../src/sync-v2/materializer';
import {NOTE_ASSET_SCHEMA,NOTE_ASSET_WITNESS_SCHEMA,refreshNoteAssets} from '../../src/sync-v2/note-assets';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {WatchProjectionStore} from '../../src/sync-v2/store';
import {b64} from '../../src/sync-v2/wire';
import {SqlFixture,binding,scope,idKey,libraryId,productCipherHost} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';

const fingerprint='f'.repeat(64),bookId=sha256Hex(bookIdInput(fingerprint));
const book={bookId,fingerprint,chapterCount:1,title:'Book',kind:'txt',sourceDeviceId:'watch',updatedAt:10,deleted:false,deletedAt:0,deletedChapters:[],deletionClock:0};
const deviceId='a'.repeat(32);
const legacy={load:async()=>({offset:0,progress:0,updatedAt:0})} as any;

async function fixture(size:number){
 const db=new SqlFixture();
 await initializeSchema(db);
 db.raw.exec(`INSERT INTO sync_local_identity VALUES(1,'watch','watch-order');
  INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',10),(2,'https://example.invalid/feed','Feed',10);
  WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${size})
  INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at)
   SELECT i,1,'Article '||i,'https://example.invalid/'||i,'local-'||i,10 FROM seq;
  INSERT INTO article_reading_state VALUES(1,.25,12,10,'body', '{"offset":40,"progress":0.25,"updatedAt":12}');`);
 await db.execute('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json) VALUES(?,?,1,?)',[bookId,fingerprint,JSON.stringify(book)]);
 let transactions=0,opens=0,decryptions=0,projected=0,fullPages=0;
 const transact=db.transaction.bind(db);
 db.transaction=async statements=>{transactions++;await transact(statements);};
 const bridge=productCipherHost();
 const cipher=localProjectionCipher(async<T>(method:string,args:Record<string,unknown>)=>{
  if(method==='crypto.aesGcmDecrypt')decryptions++;
  return bridge.host(method,args) as Promise<T>;
 },'perf');
 const open=cipher.open.bind(cipher);
 cipher.open=async(aad,body)=>{if(JSON.parse(aad).purpose==='candidate')opens++;return open(aad,body);};
 const newStore=()=>new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey);
 db.programCipher=cipher;
 let store=newStore();await store.initialize();
 const text={parseUri:async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async()=>{throw Error('body-read');}};
 const metadata=new LocalArticleManifestStore(db,{sha256:async(b:Uint8Array)=>sha256Hex(b)} as any,text,{} as any,async()=>{throw Error('reading-migration');});
 const source=await SqlBusinessSource.open(db,watchMaterializer(db,metadata,(table,locator)=>store.readCandidateBySource(table,locator),(kind,id)=>store.readCandidate(store.entityKeyFor(kind,id)),undefined,id=>store.bookReferenced(id)));
 const page=source.page.bind(source),changed=source.changed.bind(source);
 source.page=async(...args)=>{fullPages++;const result=await page(...args);projected+=result.rows.length;return result;};
 source.changed=async(...args)=>{projected++;return changed(...args);};
 const scan=async()=>{
  let cp=await store.checkpoint();
  if(cp?.phase==='complete')cp=await store.beginTailWindow();
  else if(!cp)cp=(await store.beginScan(binding)).checkpoint;
  while(cp.phase!=='complete')cp=cp.phase==='scan'?await store.scanPage(source):await store.catchUpPage(source);
 };
 const reset=()=>{transactions=opens=decryptions=projected=fullPages=0;};
 const counts=()=>({projected,opens,decryptions,transactions,fullPages});
 return {db,scan,reset,counts,source,metadata,get store(){return store;},reopen(){store=newStore();}};
}

for(const size of [320,640])test(`one native edit in ${size} cold candidates touches a constant number of rows and transactions`,async()=>{
 const f=await fixture(size);
 try{
  const server=new SyntheticIndexBackend(),keys={id:idKey,content:Buffer.alloc(32,0x22),version:1};
  const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({userId:'00000000-0000-0000-0000-000000000001',accessToken:'t',legacyDeviceId:'d',scope}),true,serverPin());
  const publisher=(limit?:number)=>new WatchIndexPublisher(f.store,http,crypto,keys,()=>100,undefined,{maxChangedRows:limit});
  const pull=()=>new WatchCloudIndex(f.store,http,crypto,keys,async id=>({deviceId:id,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100).pull(server.window());
  const prepare=(p:WatchIndexPublisher,i:number)=>p.prepare(deviceId,'key',{commitOid:server.device.commitOid,revision:server.device.revision},i.toString(16).padStart(32,'0'));
  // A followed article already has protected metadata. Reader writes must
  // project its native interaction without rewriting the protected register.
  const article=(await f.metadata.cloudRestoreMetadata({itemIds:[1]},undefined,true)).articles[0]!;
  const value=Object.fromEntries(Object.entries(article).filter(([field])=>BUSINESS_FIELDS.article.includes(field)));
  const document=JSON.stringify({kind:'article',value});
  await f.db.execute('INSERT INTO article_register_state(article_id,item_id,state_json,raw_json) VALUES(?,1,?,?)',[article.articleId,document,document]);
  await f.scan();
  const seed=publisher(),published=await prepare(seed,1);
  expect(published.changedRows).toBeGreaterThanOrEqual(size+1);
  await seed.flush();await pull();
  const actions=[
   ['read',()=>f.db.execute('UPDATE articles SET is_read=1 WHERE id=2')],
   ['cursor',()=>new SqlReadingProgressStore(f.db,legacy).saveSnapshot(1,{offset:60,progress:.5,updatedAt:30})],
   ['favorite',()=>f.db.execute("INSERT INTO article_saved_states VALUES(3,'favorite',1,31,-31)")],
   ['delete-book',()=>f.db.execute('INSERT INTO sync_book_events VALUES(?,0,34)',[bookId])],
  ] as const;
  for(let i=0;i<actions.length;i++){
   const [name,edit]=actions[i]!;
   await edit();f.reopen();f.reset();
   await f.scan();
   const scanned=f.counts();
   const pending=publisher(64),prepared=await prepare(pending,i+2);
   expect(prepared.changedRows).toBe(1);
   const total=f.counts();
   console.log('SYNCV2_INCREMENTAL',JSON.stringify({size,name,scanned,total}));
   expect(total.fullPages).toBe(0);
   expect(total.projected).toBe(1);
   expect(total.opens).toBeLessThanOrEqual(3);
   expect(total.decryptions).toBeLessThan(90);
   expect(total.transactions).toBeLessThanOrEqual(8);
   await pending.flush();await pull();
   if(name==='cursor'){
    const latest=await f.store.readState(),row=await f.store.cloudRow(latest.cloud.current.treeRoot,f.store.entityKeyFor('article',article.articleId));
    const decoded=fromWire('article',row.meta.payload,row.state.payload);
    expect(decoded.readingProgress).toBe(.5);
    expect(decoded.readingPositionChangedAt).toBe(30);
    expect((await f.db.query('SELECT state_json FROM article_register_state WHERE item_id=1'))[0]!.state_json).toBe(document);
   }
  }
  const tombstone=await f.store.readCandidate(f.store.entityKeyFor('book',bookId));
  expect(tombstone.state.payload.deleted).toBe(true);
  const before=await f.store.readStableState(),revision=await businessRevision(f.db);
  f.reset();
  await new SqlReadingProgressStore(f.db,legacy).saveSnapshot(1,{offset:60,progress:.5005,updatedAt:32});
  expect(f.counts().transactions).toBe(0);
  await f.db.transaction([
   {sql:"UPDATE article_reading_state SET state_json=json_set(state_json,'$.updatedAt',33) WHERE article_id=1"},
   {sql:"UPDATE articles SET content='cache only' WHERE id=1"},
   {sql:'INSERT INTO article_sync_encoding_cache(item_id,body_hash) VALUES(1,?)',params:['fingerprint']},
  ]);
  expect(await businessRevision(f.db)).toEqual(revision);
  expect(await f.store.matchesRoundState(before,await f.store.roundSchemaVersion())).toBe(true);
 }finally{f.db.close();}
},120_000);

test('article clocks agree between incremental and full projection for RSS and both import channels',async()=>{
 const f=await fixture(5);
 try{
  const published='Fri, 27 Nov 2026 12:00:00 GMT';
  const article=(id:number)=>'https://example.invalid/'+id;
  await f.db.transaction([
   {sql:"INSERT INTO channels(id,url,title,created_at) VALUES(3,'https://watchrss.local/import-content/example','Local',10)"},
   {sql:"INSERT INTO channels(id,url,title,created_at) VALUES(4,'http://example.invalid/feed','HTTP feed',11)"},
   {sql:'UPDATE articles SET channel_id=3 WHERE id=2'},
   {sql:'UPDATE articles SET channel_id=2,is_read=1,pub_date=? WHERE id=3',params:[published]},
   {sql:'UPDATE articles SET channel_id=2,is_read=1 WHERE id=4'},
   {sql:"UPDATE articles SET channel_id=4,is_read=1,pub_date='invalid' WHERE id=5"},
  ]);
  for(const id of [3,4,5])await f.db.execute('UPDATE articles SET dedup_key=? WHERE id=?',[rssDedupKey(null,article(id),'Article '+id),id]);
  const rss=new WatchRssRepository(f.db,async()=>{throw Error('network not expected');});
  const feed=(title:string,items:[number,string?][])=>`<rss><channel><title>${title}</title>${items.map(([id,date])=>
   `<item><title>Article ${id}</title><link>${article(id)}</link>${date?`<pubDate>${date}</pubDate>`:''}</item>`).join('')}</channel></rss>`;
  const httpsFeed=feed('Feed',[[3,published],[4]]),httpFeed=feed('HTTP feed',[[5,'invalid']]);
  await rss.refreshChannel(2,httpsFeed);await rss.refreshChannel(4,httpFeed);
  await f.scan();
  const candidates=async()=>new Map((await f.store.candidatePage())
   .filter(({candidate})=>candidate.meta.kind==='article')
   .map(({candidate})=>[candidate.meta.payload.url,candidate]));
  const before=await candidates();
  expect(before.get(article(3))?.state.payload.updatedAt).toBe(Date.parse(published));
  expect(before.get(article(4))?.state.payload.updatedAt).toBe(10);
  expect(before.get(article(5))?.state.payload.updatedAt).toBe(11);
  const revision=await businessRevision(f.db);
  const fetchTime=spyOn(Date,'now');
  try{
   for(const fetchedAt of [30,45]){
    fetchTime.mockReturnValue(fetchedAt);
    await rss.refreshChannel(2,httpsFeed);await rss.refreshChannel(4,httpFeed);
   }
  }finally{fetchTime.mockRestore();}
  expect(await f.db.query('SELECT DISTINCT fetched_at FROM articles WHERE id IN (3,4,5)')).toEqual([{fetched_at:45}]);
  expect(await businessRevision(f.db)).toEqual(revision);
  const corrected='2026-11-28T12:00:00.000Z';
  await f.db.execute('UPDATE articles SET pub_date=? WHERE id=3',[corrected]);
  await f.db.execute('UPDATE articles SET fetched_at=25 WHERE id IN (1,2)');
  f.reset();await f.scan();
  const incremental=await candidates();
  expect(f.counts()).toMatchObject({fullPages:0,projected:3});
  expect(incremental.get(article(1))?.state.payload).toMatchObject({updatedAt:25,independentChangedAt:25});
  expect(incremental.get(article(2))?.state.payload).toMatchObject({updatedAt:25,independentChangedAt:0});
  expect(incremental.get(article(3))?.state.payload.updatedAt).toBe(Date.parse(corrected));
  expect(incremental.get(article(4))).toEqual(before.get(article(4)));
  expect(incremental.get(article(5))).toEqual(before.get(article(5)));
  await f.store.restartScan();await f.scan();
  expect(await candidates()).toEqual(incremental);
  await f.db.execute('UPDATE channels SET created_at=20 WHERE id=4');
  await f.scan();
  const moved=await candidates();
  expect(moved.get(article(5))?.state.payload.updatedAt).toBe(20);
  await f.store.restartScan();await f.scan();
  expect(await candidates()).toEqual(moved);
 }finally{f.db.close();}
});

test('repair and dirty overflow reconcile the full source, including removed books',async()=>{
 const f=await fixture(320);
 try{
  await f.scan();f.reset();f.db.sql=[];
  await installBusinessRevision(f.db);
  expect(f.db.sql).toEqual(['PRAGMA schema_version']);
  const before=await businessRevision(f.db);
  f.db.raw.exec('DROP TRIGGER syncv2_articles_update; UPDATE articles SET is_read=1 WHERE id=1');
  expect(await businessRevision(f.db)).toEqual(before);
  await installBusinessRevision(f.db);
  expect((await businessRevision(f.db)).epoch).not.toBe(before.epoch);
  await f.scan();
  expect(f.counts().projected).toBeGreaterThanOrEqual(321);

  const repaired=await businessRevision(f.db);
  f.db.raw.exec(`DELETE FROM sync_books;
   WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<=${DIRTY_LIMIT})
   INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at)
    SELECT 1000+i,2,'Uninteracted','https://example.invalid/cache/'||i,'cache-'||i,11 FROM seq;
   UPDATE articles SET is_read=1 WHERE id=2;`);
  expect((await businessRevision(f.db)).epoch).not.toBe(repaired.epoch);
  f.reset();await f.scan();
  expect(f.counts().fullPages).toBeGreaterThan(0);
  expect((await f.store.readCandidate(f.store.entityKeyFor('book',bookId))).state.payload.deleted).toBe(true);
  const published=await f.store.candidatePage('',400);
  expect(published.filter(row=>row.candidate.state.payload.isRead===true)).toHaveLength(2);
  expect(f.db.raw.query('SELECT count(*) AS n FROM syncv2_dirty').get()).toEqual({n:0});
 }finally{f.db.close();}
});

test('a locator updated during a tail window survives the older window',async()=>{
 const f=await fixture(8);
 try{
  await f.scan();
  await f.db.execute("UPDATE articles SET title='Intermediate' WHERE id=2");
  await f.db.execute("UPDATE articles SET title='Third' WHERE id=3");
  await f.store.beginTailWindow();
  await f.store.catchUpPage(f.source,1);
  await f.db.execute("UPDATE articles SET title='Final' WHERE id=2");
  f.reset();await f.scan();
  const rows=await f.store.candidatePage();
  expect(rows.find(row=>row.candidate.meta.payload.url==='https://example.invalid/2')?.candidate.meta.payload.title).toBe('Final');
  expect(rows.find(row=>row.candidate.meta.payload.url==='https://example.invalid/3')?.candidate.meta.payload.title).toBe('Third');
  expect(f.counts().fullPages).toBe(0);
 }finally{f.db.close();}
});

test('note asset refresh reads bytes only after the file witness changes',async()=>{
 const db=new SqlFixture();
 try{
  db.raw.exec(NOTE_ASSET_SCHEMA);db.raw.exec(NOTE_ASSET_WITNESS_SCHEMA);
  let reads=0,modified=1,bytes=new Uint8Array([1,2]);
  const repo={cloudNotes:async()=>({notes:[],assetKeys:['a.png']}),cloudNoteAsset:async()=>{reads++;return bytes;}};
  const stat=async()=>({path:'notes/assets/a.png',size:bytes.length,modified});
  const refresh=()=>refreshNoteAssets(db,repo,'watch',()=>10,undefined,stat);
  expect((await refresh()).errors).toEqual([]);
  expect((await refresh()).errors).toEqual([]);
  expect(reads).toBe(1);
  modified++;bytes=new Uint8Array([3,4]);
  expect((await refresh()).errors).toEqual([]);
  expect(reads).toBe(2);
  expect(db.raw.query('SELECT local_sha256 AS hash FROM memo_assets').get()).toEqual({hash:sha256Hex(bytes)});
 }finally{db.close();}
});

test('prepare retries a held legacy candidate without an identity map',async()=>{
 const f=await fixture(1);
 try{
  await f.scan();
  const entity=(await f.store.candidatePage()).find(({candidate})=>candidate.meta.kind==='article')!.entityKey;
  await f.db.execute('DELETE FROM syncv2_identity_map WHERE entity_key=?',[entity]);
  const server=new SyntheticIndexBackend(),keys={id:idKey,content:Buffer.alloc(32,0x22),version:1};
  const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({userId:'00000000-0000-0000-0000-000000000001',accessToken:'t',legacyDeviceId:'d',scope}),true,serverPin());
  let hasBody=false,attempts=0;
  const publisher=new WatchIndexPublisher(f.store,http,crypto,keys,()=>100,async entry=>{
   if(entry.entityKey===entity){
    attempts++;
    if(!hasBody)throw Error('body_channel_source_missing');
   }
   return null;
  });
  const prepare=(i:number)=>publisher.prepare(deviceId,'key',{commitOid:server.device.commitOid,revision:server.device.revision},String(i).repeat(32));
  const reader=new WatchCloudIndex(f.store,http,crypto,keys,async id=>({deviceId:id,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100);
  await prepare(1);await publisher.flush();await reader.pull(server.window());
  expect((await f.store.readState()).cloud.publicationHeld).toEqual([entity]);
  expect(await prepare(2)).toMatchObject({skipped:true,heldEdits:true,changedRows:0});
  expect(attempts).toBe(2);
  hasBody=true;
  expect(await prepare(3)).toMatchObject({changedRows:1});
  await publisher.flush();
  expect((await f.store.readState()).cloud.publicationHeld).toEqual([]);
 }finally{f.db.close();}
});

test('the prepare time budget pauses and resumes while every compared row is unchanged',async()=>{
 const f=await fixture(12);
 try{
  const server=new SyntheticIndexBackend(),keys={id:idKey,content:Buffer.alloc(32,0x22),version:1};
  const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({userId:'00000000-0000-0000-0000-000000000001',accessToken:'t',legacyDeviceId:'d',scope}),true,serverPin());
  const publisher=(time?:number)=>new WatchIndexPublisher(f.store,http,crypto,keys,()=>100,undefined,{maxPrepareMillis:time});
  const prepare=(p:WatchIndexPublisher,i:number)=>p.prepare(deviceId,'key',{commitOid:server.device.commitOid,revision:server.device.revision},String(i).repeat(32));
  await f.scan();
  const seed=publisher();await prepare(seed,1);await seed.flush();
  const reader=new WatchCloudIndex(f.store,http,crypto,keys,async id=>({deviceId:id,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100);
  await reader.pull(server.window());
  await f.store.restartScan();await f.scan();
  let millis=0,firstKey='';const clock=spyOn(Date,'now').mockImplementation(()=>millis);
  const publicationKeys=f.store.publicationKeys.bind(f.store),batch=f.store.candidateBatch.bind(f.store);
  f.store.publicationKeys=async (...args)=>{millis+=10;return publicationKeys(...args);};
  f.store.candidateBatch=async keys=>{firstKey=keys[0]!;return batch(keys);};
  try{
   f.reset();
   const paused=await prepare(publisher(5),2);
   expect(paused).toMatchObject({changedRows:0,skipped:true,chunked:true});
   expect(f.counts().opens).toBe(1);
   expect((await f.store.readState()).cloud.pendingPublish).toBeNull();
   const cursor=(await f.store.readState()).cloud.publicationScan;
   expect(cursor.group>0||cursor.after===firstKey).toBe(true);
   f.store.publicationKeys=publicationKeys;
   const compared:string[]=[];
   f.store.candidateBatch=async keys=>{compared.push(...keys);return batch(keys);};
   const resumed=await prepare(publisher(5),3);
   expect(resumed).toMatchObject({changedRows:0,chunked:false});
   expect(compared).not.toContain(firstKey);
   expect(compared).toHaveLength(13);
  }finally{clock.mockRestore();}
 }finally{f.db.close();}
});
