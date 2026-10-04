import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams} from '@podjs/framework/services';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';

const key='phone-to-watch-peer-result';
const sourceId='stale-watch-article';
const targetId='phone-source-article';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture must start empty');
 await db.transaction([
  {sql:"INSERT INTO channels(url,title,created_at,sort_order) VALUES('watchrss://phone-imports','Imported',100,-100)"},
  {sql:'INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_read,reading_progress) SELECT id,?,?,?,?,?,?,?,? FROM channels WHERE url=?',params:['Stale watch article','Old article','Must be removed','https://example.com/stale-watch-article',sourceId,100,0,0,'watchrss://phone-imports']},
 ]);
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 try{
  const results=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening',watchId:'fixture',staleArticleId:sourceId,targetArticleId:targetId})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Phone replacement did not apply');
  const rows=await db.query('SELECT dedup_key,content FROM articles');
  check(rows.length===1,'Phone replacement did not leave exactly one article');
  check(rows[0]?.dedup_key===targetId,'Stale article survived or phone article missing');
  check(rows[0]?.content==='Phone source body 😀','Phone article body mismatch');
  const saves=await db.query('SELECT save_type,saved FROM article_saved_states WHERE article_id=(SELECT id FROM articles WHERE dedup_key=?)',[targetId]);
  check(saves.some(row=>row.save_type==='favorite'&&Number(row.saved)===1),'Favorite was lost');
  check(saves.some(row=>row.save_type==='watchLater'&&Number(row.saved)===1),'Watch later was lost');
  kv.set(key,{state:'passed',watchArticles:rows.length,articleId:targetId,body:rows[0]?.content,states:saves,actions:results.length});
 }finally{listener.stop();}
}
mount(()=><Text>Phone to watch sync verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
