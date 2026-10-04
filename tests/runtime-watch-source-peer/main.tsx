import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams} from '@podjs/framework/services';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';

const key='watch-source-peer-result';
const uuid='a98a29ad-5cde-43f5-a049-e80b3e7bb801';
const peer='watch-source-phone-fixture';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture article rows must be empty');
 check((await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id=?',[peer])).length===0,'Fixture peer already exists');
 const initialChannels=Number((await db.query('SELECT count(*) n FROM channels'))[0]?.n);
 const listener=new RfcommLibraryListener(repository,{radio:{...rfcomm,listen:()=>rfcomm.listen('Watch Source Verification',uuid)},streams:byteStreams});
 let receivedArticles=-1;
 try{
  const result=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening',uuid}),onStatus:status=>{if(status.phase==='sending')receivedArticles=status.receivedArticles??-1;}});
  check(result.length===1&&result[0]?.libraryApplied&&result[0].ack?.applied,'Source-mode ACK was not applied');
  check(receivedArticles===1,'Source mode did not count the incoming article');
  const articles=Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
  const channels=Number((await db.query('SELECT count(*) n FROM channels'))[0]?.n);
  const peers=await db.query('SELECT peer_device_id,last_local_seq_acked,last_remote_seq_applied FROM sync_peer_state WHERE peer_device_id=?',[peer]);
  check(articles===0&&channels===initialChannels,'Incoming phone article changed the watch library');
  check(peers.length===1&&Number(peers[0]!.last_local_seq_acked)===0&&Number(peers[0]!.last_remote_seq_applied)===0,'Source-mode peer cursor differs from native');
  kv.set(key,{state:'passed',incomingArticles:receivedArticles,watchArticles:articles,watchChannels:channels,peerLocalSeq:0,peerRemoteSeq:0,appliedAck:true});
 }finally{listener.stop();}
}
mount(()=><Text>Watch source synchronization verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
