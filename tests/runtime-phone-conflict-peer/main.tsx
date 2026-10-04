import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams,fileChunks} from '@podjs/framework/services';
import {getLibrarySyncRepository,db,memoRepository} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {ReaderSyncActions} from '../../src/sync/reader-actions.ts';
import {ReaderPresetStore} from '../../src/reader/preset-store.ts';
import {ReaderResources} from '../../src/sync/reader-resources.ts';
import {hostReaderResourceFiles} from '../../src/sync/reader-resources-host.ts';
import {NoteAssetReceiver} from '../../src/sync/note-assets.ts';

const key='phone-conflict-peer-result';
const articleId='9cfe65c6cc9c21ecc63e0b09f39c3965c851f9eea5ae22adcf14f7bab94ee377';
const url='https://example.com/merge-conflict';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 const deviceId=await repository.deviceId();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture must start empty');
 await db.transaction([
  {sql:"INSERT INTO channels(url,title,created_at,sort_order) VALUES('watchrss://phone-imports','Imported',100,-100)"},
  {sql:'INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_read,reading_progress) SELECT id,?,?,?,?,?,?,?,? FROM channels WHERE url=?',params:['Watch old title','Old excerpt','Watch older body',url,articleId,100,0,0,'watchrss://phone-imports']},
  {sql:"INSERT INTO article_saved_states(article_id,save_type,saved,changed_at,sort_order) SELECT id,'favorite',1,300,300 FROM articles WHERE dedup_key=?",params:[articleId]},
 ]);
 await memoRepository.initialize();
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 try{
  const handleAction=createApplicationActionHandler({
   notes:memoRepository,deviceId:()=>repository.deviceId(),notesChanged:()=>{},
   readerSync:new ReaderSyncActions(new ReaderPresetStore(),new ReaderResources(hostReaderResourceFiles),()=>{}),
   noteAssets:new NoteAssetReceiver(fileChunks),
  });
  const results=await listener.start({handleAction,onListening:()=>kv.set(key,{state:'running',deviceId})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Merge did not apply');
  check(results.every(result=>result.response.success===true),'A follow-up action failed');
  const rows=await db.query('SELECT id,title,content,link FROM articles');
  check(rows.length===1&&rows[0]?.link===url,'Same URL became duplicate articles');
  check(rows[0]?.content==='Phone newer body 😀','Newer phone body did not win');
  const saves=await db.query('SELECT save_type,saved,changed_at FROM article_saved_states WHERE article_id=?',[rows[0]?.id]);
  check(saves.some(row=>row.save_type==='favorite'&&Number(row.saved)===1),'Newer watch favorite did not survive');
  check(saves.some(row=>row.save_type==='watchLater'&&Number(row.saved)===1),'Phone watch-later state was lost');
  kv.set(key,{state:'passed',watchArticles:rows.length,body:rows[0]?.content,saves,actions:results.length});
 }finally{listener.stop();}
}
mount(()=><Text>Phone/watch conflict verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
