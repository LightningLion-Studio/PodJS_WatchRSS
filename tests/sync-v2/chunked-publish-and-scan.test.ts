import {test,expect} from 'bun:test';
import {initializeSchema} from '../../src/core/schema';
import {LocalArticleManifestStore} from '../../src/sync/local-manifest';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {watchMaterializer} from '../../src/sync-v2/materializer';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {IndexObjectCache} from '../../src/sync-v2/index-object-cache';
import {WatchServiceKeyPin} from '../../src/sync-v2/service-key';
import {SyncV2Http} from '../../src/sync-v2/http';
import {SqlFixture,binding,noteValue,scope,idKey} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';
import {b64} from '../../src/sync-v2/wire';
import {sha256Hex} from '@podjs/framework/crypto';
import {bookIdInput} from '../../src/books/protocol';
import {createCloudTransport} from '../../src/cloud/transport';

test('SqlBusinessSource skips untouched public RSS cache and registered-book deletions while keeping interacted articles and imports',async()=>{
 const db=new SqlFixture();
 try{
  await initializeSchema(db);
  await db.execute("INSERT INTO sync_local_identity VALUES(1,'watch','watch-order')");
  await db.execute("INSERT INTO channels(id,url,title,description,created_at,sort_order) VALUES(1,'https://example.invalid/rss','Feed','desc',10,0),(2,'watchrss://phone-imports','Imports','',10,1)");
  await db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at,is_read,is_saved,reading_progress) VALUES(1,1,'Unread RSS','body','https://example.invalid/u1','g1','guid:g1',11,0,0,0),(2,1,'Read RSS','body','https://example.invalid/r1','g2','guid:g2',12,1,0,0),(3,2,'Imported','body','https://example.invalid/imp1','g3','guid:g3',13,0,0,0)");
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_books(book_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,registration_complete INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_book_aliases(item_id INTEGER PRIMARY KEY,book_id TEXT NOT NULL,chapter_index INTEGER NOT NULL,article_id TEXT NOT NULL,url TEXT NOT NULL)`);
  const fingerprint='f'.repeat(64),bookId=sha256Hex(bookIdInput(fingerprint));
  const validBook=JSON.stringify({bookId,fingerprint,chapterCount:1,title:'Book',kind:'txt',sourceDeviceId:'watch',sourceUrl:'watchrss://import/book',updatedAt:10,deleted:false,deletedAt:0,deletedChapters:[],deletionClock:0});
  await db.execute(`INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,registration_complete) VALUES(?,?,1,?,1)`,[bookId,'f'.repeat(64),validBook]);
  await db.execute(`INSERT INTO sync_book_aliases(item_id,book_id,chapter_index,article_id,url,channel_url) VALUES(99,?,1,'del-book-art','https://watchrss.local/import-txt-novel/book/chapter/0001','https://watchrss.local/import-txt-novel/book')`,[bookId]);
  await db.execute(`INSERT INTO sync_article_deletions VALUES('del-book-art','https://watchrss.local/import-txt-novel/book/chapter/0001',14,'watch','watch-order'),('del-real-art','https://example.invalid/gone',15,'watch','watch-order')`);
  const readonlyDb={...db,query:db.query.bind(db),transaction:async()=>{throw Error('ro');},execute:async()=>{throw Error('ro');}};
  const codec={sha256:async(b:Uint8Array)=>sha256Hex(b)} as any;
  const text={parseUri:async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async()=>{throw Error('body-read');}};
  const metadata=new LocalArticleManifestStore(readonlyDb,codec,text,{} as any,async()=>{throw Error('reading-migration');});
  const store=db.store();
  const source=await SqlBusinessSource.open(db,watchMaterializer(db,metadata,(t,l)=>store.readCandidateBySource(t,l),(k,id)=>store.readCandidate(store.entityKeyFor(k,id)),(k,ids)=>store.readCandidates(k,ids)));
  await store.initialize();await store.beginScan(binding);
  while((await store.checkpoint())!.phase==='scan')await store.scanPage(source,32);
  while((await store.checkpoint())!.phase==='tail')await store.catchUpPage(source,32);
  const rows=await store.candidatePage('',100);
  const articles=rows.filter(r=>r.candidate.meta.kind==='article');
  // Expected: Read RSS (#2), Imported (#3), and del-real-art tombstone — NOT Unread RSS (#1) or del-book-art.
  expect(articles.length).toBe(3);
  const urls=articles.map(a=>a.candidate.meta.payload.url).sort();
  expect(urls).toEqual(['https://example.invalid/gone','https://example.invalid/imp1','https://example.invalid/r1']);
 }finally{db.close();}
});

test('WatchIndexPublisher priority-first chunked publish commits notes before backlog and WatchCloudIndex reuses verified rows',async()=>{
 const server=new SyntheticIndexBackend(),db=new SqlFixture();
 try{
  const pin=serverPin();
  const http=new SyncV2Http({request:r=>server.request(r)},'http://127.0.0.1:1',scope,async()=>({userId:'00000000-0000-0000-0000-000000000001',accessToken:'t',legacyDeviceId:'d',scope}),true,pin);
  const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1};
  const store=db.store();await store.initialize();
  await db.execute(`CREATE TABLE memo_notes(note_id TEXT PRIMARY KEY,folder_id TEXT,title TEXT NOT NULL,markdown TEXT NOT NULL,plain_text TEXT NOT NULL,content_hash TEXT NOT NULL,base_content_hash TEXT NOT NULL,base_markdown TEXT NOT NULL,pinned INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,modified_by TEXT NOT NULL,deleted INTEGER NOT NULL,deleted_at INTEGER NOT NULL)`);
  await db.execute(`CREATE TABLE sync_article_deletions(article_id TEXT PRIMARY KEY,url TEXT NOT NULL,changed_at INTEGER NOT NULL,source_device_id TEXT NOT NULL,source_order TEXT NOT NULL)`);
  const n1=noteValue('note-priority-1');
  await db.execute(`INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[n1.noteId,n1.folderId,n1.title,n1.markdown,n1.plainText,n1.contentHash,n1.baseContentHash,n1.baseMarkdown,0,n1.createdAt,n1.updatedAt,n1.modifiedBy,0,0]);
  for(let i=1;i<=4;i++)await db.execute(`INSERT INTO sync_article_deletions VALUES(?,?,?,?,?)`,['art-del-'+i,'https://example.invalid/del/'+i,100+i,'watch','watch-order']);
  const source=await SqlBusinessSource.open(db);
  await store.beginScan(binding);
  while((await store.checkpoint())!.phase==='scan')await store.scanPage(source,32);
  while((await store.checkpoint())!.phase==='tail')await store.catchUpPage(source,32);

  const indexObjects=new IndexObjectCache();
  const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>100,undefined,{maxChangedRows:2,uploadConcurrency:4,indexObjects});
  const reader=new WatchCloudIndex(store,http,crypto,keys,async deviceId=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100,undefined,{readConcurrency:4,indexObjects});

  // Commit #1: must include the priority memo + 1 deletion (2 rows total), chunked=true.
  const prep1=await publisher.prepare('a'.repeat(32),'key',{commitOid:null,revision:'0'},'1'.repeat(32));
  expect(prep1.rows).toBe(2);
  expect(prep1.chunked).toBe(true);
  const res1=await publisher.flush();
  expect(res1.chunked).toBe(true);
  expect((await store.readState()).hasUnsentEdits).toBe(true);

  const objectReadsBefore=Object.entries(server.calls).filter(([p])=>p==='/objects/batch'||p.startsWith('/objects/')).reduce((s,[,n])=>s+n,0);
  await reader.pull(server.window());
  const objectReadsAfter=Object.entries(server.calls).filter(([p])=>p==='/objects/batch'||p.startsWith('/objects/')).reduce((s,[,n])=>s+n,0);
  // Freshly uploaded meta/state/tree/state-refs bytes hit IndexObjectCache (0 extra object GET/batch calls!).
  expect(objectReadsAfter-objectReadsBefore).toBe(0);
  const cloudAfter1=await store.cloudRows((await store.readState()).cloud!.current!.treeRoot,'',32);
  expect(cloudAfter1.length).toBe(2);
  expect(cloudAfter1.some((r:any)=>r.meta.kind==='note'&&r.meta.logicalId==='note-priority-1')).toBe(true);

  // Commit #2: next 2 deletions (4 rows total), chunked=true; pull reuses the 2 verified rows from Commit #1.
  const stateRefsBefore=Object.entries(server.calls).filter(([p])=>p.startsWith('/state-refs/')).reduce((s,[,n])=>s+n,0);
  const prep2=await publisher.prepare('a'.repeat(32),'key',{commitOid:server.device.commitOid,revision:server.device.revision},'2'.repeat(32));
  expect(prep2.rows).toBe(4);
  expect(prep2.chunked).toBe(true);
  await publisher.flush();
  await reader.pull(server.window());
  const stateRefsAfter=Object.entries(server.calls).filter(([p])=>p.startsWith('/state-refs/')).reduce((s,[,n])=>s+n,0);
  expect(stateRefsAfter-stateRefsBefore).toBe(2);

  // Commit #3: final deletion (5 rows total), chunked=false, hasUnsentEdits=false!
  const prep3=await publisher.prepare('a'.repeat(32),'key',{commitOid:server.device.commitOid,revision:server.device.revision},'3'.repeat(32));
  expect(prep3.rows).toBe(5);
  expect(prep3.chunked).toBe(false);
  const res3=await publisher.flush();
  expect(res3.chunked).toBeUndefined();
  await reader.pull(server.window());
  expect((await store.readState()).hasUnsentEdits).toBe(false);
 }finally{db.close();}
});

test('createCloudTransport bounds concurrent requests so live temp handles stay below the 8-handle host limit',async()=>{
 const liveTemp=new Set<string>();
 let seq=0,maxTemp=0,activeDownloads=0,maxDownloads=0;
 const host=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{
  if(method==='file.createTemp'){
   if(liveTemp.size>=8)throw Error('too_many_temporary_files');
   const path=`cloud-http/.pod-write-live${++seq}.part`;
   liveTemp.add(path);
   maxTemp=Math.max(maxTemp,liveTemp.size);
   return {path} as T;
  }
  if(method==='file.write')return {size:2} as T;
  if(method==='file.delete'){liveTemp.delete(String(args.path));return {} as T;}
  if(method==='http.download'){
   const path=String(args.path);
   liveTemp.add(path);
   maxTemp=Math.max(maxTemp,liveTemp.size);
   activeDownloads++;maxDownloads=Math.max(maxDownloads,activeDownloads);
   await new Promise(r=>setTimeout(r,15));
   activeDownloads--;
   return {status:200,headers:{},size:2,path} as T;
  }
  if(method==='file.read')return {offset:0,size:2,dataBase64:'b2s='} as T;
  throw Error('unexpected '+method);
 };
 const transport=createCloudTransport(host,{require(){}});
 const results=await Promise.all(Array.from({length:6},(_,i)=>transport.request({method:'POST',url:`https://example.invalid/p/${i}`,headers:{},body:new Uint8Array([111,107])})));
 expect(results.every(r=>r.status===200)).toBe(true);
 expect(maxDownloads).toBeLessThanOrEqual(3);
 expect(maxTemp).toBeLessThanOrEqual(6);
 expect(liveTemp.size).toBe(0);
});

test('chunked publication sends a note after its folder and asset',async()=>{
 const server=new SyntheticIndexBackend(),db=new SqlFixture();
 try{
  const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({userId:'00000000-0000-0000-0000-000000000001',accessToken:'t',legacyDeviceId:'d',scope}),true,serverPin());
  const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1};
  const store=db.store();await store.initialize();await store.beginScan(binding);
  const folderId='folder-dependency',assetId='asset-dependency.png';
  const dependencyKeys=[store.entityKeyFor('folder',folderId),store.entityKeyFor('asset',assetId)].sort();
  let noteId='note-dependency',suffix=0;
  while(store.entityKeyFor('note',noteId)>dependencyKeys[0]!)noteId='note-dependency-'+(++suffix);
  const noteKey=store.entityKeyFor('note',noteId);
  const records=[
   {kind:'note' as const,logicalId:noteId,value:{...noteValue(noteId),folderId,markdown:'![image](assets/'+assetId+')'}},
   {kind:'folder' as const,logicalId:folderId,value:{folderId,name:'Folder',sortOrder:0,updatedAt:1,modifiedBy:'watch',deleted:false,deletedAt:0}},
   {kind:'asset' as const,logicalId:assetId,value:{assetId,mime:'image/png',originalFilename:assetId,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}},
  ];
  await store.scanPage({page:async()=>({rows:records,after:'done',done:true}),changed:async()=>[]});
  const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>100,undefined,{maxChangedRows:1});
  const reader=new WatchCloudIndex(store,http,crypto,keys,async deviceId=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100);
  const expected=[...dependencyKeys,noteKey];
  for(let i=0;i<expected.length;i++){
   const prep=await publisher.prepare('a'.repeat(32),'key',{commitOid:server.device.commitOid,revision:server.device.revision},String(i+1).repeat(32));
   expect(prep.changedRows).toBe(1);
   await publisher.flush();
   await reader.pull(server.window());
   const rows=await store.cloudRows((await store.readState()).cloud!.current!.treeRoot,'',32);
   expect(rows.map(r=>r.row.entityKey).sort()).toEqual(expected.slice(0,i+1).sort());
  }
 }finally{db.close();}
});
