import {SCALE_LOOPBACK_FULL,SCALE_LOOPBACK_ARTICLES,SCALE_LOOPBACK_INTERRUPT_AT,SCALE_LOOPBACK_BULK_ACK_MS,SCALE_LOOPBACK_TEST_MS} from './scale-loopback-budget';
import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import type {Socket} from 'node:net';
import {pairedLoopback} from './paired-loopback';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {initializeSchema} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository.ts';
import {SyncSavedStateStore} from '../../src/sync/saved-state.ts';
import {StreamFrameConnection} from '../../src/sync/stream.ts';
import {FrameLengthError} from '@podjs/framework/frame-stream';
import {LibrarySyncSession} from '../../src/sync/session.ts';
import {ArticleBatchReceiver,parseBodyRequests} from '../../src/sync/article-batches.ts';
import {parseArticleManifest,selectArticleBodyRequests} from '../../src/sync/manifest.ts';
import {buildManifestFrames,combineManifestFrames,manifestBatchCount,buildChunkedResponseFrames,parseCursor} from '../../src/sync/library-wire.ts';
import {LIBRARY_CHECKPOINT_FEATURE as feature,libraryBatchAck,requireLibraryBatchAck,wantsLibraryCheckpoint} from '../../src/sync/checkpoints.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body.ts';
import type {JsonObject} from '../../src/sync/protocol.ts';
const codec:SyncBodyCodec={encode:async body=>gzipSync(encodeBodyJson(body)),decode:async bytes=>gunzipSync(bytes).toString(),sha256:async bytes=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex')};
async function fixture(path:string,id:string){
 const sql=new Database(path);sql.exec('PRAGMA foreign_keys=ON');let queries=0;
 const db:SqlDatabase={query:async(q,p=[])=>{queries++;return sql.query(q).all(...p as any[]) as any;},execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async statements=>{sql.transaction(()=>{for(const s of statements)sql.query(s.sql).run(...(s.params??[]) as any[]);})();},transactionChanges:async statements=>sql.transaction(()=>statements.map(s=>{sql.query(s.sql).run(...(s.params??[]) as any[]);return Number((sql.query('SELECT changes() n').get() as any).n);} ))()};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice(id);
 const text={parseUri:async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async(value:string)=>value};
 const repo=new SqlLibrarySessionRepository(db,{codec,text,uri:{parseUri:text.parseUri,parseAndroid:text.parseUri},files:{storeText:async(_k,v)=>v,hydrate:async v=>v},migrateReading:async()=>{},migrateReadingMany:async()=>{},cleanupRemovedContent:async()=>{}});
 return {sql,db,repo,queries:()=>queries,count:()=>Number((sql.query('SELECT count(*) n FROM articles').get() as any).n)};
}
// Match the native TCP transport: framing writes its short length prefix separately.
function connection(socket:Socket){ socket.setNoDelay(true);const endpoints={localPort:socket.localPort,remotePort:socket.remotePort};
 const chunks:Uint8Array[]=[];let ended=false,notify:(()=>void)|undefined,total=0,readBytes=0,readCalls=0,activeReads=0,maxActiveReads=0;
 socket.on('data',(b:Buffer)=>{chunks.push(new Uint8Array(b));notify?.();});socket.on('end',()=>{ended=true;notify?.();});socket.on('close',()=>{ended=true;notify?.();});socket.on('error',()=>{ended=true;notify?.();});socket.resume();
 const conn=new StreamFrameConnection({read:async(max,timeout)=>{readCalls++;activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);try{while(!chunks.length&&!ended){await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{notify=undefined;reject(new Error('loopback read timed out'));},timeout);notify=()=>{clearTimeout(timer);notify=undefined;resolve();};});}const b=chunks.shift();if(!b)return null;if(b.length>max)chunks.unshift(b.subarray(max));const bytes=b.subarray(0,max);readBytes+=bytes.length;return bytes;}finally{activeReads--;}},write:async b=>{total+=b.length;await new Promise<void>((resolve,reject)=>socket.write(b,error=>error?reject(error):resolve()));},close:async()=>{socket.destroy();}});
 return {conn,bytes:()=>total,diagnostics:()=>({...endpoints,readCalls,readBytes,maxActiveReads})};
}
async function exchange(serverRepo:SqlLibrarySessionRepository,phone:Awaited<ReturnType<typeof fixture>>,options:{checkpoint:boolean;interruptAt?:number;dropFinalAck?:boolean}){
 
 const {socket,remote}=await server.pair();
 const paired=remote.remotePort===socket.localPort&&remote.localPort===socket.remotePort;
 expect(paired).toBe(true);
 const a=connection(remote),b=connection(socket);let phases:Record<string,number>={},phaseStart=performance.now(),last='request';
 const session=new LibrarySyncSession(a.conn,serverRepo,{responseAckTimeoutMs:options.checkpoint?10000:SCALE_LOOPBACK_BULK_ACK_MS,onStatus:status=>{const now=performance.now();phases[last]=(phases[last]??0)+now-phaseStart;phaseStart=now;last=status.phase;}});
 const running=session.run();void running.catch(error=>{if(error instanceof FrameLengthError)console.error('T39_FRAME_DIAGNOSTIC '+JSON.stringify({length:error.length,maxFrameBytes:error.maxFrameBytes,paired,server:a.diagnostics(),client:b.diagnostics()}));});let requests=0,fullBodies=0,completed=0,frames=0;const started=performance.now();
 try{
  const localId=await phone.repo.deviceId(),cursor=await phone.repo.cursor('watch');
  await b.conn.writeFrame({version:14,action:'syncLibrary',phase:'cursor',deviceId:localId,syncCursor:cursor,...(options.checkpoint?{[feature]:true}:{})});
  const remoteCursor=await b.conn.readFrame(30000);const window=await phone.repo.prepareWindow('watch',parseCursor(remoteCursor).lastRemoteSeqApplied);
  const manifest:JsonObject={version:14,action:'syncLibrary',phase:'manifest',deviceId:localId,libraryMode:'merge',supportsArticleBatches:true,supportsManifestBatches:true,supportsChunkedBodies:true,supportsMetadataOnlyArticles:true,supportsChangeSequences:true,syncCursor:cursor,articleManifest:window.articleManifest,rssSources:window.rssSources,fullSnapshot:window.fullSnapshot,changeSeqRange:{fromExclusive:window.fromSeqExclusive,toInclusive:window.toSeqInclusive},...(options.checkpoint?{[feature]:true}:{})};
  for(const frame of buildManifestFrames(manifest))await b.conn.writeFrame(frame);
  const first=await b.conn.readFrame(30000),mf=[first];for(let i=1;i<manifestBatchCount(first);i++)mf.push(await b.conn.readFrame(30000));const response=combineManifestFrames(mf);
  if(response.success!==true)throw new Error(String(response.message));
  expect(response.success).toBe(true);expect(response[feature]===true).toBe(options.checkpoint);
  const selected=selectArticleBodyRequests(window.fullArticleManifest,parseArticleManifest(response),{supportsMetadataOnly:true});requests=selected.length;fullBodies=selected.filter(r=>!r.metadataOnly).length;
  const outgoing=await phone.repo.exportRequested(parseBodyRequests(response));const forward=buildChunkedResponseFrames(localId,outgoing,parseBodyRequests(response),0,0,true);
  forward.forEach((f,i)=>{f.phase='articles';if(i===0)f.bodyRequests=selected;});
  for(let i=0;i<forward.length;i++){const f=forward[i]!,checkpoint=options.checkpoint&&wantsLibraryCheckpoint(forward,i);if(options.checkpoint)f.libraryCheckpoint=checkpoint;await b.conn.writeFrame(f);if(checkpoint)requireLibraryBatchAck(await b.conn.readFrame(30000),'phoneToWatch',i);}
  const receiver=new ArticleBatchReceiver(selected,async entry=>{await phone.repo.receiveArticle(entry,'watch',false);},{flushCompleteArticles:options.checkpoint});
  let count=1;for(let i=0;i<count;i++){
   const f=await b.conn.readFrame(30000);if(f.success===false)throw Error('server exchange failed');count=Number(f.batchCount??1);frames++;
   await receiver.consume({...f,phase:'articles'});completed=receiver.committedArticles;
   if(options.checkpoint&&f.libraryCheckpoint===true){expect(receiver.checkpointReady).toBe(true);await b.conn.writeFrame(libraryBatchAck('watchToPhone',i,completed));}
   if(options.interruptAt&&completed>=options.interruptAt){await b.conn.close();await running;return {interrupted:true,completed,requests,fullBodies,frames,elapsedMs:performance.now()-started,phases,wireBytes:a.bytes()+b.bytes()};}
  }
  receiver.finish();if(!options.dropFinalAck)await b.conn.writeFrame({action:'ack',phase:'applied',success:true,applied:true});else await b.conn.close();
  const result=await running;expect(result.at(-1)?.libraryApplied).toBe(!options.dropFinalAck);
  if(!options.dropFinalAck)await phone.repo.markSuccess({remoteDeviceId:'watch',projectionGeneration:window.projectionGeneration,localSeqToInclusive:window.toSeqInclusive,remoteSeqToInclusive:Number((response.changeSeqRange as JsonObject).toInclusive),remoteProtocolVersion:14,fullSnapshot:window.fullSnapshot});
  return {interrupted:false,completed,requests,fullBodies,frames,elapsedMs:performance.now()-started,phases,wireBytes:a.bytes()+b.bytes()};
 }finally{console.log('T39 exchange progress '+JSON.stringify({options,elapsedMs:performance.now()-started,completed,requests,frames,phases,paired,server:a.diagnostics(),client:b.diagnostics()}));await b.conn.close();await a.conn.close();await running.catch(()=>{});}
}
// Each exchange uses actual localhost TCP and production framing/coordinator/SQLite repositories.
let server:Awaited<ReturnType<typeof pairedLoopback>>;
test(`${SCALE_LOOPBACK_ARTICLES} articles over TCP: legacy compatibility, durable resume, lost ACK and one-article delta`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'wrss-t39-'));server=await pairedLoopback();
 let watch=await fixture(join(root,'watch.sqlite'),'watch'),phone=await fixture(join(root,'phone.sqlite'),'phone');
 try{
  const source='https://watchrss.local/import-txt-novel/'+'39'.repeat(16),body='T39 中文🙂 complete body '.repeat(65)+(SCALE_LOOPBACK_FULL?'':Array.from({length:128},(_,i)=>new Bun.CryptoHasher('sha256').update('T-TESTSTAB body '+i).digest('hex')).join(''))+' END';
  // Diverse deterministic bytes cross real wire batch boundaries with fewer
  // SQLite fsyncs. Keep the 5500-article body exactly as before in scale mode.
  await watch.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,?,100,-100)',[source,'T39 SCALE']);
  await watch.db.transaction(Array.from({length:SCALE_LOOPBACK_ARTICLES},(_,i)=>{const url=source+'/chapter/'+String(i+1).padStart(4,'0')+'-'+(i+1).toString(16).padStart(16,'0');return {sql:'INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,?,?,?,?,?)',params:['Chapter '+i,body,url,new Bun.CryptoHasher('sha256').update(url).digest('hex'),100+i]};}));
  const partial=await exchange(watch.repo,phone,{checkpoint:true,interruptAt:SCALE_LOOPBACK_INTERRUPT_AT});expect(partial.interrupted).toBe(true);expect(phone.count()).toBeGreaterThanOrEqual(SCALE_LOOPBACK_INTERRUPT_AT);expect(phone.count()).toBeLessThan(SCALE_LOOPBACK_ARTICLES);expect(await phone.db.query('SELECT * FROM sync_peer_state')).toHaveLength(0);
  // Recreate both repositories from disk, as after a process restart / transport change.
  watch.sql.close();phone.sql.close();watch=await fixture(join(root,'watch.sqlite'),'watch');phone=await fixture(join(root,'phone.sqlite'),'phone');
  expect(partial.frames).toBeGreaterThan(0);
  const resumed=await exchange(watch.repo,phone,{checkpoint:true});expect(resumed.fullBodies).toBeLessThanOrEqual(SCALE_LOOPBACK_ARTICLES-partial.completed);expect(resumed.frames).toBeGreaterThan(1);expect(phone.count()).toBe(SCALE_LOOPBACK_ARTICLES);expect(await phone.db.query("SELECT count(*) n FROM articles WHERE content NOT LIKE '% END'" )).toEqual([{n:0}]);
  const noop=await exchange(watch.repo,phone,{checkpoint:true});expect(noop.fullBodies).toBe(0);expect(noop.requests).toBe(0);expect(noop.elapsedMs).toBeLessThan(5000);
  await watch.db.execute('UPDATE articles SET title=?,fetched_at=fetched_at+10000 WHERE id=1',['Edited once']);
  const delta=await exchange(watch.repo,phone,{checkpoint:true});expect(delta.requests).toBe(1);expect(delta.fullBodies).toBe(1);expect(delta.elapsedMs).toBeLessThan(5000);expect((await phone.db.query('SELECT title FROM articles WHERE title=?',['Edited once']))).toHaveLength(1);
  await phone.db.execute('UPDATE articles SET title=?,fetched_at=fetched_at+20000 WHERE id=(SELECT MIN(id) FROM articles)',['Phone edited once']);
  await exchange(watch.repo,phone,{checkpoint:true});expect(watch.count()).toBe(SCALE_LOOPBACK_ARTICLES);expect((await watch.db.query('SELECT id FROM articles WHERE title=?',['Phone edited once']))).toHaveLength(1);
  const oldPhone=await fixture(join(root,'old-phone.sqlite'),'legacy-phone');try{const legacy=await exchange(watch.repo,oldPhone,{checkpoint:false});expect(oldPhone.count()).toBe(SCALE_LOOPBACK_ARTICLES);console.log('T39 scale '+JSON.stringify({partial,resumed,noop,delta,legacy}));}finally{oldPhone.sql.close();}
  const beforeLost=await watch.repo.cursor('phone');
  await watch.db.execute('UPDATE articles SET title=?,fetched_at=fetched_at+20000 WHERE id=2',['Lost ACK edit']);
  await exchange(watch.repo,phone,{checkpoint:true,dropFinalAck:true});expect(phone.count()).toBe(SCALE_LOOPBACK_ARTICLES);
  expect((await watch.repo.cursor('phone')).lastLocalSeqAckedByPeer).toBe(beforeLost.lastLocalSeqAckedByPeer);
  const retry=await exchange(watch.repo,phone,{checkpoint:true});expect(retry.fullBodies).toBe(0);expect(phone.count()).toBe(SCALE_LOOPBACK_ARTICLES);
  expect((await watch.repo.cursor('phone')).lastLocalSeqAckedByPeer).toBeGreaterThan(beforeLost.lastLocalSeqAckedByPeer);

 }finally{watch.sql.close();phone.sql.close();await server.close();rmSync(root,{recursive:true,force:true});}
},SCALE_LOOPBACK_TEST_MS);
