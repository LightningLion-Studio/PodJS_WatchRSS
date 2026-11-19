import {test} from 'bun:test';
import {strict as assert} from 'node:assert';
import type {StateReceipts} from '@podjs/framework/acked-state-vector';
import {bookFixture} from '../books/fixture';
import {sha} from './ble-v2-fixture';
import {SqlDomainVectorStore,SYNC_DOMAINS,DOMAIN_FAST_PATH_PROFILE} from '../../src/sync/domain-fast-path';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {PROJECTION_EVENT_RETENTION} from '../../src/sync/projection-cache';
import type {LibraryWindow} from '../../src/sync/session';

const peer='canonical-phone', legacy='legacy-phone', scope=':canonical:books-v1';
const remote=Object.fromEntries(SYNC_DOMAINS.map(domain=>[domain,'b'.repeat(64)]));
const descriptors=Object.fromEntries(SYNC_DOMAINS.map(domain=>[domain,{encoder:1,schema:18,definition:remote[domain]!}]));

async function setup(change:'alias'|'body'){
 const f=await bookFixture();
 const url='https://review.example/saved', donor='https://review.example/unsaved-alias';
 const alias=sha('new-unsaved-alias');
 const make=(canonical:boolean)=>{
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});
  if(canonical)repo.configurePeer(peer,{supportsRssCanonicalIds:true,supportsBookSyncV1:true});
  return repo;
 };
 const repo=make(true), legacyRepo=make(false);
 const ack=(repo:SqlLibrarySessionRepository,w:LibraryWindow,name:string)=>repo.markSuccess({
  remoteDeviceId:name,localSeqToInclusive:w.toSeqInclusive,remoteSeqToInclusive:10,remoteProtocolVersion:14,
  fullSnapshot:w.fullSnapshot,projectionGeneration:w.projectionGeneration
 });
 const open=(canSkipLibrary=(name:string)=>repo.canSkipLibrary(name))=>
  new SqlDomainVectorStore(f.db,f.codec,async()=>({scope:'a'.repeat(64),roots:remote}),{
   now:()=>1000,definitions:repo.domainDefinitions(),canSkipLibrary
  }).open(peer,DOMAIN_FAST_PATH_PROFILE);
 const cursors=()=>f.db.query('SELECT last_local_seq_acked,last_remote_seq_applied FROM sync_peer_state WHERE peer_device_id=?',[peer]);
 const hasHeader=async()=>!!(await f.db.query('SELECT 1 FROM sync_projection_header WHERE scope=?',[scope]))[0];
 try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(100,'https://feed.review.example/rss','RSS',1)");
  await f.db.execute(`INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at,content) VALUES
   (1,100,'Saved',?,?,'saved-item',100,'saved text'),
   (2,100,'Donor',?,?,?,100,'alias text'),
   (3,100,'Unrelated','https://review.example/noise','noise-guid','noise',100,'noise body')`,
   [url,change==='body'?'canonical-saved-guid':url,donor,change==='body'?'unrelated-donor-guid':url,
    change==='body'?sha('canonical-saved-guid'):'unsaved-alias']);
  await f.db.execute("INSERT INTO article_saved_states(article_id,save_type,saved,changed_at) VALUES(1,'favorite',1,100)");
  const legacyWindow=await legacyRepo.prepareWindow(legacy,0);
  await ack(legacyRepo,legacyWindow,legacy);
  const initial=await repo.prepareWindow(peer,0);
  const [old]=initial.fullArticleManifest;
  assert.ok(old);
  assert.deepEqual(old.legacyArticleIds,[sha(change==='body'?url:donor)]);
  if(change==='body'){
   const [body]=await repo.exportRequested([{articleId:old.articleId,bodyHash:old.bodyHash,chunkIndexes:[0],metadataOnly:false}],peer);
   assert.equal(body?.article.contentText,'alias text');
  }
  await ack(repo,initial,peer);
  const issued=await open(), first=await issued.summary(remote,{},descriptors);
  for(const domain of SYNC_DOMAINS)issued.completed(domain);
  await issued.stage(first.windowId,remote,SYNC_DOMAINS,descriptors);
  await issued.applied();
  const known:StateReceipts=Object.fromEntries(
   Object.entries(first.roots).map(([domain,root])=>[domain,{localRoot:remote[domain]!,remoteRoot:root}])
  );
  const summary=async()=> (await open()).summary(remote,known,descriptors);
  assert.deepEqual((await summary()).skipDomains,[...SYNC_DOMAINS]);
  const age=async()=>{
   for(let remaining=PROJECTION_EVENT_RETENTION+52;remaining>0;remaining-=900){
    await f.db.transaction(Array.from({length:Math.min(900,remaining)},()=>({
     sql:'UPDATE articles SET fetched_at=fetched_at+1 WHERE id=3'
    })));
   }
  };
  const prune=()=>make(false).prepareWindow(legacy,legacyWindow.toSeqInclusive);
  const mutate=()=>change==='body'
   ? f.db.execute("UPDATE articles SET content='updated unsaved body' WHERE id=2")
   : f.db.execute('INSERT INTO sync_article_ids(article_id,item_id,url) VALUES(?,2,?)',[alias,donor]);
  const prepare=()=>make(true).prepareWindow(peer,initial.toSeqInclusive);
  return {f,repo,make,initial,first,known,open,summary,age,prune,mutate,prepare,hasHeader,cursors,alias};
 }catch(error){f.sql.close();throw error;}
}

for(const change of ['alias','body'] as const)test(`retiring a projection drops library SKIP for a cross-URL ${change} change`,async()=>{
 const s=await setup(change);
 try{
  const cursor=await s.cursors();
  const inFlight=await s.open(), oldSummary=await inFlight.summary(remote,s.known,descriptors);
  assert.ok(oldSummary.skipDomains.includes('library'));
  await s.age();
  assert.ok(await s.hasHeader());
  const expired=await s.summary();
  assert.equal(expired.roots.library,s.first.roots.library);
  assert.ok(!expired.skipDomains.includes('library'),'an over-age header cannot authorize SKIP');
  await s.prune();
  assert.ok(!await s.hasHeader());
  assert.ok((await s.f.db.query('SELECT 1 FROM sync_projection_header WHERE scope=?',['']))[0]);
  assert.ok(!await s.repo.canSkipLibrary(peer),'the other active scope cannot authorize this peer');
  const evicted=await s.summary();
  assert.notEqual(evicted.roots.library,s.first.roots.library);
  assert.deepEqual(evicted.skipDomains,SYNC_DOMAINS.filter(domain=>domain!=='library'));
  assert.deepEqual((await inFlight.stage(oldSummary.windowId,remote,[],descriptors)).retryDomains,['library']);
  await s.mutate();
  assert.ok(!(await s.summary()).skipDomains.includes('library'));
  assert.deepEqual(await s.cursors(),cursor);
  const visible=await s.prepare(), [manifest]=visible.articleManifest;
  assert.equal(visible.articleManifest.length,1);
  assert.ok(manifest);
  if(change==='body'){
   const [body]=await s.make(true).exportRequested([{articleId:manifest.articleId,bodyHash:manifest.bodyHash,chunkIndexes:[0],metadataOnly:false}],peer);
   assert.equal(body?.article.contentText,'updated unsaved body');
  }else assert.ok(manifest.legacyArticleIds?.includes(s.alias));
  assert.deepEqual(await s.cursors(),cursor);
  assert.ok(await s.repo.canSkipLibrary(peer),'the scope was rebuilt successfully');
  assert.ok(!(await s.summary()).skipDomains.includes('library'),'rebuilding a scope never revives the prior receipt');
 }finally{s.f.sql.close();}
});

test('retiring and rebuilding the selected scope during summary cannot validate the old library root',async()=>{
 const s=await setup('alias');
 try{
  await s.age();
  let checked=false;
  const vector=await s.open(async name=>{
   checked=true;
   await s.prune();
   await s.prepare();
   assert.ok(await s.repo.canSkipLibrary(name));
   return true;
  });
  const mixed=await vector.summary(remote,s.known,descriptors);
  assert.ok(checked,'the old roots and receipts reached the projection check');
  assert.equal(mixed.roots.library,s.first.roots.library);
  assert.deepEqual(mixed.skipDomains,SYNC_DOMAINS.filter(domain=>domain!=='library'));
  const refreshed=await s.open(), next=await refreshed.summary(remote,s.known,descriptors);
  refreshed.completed('library');
  assert.ok((await refreshed.stage(next.windowId,remote,['library'],descriptors)).committedDomains.includes('library'));
  await refreshed.applied();
  const known={...s.known,library:{localRoot:remote.library!,remoteRoot:next.roots.library!}};
  const warm=await (await s.open()).summary(remote,known,descriptors);
  assert.deepEqual(warm.skipDomains,[...SYNC_DOMAINS]);
 }finally{s.f.sql.close();}
});
