import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams} from '@podjs/framework/services';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {stableArticleId} from '../../src/sync/local-manifest.ts';
import {hostArticleBodyCodec,hostSyncText} from '../../src/sync/article-body-host.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';

const key='normal-phone-peer-result',url='https://watchrss.local/import-content/txt/normal-phone-fixture';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture article rows must be empty');
 const articleId=await stableArticleId(url,hostSyncText.parseUri,hostArticleBodyCodec);
 await db.transaction([
  {sql:"INSERT INTO channels(url,title,created_at,sort_order) VALUES('watchrss://phone-imports','Imported',100,-100)"},
  {sql:'INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_read,reading_progress) SELECT id,?,?,?,?,?,?,?,? FROM channels WHERE url=?',params:['Watch fixture article','Fixture excerpt','Watch source body 😀',url,articleId,100,1,0.25,'watchrss://phone-imports']},
  {sql:"INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) SELECT id,'favorite',1,100,-100 FROM articles WHERE dedup_key=?",params:[articleId]},
  {sql:"INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) SELECT id,'watchLater',1,100,-100 FROM articles WHERE dedup_key=?",params:[articleId]},
  {sql:'UPDATE articles SET is_saved=1 WHERE dedup_key=?',params:[articleId]},
 ]);
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 try{
  const results=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening',watchId:'fixture',articleId})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Normal phone library action did not apply');
  const articles=Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
  check(articles===1,'Phone source replacement changed fixture article rows');
  kv.set(key,{state:'passed',articleId,watchArticles:articles,libraryApplied:true,actions:results.length});
 }finally{listener.stop();}
}
mount(()=><Text>Normal phone sync verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
