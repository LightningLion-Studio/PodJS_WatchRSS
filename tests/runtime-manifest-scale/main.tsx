import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {db,getLibrarySyncRepository} from '../../src/services.ts';
import {hostArticleBodyCodec} from '../../src/sync/article-body-host.ts';

const key='manifest-scale-result',count=5378;
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 const previous=(await db.query('SELECT count(*) n FROM articles'))[0];
 check(Number(previous?.n)===0||Number(previous?.n)===count,'Unexpected scale fixture article count');
 const now=Date.now(),source='https://watchrss.local/import-txt-novel/scale-fixture';
 if(Number(previous?.n)===0){
  await db.execute('INSERT INTO channels(url,title,created_at,sort_order) VALUES(?,?,?,?)',[source,'Scale fixture',now,now]);
  const channel=(await db.query('SELECT id FROM channels WHERE url=?',[source]))[0];check(channel,'Scale channel missing');
  const body='第一章正文'+'字'.repeat(3000);
  kv.set(key,{state:'running',stage:'seeding',articles:0});
  for(let start=1;start<=count;start+=50){
   const statements=[];
   for(let index=start;index<Math.min(start+50,count+1);index++){
    const url=`${source}/chapter/${String(index).padStart(4,'0')}`;
    statements.push({sql:'INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,?,?,?,?,?)',params:[Number(channel.id),`第${index}章`,body,url,url,now-index]});
   }
   await db.transaction(statements);
   if(start%500===1)kv.set(key,{state:'running',stage:'seeding',articles:Math.min(start+49,count)});
  }
 }
 // Keep this isolated fixture's migration workload cold on every run.
 await db.execute('DELETE FROM article_reading_state');
 let queries=0,encodes=0,hashes=0;
 const query=db.query.bind(db),encode=hostArticleBodyCodec.encode.bind(hostArticleBodyCodec),sha256=hostArticleBodyCodec.sha256.bind(hostArticleBodyCodec);
 db.query=async(sql,params)=>{queries++;return query(sql,params);};
 hostArticleBodyCodec.encode=async body=>{const result=await encode(body);encodes++;if(encodes%100===0)kv.set(key,{state:'running',stage:'snapshot',articles:count,started,queries,encodes,hashes});return result;};
 hostArticleBodyCodec.sha256=async bytes=>{const result=await sha256(bytes);hashes++;return result;};
 const started=Date.now();kv.set(key,{state:'running',stage:'snapshot',articles:count,started,queries,encodes,hashes});
 const window=await repository.prepareWindow('scale-fixture-peer',0);
 const articles=window.fullArticleManifest;
 check(articles.length===count,'Scale manifest article count mismatch');
 check(articles.every(item=>item.bodyAvailable&&item.bodySyncMode==='full'),'Scale manifest lost full local content');
 kv.set(key,{state:'passed',articles:articles.length,elapsedMs:Date.now()-started,bodyBytes:articles.reduce((sum,item)=>sum+item.bodyByteCount,0),sources:window.rssSources.length,queries,encodes,hashes});
}
mount(()=><Text>Manifest scale fixture</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
