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
const parseUri=async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};};
const codec={sha256:crypto.sha256,encode:async(b:any)=>crypto.gzip(utf8Encode(encodeBodyJson(b))),decode:async(b:Uint8Array)=>utf8Decode(await crypto.gunzip(b,32*1024*1024))};
const cloudCrypto={...crypto,stableId:(url:string)=>stableArticleId(url,parseUri,crypto)};
const article=(p:Partial<ExportedArticle>={}):ExportedArticle=>({articleId:'a',sourceDeviceId:'phone',url:'https://example.com/private',title:'Private',siteName:'Example',excerpt:'Preview',contentHtml:'<p>private</p>',contentText:'private',imageUrl:null,contentHash:'h',importedAt:1,updatedAt:2,rssSourceUrl:null,rssSourceTitle:null,independentSaved:true,independentChangedAt:2,independentSortOrder:1,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:.25,readingPositionBytes:1,readingPositionContentHash:'h',readingPositionChangedAt:2,isRead:false,...p});
async function dbFixture(){const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');let fail=false;
 const exec=(s:{sql:string;params?:readonly unknown[]})=>{sql.query(s.sql).run(...(s.params??[]) as any[]);if(fail&&s.sql.includes('INSERT INTO article_reading_state'))throw Error('disk fault');};
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{exec({sql:q,params:p});},transaction:async ss=>{sql.transaction(()=>ss.forEach(exec))();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{exec(s);return (sql.query('SELECT changes() AS n').get() as any).n;}))()};
 await initializeSchema(db,{seedBuiltinChannels:false});await new SyncSavedStateStore(db).initializeDevice('watch');
 const repo=new SqlLibrarySessionRepository(db,{codec,text:{parseUri,htmlText:async s=>s.replace(/<[^>]*>/g,'')},uri:{parseUri,parseAndroid:parseUri},files:{storeText:async(_,v)=>v,hydrate:async v=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:()=>100});
 const adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);return {db,sql,repo,adapter,fail:()=>{fail=true;}};
}
test('native relay gzip fields, private-body rule and stable state JSON; validate both payloads before mutation',async()=>{
 const rows=[article(),article({articleId:'public',rssSourceUrl:'https://feed.example/rss'}),article({articleId:'imported',rssSourceUrl:'https://watchrss.local/import-content',url:'https://x/chapter'})];let merges=0;
 const adapter=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:rows,stateArticles:rows,sources:[]}),mergeCloud:async(_,articles)=>{merges++;expect(articles[0].contentHtml).toBe('<p>private</p>');return articles.length;}},'watch',cloudCrypto,enabled);
 const one=await adapter.exportPayloads(true),two=await adapter.exportPayloads(true);expect(one).toEqual(two);
 const relay=JSON.parse(utf8Decode(one.relay!));expect(relay.action).toBe('syncLibrary');expect(relay.articles[0].contentTextGzip).toBeString();expect('imageUrl' in relay.articles[0]).toBe(false);expect(relay.articles.find((a:any)=>a.articleId==='public').contentHtmlGzip).toBeUndefined();expect(privateCloudBody(rows[2])).toBe(true);
 const state=JSON.parse(utf8Decode(one.state));expect(state.articles.every((a:any)=>!('contentHtml'in a)&&!('contentText'in a))).toBe(true);
 await expect(adapter.restorePayloads(new Map([['library-sync.json',one.relay!],['rss-state.json',utf8Encode('{"format":"wrong","articles":[]}')]]),'phone')).rejects.toThrow();expect(merges).toBe(0);
});
test('real SQL restores private body/saves/progress and state-only merge preserves stored body',async()=>{
 const f=await dbFixture();try{
  const a=article({favoriteSaved:true,favoriteChangedAt:5,favoriteSortOrder:7});a.articleId=await cloudCrypto.stableId(a.url);
  const remote=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:[a],stateArticles:[a],sources:[]}),mergeCloud:async()=>0},'phone',cloudCrypto,enabled);
  const payload=await remote.exportPayloads(true);await f.adapter.restorePayloads(new Map([['library-sync.json',payload.relay!],['rss-state.json',payload.state]]),'phone');
  expect((await f.db.query('SELECT content,is_saved,reading_progress FROM articles'))[0]).toMatchObject({content:'<p>private</p>',is_saved:1,reading_progress:.25});
  const body=(await f.db.query('SELECT content_text FROM article_sync_content'))[0].content_text;
  a.readingProgress=.75;a.readingPositionChangedAt=9;
  await f.adapter.restorePayloads(new Map([['rss-state.json',(await remote.exportPayloads(false)).state]]),'phone');
  expect((await f.db.query('SELECT content_text FROM article_sync_content'))[0].content_text).toBe(body);expect((await f.db.query('SELECT progress FROM article_reading_state'))[0].progress).toBe(.75);
  const exported=await f.adapter.exportPayloads(true);expect(JSON.parse(utf8Decode(exported.state)).articles).toHaveLength(1);
 }finally{f.sql.close();}
});
test('article transaction rolls back source/body/reading/saves on mid-transaction failure',async()=>{
 const f=await dbFixture();try{f.fail();await expect(f.repo.mergeCloud([], [article()], 'phone')).rejects.toThrow('disk fault');expect(await f.db.query('SELECT * FROM articles')).toEqual([]);expect(await f.db.query('SELECT * FROM channels')).toEqual([]);expect(await f.db.query('SELECT * FROM sync_saved_states')).toEqual([]);}finally{f.sql.close();}
});
test('ordinary unsaved RSS read rows enter state export and public source inventory excludes imports',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://feed.example/rss','Feed',1,1)");
  await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_read,reading_progress) VALUES(1,1,'Read','Do not upload body','https://example.com/read','guid',1,1,0.5)");
  const data=await f.adapter.exportPayloads(false),state=JSON.parse(utf8Decode(data.state));expect(state.articles).toHaveLength(1);expect(state.articles[0]).toMatchObject({isRead:true,readingProgress:.5});expect(utf8Decode(data.state)).not.toContain('Do not upload body');expect((await f.adapter.publicSources()).map(s=>s.url)).toEqual(['https://feed.example/rss']);
 }finally{f.sql.close();}
});
test('public inventory preserves saved flags/read progress across repeated recent/all merges',async()=>{
 const f=await dbFixture();try{const inventory={url:'https://feed.example/rss',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[{url:'https://example.com/read',title:'Read',excerpt:'Text',contentHtml:null,contentText:'Text',imageUrl:null,guid:'g',contentHash:null}]};
  await f.adapter.mergeInventory(inventory);const row=(await f.db.query('SELECT id FROM articles'))[0];await f.db.execute('UPDATE article_reading_state SET progress=.75,changed_at=50 WHERE article_id=?',[row.id]);await f.db.execute('UPDATE articles SET reading_progress=.75,is_read=1 WHERE id=?',[row.id]);
  await f.adapter.mergeInventory(inventory);expect((await f.db.query('SELECT reading_progress,is_read FROM articles'))[0]).toMatchObject({reading_progress:.75,is_read:1});
 }finally{f.sql.close();}
});
