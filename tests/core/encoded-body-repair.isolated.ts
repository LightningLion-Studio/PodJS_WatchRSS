import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {initializeSchema} from '../../src/core/schema';
import {repairEncodedRssBodies} from '../../src/core/encoded-body-repair';
import {parseFeed,parseFeedAsync} from '../../src/core/parser';
import {poolFeedXml} from '../../src/cloud/rss-pool';
import {contentText,parseContent,parseContentAsync} from '../../src/reader/content';
import fixture from '../fixtures/ifanr-13790-sanitized.json';

function fixtureDb(){const raw=new Database(':memory:');const db={async execute(sql:string,params:readonly any[]=[]){raw.run(sql,[...params]);},async query(sql:string,params:readonly any[]=[]){return raw.query(sql).all(...params) as Record<string,unknown>[];},async transaction(items:{sql:string;params?:readonly any[]}[]){raw.transaction(()=>{for(const item of items)raw.run(item.sql,[...(item.params??[])]);})();}};return {raw,db};}
test('real incident shape recovers text and media in sync/async production defaults',async()=>{
 for(const blocks of [parseContent(fixture.content),await parseContentAsync(fixture.content)]){
  expect(contentText(blocks)).toContain('测试设备发布');expect(contentText(blocks)).not.toContain('&lt;');
  expect(blocks.some(b=>b.type==='image'&&b.url.includes('example.test'))).toBe(true);
  expect(blocks.every(b=>b.type!=='text'||b.text.length<=1024)).toBe(true);
 }
});
test('public-pool XML envelope and ordinary RSS/CDATA reach identical HTML without double decoding',async()=>{
 const html='<p>A &amp; B <code>&lt;span&gt;</code></p>';
 const xml=poolFeedXml({title:'Feed',description:'',items:[{title:'Title',guid:'g',url:'https://example.test/a',excerpt:'',contentHtml:html,contentText:'A & B',dedupKey:'a'.repeat(64)}]} as any);
 for(const feed of [parseFeed(xml),await parseFeedAsync(xml)])expect(feed.articles[0]!.content).toBe(html);
 expect(parseFeed('<rss><channel><title>F</title><item><content:encoded><![CDATA['+html+']]></content:encoded></item></channel></rss>').articles[0]!.content).toBe(html);
});
test('repair preserves exact original, clocks, identities, saved data and chunks; skips imported/received bodies; is idempotent',async()=>{
 const {raw,db}=fixtureDb();await initializeSchema(db);
 raw.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test/rss','F',1),(2,'https://watchrss.local/import-txt-novel/book','Book',1)");
 for(let id=1;id<=4;id++)raw.run('INSERT INTO articles(id,channel_id,title,content,dedup_key,fetched_at,is_read,is_saved,reading_progress) VALUES(?,?,?,?,?,1,1,1,0.4)',[id,id===3?2:1,'Title',id===2?null:fixture.content,String(id)]);
 raw.run('INSERT INTO article_body_chunks VALUES(2,0,?)',[fixture.content]);
 raw.run("INSERT INTO article_sync_content VALUES(4,NULL,'received','hash',8,8,'[]',8)");
 raw.run("INSERT INTO article_saved_states VALUES(1,'favorite',1,123,7)");
 const before=raw.query('SELECT id,channel_id,dedup_key,is_read,is_saved,reading_progress,fetched_at FROM articles').all();
 expect(await repairEncodedRssBodies(db,{yieldTurn:async()=>{}})).toBe(2);
 expect(await repairEncodedRssBodies(db,{yieldTurn:async()=>{}})).toBe(0);
 expect(raw.query('SELECT body FROM article_html_repair_backup ORDER BY article_id').all()).toEqual([{body:fixture.content},{body:fixture.content}]);
 expect(raw.query('SELECT id,channel_id,dedup_key,is_read,is_saved,reading_progress,fetched_at FROM articles').all()).toEqual(before);
 expect(raw.query('SELECT changed_at FROM article_saved_states').get()).toEqual({changed_at:123});
 expect(raw.query('SELECT body FROM article_body_chunks').get()).toEqual({body:fixture.content});
 expect(raw.query('SELECT content FROM articles WHERE id IN (3,4)').all()).toEqual([{content:fixture.content},{content:fixture.content}]);raw.close();
});
test('concurrent refresh wins the CAS; failure leaves exact body available for retry',async()=>{
 const {raw,db}=fixtureDb();await initializeSchema(db);raw.run("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test/rss','F',1)");raw.run("INSERT INTO articles(id,channel_id,title,content,dedup_key,fetched_at) VALUES(1,1,'Title',?,'g',1)",[fixture.content]);
 const transaction=db.transaction;let race=true;
 db.transaction=async statements=>{if(race){race=false;raw.run("UPDATE articles SET content='<p>fresh</p>' WHERE id=1");}await transaction(statements);};
 expect(await repairEncodedRssBodies(db,{id:1})).toBe(0);expect(raw.query('SELECT content FROM articles').get()).toEqual({content:'<p>fresh</p>'});expect(raw.query('SELECT COUNT(*) n FROM article_html_repair_backup').get()).toEqual({n:0});
 raw.run('UPDATE articles SET content=?',[fixture.content]);db.transaction=async()=>{throw Error('injected SQL failure');};
 await expect(repairEncodedRssBodies(db,{id:1})).rejects.toThrow('injected');expect(raw.query('SELECT content FROM articles').get()).toEqual({content:fixture.content});db.transaction=transaction;
 expect(await repairEncodedRssBodies(db,{id:1})).toBe(1);raw.close();
});
test('pool roundtrip preserves CDATA terminators and plain entity examples exactly',()=>{
 for(const body of ['<p>one ]]> two &amp; three</p>','literal &lt;code&gt; example']){
  const xml=poolFeedXml({title:'Feed',description:'',items:[{title:'A',url:'https://example.test',guid:'g',excerpt:'',contentHtml:body,contentText:''}]} as any);
  expect(parseFeed(xml).articles[0]!.content).toBe(body);
 }
});
test('multi-megabyte unbroken fallback yields to the event loop and cancellation never publishes',async()=>{
 const abort=new AbortController();const text='超长文本😀'.repeat(300000);let yielded=false;
 setTimeout(()=>{yielded=true;abort.abort();},0);
 await expect(parseContentAsync(text,abort.signal)).rejects.toThrow('cancelled');expect(yielded).toBe(true);
 const input='长段落😀'.repeat(25000),blocks=await parseContentAsync(input);
 expect(blocks.every(b=>b.type==='text'&&b.text.length<=1024)).toBe(true);
 expect(contentText(blocks).replaceAll('\n','')).toBe(input);
});
