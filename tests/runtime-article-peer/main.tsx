import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams} from '@podjs/framework/services';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {hostArticleBodyCodec} from '../../src/sync/article-body-host.ts';
import {hashJavaText} from '../../src/sync/article-export.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
const key='article-peer-result',uuid='8c7535e3-b05d-42fd-b5e3-1f747e864d1b',peer='article-peer-phone';
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
async function run(){
 const repository=await getLibrarySyncRepository();check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture articles must be empty');check(Number((await db.query('SELECT count(*) n FROM channels'))[0]?.n)===0,'Fixture channels must be empty');check((await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id=?',[peer])).length===0,'Owned peer already exists');
 let gate:Promise<unknown>|undefined;let proof:Record<string,unknown>={};const listener=new RfcommLibraryListener(repository,{radio:{...rfcomm,listen:()=>rfcomm.listen('Paired Article Verification',uuid)},streams:byteStreams});
 try{
  const results=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening',uuid}),onStatus:s=>{if(s.phase==='ack')gate=db.query('SELECT * FROM sync_peer_state WHERE peer_device_id=?',[peer]).then(rows=>{check(rows.length===0,'Cursor advanced before applied ACK');});}});
  await gate;check(!!gate,'ACK gate not observed');check(results.length===1&&results[0]?.libraryApplied&&results[0].ack?.applied,'Applied exchange missing');const cursor=await repository.cursor(peer);check(cursor.lastRemoteSeqApplied===11,'Durable remote sequence');
  const exported=await repository.exportRequested([{articleId:'c83023f8b742978ea92293dc638bc9493b6a2acd45c521bdf8dc650996516da6',bodyHash:'',chunkIndexes:[],metadataOnly:false}]);check(exported.length===1,'Durable export missing');const a=exported[0]!.article;check(a.independentSaved&&a.favoriteSaved&&a.watchLaterSaved,'Saved state missing');check(a.readingProgress===.25&&a.readingPositionBytes===17,'Reader position missing');
  proof={watchId:await repository.deviceId(),contentSha256:await hashJavaText(a.contentText,hostArticleBodyCodec),storedContentHash:a.contentHash,savedFlags:true,cursorBeforeApplied:0,cursorAfterApplied:cursor.lastRemoteSeqApplied,ownedArticleExported:true};
 }finally{listener.stop();const rows=await db.query('SELECT dedup_key FROM articles');check(rows.every(r=>r.dedup_key==='c83023f8b742978ea92293dc638bc9493b6a2acd45c521bdf8dc650996516da6'),'Unexpected fixture article; refuse cleanup');await repository.finalizeSnapshot([],[]);}
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Owned article cleanup');kv.set(key,{state:'passed',...proof,ownedDataRemoved:true,visualAcceptance:false});
}
mount(()=><Text>Paired article synchronization verification</Text>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
