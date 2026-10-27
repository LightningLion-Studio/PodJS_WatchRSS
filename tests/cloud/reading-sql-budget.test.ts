import {test,expect} from 'bun:test';
import {dbFixture,cloudCrypto} from './library-fixture';
import {LocalArticleManifestStore,type SyncTextPort} from '../../src/sync/local-manifest';
import type {SyncBodyCodec} from '../../src/sync/article-body';
const codec:SyncBodyCodec={sha256:cloudCrypto.sha256,encode:async()=>{throw Error('Reading must not encode bodies');},decode:async()=>{throw Error('Reading must not decode bodies');}};
const text:SyncTextPort={parseUri:async value=>{try{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};}catch{return {valid:false,scheme:null,host:null,rawPath:null,rawQuery:null};}},htmlText:async html=>html.replace(/<[^>]*>/g,'')};
const files={storeText:async(_:string,v:string)=>v,hydrate:async(v:string)=>v};
test('5500 RSS reading candidates exclude 3500 imported chapters in SQL and never read ordinary bodies',async()=>{
 const f=await dbFixture();try{
  f.sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://reading.example/rss','Reading',1,1),(2,'https://watchrss.local/import-txt-novel/book','Book',1,2)");
  f.sql.transaction(()=>{const insert=f.sql.prepare('INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,?,?,?,?,?,?,1)');for(let i=1;i<=9000;i++)insert.run(i,i<=5500?1:2,'Item','body '.repeat(200),i<=5500?'https://reading.example/'+i:'https://watchrss.local/import-txt-novel/book/chapter/'+i,'guid-'+i,'guid-'+i);})();
  await f.db.execute("INSERT INTO article_reading_state(article_id,progress,changed_at,position_bytes,position_hash) VALUES(5500,.75,20,64,'reading-hash')");await f.db.execute("INSERT INTO native_reading_sources(item_id,source_device_id,changed_at) VALUES(5500,'remote-reader',20)");
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(3,'https://watchrss.local/import-future','Unknown future source',1,3)");await f.db.execute("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at) VALUES(9001,3,'Future','https://reading.example/future','future','future',1)");
  const query=f.db.query.bind(f.db);let rowsRead=0,bodyReads=0;f.db.query=async(q,p)=>{if(q.includes('FROM articles a')){if(q.includes('a.content')||q.includes('article_original_chunks')){bodyReads++;throw Error('Broad body projection in reading-only query');}expect(q).toContain("lower(ch.url) NOT LIKE 'https://watchrss.local/import-content%'");}const rows=await query(q,p);if(q.includes('FROM articles a'))rowsRead+=rows.length;return rows;};
  const store=new LocalArticleManifestStore(f.db,codec,text,files,async()=>{});const states=await store.cloudReadingStates(true);expect(states).toHaveLength(5501);expect(rowsRead).toBe(5501);expect(bodyReads).toBe(0);expect(states.find(a=>a.url==='https://reading.example/5500')).toMatchObject({readingProgress:.75,readingPositionChangedAt:20,readingPositionBytes:64,readingPositionContentHash:'reading-hash',sourceDeviceId:'remote-reader'});expect((await query('SELECT COUNT(*) n FROM articles'))[0]?.n).toBe(9001);
 }finally{f.sql.close();}
});
test('opaque RSS identity keeps its isolated full-body fallback',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://reading.example/rss','Reading',1,1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at,is_read) VALUES(1,1,'Opaque','<p>Fallback original</p>','urn:opaque','opaque',1,1)");
  const query=f.db.query.bind(f.db);let fallback=0;f.db.query=async(q,p)=>{if(q.includes('a.content')){expect(q).toContain('WHERE a.id=?');fallback++;}return query(q,p);};const store=new LocalArticleManifestStore(f.db,codec,text,files,async()=>{});const states=await store.cloudReadingStates();expect(states).toHaveLength(1);expect(states[0]?.articleId).toMatch(/^[a-f0-9]{64}$/);expect(fallback).toBe(1);
 }finally{f.sql.close();}
});

test('read-only identity requests are bounded to four and keep SQL order despite completion order',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://reading.example/rss','Reading',1,1)");f.sql.transaction(()=>{const insert=f.sql.prepare("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at) VALUES(?,1,'Item',?,?,?,1)");for(let i=1;i<=32;i++)insert.run(i,'https://reading.example/'+i,'g'+i,'g'+i);})();
  let active=0,peak=0,calls=0;const slow={...text,parseUri:async(value:string)=>{calls++;active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,value.endsWith('/1')?6:1));return await text.parseUri(value);}finally{active--;}}};
  const store=new LocalArticleManifestStore(f.db,codec,slow,files,async()=>{}),rows=await store.cloudRssIdentities();expect(rows.map(r=>r.itemId)).toEqual(Array.from({length:32},(_,i)=>i+1));expect(calls).toBe(32);expect(peak).toBe(4);expect(active).toBe(0);
  calls=0;const cancel=new LocalArticleManifestStore(f.db,codec,slow,files,async()=>{});await expect(cancel.cloudRssIdentities(undefined,()=>{if(calls>=8)throw Error('cancel identity scan');})).rejects.toThrow('cancel identity scan');expect(calls).toBe(8);expect(active).toBe(0);
 }finally{f.sql.close();}
});
