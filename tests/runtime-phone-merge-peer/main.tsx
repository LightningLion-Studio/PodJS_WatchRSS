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

const key='phone-merge-peer-result';
const sourceId='merge-watch-article';
const targetId='merge-phone-article';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture must start empty');
 await db.transaction([
  {sql:"INSERT INTO channels(url,title,created_at,sort_order) VALUES('watchrss://phone-imports','Imported',100,-100)"},
  {sql:'INSERT INTO articles(channel_id,title,description,content,link,dedup_key,fetched_at,is_read,reading_progress) SELECT id,?,?,?,?,?,?,?,? FROM channels WHERE url=?',params:['Watch merge article','Watch article','Watch merge body 😀','https://example.com/merge-watch-article',sourceId,100,0,0,'watchrss://phone-imports']},
 ]);
 await memoRepository.initialize();
 await memoRepository.save({title:'Watch fixture note',markdown:'# Watch note\nWatch body 😀'});
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 try{
  const handleAction=createApplicationActionHandler({
   notes:memoRepository,deviceId:()=>repository.deviceId(),notesChanged:()=>{},
   readerSync:new ReaderSyncActions(new ReaderPresetStore(),new ReaderResources(hostReaderResourceFiles),()=>{}),
   noteAssets:new NoteAssetReceiver(fileChunks),
  });
  const results=await listener.start({handleAction,onListening:()=>kv.set(key,{state:'running',phase:'listening',watchId:'fixture',staleArticleId:sourceId,targetArticleId:targetId})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Merge did not apply');
  check(results.some(result=>result.request.action==='syncNotes'&&result.response.success===true),'Notes follow-up did not complete');
  check(results.every(result=>result.response.success===true),'A follow-up action failed');
  const rows=await db.query('SELECT dedup_key,content FROM articles');
  check(rows.length===2,'Merge must retain both articles');
  check(rows.some(row=>row.dedup_key===sourceId&&row.content==='Watch merge body 😀'),'Watch article was lost');
  check(rows.some(row=>row.dedup_key===targetId&&row.content==='Phone merge body 😀'),'Phone article body mismatch');
  const saves=await db.query('SELECT save_type,saved FROM article_saved_states WHERE article_id=(SELECT id FROM articles WHERE dedup_key=?)',[targetId]);
  check(saves.some(row=>row.save_type==='favorite'&&Number(row.saved)===1),'Favorite was lost');
  check(saves.some(row=>row.save_type==='watchLater'&&Number(row.saved)===1),'Watch later was lost');
  const notes=await memoRepository.allIncludingDeleted();
  check(notes.length===2,'Note sync did not leave both notes');
  check(notes.some(note=>note.title==='Watch fixture note'&&note.markdown==='# Watch note\nWatch body 😀'),'Watch note was lost');
  check(notes.some(note=>note.title==='Phone fixture note'&&note.markdown==='# Phone note\nPhone body 😀'),'Phone note was not received');
  kv.set(key,{state:'passed',watchArticles:rows.length,articleId:targetId,body:rows.find(row=>row.dedup_key===targetId)?.content,states:saves,actions:results.length,watchNotes:notes.length});
 }finally{listener.stop();}
}
mount(()=><Text>Phone/watch merge verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
