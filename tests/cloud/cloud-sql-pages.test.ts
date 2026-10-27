import {test,expect} from 'bun:test';
import {dbFixture,article} from './library-fixture';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';

test('cloud metadata and public origins exceed native row limits without losing the last page',async()=>{
 const f=await dbFixture();try{
  await f.repo.mergeCloud([], [article({articleId:'last-private'})], 'phone');
  const initial=await f.repo.cloudSnapshot(false),saved=initial.stateArticles.find(a=>a.independentSaved)!;expect(saved).toBeDefined();
  f.sql.transaction(()=>{
   const metadata=f.sql.prepare('INSERT OR REPLACE INTO cloud_article_state(article_id,content_hash,body_hash,reading_clock,reading_source) VALUES(?,?,?,?,?)');
   for(let i=0;i<3220;i++)metadata.run('!padding-'+String(i).padStart(5,'0'),'hash','hash',0,'padding');
   metadata.run(saved.articleId,saved.contentHash,saved.contentHash,saved.readingPositionChangedAt,'remote-last-page');
   f.sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(9000,'https://paging.example/rss','Paging',1,1)");
   const insert=f.sql.prepare("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,9000,'Paging','','https://paging.example/'||?, ?,1)");
   const mapping=f.sql.prepare('INSERT INTO sync_article_ids(item_id,article_id,url) VALUES(?,?,?)');
   for(let i=0;i<5492;i++){insert.run(10000+i,i,'page-'+i);mapping.run(10000+i,'public-'+i,'https://paging.example/'+i);}
  })();
  const raw=f.db.query.bind(f.db);let rejected=0,pages=0;
  f.db.query=async(q,p)=>{const rows=await raw(q,p);if(rows.length>1000){rejected++;throw Error('Query exceeds 1000 rows; use LIMIT and pagination');}if(JSON.stringify(rows).length>512*1024)throw Error('Query result too large; use paging');if(q.includes('LIMIT ? OFFSET ?'))pages++;return rows;};
  await expect(f.db.query('SELECT * FROM cloud_article_state')).rejects.toThrow('1000 rows');
  const candidates=await f.repo.cloudReadingCandidates();expect(candidates).toBeDefined();
  const snapshot=await f.repo.cloudSnapshot(false);expect(snapshot.stateArticles.find(a=>a.articleId===saved.articleId)?.sourceDeviceId).toBe('remote-last-page');expect(rejected).toBe(1);expect(pages).toBeGreaterThan(20);
 }finally{f.sql.close();}
});

test('SQL bridge diagnostic retains only fixed limit classification',()=>{
 expect(JSON.parse(recordFailureDiagnostic({name:'HostServiceError',code:'invalid_argument',message:'Query exceeds 1000 rows; use LIMIT and pagination'}))).toEqual({event:'records-failed',code:'host_query_row_limit',name:'HostServiceError'});
 expect(JSON.parse(recordFailureDiagnostic({name:'HostServiceError',message:'Query result too large; use paging'})).code).toBe('host_query_bytes_limit');
 expect(recordFailureDiagnostic({message:'secret https://private.example/token'})).not.toContain('private.example');
});
