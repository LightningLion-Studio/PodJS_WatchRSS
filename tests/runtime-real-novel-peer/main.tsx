import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams} from '@podjs/framework/services';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';

const key='real-novel-peer-result',expected=5378;
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository(),watchId=await repository.deviceId();
 const before=Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
 check(before===expected,'Isolated real novel library count mismatch');
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 const started=Date.now();
 try{
  const results=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening',watchId,articles:before,started})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Full library action did not complete');
  const articles=Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
  const caches=Number((await db.query('SELECT count(*) n FROM article_sync_content'))[0]?.n);
  check(articles===expected&&caches===expected,'Watch fixture library or cache changed');
  kv.set(key,{state:'passed',watchId,articles,caches,actions:results.length,elapsedMs:Date.now()-started});
 }finally{listener.stop();}
}
mount(()=><Text>Real novel sync verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
