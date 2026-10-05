import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {initializeSchema} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import {ExternalSavedStore,biliExternalItem,douyinExternalItem} from '../../src/core/external-saved.ts';
import {DouyinSavedStore} from '../../src/douyin/saved.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
import {BiliClient} from '../../src/bili/client.ts';
import {prepareLocalSaveAlias} from '../../src/sync/local-identity.ts';
import {SyncSavedStateStore} from '../../src/sync/saved-state.ts';
import {LocalArticleManifestStore,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body.ts';
import {prepareArticle,bodyForRequest} from '../../src/sync/article-export.ts';
import {LibrarySyncSession} from '../../src/sync/session.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {readSavedLinks} from '../../src/sync/saved-links.ts';
import type {JsonObject} from '../../src/sync/protocol.ts';
const codec:SyncBodyCodec={sha256:async b=>new Bun.CryptoHasher('sha256').update(b).digest('hex'),encode:async b=>gzipSync(encodeBodyJson(b)),decode:async b=>gunzipSync(b).toString()};
const text:SyncTextPort={parseUri:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async s=>s};
const video:DouyinItem={awemeId:'7',description:'视频标题',authorName:'作者',playUrl:'https://cdn.test/play',coverUrl:'https://cdn.test/cover',likeCount:123,createdAtSeconds:0,authorId:'a',commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[]};
function kvStore(){const values=new Map<string,string>();return {values,get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};}
async function setup(path=':memory:',kv=kvStore()){
 const sql=new Database(path);sql.exec('PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{sql.query(s.sql).run(...(s.params??[]) as any[]);return (sql.query('SELECT changes() AS n').get() as {n:number}).n;}))()};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice('watch');let now=1000;
 const external=new ExternalSavedStore(db,id=>prepareLocalSaveAlias(db,id,text,codec),()=>now);
 const douyin=new DouyinSavedStore(kv,()=>now,external);
 const ports={codec,text,uri:{parseUri:text.parseUri,parseAndroid:text.parseUri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:()=>now};
 const repo=new SqlLibrarySessionRepository(db,ports),manifest=new LocalArticleManifestStore(db,codec,text,ports.files,ports.migrateReading);
 const handle=createApplicationActionHandler({notes:{} as never,deviceId:()=>repo.deviceId(),notesChanged:()=>{},clearLibrary:()=>repo.clearLibrary(),readSavedLinks:type=>readSavedLinks(db,type)});
 return {sql,db,external,douyin,repo,manifest,handle,kv,setNow:(value:number)=>{now=value;}};
}
const legacy=(kind='favorite',saved=true)=>({platform:'douyin',awemeId:'7',item:video,kind,saved,savedAtMillis:123,changedAtMillis:saved?123:456,shareUrl:'https://www.douyin.com/video/7'});

test('native external channel, content, guid dedup and timestamps; both platform lists and pullSavedItems',async()=>{
 const f=await setup();try{
  await f.douyin.set(video,'favorite',true);await f.douyin.set(video,'watchLater',true);
  await f.external.sync(biliExternalItem({aid:2,bvid:'BV2',cid:9,title:'Bili',owner:{name:'UP'},cover:'https://cover'}),'favorite',true);
  expect(await f.db.query('SELECT c.url,a.title,a.description,a.content,a.guid,a.dedup_key,a.link,a.video_url FROM articles a JOIN channels c ON c.id=a.channel_id ORDER BY a.id')).toEqual([
   {url:'builtin:douyin',title:'视频标题',description:'作者：作者 · 点赞 123',content:'作者：作者 · 点赞 123',guid:'douyin:7',dedup_key:'guid:douyin:7',link:'https://www.douyin.com/video/7',video_url:video.playUrl},
   {url:'builtin:bili',title:'Bili',description:'UP主：UP',content:'UP主：UP',guid:'bili:BV2',dedup_key:'guid:bili:BV2',link:'https://www.bilibili.com/video/BV2?cid=9',video_url:'https://www.bilibili.com/video/BV2?cid=9'}]);
  await f.external.sync(biliExternalItem({aid:2,bvid:'BV2',cid:10,title:'New title',owner:{name:'New UP'}}),'watchLater',true);
  expect(await f.db.query("SELECT title,link,video_url,description FROM articles WHERE guid='bili:BV2'")).toEqual([{title:'Bili',link:'https://www.bilibili.com/video/BV2?cid=9',video_url:'https://www.bilibili.com/video/BV2?cid=10',description:'UP主：New UP'}]);
  f.setNow(2000);await f.douyin.set({...video,description:'new title',playUrl:'https://new'},'favorite',true);
  expect(await f.douyin.list('favorite')).toMatchObject([{savedAtMillis:1000,item:{description:'视频标题',playUrl:'https://new'}}]);
  expect(await f.db.query("SELECT changed_at FROM article_saved_states WHERE save_type='favorite' ORDER BY article_id")).toEqual([{changed_at:1000},{changed_at:1000}]);
  const pull=await f.handle({action:'pullSavedItems',type:'FAVORITE'});expect(pull.count).toBe(2);expect(pull.items).toEqual([{link:'https://www.bilibili.com/video/BV2?cid=9'},{link:'https://www.douyin.com/video/7'}]);
  expect((await f.manifest.snapshot()).map(p=>p.article.url).sort()).toEqual(['https://www.bilibili.com/video/BV2?cid=9','https://www.douyin.com/video/7']);
  await f.douyin.set(video,'favorite',false);expect(await f.douyin.state('7')).toEqual({favorite:false,watchLater:true});
  expect((await f.manifest.snapshot()).find(p=>p.article.url.includes('douyin'))?.article).toMatchObject({favoriteSaved:false,favoriteChangedAt:2000,watchLaterSaved:true,watchLaterChangedAt:1000});
  await f.external.sync(biliExternalItem({bvid:'BVmissing'}),'favorite',false);expect((await f.db.query('SELECT id FROM articles')).length).toBe(2);
 }finally{f.sql.close();}
});

test('KV migration preserves both clocks and cancellations, resumes after interruption, and never resurrects after disk reopen/clear',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wrss-b2-'),path=dir+'/test.db',kv=kvStore();kv.values.set('douyin.saved.v1',JSON.stringify([legacy(),legacy('watchLater',false)]));
 let f=await setup(path,kv);try{
  // Crash after one durable entry: restarting must finish only the remaining entry.
  await f.external.initializeMigration();await f.external.sync(douyinExternalItem(video),'favorite',true,{key:'douyin.saved.v1:7:favorite',changedAt:123,createdAt:123});
  f.sql.close();f=await setup(path,kv);await f.douyin.migrate();
  expect(await f.db.query('SELECT save_type,saved,changed_at FROM article_saved_states ORDER BY save_type')).toEqual([{save_type:'favorite',saved:1,changed_at:123},{save_type:'watchLater',saved:0,changed_at:456}]);
  expect((await f.douyin.list())[0]?.savedAtMillis).toBe(123);f.setNow(900);await f.douyin.set(video,'favorite',false);
  f.sql.close();f=await setup(path,kv);await f.douyin.migrate();expect(await f.douyin.state('7')).toEqual({favorite:false,watchLater:false});
  expect((await f.manifest.snapshot())[0]?.article).toMatchObject({favoriteSaved:false,favoriteChangedAt:900,watchLaterSaved:false,watchLaterChangedAt:456});
  await f.handle({action:'clearLibrary',version:14});f.sql.close();f=await setup(path,kv);await f.douyin.migrate();expect(await f.db.query('SELECT id FROM articles')).toEqual([]);expect(await f.douyin.list()).toEqual([]);
 }finally{f.sql.close();rmSync(dir,{recursive:true,force:true});}
});

test('preexisting SQL cancellation wins over an unmigrated KV favorite',async()=>{const f=await setup();try{
 await f.external.sync(douyinExternalItem(video),'favorite',true);f.setNow(2000);await f.external.sync(douyinExternalItem(video),'favorite',false);
 f.kv.values.set('douyin.saved.v1',JSON.stringify([legacy()]));await f.douyin.migrate();expect(await f.douyin.state('7')).toEqual({favorite:false,watchLater:false});expect((await f.manifest.snapshot())[0]?.article.favoriteChangedAt).toBe(2000);
 }finally{f.sql.close();}});

async function exchange(f:Awaited<ReturnType<typeof setup>>,mode:string,incoming:Awaited<ReturnType<typeof prepareArticle>>[]){
 const frames:JsonObject[]=[{action:'syncLibrary',phase:'manifest',version:14,deviceId:'phone',libraryMode:mode,supportsChunkedBodies:true,supportsMetadataOnlyArticles:true,articleManifest:incoming.map(p=>p.manifest),rssSources:[]},
 {action:'syncLibrary',phase:'articles',articles:incoming.map(p=>({...p.article,body:bodyForRequest(p,{articleId:p.article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false})})),bodyRequests:[]},{action:'ack',success:true,phase:'applied',applied:true}];
 const written:JsonObject[]=[];
 const result=await new LibrarySyncSession({readFrame:async()=>{const frame=frames.shift();if(!frame)throw new Error('unexpected frame read');if(frame.phase==='articles'){const requests=written.find(w=>w.phase==='manifest')?.bodyRequests as any[];frame.articles=requests.map(request=>{const p=incoming.find(p=>p.article.articleId===request.articleId)!;return {...p.article,body:bodyForRequest(p,request)};});}return frame;},writeFrame:async frame=>{written.push(frame);},close:async()=>{}},f.repo).run();
 expect(result[0]?.response).toMatchObject({success:true});return written;
}

test('real syncLibrary merge, both replace directions and clear preserve platform state and do not replay KV',async()=>{
 const f=await setup();try{
  f.kv.values.set('douyin.saved.v1',JSON.stringify([legacy()]));await f.douyin.migrate();await f.douyin.set(video,'watchLater',true);
  const original=(await f.manifest.snapshot())[0]!;
  const remote=await prepareArticle({...original.article,favoriteSaved:false,favoriteChangedAt:5000,watchLaterSaved:true,watchLaterChangedAt:5000,updatedAt:5000},codec);
  await exchange(f,'merge',[remote]);expect(await f.douyin.state('7')).toEqual({favorite:false,watchLater:true});
  expect((await f.handle({action:'pullSavedItems',type:'favorite'})).count).toBe(0);
  expect((await f.handle({action:'pullSavedItems',type:'watchLater'})).count).toBe(1);
  await exchange(f,'watchToPhoneReplace',[]);expect(await f.douyin.state('7')).toEqual({favorite:false,watchLater:true});
  const replace=await prepareArticle({...original.article,favoriteSaved:true,favoriteChangedAt:100,watchLaterSaved:false,watchLaterChangedAt:100,updatedAt:6000},codec);
  await exchange(f,'phoneToWatchReplace',[replace]);expect(await f.douyin.state('7')).toEqual({favorite:true,watchLater:false});
  await exchange(f,'phoneToWatchReplace',[]);await f.douyin.migrate();expect(await f.douyin.list()).toEqual([]);
 }finally{f.sql.close();}
});

test('Bili remote success writes unified states, failure does not, cancellations preserve other folders',async()=>{
 const f=await setup();try{let fail=false,other=false;const client=new BiliClient({secureStore:{get:async()=>JSON.stringify({cookies:{bili_jct:'csrf',DedeUserID:'42'},updatedAt:0}),set:async()=>{},delete:async()=>{}},transport:{request:async request=>({status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({code:fail?-1:0,message:'failed',data:request.url.includes('list-all')?{list:[{id:2,fav_state:other?1:0}]}:{}}))})},onSaved:async(item,type,saved)=>f.external.sync(biliExternalItem(item),type,saved)});
 const item={aid:2,bvid:'BV2',cid:9,title:'Bili'};
 await client.favorite({...item,addMediaIds:[1],savedItem:item});await client.addToView({...item,savedItem:item});expect((await f.handle({action:'pullSavedItems',type:'favorite'})).count).toBe(1);
 fail=true;await expect(client.removeToView(item)).rejects.toThrow();expect((await f.handle({action:'pullSavedItems',type:'watchLater'})).count).toBe(1);
 fail=false;other=true;await client.favorite({...item,removeMediaIds:[1]});expect((await f.handle({action:'pullSavedItems',type:'favorite'})).count).toBe(1);
 other=false;await client.favorite({...item,removeMediaIds:[2]});await client.removeToView(item);expect((await f.handle({action:'pullSavedItems',type:'favorite'})).count).toBe(0);expect((await f.handle({action:'pullSavedItems',type:'watchLater'})).count).toBe(0);
 }finally{f.sql.close();}
});

test('local platform actions after phone merge retain clocks on no-op and stamp new cancellation/resave',async()=>{
 const f=await setup();try{
  await f.douyin.set(video,'favorite',true);await f.douyin.set(video,'watchLater',true);
  const original=(await f.manifest.snapshot())[0]!;
  const remote=await prepareArticle({...original.article,favoriteChangedAt:5000,watchLaterChangedAt:5000,updatedAt:5000},codec);
  await exchange(f,'merge',[remote]);
  f.setNow(6000);await f.douyin.set(video,'favorite',true);
  expect((await f.manifest.snapshot())[0]?.article.favoriteChangedAt).toBe(5000);
  expect((await f.handle({action:'pullSavedItems',type:'favorite'})).count).toBe(1);
  await f.douyin.set(video,'favorite',false);
  expect(await f.douyin.state('7')).toEqual({favorite:false,watchLater:true});
  expect((await f.manifest.snapshot()).find(p=>p.article.url.includes('douyin'))?.article.favoriteChangedAt).toBe(6000);
  f.setNow(7000);await f.douyin.set(video,'favorite',true);
  expect((await f.douyin.list('favorite'))).toMatchObject([{savedAtMillis:7000}]);
  expect((await f.handle({action:'pullSavedItems',type:'favorite'})).count).toBe(1);
 }finally{f.sql.close();}
});
