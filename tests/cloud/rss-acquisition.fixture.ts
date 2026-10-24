import {expect,test} from 'bun:test';
import {acquireRssFeed,RssLocalAccess,type RssAcquisitionState} from '../../src/rss/acquisition';
import {resolvePoolFeed} from '../../src/cloud/rss-pool';
import {WatchAccountStore} from '../../src/account/store';
import {utf8Encode} from '../../src/cloud/types';
const state={userId:'u',backendBaseUrl:'https://backend.invalid',watchDeviceToken:'watch-token',watchRefreshToken:'',tokenExpiresAtMillis:9e15,refreshTokenExpiresAtMillis:0,phoneMasked:'',installId:'i',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},updatedAtMillis:1};
function accounts(){const memory=new Map<string,string>();return new WatchAccountStore({get:async k=>memory.get(k)??null,set:async(k,v)=>{memory.set(k,v);},remove:async k=>{memory.delete(k);}});}
test('unbound/expired public RSS is fetched on watch with accurate add/refresh state, not for network errors or cancellation',async()=>{
 for(const reason of ['unbound','expired'] as const)for(const purpose of ['add','refresh'] as const){let direct=0;const states:RssAcquisitionState[]=[];
  const result=await acquireRssFeed('https://feed.example/rss',purpose,true,{pool:async()=>{throw new RssLocalAccess(reason);},direct:async()=>{direct++;return '<rss/>';},publish:s=>states.push(s)});
  expect(result).toEqual({xml:'<rss/>',mode:'local'});expect(direct).toBe(1);expect(states.at(-1)).toMatchObject({reason,mode:'local',phase:'ready',purpose});expect(states.at(-1)!.message).toContain(purpose==='add'?'添加':'刷新');
 }
 for(const error of [Error('HTTP 503'),Error('账号已变更')])await expect(acquireRssFeed('u','refresh',true,{pool:async()=>{throw error;},direct:async()=>{throw Error('unexpected direct');}})).rejects.toBe(error);
 await expect(acquireRssFeed('u','refresh',true,{cancelled:()=>true,pool:async()=>{throw new RssLocalAccess('unbound');},direct:async()=>{throw Error('unexpected direct');}})).rejects.toBeInstanceOf(RssLocalAccess);
});
test('public client classifies absent/locally expired credentials and confirmed HTTP401, while keeping 503 distinct',async()=>{
 const store=accounts();let requests=0;const transport={request:async()=>{requests++;return {status:401,headers:{},body:utf8Encode('{}')};}};
 await expect(resolvePoolFeed(store,transport,'https://feed.example/rss','test')).rejects.toMatchObject({reason:'unbound'});expect(requests).toBe(0);
 await store.save({...state,tokenExpiresAtMillis:1});await expect(resolvePoolFeed(store,transport,'https://feed.example/rss','test')).rejects.toMatchObject({reason:'expired'});expect(requests).toBe(0);
 await store.save(state);await expect(resolvePoolFeed(store,transport,'https://feed.example/rss','test')).rejects.toMatchObject({reason:'expired'});expect(await store.read()).toBeNull();
 await store.save(state);await expect(resolvePoolFeed(store,{request:async()=>({status:503,headers:{},body:utf8Encode('{}')})},'https://feed.example/rss','test')).rejects.toMatchObject({status:503});expect(await store.read()).not.toBeNull();
});
test('binding local feeds to public identities is idempotent and preserves local article/read/save clocks',async()=>{
 const {Database}=await import('bun:sqlite'),{initializeSchema}=await import('../../src/core/schema'),{WatchRssRepository}=await import('../../src/core/repository'),{poolFeedXml}=await import('../../src/cloud/rss-pool');
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');const db={query:async(q:string,p:readonly any[]=[])=>sql.query(q).all(...p) as Record<string,unknown>[],execute:async(q:string,p:readonly any[]=[])=>{sql.query(q).run(...p);},transaction:async(ss:{sql:string;params?:readonly any[]}[])=>{sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]));})();}};
 try{
  await initializeSchema(db,{seedBuiltinChannels:false});const repo=new WatchRssRepository(db,async()=>''),channel=await repo.addChannel('https://feed.example/rss','Custom local title');
  await repo.refreshChannel(channel.id,'<rss><channel><title>Local</title><item><guid>old-guid</guid><title>Post</title><link>https://site.example/中文</link><description>body</description></item></channel></rss>');
  expect(await db.query('SELECT url FROM rss_local_sources WHERE url=?',[channel.url])).toHaveLength(1);const id=Number((await db.query('SELECT id FROM articles'))[0].id);await repo.setRead(id,true,.5);await repo.setSaveState(id,'watchLater',true);
  const before=(await db.query('SELECT * FROM article_reading_state'))[0],saved=(await db.query('SELECT * FROM article_saved_states'))[0];
  const inventory={url:channel.url,title:'Pool',description:'',siteUrl:null,imageUrl:null,items:[{dedupKey:'a'.repeat(64),guid:'changed-guid',url:'https://site.example/%E4%B8%AD%E6%96%87',title:'Post',excerpt:'',contentText:'new body',contentHtml:null,imageUrl:null,contentHash:null}]};
  await repo.refreshChannel(channel.id,poolFeedXml(inventory),undefined,true);await db.execute('DELETE FROM rss_local_sources WHERE url=?',[channel.url]);await repo.refreshChannel(channel.id,poolFeedXml(inventory),undefined,true);
  expect(await db.query('SELECT id,is_read,reading_progress FROM articles')).toEqual([{id,is_read:1,reading_progress:.5}]);expect((await db.query('SELECT * FROM article_reading_state'))[0]).toEqual(before);expect((await db.query('SELECT * FROM article_saved_states'))[0]).toEqual(saved);expect((await db.query('SELECT article_id FROM cloud_rss_article_ids'))[0].article_id).toBe('a'.repeat(64));expect(await db.query('SELECT id FROM channels')).toHaveLength(1);await db.execute('INSERT OR IGNORE INTO rss_local_sources VALUES(?)',[channel.url]);await repo.removeChannel(channel.id);expect(await db.query('SELECT * FROM rss_local_sources')).toEqual([]);
 }finally{sql.close();}
});
