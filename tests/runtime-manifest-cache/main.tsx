import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {db,getLibrarySyncRepository} from '../../src/services.ts';
import {hostArticleBodyCodec,hostSyncText} from '../../src/sync/article-body-host.ts';
import {stableArticleId} from '../../src/sync/local-manifest.ts';

const resultKey='manifest-cache-result',count=100,source='https://watchrss.local/import-txt-novel/cache-fixture';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 const existing=Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
 check(existing===0,'Unexpected cache fixture state');
 const now=Date.now();
 await db.execute('INSERT INTO channels(url,title,created_at,sort_order) VALUES(?,?,?,?)',[source,'Cache fixture',now,now]);
 const channel=Number((await db.query('SELECT id FROM channels WHERE url=?',[source]))[0]?.id);
 check(channel>0,'Missing fixture channel');
 const body='第一章正文'+'字'.repeat(3000),links:string[]=[];
 for(let start=1;start<=count;start+=50){
  const statements=[];
  for(let index=start;index<Math.min(start+50,count+1);index++){
   const link=`${source}/chapter/${String(index).padStart(4,'0')}`;links.push(link);
   statements.push({sql:'INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)',params:[channel,`第${index}章`,body,link,link,now-index]});
  }
  await db.transaction(statements);
 }
 let encodes=0;
 const encode=hostArticleBodyCodec.encode.bind(hostArticleBodyCodec);
 hostArticleBodyCodec.encode=async article=>{encodes++;return encode(article);};
 const firstStart=Date.now(),first=(await repository.prepareWindow('cache-fixture-peer',0)).fullArticleManifest,firstMs=Date.now()-firstStart;
 check(first.length===count&&first.every(article=>article.bodyAvailable),'First manifest incomplete');
 const firstEncodes=encodes,firstById=new Map(first.map(article=>[article.articleId,article]));
 const nativeHashRows=[];
 for(const link of links){
  const id=await stableArticleId(link,hostSyncText.parseUri,hostArticleBodyCodec),bodyHash=firstById.get(id)?.bodyHash;
  check(bodyHash,'Missing first body hash');
  nativeHashRows.push({sql:'INSERT INTO article_native_sync_hash(item_id,body_hash) SELECT id,? FROM articles WHERE link=?',params:[bodyHash,link]});
 }
 await db.transaction(nativeHashRows);
 await repository.deviceId();
 const secondStart=Date.now(),second=(await repository.prepareWindow('cache-fixture-peer',0)).fullArticleManifest,secondMs=Date.now()-secondStart;
 const secondEncodes=encodes-firstEncodes;
 check(second.length===count&&second.every(article=>article.bodyAvailable),'Second manifest incomplete');
 check(secondEncodes===count,'Second manifest did not encode each uncached chapter exactly once');
 const bodyCaches=Number((await db.query('SELECT count(*) n FROM article_sync_content'))[0]?.n);
 const localCaches=Number((await db.query('SELECT count(*) n FROM article_sync_encoding_cache'))[0]?.n);
 check(bodyCaches===count&&localCaches===count,'Body cache was not published');
 await repository.deviceId();
 const thirdStart=Date.now(),third=(await repository.prepareWindow('cache-fixture-peer',0)).fullArticleManifest,thirdMs=Date.now()-thirdStart;
 const thirdEncodes=encodes-firstEncodes-secondEncodes;
 check(thirdEncodes===0,'Cached manifest recompressed a chapter');
 check(JSON.stringify(third)===JSON.stringify(second),'Cached manifest changed metadata or order');
 kv.set(resultKey,{state:'passed',articles:count,firstMs,secondMs,thirdMs,firstEncodes,secondEncodes,thirdEncodes,bodyCaches,localCaches});
}
mount(()=><Text>Manifest cache fixture</Text>);
void run().catch(error=>kv.set(resultKey,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
