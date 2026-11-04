import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {fixture} from './ble-v2-fixture';
import {LocalArticleManifestStore} from '../../src/sync/local-manifest';
import {isImportedContentUrl} from '../../src/core/imported-content';

test('reading preparation classifies channels once per page while preserving legacy LIKE rules',async()=>{
 const f=await fixture(),reference=new Database(':memory:');
 try{
  const urls=['watchrss://phone-imports','https://watchrss.local/import-content/one','prefix:https://watchrss.local/import-epub/two','HTTPS://WATCHRSS.LOCAL/import-txt-novel/case','https://rss.invalid/feed'];
  for(const url of urls){await f.db.execute('INSERT INTO channels(url,title,created_at) VALUES(?,?,1)',[url,'fixture']);const channel=(await f.db.query('SELECT id FROM channels WHERE url=?',[url]))[0]!.id;
   for(let i=0;i<100;i++)await f.db.execute('INSERT INTO articles(channel_id,title,link,dedup_key,fetched_at) VALUES(?,?,?,?,1)',[channel,'fixture',url+'/'+i,url+'/'+i]);
  }
  const oldQuery=`SELECT a.id,c.url AS channel_url FROM articles a JOIN channels c ON c.id=a.channel_id WHERE c.url LIKE '%watchrss://phone-imports%' OR c.url LIKE '%https://watchrss.local/import-content%' OR c.url LIKE '%https://watchrss.local/import-epub%' OR c.url LIKE '%https://watchrss.local/import-txt-novel%' ORDER BY a.id`;
  const old=await f.db.query(oldQuery);
  const expected=old.filter(row=>isImportedContentUrl(String(row.channel_url))).map(row=>Number(row.id));
  let likes=0;const builtin=reference.query('SELECT ? LIKE ? AS matched');
  // Bun 1.4 provides SQLite functions; this repository pins older type declarations.
  const functions=f.sql as unknown as {function(name:string,options:{deterministic:boolean},callback:(pattern:string,value:string)=>number):void};
  functions.function('like',{deterministic:true},(pattern:string,value:string)=>{likes++;return Number((builtin.get(value,pattern) as any).matched);});
  const migrated:number[]=[];const local=new LocalArticleManifestStore(f.db,f.codec,f.ports.text,f.ports.files,async()=>{},async ids=>{migrated.push(...ids);});
  await local.prepareReadingForSnapshot();expect(migrated).toEqual(expected);expect(likes).toBeGreaterThan(0);expect(likes).toBeLessThan(128);const optimized=likes;likes=0;await f.db.query(oldQuery);expect(likes).toBeGreaterThan(optimized*10);console.info('CHANNEL_MATCH_COUNTS',JSON.stringify({articles:500,channels:5,original:likes,optimized}));
 }finally{f.sql.close();reference.close();}
});
