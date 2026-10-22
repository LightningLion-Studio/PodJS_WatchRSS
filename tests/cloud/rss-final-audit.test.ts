import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {article,dbFixture,cloudCrypto} from './library-fixture';
import {fixture as serviceFixture} from './service-fixture';
import {crypto,key} from './k2-crypto';
import {CloudRecordCodec,WatchCloudRecords} from '../../src/cloud/records';
import {rssArticleId,rssSourceKey,tryRssArticleId} from '../../src/cloud/rss-identity';
import {fileURLToPath} from 'node:url';
import {WatchRssRepository} from '../../src/core/repository';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {utf8Encode} from '../../src/cloud/types';
import vectors from './fixtures/rss-source-key.json';
const feed='https://public.example/rss',rc={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
async function integration(){
 const f=await serviceFixture(),local=await dbFixture();f.session.library=local.adapter;
 f.session.records=async(_,current)=>new WatchCloudRecords({userId:'user',epoch:'9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',anchorVersion:1,version:1,crypto:rc,key:async()=>key.slice(),readState:()=>f.cache.records('user'),writeState:v=>f.cache.storeRecords('user',v),get:after=>(f.session.client as any).records(after,'watch'),push:items=>(f.session.client as any).pushRecords(items),current,assertUpload:current,apply:docs=>local.adapter.applyRecords(docs),export:()=>local.adapter.exportRecords()});
 f.session.client.resolveRssSource=async url=>({sourceId:'pool',url,title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[]});return {...f,local};
}
const inventory=(items:any[])=>({url:feed,title:'Feed',description:'',siteUrl:null,imageUrl:null,items});
test('R41 backend vectors through local SQL rows use guid/link/body/title priority, including all-empty and Chinese identities',async()=>{
 const f=await dbFixture();try{
  await f.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,\'Feed\',1,1)',[feed]);
  for(const [i,v]of vectors.articleCases.entries()){
   const body=v.contentHash===await crypto.sha256(utf8Encode('Synthetic body'))?'Synthetic body':v.contentHash===await crypto.sha256(utf8Encode('body'))?'body':'';
   await f.db.execute('INSERT INTO articles(channel_id,title,content,link,guid,dedup_key,fetched_at,is_read) VALUES(1,?,?,?,?,?,1,1)',[v.title,body,v.input,v.guid,String(i)]);
  }
  const rows=await f.repo.cloudReadingCandidates(),docs=(await f.adapter.exportRecords()).filter(d=>d.kind==='rss-state');
  for(const v of vectors.articleCases){expect(rows.some(r=>r.articleId===v.articleId)).toBe(true);expect(docs.some(d=>d.value.articleIdHash===v.articleIdHash)).toBe(true);}
  expect(docs).toHaveLength(new Set(vectors.articleCases.map(v=>v.articleIdHash)).size);
  const empty=vectors.articleCases.find(v=>v.name==='all-empty')!,sourceId=await rssSourceKey(feed,crypto.sha256);
  await f.adapter.applyRecords([{kind:'rss-state',value:{sourceId,articleIdHash:empty.articleIdHash,isRead:false,readingProgress:0,readingPositionChangedAt:500,sourceDeviceId:'phone'}}]);
  expect((await f.db.query("SELECT is_read FROM articles WHERE guid='urn:uuid:1234'"))[0].is_read).toBe(1);
 }finally{f.sql.close();}
});
test('R41 guid-only and healthy entries plus an uncomputable entry cannot block records or a private snapshot',async()=>{
 const f=await integration();try{
  await f.local.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,\'Feed\',1,1)',[feed]);
  for(const [i,guid]of ['tag:example.com,2026:post-1','urn:uuid:1234',null,'broken'].entries())await f.local.db.execute('INSERT INTO articles(channel_id,title,content,link,guid,dedup_key,fetched_at,is_read) VALUES(1,\'Entry\',\'original\',?,?,?,1,1)',[guid?null:'https://example.com/healthy',guid,String(i)]);
  await f.local.db.execute("INSERT INTO cloud_rss_article_ids(item_id,article_id) VALUES(4,'not-a-valid-dedup-key')");
  await new WatchRssRepository(f.local.db,async()=>'').setSaved(4,true);
  await f.local.repo.mergeCloud([], [article({articleId:await cloudCrypto.stableId('https://private.example/p'),url:'https://private.example/p',contentText:'private original',contentHtml:null})], 'phone');
  expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(1);
  const codec=new CloudRecordCodec(rc),docs=await Promise.all([...f.recordRows.values()].map(async row=>(await codec.decode(key,key,'user',row)).doc));
  expect(docs.filter(d=>d.kind==='rss-state')).toHaveLength(3);expect(docs.some(d=>d.kind==='article'&&d.value.url==='https://private.example/p')).toBe(true);
  const sourceId=await rssSourceKey(feed,crypto.sha256),id=await rssArticleId({guid:'urn:uuid:1234'},crypto.sha256),hash=await crypto.sha256(utf8Encode(id));
  await f.local.adapter.applyRecords([{kind:'rss-state',value:{sourceId,articleIdHash:hash,isRead:false,readingProgress:0,readingPositionChangedAt:500,sourceDeviceId:'phone'}}]);
  expect((await f.local.db.query("SELECT is_read FROM articles WHERE guid='urn:uuid:1234'"))[0].is_read).toBe(0);
  expect(await f.service.syncNow(true)).toBe(true);expect((await f.local.db.query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(5);
  expect(await tryRssArticleId({dedupKey:'broken'},crypto.sha256)).toBeUndefined();
 }finally{f.local.sql.close();}
});
test('R41 Chinese raw/canonical URL roundtrip keeps one original local row, native binding, body and newer reading/save clocks',async()=>{
 const f=await dbFixture(),other=await dbFixture();try{
  const raw=vectors.articleCases.find(v=>v.name==='chinese-raw')!,canonical=vectors.articleCases.find(v=>v.name==='chinese-canonical')!;
  await f.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,\'Feed\',1,1)',[feed]);
  await f.db.execute('INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,?,\'中文原文\',?,\'link:old-native\',1)',[raw.title,raw.input]);
  await new WatchRssRepository(f.db,async()=>'').setSaved(1,true);
  const before=(await f.repo.cloudSnapshot(true)).articles[0];expect(before.articleId).toBe(raw.articleId);
  const native=await cloudCrypto.stableId(raw.input);expect(native).not.toBe(raw.articleId);
  await new SyncSavedStateStore(f.db).bindArticle(1,native,raw.input);
  await f.adapter.mergeInventory(inventory([{url:canonical.input,identityLink:canonical.input,guid:'',dedupKey:canonical.articleId,title:canonical.title,excerpt:'',contentHtml:null,contentText:'pool refresh',imageUrl:null,contentHash:null}]));
  const sourceId=await rssSourceKey(feed,crypto.sha256),state={kind:'rss-state',value:{sourceId,articleIdHash:raw.articleIdHash,sourceDeviceId:'zz-phone',isRead:true,readingProgress:.75,readingPositionChangedAt:Date.now()+1000,favoriteSaved:true,favoriteChangedAt:Date.now()+1000,favoriteSortOrder:1}};
  await f.adapter.applyRecords([state]);const out=await f.adapter.exportPayloads(true),snapshot=await f.repo.cloudSnapshot(true);
  expect(snapshot.articles).toHaveLength(1);expect(snapshot.articles[0]).toMatchObject({articleId:raw.articleId,url:raw.input,isRead:true,contentText:'中文原文',favoriteSaved:true});
  expect((await f.db.query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(1);expect((await f.db.query('SELECT article_id FROM sync_article_ids WHERE item_id=1'))[0].article_id).toBe(native);
  await other.adapter.applyRecords([state]);await other.adapter.restorePayloads(new Map(out.objects.map(o=>[o.name,o.bytes])),'phone-restored');
  const restored=(await other.repo.cloudSnapshot(true)).articles[0];expect(restored).toMatchObject({articleId:raw.articleId,contentText:'中文原文',isRead:true,favoriteSaved:true});
  await f.adapter.restorePayloads(new Map((await other.adapter.exportPayloads(true)).objects.map(o=>[o.name,o.bytes])),'phone-return');
  expect((await f.db.query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(1);expect((await f.repo.cloudReadingCandidates())[0].articleId).toBe(raw.articleId);
  const cancel={kind:'rss-state',value:{...state.value,sourceDeviceId:'zzz-phone',favoriteSaved:false,favoriteChangedAt:state.value.favoriteChangedAt+1}};await f.adapter.applyRecords([cancel]);expect((await f.adapter.exportPayloads(true)).objects).toHaveLength(0);
 }finally{f.sql.close();other.sql.close();}
});
test('R41 pool dedup keys survive XML refresh; different GUID entries sharing a link stay distinct and invalid keys skip individually',()=>{
 const result=Bun.spawnSync([process.execPath,fileURLToPath(new URL('./rss-local-refresh.fixture.ts',import.meta.url))]);expect({code:result.exitCode,error:result.stderr.toString()}).toEqual({code:0,error:''});
});
test('R41 legacy native materialization maps once to a pool GUID, without double-hashing its synthetic GUID or merging another GUID',async()=>{
 const f=await dbFixture();try{
  const url='https://example.com/legacy',native=await cloudCrypto.stableId(url);
  await f.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,\'Feed\',1,1)',[feed]);
  await f.db.execute('INSERT INTO articles(channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(1,\'Legacy\',\'legacy original\',?,?,?,1)',[url,native,native]);
  await new SyncSavedStateStore(f.db).bindArticle(1,native,url);
  expect((await f.repo.cloudReadingCandidates())[0].articleId).toBe(await rssArticleId(url,crypto.sha256));
  const items=[];for(const guid of ['actual-guid','different-guid'])items.push({url,title:guid,excerpt:'',contentText:guid,contentHtml:null,imageUrl:null,guid,dedupKey:await rssArticleId({guid},crypto.sha256),contentHash:null});
  await f.adapter.mergeInventory(inventory(items));
  expect((await f.db.query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(2);
  expect((await f.db.query('SELECT article_id FROM cloud_rss_article_ids WHERE item_id=1'))[0].article_id).toBe(items[0].dedupKey);
  expect((await f.db.query('SELECT article_id FROM sync_article_ids WHERE item_id=1'))[0].article_id).toBe(native);
  expect((await f.repo.cloudReadingCandidates()).map(a=>a.articleId).sort()).toEqual(items.map(a=>a.dedupKey).sort());
 }finally{f.sql.close();}
});
