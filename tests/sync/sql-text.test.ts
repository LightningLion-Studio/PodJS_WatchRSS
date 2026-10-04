import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readSyncSqlText} from '../../src/sync/sql-text.ts';
import {LocalArticleManifestStore,stableArticleId,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {initializeSchema} from '../../src/core/schema.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
const codec:SyncBodyCodec={sha256:async bytes=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),encode:async body=>gzipSync(encodeBodyJson(body)),decode:async bytes=>gunzipSync(bytes).toString()};
const text:SyncTextPort={parseUri:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async value=>value};
async function fixture(){
 const raw=new Database(':memory:');raw.exec('PRAGMA foreign_keys=ON');let maxResult=0,maxRequest=0;
 const checkRequest=(value:unknown)=>{const size=JSON.stringify(value).length;maxRequest=Math.max(maxRequest,size);if(size>512*1024)throw new Error('Oversized host request');};
 const db:SqlDatabase={query:async(sql,params=[])=>{checkRequest({sql,params});const rows=raw.query(sql).all(...params as any[]) as Record<string,unknown>[];const size=rows.reduce((n,row)=>n+JSON.stringify(row).length,0);if(size>512*1024)throw new Error('Oversized host query result');maxResult=Math.max(maxResult,size);return rows;},execute:async(sql,params=[])=>{checkRequest({sql,params});raw.query(sql).run(...params as any[]);},transaction:async statements=>{checkRequest(statements);raw.transaction(()=>{for(const statement of statements)raw.query(statement.sql).run(...statement.params as any[]??[]);})();}};
 await initializeSchema(db);raw.exec("INSERT INTO sync_local_identity(id,device_id,device_order) VALUES(1,'local','local');INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',1)");
 const id=await stableArticleId('https://example.com/long',text.parseUri,codec);raw.query("INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at) VALUES(1,1,'Long body','https://example.com/long',?,1)").run(id);
 const stored=new Map<string,string>(),files={storeText:async(key:string,value:string)=>{const marker='marker:'+key;stored.set(marker,value);return marker;},hydrate:async(value:string)=>stored.get(value)??value};
 return {raw,db,id,stored,files,limits:()=>({maxResult,maxRequest}),store:new LocalArticleManifestStore(db,codec,text,files,async()=>{})};
}
test('byte-paged SQL text preserves NUL, supplementary characters, empty strings and null',async()=>{
 const f=await fixture();try{const body='x'.repeat(32767)+'😀汉\0尾巴'.repeat(120000);f.raw.query('UPDATE articles SET content=? WHERE id=1').run(body);
 await expect(f.db.query('SELECT content FROM articles WHERE id=1')).rejects.toThrow('Oversized');expect(await readSyncSqlText(f.db,'SELECT content AS value FROM articles WHERE id=?',[1])).toBe(body);
 f.raw.exec("UPDATE articles SET content='' WHERE id=1");expect(await readSyncSqlText(f.db,'SELECT content AS value FROM articles WHERE id=?',[1])).toBe('');f.raw.exec('UPDATE articles SET content=NULL WHERE id=1');expect(await readSyncSqlText(f.db,'SELECT content AS value FROM articles WHERE id=?',[1])).toBeNull();expect(f.limits().maxResult).toBeLessThan(70000);
 }finally{f.raw.close();}
});
for(const mode of ['inline','chunks','original'] as const)test('large '+mode+' body exports and publishes cache metadata within host message limits',async()=>{
 const f=await fixture();try{const body='汉😀\0text'.repeat(80000);
 if(mode==='inline')f.raw.query('UPDATE articles SET content=? WHERE id=1').run(body);
 else{if(mode==='original')f.raw.exec("UPDATE articles SET content='rss fallback' WHERE id=1");const table=mode==='chunks'?'article_body_chunks':'article_original_chunks';for(let offset=0,index=0;offset<body.length;offset+=72000,index++)f.raw.query(`INSERT INTO ${table}(article_id,chunk_index,body) VALUES(1,?,?)`).run(index,body.slice(offset,offset+72000));}
 const output=await f.store.snapshot();expect(output).toHaveLength(1);expect(output[0]!.article.contentText).toBe(body);expect(output[0]!.manifest.bodyAvailable).toBe(true);expect([...f.stored.values()]).toContain(body);expect(f.raw.query('SELECT body_hash FROM article_sync_content WHERE item_id=1').get()).not.toBeNull();expect(f.limits().maxResult).toBeLessThan(70000);expect(f.limits().maxRequest).toBeLessThan(70000);
 const resolved=await f.store.resolveIncomingBody(output[0]!.article);expect(resolved?.body?.contentText).toBe(body);
 }finally{f.raw.close();}
});
test('a same-length edit between byte pages rejects the snapshot without publishing cache metadata',async()=>{
 const f=await fixture();try{f.raw.query('UPDATE articles SET content=? WHERE id=1').run('a'.repeat(700000));let pages=0;const db:SqlDatabase={...f.db,query:async(sql,params)=>{const rows=await f.db.query(sql,params);if(sql.startsWith('SELECT CAST(substr(')&&++pages===1)f.raw.query('UPDATE articles SET content=? WHERE id=1').run('b'.repeat(700000));return rows;}};
 await expect(new LocalArticleManifestStore(db,codec,text,f.files,async()=>{}).snapshot()).rejects.toThrow('changed');expect(f.raw.query('SELECT count(*) n FROM article_sync_content').get()).toEqual({n:0});
 }finally{f.raw.close();}
});
