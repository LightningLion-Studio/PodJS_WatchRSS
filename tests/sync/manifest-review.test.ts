import {test} from 'bun:test';
import {strict as assert} from 'node:assert';
import {fixture,sha} from './ble-v2-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {LibrarySyncSession,type LibraryWindow} from '../../src/sync/session';
import {encodeFrame,decodeFrame,type JsonObject} from '../../src/sync/protocol';
import {combineManifestFrames} from '../../src/sync/library-wire';
import {WatchRssRepository} from '../../src/core/repository';
import {prepareLocalSaveAlias} from '../../src/sync/local-identity';
import {PeerEchoStore} from '../../src/sync/echo-store';
import {LibraryProjectionCache} from '../../src/sync/projection-cache';
import {libraryRevision} from '../../src/sync/revision';

for(const forceFull of [false,true])test('shared legacy ID keeps its saved alternate after the winner is unsaved, forceFull='+forceFull,async()=>{
 const f=await fixture();
 const peer='fixture-phone-117';
 const url1='https://www.review.example/article',url2='https://review.example/article';
 const stable=()=>new SqlLibrarySessionRepository(f.db,f.ports);
 const state=()=>f.db.query('SELECT last_local_seq_acked,last_remote_seq_applied FROM sync_peer_state WHERE peer_device_id=?',[peer]);
 try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(100,'https://feed.review.example/rss','Fixture RSS',1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at,description) VALUES(1,100,'Winner',?,'first-guid','first-dedup',200,'First body'),(2,100,'Alternate',?,'second-guid','second-dedup',100,'Alternate body')",[url1,url2]);
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(1,'favorite',1,200,2),(2,'favorite',1,100,1)");
  const firstRepo=stable(), first=await firstRepo.prepareWindow(peer,0);
  assert.equal(first.fullArticleManifest.length,1);
  await firstRepo.markSuccess({remoteDeviceId:peer,localSeqToInclusive:first.toSeqInclusive,remoteSeqToInclusive:10,remoteProtocolVersion:14,fullSnapshot:true,projectionGeneration:first.projectionGeneration});
  const prior=await state();
  await f.db.execute("UPDATE article_saved_states SET saved=0,changed_at=300 WHERE article_id=1 AND save_type='favorite'");
  const frames:JsonObject[]=[];
  let step=0, sentManifest:JsonObject|undefined;
  const repo=stable();
  const [result]=await new LibrarySyncSession({
   readFrame:async()=>{
    let frame:JsonObject;
    if(step===0){
     frame={action:'syncLibrary',phase:'manifest',version:14,deviceId:peer,supportsChunkedBodies:true,supportsChangeSequences:true,supportsManifestBatches:true,supportsArticleBatches:true,supportsMetadataOnlyArticles:true,forceFull,fullSnapshot:forceFull,changeSeqRange:{fromExclusive:forceFull?0:10,toInclusive:11},syncCursor:{lastRemoteSeqApplied:first.toSeqInclusive,lastLocalSeqAckedByPeer:10},articleManifest:[],rssSources:[]};
    }else if(step===1){
     sentManifest=combineManifestFrames(frames.filter(x=>x.phase==='manifest'));
     assert.equal(sentManifest.success,true);
     assert.equal(sentManifest.fullSnapshot,forceFull);
     assert.ok(Array.isArray(sentManifest.articleManifest));
     assert.equal(sentManifest.articleManifest.length,1);
     const row=sentManifest.articleManifest[0] as JsonObject;
     frame={action:'syncLibrary',phase:'articles',batchIndex:0,batchCount:1,articles:[],bodyRequests:[{articleId:row.articleId,bodyHash:row.bodyHash,chunkIndexes:[0]}]};
    }else if(step===2){
     frame={action:'ack',phase:'applied',applied:true,success:true};
    }else{
     throw Error('Unexpected read');
    }
    step++;
    return decodeFrame(encodeFrame(frame));
   },
   writeFrame:async frame=>{assert.deepEqual(await state(),prior);frames.push(decodeFrame(encodeFrame(frame)));},
   close:async()=>{}
  },repo,{now:()=>1000}).run();
  assert.equal(result.libraryApplied,true);
  const article=frames.filter(frame=>frame.phase!=='manifest').flatMap(frame=>(frame.articles as JsonObject[]|undefined)??[])[0];
  assert.ok(sentManifest);
  const next=await repo.prepareWindow(peer,Number((sentManifest.changeSeqRange as JsonObject).toInclusive));
  assert.equal(article?.url,url2);
  assert.equal(article?.favoriteSaved,true);
  assert.equal(next.articleManifest.length,0);
 }finally{f.sql.close();}
});

for(const change of ['unsave','title'] as const)test('legacy URL aliases retain the other row’s saved state after '+change,async()=>{
 const f = await fixture();
 const local = new WatchRssRepository(f.db, async () => { throw Error('network forbidden'); }, undefined,
  (id:number) => prepareLocalSaveAlias(f.db,id,f.ports.text,f.codec));
 const url1 = 'https://www.review.example/article';
 const url2 = 'https://review.example/article';
 const peer = 'fixture-phone-117';
 function repo(){ const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer(peer,{supportsRssCanonicalIds:false});return r; }
 async function state(){ return f.db.query('SELECT last_local_seq_acked,last_remote_seq_applied FROM sync_peer_state WHERE peer_device_id=?',[peer]); }
 async function ack(r:SqlLibrarySessionRepository,w:LibraryWindow,remote=10){
  await r.markSuccess({remoteDeviceId:peer,localSeqToInclusive:w.toSeqInclusive,remoteSeqToInclusive:remote,remoteProtocolVersion:14,fullSnapshot:w.fullSnapshot,projectionGeneration:w.projectionGeneration});
 }
 try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(100,'https://feed.review.example/rss','Fixture RSS',1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at,description) VALUES(1,100,'Winner',?,'first-guid','first-dedup',200,'First body'),(2,100,'Alternate',?,'second-guid','second-dedup',100,'Alternate body')",[url1,url2]);
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(1,'favorite',1,200,2),(2,'watchLater',1,100,1)");
  const firstRepo=repo(), first=await firstRepo.prepareWindow(peer,0);
  assert.equal(first.fullArticleManifest.length,1);
  await ack(firstRepo,first);
  const before=await state();
  if(change==='unsave'){
   const now=Date.now;Date.now=()=>300;try{await local.setSaved(1,false);}finally{Date.now=now;}
  }else await f.db.execute("UPDATE articles SET title='Edited winner' WHERE id=1");
  const secondRepo=repo(), second=await secondRepo.prepareWindow(peer,first.toSeqInclusive);
  assert.deepEqual(await state(),before);
  const [m]=second.articleManifest;
  assert.ok(m);
  assert.equal(m.articleId,first.articleManifest[0]?.articleId);
  const [exported]=await secondRepo.exportRequested([{articleId:m.articleId,bodyHash:m.bodyHash,chunkIndexes:[0],metadataOnly:false}],peer);
  await ack(secondRepo,second,11);
  const next=await secondRepo.prepareWindow(peer,second.toSeqInclusive);
  assert.equal(exported?.article.url,change==='unsave'?url2:url1);
  assert.equal(exported?.article.contentText,'First body');
  assert.equal(exported?.article.favoriteSaved,change==='title');
  assert.equal(exported?.article.watchLaterSaved,true);
  assert.equal(next.articleManifest.length,0);
  assert.deepEqual(await state(),[{last_local_seq_acked:second.toSeqInclusive,last_remote_seq_applied:11}]);
 }finally{f.sql.close();}
});

for(const canonical of [false,true])test('body-source edit follows the physical binding across URLs, canonical='+canonical,async()=>{
 const f=await fixture();
 const url='https://review.example/saved',physical='https://review.example/physical';
 const peer='fixture-phone-117',id=sha(url);
 const newRepo=()=>{const repo=new SqlLibrarySessionRepository(f.db,f.ports);repo.configurePeer(peer,{supportsRssCanonicalIds:canonical});return repo;};
 try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(100,'https://feed.review.example/rss','Fixture RSS',1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at,content) VALUES(1,100,'Saved',?,'saved-row',200,'Unselected body'),(2,100,'Body source',?,?,100,'Body before')",[url,physical,id]);
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) VALUES(1,'favorite',1,200,2)");
  const firstRepo=newRepo(),first=await firstRepo.prepareWindow(peer,0);
  assert.equal(first.fullArticleManifest.length,1);
  const old=first.fullArticleManifest[0]!;
  const [before]=await firstRepo.exportRequested([{articleId:id,bodyHash:old.bodyHash,chunkIndexes:[0],metadataOnly:false}],peer);
  assert.equal(before?.article.contentText,'Body before');
  await firstRepo.markSuccess({remoteDeviceId:peer,localSeqToInclusive:first.toSeqInclusive,remoteSeqToInclusive:10,remoteProtocolVersion:14,fullSnapshot:true,projectionGeneration:first.projectionGeneration});
  await f.db.execute("UPDATE articles SET content='Body after!' WHERE id=2");
  const repo=newRepo(),next=await repo.prepareWindow(peer,first.toSeqInclusive);
  const current=next.fullArticleManifest[0]!;
  const [body]=await repo.exportRequested([{articleId:id,bodyHash:current.bodyHash,chunkIndexes:[0],metadataOnly:false}],peer);
  assert.equal(next.articleManifest.length,1);
  assert.notEqual(current.bodyHash,old.bodyHash);
  assert.equal(body?.article.contentText,'Body after!');
  assert.ok(next.toSeqInclusive>first.toSeqInclusive);
  // Also exercise the derived-only path with no change to the business revision.
  const projection=new LibraryProjectionCache(f.db),scope=canonical?':canonical':'',revision=await libraryRevision(f.db);
  const clean=await projection.plan(scope,revision,false);
  assert.ok(clean);
  await f.db.execute("INSERT INTO sync_projection_events(kind,new_url,new_item,legacy_rebuild) VALUES('cacheNone',?,2,0)",[physical]);
  assert.equal(await libraryRevision(f.db),revision);
  assert.equal(await projection.plan(scope,revision,false),undefined);
 }finally{f.sql.close();}
});

test('canonical alias additions and removals advance the delta exactly once',async()=>{
 const f=await fixture(),peer='fixture-b2-peer',url='https://review.example/article';
 const make=()=>{const r=new SqlLibrarySessionRepository(f.db,f.ports);r.configurePeer(peer,{supportsRssCanonicalIds:true});return r;};
 try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(100,'https://feed.review.example/rss','RSS',1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at,content) VALUES(1,100,'Article',?,'guid','dedup',100,'Body')",[url]);
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(1,'favorite',1,100)");
  const repo=make(),initial=await repo.prepareWindow(peer,0);
  assert.deepEqual(initial.fullArticleManifest[0]?.legacyArticleIds,[sha(url)]);
  await repo.markSuccess({remoteDeviceId:peer,localSeqToInclusive:initial.toSeqInclusive,remoteSeqToInclusive:10,remoteProtocolVersion:14,fullSnapshot:true,projectionGeneration:initial.projectionGeneration});
  const binding=sha('fixture-local-binding');
  await f.db.execute("INSERT INTO sync_article_ids VALUES(?,1,?)",[binding,url]);
  const next=await make().prepareWindow(peer,initial.toSeqInclusive);
  assert.deepEqual(next.fullArticleManifest[0]?.legacyArticleIds,[binding,sha(url)]);
  assert.deepEqual(next.articleManifest.map(row=>row.legacyArticleIds),[[binding,sha(url)]]);
  assert.ok(next.toSeqInclusive>initial.toSeqInclusive);
  assert.equal((await make().prepareWindow(peer,next.toSeqInclusive)).articleManifest.length,0);
  await f.db.execute('DELETE FROM sync_article_ids WHERE item_id=1');
  const removed=await make().prepareWindow(peer,next.toSeqInclusive);
  assert.deepEqual(removed.articleManifest.map(row=>row.legacyArticleIds),[[sha(url)]]);
  assert.ok(removed.toSeqInclusive>next.toSeqInclusive);
 }finally{f.sql.close();}
});

test('a peer receipt for the old aliases cannot suppress an alias-only delta',async()=>{
 const f=await fixture(),peer='fixture-peer';
 try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(100,'https://feed.review.example/rss','RSS',1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at,content) VALUES(1,100,'Article','https://review.example/article','guid','dedup',100,'Body')");
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(1,'favorite',1,100)");
  const repo=new SqlLibrarySessionRepository(f.db,f.ports);
  repo.configurePeer(peer,{supportsRssCanonicalIds:true});
  const [manifest]=(await repo.prepareWindow(peer,0)).fullArticleManifest;
  assert.ok(manifest?.legacyArticleIds?.length);
  const observed={...manifest,sourceDeviceId:peer};
  const changed={...observed,legacyArticleIds:[...manifest.legacyArticleIds,sha('new binding')]};
  const echo=new PeerEchoStore(f.db,f.codec);
  await f.db.transaction(await echo.stage(peer,[observed],[],[observed],[]));
  assert.deepEqual((await echo.filter(peer,[observed],[])).articleManifest,[]);
  assert.deepEqual((await echo.filter(peer,[changed],[])).articleManifest,[changed]);
  await f.db.transaction(await echo.stage(peer,[changed],[],[observed],[]));
  assert.deepEqual((await echo.filter(peer,[changed],[])).articleManifest,[changed]);
 }finally{f.sql.close();}
});
