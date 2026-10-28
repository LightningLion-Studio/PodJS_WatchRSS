import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {initializeSchema} from '../../src/core/schema';
import {WatchRssRepository} from '../../src/core/repository';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {OfflineMediaQueue,type OfflineQueuePort} from '../../src/reader/offline-queue';
import type {SqlDatabase} from '../../src/core/types';
async function fixture(){
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 await initializeSchema(db,{seedBuiltinChannels:false});await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.example/rss','Feed',1)");await db.execute(`INSERT INTO articles(id,channel_id,title,content,link,image_url,video_url,dedup_key,fetched_at) VALUES(1,1,'Unread','<img src="/a.png"><video src="https://feed.example/b.mp4"></video>','https://feed.example/post','https://feed.example/a.png',NULL,'a',1)`);
 const files=new Set<string>(),downloads:string[]=[],cleaned:number[]=[];let fail=false,now=100;
 const port:OfflineQueuePort={body:id=>repo.getArticleBody(id),stat:async p=>({file:files.has(p),size:files.has(p)?10:0}),remove:async p=>{files.delete(p);},clearItem:async id=>{cleaned.push(id);for(const p of files)if(p.startsWith(`offline/rss/${id}/`))files.delete(p);},download:(url,path)=>({result:(async()=>{downloads.push(url);if(fail)throw Error('network');files.add(path);})(),cancel(){}}),schedule:()=>()=>{},now:()=>now};
 const repo=new WatchRssRepository(db,async()=>''),queue=new OfflineMediaQueue(db,port);
 return {sql,db,repo,queue,port,files,downloads,cleaned,setFail:(v:boolean)=>fail=v,setNow:(v:number)=>now=v,jobs:()=>sql.query('SELECT * FROM offline_media_jobs').all() as any[]};
}
test('saving never-opened content produces image/video records and files; one save keeps files, last cancellation cleans',async()=>{
 const f=await fixture();try{
  await f.repo.setSaveState(1,'favorite',true);expect(f.jobs()).toHaveLength(1);await f.queue.wake();expect(f.downloads).toEqual(['https://feed.example/a.png','https://feed.example/b.mp4']);expect(f.files.size).toBe(2);
  await f.repo.setSaveState(1,'watchLater',true);await f.repo.setSaveState(1,'favorite',false);await f.queue.wake();expect(f.files.size).toBe(2);expect(f.cleaned).toEqual([]);
  await f.repo.setSaveState(1,'watchLater',false);await f.queue.wake();expect(f.files.size).toBe(0);expect(f.cleaned).toEqual([1]);expect(await f.db.query('SELECT * FROM offline_media')).toHaveLength(0);
 }finally{f.sql.close();}
});
test('failures are recorded before IO, survive queue recreation and retry with backoff/manual retry',async()=>{
 const f=await fixture();try{
  f.setFail(true);await f.repo.setSaveState(1,'favorite',true);await f.queue.wake();expect(await f.db.query('SELECT * FROM offline_media WHERE relative_path IS NULL')).toHaveLength(3);expect(f.jobs()[0]).toMatchObject({attempts:1,last_error:'media_unavailable',next_at:30100});
  const reopened=new OfflineMediaQueue(f.db,f.port);f.setFail(false);await reopened.wake();expect(f.files.size).toBe(0);f.setNow(30100);await reopened.wake();expect(f.files.size).toBe(2);expect(f.jobs()).toEqual([]);
 }finally{f.sql.close();}
});
test('normal remote merge schedules media; authoritative replacement does not, but authoritative last unsave cleans',async()=>{
 const f=await fixture();try{
  const store=new SyncSavedStateStore(f.db);await store.initializeDevice('watch');await store.bindArticle(1,'a','https://feed.example/post');
  const state={articleId:'a',url:'https://feed.example/post',type:'favorite' as const,saved:true,changedAt:10,sortOrder:10,sourceDeviceId:'phone'};
  await store.apply(state,{authoritative:true});expect(f.jobs()).toEqual([]);
  await store.apply({...state,saved:false,changedAt:11},{authoritative:true});await f.queue.wake();
  await store.apply({...state,changedAt:12});expect(f.jobs()[0].desired).toBe('download');await f.queue.wake();expect(f.files.size).toBe(2);
  await store.apply({...state,saved:false,changedAt:13},{authoritative:true});await f.queue.wake();expect(f.files.size).toBe(0);
 }finally{f.sql.close();}
});
test('in-flight cancellation cancels transport and fences late success before cleaning the last saved article',async()=>{
 const f=await fixture();try{
  let release!:()=>void,started!:()=>void,cancels=0;const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
  f.port.download=(_url,path)=>({result:(async()=>{started();await gate;f.files.add(path);})(),cancel(){cancels++;release();}});
  await f.repo.setSaveState(1,'favorite',true);const running=f.queue.wake();await entered;const generation=f.jobs()[0].generation;await f.repo.setSaveState(1,'watchLater',true);await f.repo.setSaveState(1,'favorite',false);void f.queue.wake();expect(f.jobs()[0].generation).toBe(generation);expect(cancels).toBe(0);await f.repo.setSaveState(1,'watchLater',false);void f.queue.wake();await running;
  expect(cancels).toBe(1);expect(f.files.size).toBe(0);expect(await f.db.query('SELECT * FROM offline_media')).toHaveLength(0);
 }finally{f.sql.close();}
});
test('v6 upgrade installs durable auxiliary state atomically without changing existing reading/saves or enqueueing old saves',async()=>{
 const f=await fixture();try{
  await f.repo.setSaveState(1,'favorite',true);await f.repo.setRead(1,true,.25);const reading=await f.db.query('SELECT * FROM article_reading_state');
  for(const name of ['offline_saved_insert','offline_saved_update','offline_saved_delete','offline_article_delete'])await f.db.execute('DROP TRIGGER '+name);
  for(const name of ['offline_media_jobs','offline_media_policy','native_reading_sources','rss_local_sources'])await f.db.execute('DROP TABLE '+name);await f.db.execute('PRAGMA user_version=6');
  await initializeSchema(f.db,{seedBuiltinChannels:false});expect((await f.db.query('PRAGMA user_version'))[0].user_version).toBe(9);expect(await f.db.query('SELECT * FROM article_reading_state')).toEqual(reading);expect(f.jobs()).toEqual([]);
  await f.repo.setSaveState(1,'watchLater',true);expect(f.jobs()).toHaveLength(1);
 }finally{f.sql.close();}
});

test('relative media without an article link resolves against its subscribed source',async()=>{
 const f=await fixture();try{await f.db.execute("UPDATE articles SET link=NULL,image_url=NULL,video_url=NULL,content='<img src=\"/only.png\">' WHERE id=1");await f.repo.setSaveState(1,'favorite',true);await f.queue.wake();expect(f.downloads).toEqual(['https://feed.example/only.png']);const {readOfflineMedia}=await import('../../src/reader/offline-media');expect((await readOfflineMedia(f.db,f.port,1)).available['/only.png']).toBeDefined();}finally{f.sql.close();}
});

test('a terminal cleanup failure is explicitly retryable without recreating a download',async()=>{
 const f=await fixture();try{
  await f.repo.setSaveState(1,'favorite',true);await f.queue.wake();await f.repo.setSaveState(1,'favorite',false);const clear=f.port.clearItem;f.port.clearItem=async()=>{throw Error('permission');};
  for(let i=0;i<6;i++){f.setNow(100000000*(i+1));await f.queue.wake();}expect(f.jobs()[0]).toMatchObject({desired:'cleanup',attempts:6});expect(f.files.size).toBe(2);
  f.port.clearItem=clear;await f.queue.retry(1);expect(f.jobs()).toEqual([]);expect(f.files.size).toBe(0);expect(f.downloads).toHaveLength(2);
 }finally{f.sql.close();}
});

test('library wipe pauses queue, cancels active IO and awaits non-cooperative completion without resurrection',async()=>{
 const f=await fixture();try{
  let started!:()=>void,release!:()=>void,cancels=0,settled=false;
  const entered=new Promise<void>(resolve=>{started=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.port.download=(_url,path)=>({result:(async()=>{started();await blocked;f.files.add(path);})(),cancel(){cancels++;}});
  await f.repo.setSaveState(1,'favorite',true);void f.queue.wake();await entered;
  const idle=f.queue.pause().then(()=>{settled=true;});await Promise.resolve();expect(cancels).toBe(1);expect(settled).toBe(false);
  void f.queue.wake();release();await idle;
  expect(f.files.size).toBe(0);expect(f.jobs()[0].attempts).toBe(0);
  await f.db.transaction([{sql:'DELETE FROM channels'},{sql:'DELETE FROM offline_media_jobs'}]);
  await f.queue.wake();expect(f.files.size).toBe(0);f.queue.resume();await f.queue.wake();
  expect(f.jobs()).toEqual([]);expect(f.files.size).toBe(0);
 }finally{f.sql.close();}
});
