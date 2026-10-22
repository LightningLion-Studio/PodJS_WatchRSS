import {expect} from 'bun:test';
import {dbFixture} from './library-fixture';
import {rssArticleId} from '../../src/cloud/rss-identity';
import {poolFeedXml} from '../../src/cloud/rss-pool';
import {WatchRssRepository} from '../../src/core/repository';
import {crypto} from './k2-crypto';
const feed='https://public.example/rss';
const inventory=(items:any[])=>({url:feed,title:'Feed',description:'',siteUrl:null,imageUrl:null,items});
 const f=await dbFixture();try{
  await f.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,\'Feed\',1,1)',[feed]);
  const items=[];for(const guid of ['one','two'])items.push({url:'https://example.com/shared',title:guid,excerpt:'',contentHtml:null,contentText:'original',imageUrl:null,guid,dedupKey:await rssArticleId({guid},crypto.sha256),contentHash:null});
  await new WatchRssRepository(f.db,async()=>'').refreshChannel(1,poolFeedXml(inventory(items)),undefined,true);
  await f.adapter.mergeInventory(inventory([...items,{...items[0],dedupKey:'invalid',guid:'bad',url:'https://example.com/bad'}]));
  await new WatchRssRepository(f.db,async()=>'').refreshChannel(1,poolFeedXml(inventory(items)),undefined,true);
  const rows=await f.repo.cloudReadingCandidates();expect(rows.map(a=>a.articleId).sort()).toEqual(items.map(a=>a.dedupKey).sort());expect((await f.db.query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(2);
  await f.repo.clearLibrary();await f.adapter.mergeInventory(inventory(items));await new WatchRssRepository(f.db,async()=>'').refreshChannel(Number((await f.db.query('SELECT id FROM channels'))[0].id),poolFeedXml(inventory(items)),undefined,true);expect((await f.db.query('SELECT COUNT(*) n FROM articles'))[0].n).toBe(2);
 }finally{f.sql.close();}
