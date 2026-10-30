import {dbFixture,article} from './library-fixture';
import {crypto} from './k2-crypto';
import {prepareArticle,prepareCachedArticle,type PreparedArticle} from '../../src/sync/article-export';
import {utf8Encode} from '../../src/cloud/types';
import {jsonRecordTupleCodec} from '@podjs/framework/record-tuples';
import {writeWrss} from '../../src/cloud/wrss';
export const cacheTables=['sync_projection_rows','sync_projection_light','sync_projection_header','sync_fast_encoded_cache','sync_snapshot_fingerprints','sync_peer_echo'];
export async function metadataFixture(size=6530,privateCount=3351){
 const f=await dbFixture(),ids:string[]=[];for(let n=1;n<=size;n++)ids.push(await crypto.sha256(utf8Encode('https://scale.invalid/'+n)));
 await f.repo.cloudRestoreMetadata({ids:[]});await f.repo.prepareFastProjection();const generation=String((await f.db.query("SELECT generation FROM sync_fast_definitions WHERE domain='library'"))[0].generation);
 const sample=await prepareArticle(article({url:'https://scale.invalid/1',articleId:ids[0],contentHtml:null,contentText:'original',contentHash:'logical-1'}),f.ports.codec),m=sample.manifest;
 const tuple=jsonRecordTupleCodec(['articleId','sourceDeviceId','contentHash','updatedAt','independentChangedAt','favoriteChangedAt','watchLaterChangedAt','deletedAt','deleted','bodyHash','bodyByteCount','chunkSize','chunkHashes','metadataHash','bodyAvailable','bodySyncMode','readingProgress','readingPositionBytes','readingPositionContentHash','readingPositionChangedAt','isRead','legacyArticleIds']),prepared:PreparedArticle[]=[];
 for(let n=1;n<=Math.min(2654,privateCount);n++)prepared.push(await prepareCachedArticle({...sample.article,articleId:ids[n-1],url:'https://scale.invalid/'+n,contentHash:'logical-'+n,contentText:''},f.ports.codec,{...m,chunkHashes:[...m.chunkHashes]}));
 f.sql.transaction(()=>{
  f.sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'watchrss://phone-imports','Private',1,1),(2,'https://feed.invalid/rss','Feed',1,2)");
  const a=f.sql.prepare("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,?,'Item','original',?,?,?,1)"),binding=f.sql.prepare('INSERT INTO sync_article_ids VALUES(?,?,?)'),meta=f.sql.prepare('INSERT INTO cloud_article_state VALUES(?,?,?,0,0,\'\')');
  // These tables are owned cloud helpers, not user repair operations.
  for(let n=1;n<=size;n++){a.run(n,n<=privateCount?1:2,'https://scale.invalid/'+n,n<=privateCount?null:'guid-'+n,n<=privateCount?ids[n-1]:'guid-'+n);if(n<=privateCount){binding.run(ids[n-1],n,'https://scale.invalid/'+n);meta.run(ids[n-1],'logical-'+n,m.bodyHash);}}
  const body=f.sql.prepare('INSERT INTO article_sync_content(item_id,content_html,content_text,body_hash,body_bytes,chunk_size,chunk_hashes,content_bytes) VALUES(?,NULL,\'original\',?,?,?,?,8)'),enc=f.sql.prepare('INSERT INTO sync_fast_encoded_cache VALUES(?,?,?)');
  for(let n=1;n<=Math.min(3063,privateCount);n++){body.run(n,m.bodyHash,m.bodyByteCount,m.chunkSize,JSON.stringify(m.chunkHashes));enc.run(n,generation,m.bodyHash);}
  const p=f.sql.prepare('INSERT INTO sync_projection_rows VALUES(?,?,?,?,?,?,?)'),light=f.sql.prepare('INSERT INTO sync_projection_light VALUES(?,?,?,?)');
  for(let n=1;n<=Math.min(2654,privateCount);n++){const pRow=prepared[n-1];p.run(':canonical',generation,ids[n-1],'https://scale.invalid/'+n,n,n,JSON.stringify(pRow));light.run(':canonical',generation,ids[n-1],JSON.stringify([1,'https://scale.invalid/'+n,null,1,tuple.encode(pRow.manifest as any),null]));}
  f.sql.prepare('INSERT INTO sync_projection_header VALUES(?,?,?,?)').run(':canonical',generation,0,0);
  const fingerprint=f.sql.prepare('INSERT INTO sync_snapshot_fingerprints VALUES(?,?,?)');for(let n=0;n<Math.min(5342,size);n++)fingerprint.run('article','fixture-'+n,'signature-'+n);
  f.sql.exec("INSERT INTO sync_peer_echo_generation VALUES('phone','fixture')");const echo=f.sql.prepare('INSERT INTO sync_peer_echo VALUES(?,?,?,?,?,?)');for(let n=0;n<Math.min(508,size);n++)echo.run('phone','fixture','article','echo-'+n,'incoming','local');
 })();
 const rows:any[]=[],entries=new Map<string,Uint8Array>();for(let n=1;n<=privateCount;n++){const a=article({articleId:ids[n-1],url:'https://scale.invalid/'+n,title:'Item',contentHtml:null,contentText:'original',contentHash:'logical-'+n,importedAt:1,updatedAt:2,independentChangedAt:1,readingPositionChangedAt:100+n,readingProgress:.5});const stem='bodies/'+await crypto.sha256(utf8Encode(a.articleId));rows.push({...a,contentText:undefined,contentHtml:undefined,contentTextEntry:stem+'.txt',contentHtmlEntry:null});entries.set(stem+'.txt',utf8Encode('original'));}
 entries.set('manifest.json',utf8Encode(JSON.stringify({format:'watchrss-library-backup',version:3})));entries.set('articles.json',utf8Encode(JSON.stringify(rows)));
 return {...f,ids,rows,archive:writeWrss(entries),generation,cacheCounts:()=>Object.fromEntries(cacheTables.map(t=>[t,Number((f.sql.query('SELECT COUNT(*) n FROM '+t).get() as any).n)]))};
}
