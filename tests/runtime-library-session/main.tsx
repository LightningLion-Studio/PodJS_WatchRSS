import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {sqlite} from '@podjs/framework/services';
import type {SqlDatabase} from '../../src/core/types.ts';
import {initializeSchema} from '../../src/core/schema.ts';
import {hostArticleBodyCodec as codec,hostSyncText as text} from '../../src/sync/article-body-host.ts';
import {fixture as aliasCases,seedAliasCase,clearAliasFixture,aliasArticle,aliasBody,aliasOutcome} from '../helpers/alias-receive-fixture.ts';
import {fixture as sessions,replaySessionFixture,normalizeSessionResponse,sessionFixtureParts} from '../helpers/library-session-fixture.ts';
import {fixture as wireCases,wireFixtureParts} from '../helpers/library-wire-fixture.ts';
import {buildChunkedResponseFrames} from '../../src/sync/library-wire.ts';
import {LocalArticleManifestStore} from '../../src/sync/local-manifest.ts';
import {SyncArticleReceiver} from '../../src/sync/article-receiver.ts';
import {SqlLibrarySequenceStore} from '../../src/sync/sequence-store.ts';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session.ts';
import {StreamFrameConnection} from '../../src/sync/stream.ts';
import {prepareArticle,bodyForRequest} from '../../src/sync/article-export.ts';
import {FrameDecoder,encodeFrame,encodeChunkData,type JsonObject} from '../../src/sync/protocol.ts';
import {parseBodyRequests,parseChunkedArticleFrames} from '../../src/sync/article-batches.ts';
import {rebuildArticleBody} from '../../src/sync/article-body.ts';
const db:SqlDatabase={query:(q,p)=>sqlite.query(q,p as any),execute:(q,p)=>sqlite.execute(q,p as any),transaction:s=>sqlite.transaction(s as any),transactionChanges:s=>sqlite.transactionChanges(s as any)};
const files={storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v};
const local=new LocalArticleManifestStore(db,codec,text,files,async()=>{}),receiver=new SyncArticleReceiver(db,codec,files,async()=>{},()=>999,a=>local.resolveIncomingBody(a)),sequence=new SqlLibrarySequenceStore(db);
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as JsonObject)[k])).join(',')+'}';return JSON.stringify(v);}
const phase=(name:string)=>kv.set('library-session-result',{state:'running',phase:name});
async function clear(){await clearAliasFixture(db);await db.transaction([{sql:'DELETE FROM sync_peer_state'},{sql:'DELETE FROM sync_change_log'},{sql:"DELETE FROM sqlite_sequence WHERE name='sync_change_log'"}]);}
async function exchange(variant:'applied'|'receivedOnly'|'rollback'|'truncated'){
 await clear();const row=aliasCases.cases[0]!;await seedAliasCase(db,row);const before=await aliasOutcome(db);
 if(variant==='rollback')await db.execute("CREATE TRIGGER fail_session_saved BEFORE INSERT ON article_saved_entry_times BEGIN SELECT RAISE(ABORT,'injected session rollback'); END");
 const remote=await prepareArticle({...aliasArticle(row),contentHtml:null,contentText:'body'},codec),incoming:Uint8Array[]=[],outgoing:JsonObject[]=[];let offset=0,closed=false,responseComplete=false,appliedQueued=false,receivedOnlyGate=false,metadataOnlySelected=false,fragments=0;
 const enqueue=(frame:JsonObject)=>incoming.push(encodeFrame(frame));
 enqueue({version:14,action:'syncLibrary',phase:'manifest',deviceId:row.input.peer,supportsChunkedBodies:true,supportsArticleBatches:true,supportsManifestBatches:true,supportsMetadataOnlyArticles:true,supportsChangeSequences:true,fullSnapshot:true,changeSeqRange:{fromExclusive:0,toInclusive:42},articleManifest:[remote.manifest],rssSources:[]});
 const decoder=new FrameDecoder();
 const transport={read:async(max:number)=>{
  if(!incoming.length){
   if(responseComplete&&!appliedQueued&&variant==='applied'){check((await db.query('SELECT * FROM sync_peer_state')).length===0,'Received ACK prematurely advanced cursor');receivedOnlyGate=true;appliedQueued=true;enqueue({action:'ack',success:true,phase:'applied',applied:true});}
   else return null;
  }
  const first=incoming[0]!,count=Math.min(max,17,first.length-offset),bytes=first.slice(offset,offset+count);offset+=count;fragments++;if(offset===first.length){incoming.shift();offset=0;}return bytes;
 },write:async(bytes:Uint8Array)=>{
  for(const frame of decoder.push(bytes)){
   outgoing.push(frame);
   if(frame.phase==='manifest'){
    const selected=parseBodyRequests(frame);check(selected.length===1&&selected[0]!.metadataOnly,'Ordinary RSS body was not reused');metadataOnlySelected=true;
    const body=bodyForRequest(remote,selected[0]!),article=remote.article;
    enqueue({version:14,action:'syncLibrary',phase:'articles',...(variant==='truncated'?{batchIndex:0,batchCount:2}:{}),articles:[{...article,contentHtml:undefined,contentText:undefined,body:{bodyHash:body.bodyHash,bodyByteCount:body.bodyByteCount,chunkSize:body.chunkSize,chunkHashes:body.chunkHashes,metadataOnly:body.metadataOnly,chunks:body.chunks.map(c=>({index:c.index,hash:c.hash,data:encodeChunkData(c.bytes)}))}}],bodyRequests:[{articleId:article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}]});
   }
   if(frame.phase==='complete'&&Number(frame.batchIndex??0)===Number(frame.batchCount??1)-1){check((await db.query('SELECT * FROM sync_peer_state')).length===0,'Response write prematurely advanced cursor');responseComplete=true;enqueue({action:'ack',success:true,phase:'received',applied:false});}
  }
 },close:async()=>{closed=true;}};
 const repo:LibrarySessionRepository={deviceId:async()=>String((await db.query('SELECT device_id FROM sync_local_identity'))[0]!.device_id),cursor:p=>sequence.cursor(p),mergeSources:async sources=>{check(sources.length===0,'Unexpected source fixture');return 0;},prepareWindow:async(peer,acked)=>sequence.prepareWindow(peer,'local',(await local.snapshot()).map(p=>p.manifest),async()=>[],acked),exportSources:async()=>[],receiveArticle:(entry,peer,authoritative)=>receiver.receiveWithStats(entry.article,entry.body,peer,authoritative),exportRequested:async requests=>{const ids=new Set(requests.map(r=>r.articleId));return (await local.snapshot()).filter(p=>ids.has(p.article.articleId)&&p.manifest.bodyAvailable);},finalizeSnapshot:async()=>{throw new Error('Unexpected replacement fixture');},resetPeerState:()=>sequence.reset(),markSuccess:p=>sequence.markSuccess(p)};
 try{
  const result=await new LibrarySyncSession(new StreamFrameConnection(transport),repo).run();decoder.finish();check(closed&&metadataOnlySelected,'Session connection not closed');
  const peer=(await db.query('SELECT * FROM sync_peer_state'))[0];
  if(variant==='rollback'||variant==='truncated'){check(!peer&&!result[0]!.libraryApplied&&result[0]!.response.fatalSession===true,'Failed exchange advanced cursor');check(canonical(await aliasOutcome(db))===canonical(before),'Failed exchange changed article data');}
  else{
   check(canonical(await aliasOutcome(db))===canonical({items:row.items,entries:row.entries,states:row.states}),'Session SQL differs from native alias receive');
   const frames=outgoing.filter(f=>f.phase==='complete');check((frames[0]!.stats as JsonObject).applied===row.applied,'Applied count differs from native');const received=parseChunkedArticleFrames(frames);check(received.length===1,'Missing outgoing article');const body=await rebuildArticleBody(received[0]!.body,null,codec);check(body.contentText==='body','Outgoing body did not rebuild');
   if(variant==='applied')check(peer?.last_remote_seq_applied===42&&result[0]!.libraryApplied&&receivedOnlyGate,'Applied ACK did not advance durable cursor');
   else check(!peer&&!result[0]!.libraryApplied,'Received-only ACK advanced durable cursor');
  }
  return fragments;
 }finally{if(variant==='rollback')await db.execute('DROP TRIGGER fail_session_saved');}
}
async function run(){const started=Date.now();await initializeSchema(db);
 try{
  for(const row of sessions.cases){phase('native-session:'+row.input.name);await clear();const parts=sessionFixtureParts(row);
   const actual=await replaySessionFixture(row,repo=>{repo.cursor=p=>sequence.cursor(p);repo.prepareWindow=(peer,acked)=>sequence.prepareWindow(peer,row.deviceId,parts.window.fullArticleManifest,async()=>parts.window.rssSources,acked);repo.markSuccess=p=>sequence.markSuccess(p);});
   check(canonical(normalizeSessionResponse(actual.outbound))===canonical(normalizeSessionResponse(row.outbound)),'Native session frames differ: '+row.input.name);
   const p=(await db.query('SELECT * FROM sync_peer_state'))[0],peer=p?{localSeq:p.last_local_seq_acked,remoteSeq:p.last_remote_seq_applied,protocol:p.last_protocol_version,fullSync:Number(p.last_full_sync_at)>0}:null;
   check(canonical(peer)===canonical(row.peer),'Native durable peer outcome differs: '+row.input.name);
  }
  for(const row of wireCases.cases){phase('native-outgoing:'+row.input.name);const {prepared,requests}=wireFixtureParts(row);let ok=true,frames:JsonObject[]=[];
   if(row.input.name==='large-full')for(const p of prepared){const bytes=await codec.encode(p.article);check(encodeChunkData(bytes)===encodeChunkData(p.encodedBody!),'Host body encoding differs from native large outgoing corpus');}
   try{frames=buildChunkedResponseFrames('watch',prepared,requests,3,2,row.input.batches,()=>1789340000000);}catch{ok=false;}
   check(ok===row.ok,'Native outgoing acceptance differs: '+row.input.name);if(ok)check(canonical(normalizeSessionResponse(frames))===canonical(normalizeSessionResponse(row.frames)),'Native outgoing frames differ: '+row.input.name);
  }
  for(const row of aliasCases.cases){phase('native-counted-receive:'+row.input.name);await clear();await seedAliasCase(db,row);let ok=true,applied:number|undefined;try{applied=await receiver.receiveWithStats(aliasArticle(row),aliasBody(row),row.input.peer,row.input.authoritative);}catch{ok=false;}check(ok===row.ok,'Counted native acceptance differs: '+row.input.name);if(ok)check(applied===row.applied,'Counted native applied state count differs: '+row.input.name);check(canonical(await aliasOutcome(db))===canonical({items:row.items,entries:row.entries,states:row.states}),'Counted native SQL differs: '+row.input.name);}
  let fragments=0;for(const variant of ['applied','receivedOnly','rollback','truncated'] as const){phase('full-exchange:'+variant);fragments+=await exchange(variant);}
  kv.set('library-session-result',{state:'passed',nativeSessions:sessions.cases.length,nativeOutgoingCases:wireCases.cases.length,nativeCountedReceives:aliasCases.cases.length,largeHostBodyMatches:true,fragmentedBidirectionalExchange:true,receivedAckGate:true,appliedAckPersisted:true,receiveRollback:true,truncatedTransferGate:true,fragments,elapsedMs:Date.now()-started});
 }finally{await clear();}
}
mount(()=><Text>Library session verification</Text>);
void run().catch(e=>kv.set('library-session-result',{state:'failed',error:String(e),stack:e instanceof Error?e.stack:''}));
