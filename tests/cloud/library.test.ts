import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {WatchCloudLibraryAdapter,privateCloudBody} from '../../src/cloud/library';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {initializeSchema} from '../../src/core/schema';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {stableArticleId} from '../../src/sync/local-manifest';
import type {ExportedArticle} from '../../src/sync/article-export';
import {encodeBodyJson} from '../../src/sync/article-body';
import type {SqlDatabase} from '../../src/core/types';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {crypto,enabled} from './k2-crypto';
import {rssSourceKey} from '../../src/cloud/rss-identity';
import {dbFixture,cloudCrypto,article} from './library-fixture';
test('deterministic content-only WRSS excludes all public state and validates legacy input before mutation',async()=>{
 const rows=[article(),article({articleId:'public',rssSourceUrl:'https://feed.example/rss',independentSaved:false,favoriteSaved:false,watchLaterSaved:false}),article({articleId:'imported',rssSourceUrl:'https://watchrss.local/import-content',url:'https://x/chapter'})];let merges=0;
 const adapter=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:rows,stateArticles:rows,sources:[]}),mergeCloud:async(_,articles)=>{merges++;return articles.length;}},'watch',cloudCrypto,enabled);
 const one=await adapter.exportPayloads(true),two=await adapter.exportPayloads(true);expect(one).toEqual(two);expect(one.objects.map(o=>o.name)).toEqual(['private-library.wrss']);expect(privateCloudBody(rows[2])).toBe(true);
 const {readWrss}=await import('../../src/cloud/wrss');const zip=await readWrss(one.objects[0].bytes,crypto.gunzip),meta=JSON.parse(utf8Decode(zip.get('articles.json')!));expect(meta.map((a:any)=>a.articleId)).toEqual(['a','imported']);expect(meta.every((a:any)=>a.isRead===false&&a.readingPositionChangedAt===0)).toBe(true);
 rows[0].isRead=true;rows[0].readingPositionChangedAt=200;rows[0].updatedAt=200;expect(await adapter.exportPayloads(true)).toEqual(one);
 const relay=utf8Encode(JSON.stringify({action:'syncLibrary',version:14,articles:[],rssSources:[]}));
 await expect(adapter.restorePayloads(new Map([['library-sync.json',relay],['rss-state.json',utf8Encode('{"format":"wrong","articles":[]}')]]),'phone')).rejects.toThrow();expect(merges).toBe(0);
});
test('real SQL restores private body/saves/progress and state-only merge preserves stored body',async()=>{
 const f=await dbFixture();try{
  const a=article({rssSourceUrl:'https://feed.example/rss',independentSaved:false,favoriteSaved:true,favoriteChangedAt:5,favoriteSortOrder:7});a.articleId=await cloudCrypto.stableId(a.url);
  const remote=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[a],stateArticles:[a],sources:[]}),mergeCloud:async()=>0},'phone',cloudCrypto,enabled);
  const payload=await remote.exportPayloads(true);await f.adapter.applyRecords(await remote.exportRecords());await f.adapter.restorePayloads(new Map(payload.objects.map(o=>[o.name,o.bytes])),'phone');
  expect((await f.db.query('SELECT content,is_saved,reading_progress FROM articles'))[0]).toMatchObject({content:'<p>private</p>',is_saved:1,reading_progress:.25});
  const body=(await f.db.query('SELECT content_text FROM article_sync_content'))[0].content_text;
  a.readingProgress=.75;a.readingPositionChangedAt=9;
  await f.adapter.applyRecords(await remote.exportRecords());
  expect((await f.db.query('SELECT content_text FROM article_sync_content'))[0].content_text).toBe(body);expect((await f.db.query('SELECT progress FROM article_reading_state'))[0].progress).toBe(.75);
  const exported=await f.adapter.exportRecords();expect(exported.filter(d=>d.kind==='article')).toHaveLength(0);
 }finally{f.sql.close();}
});
test('article transaction rolls back source/body/reading/saves on mid-transaction failure',async()=>{
 const f=await dbFixture();try{f.fail();await expect(f.repo.mergeCloud([], [article()], 'phone')).rejects.toThrow('disk fault');expect(await f.db.query('SELECT * FROM articles')).toEqual([]);expect(await f.db.query('SELECT * FROM channels')).toEqual([]);expect(await f.db.query('SELECT * FROM sync_saved_states')).toEqual([]);}finally{f.sql.close();}
});
test('ordinary unsaved RSS read rows enter state export and public source inventory excludes imports',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://feed.example/rss','Feed',1,1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_read,reading_progress) VALUES(1,1,'Read','Do not upload body','https://example.com/read','guid',1,1,0.5)");
  await f.adapter.mergeInventory({sourceId:'pool',url:'https://feed.example/rss',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[]});const data=await f.adapter.exportRecords();const state=data.filter(d=>d.kind==='rss-state');expect(state).toHaveLength(1);expect(state[0].value).toMatchObject({sourceId:await rssSourceKey('https://feed.example/rss',crypto.sha256),isRead:true,readingProgress:.5});expect(JSON.stringify(data)).not.toContain('Do not upload body');expect((await f.adapter.publicSources()).map(s=>s.url)).toEqual(['https://feed.example/rss']);
 }finally{f.sql.close();}
});
test('public inventory preserves saved flags/read progress across repeated recent/all merges',async()=>{
 const f=await dbFixture();try{const inventory={url:'https://feed.example/rss',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[{url:'https://example.com/read',title:'Read',excerpt:'Text',contentHtml:null,contentText:'Text',imageUrl:null,guid:'g',contentHash:null}]};
  await f.adapter.mergeInventory(inventory);const row=(await f.db.query('SELECT id FROM articles'))[0];await f.db.execute('UPDATE article_reading_state SET progress=.75,changed_at=50 WHERE article_id=?',[row.id]);await f.db.execute('UPDATE articles SET reading_progress=.75,is_read=1 WHERE id=?',[row.id]);
  await f.adapter.mergeInventory(inventory);expect((await f.db.query('SELECT reading_progress,is_read FROM articles'))[0]).toMatchObject({reading_progress:.75,is_read:1});
 }finally{f.sql.close();}
});
