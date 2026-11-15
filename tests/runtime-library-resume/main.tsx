/** Dedicated synthetic-account loopback fixture. Never included by product entry. */
import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {sqlite,uri,tcp,byteStreams,hostOperation,delay,secureStorage,fileChunks,base64ToBytes} from '@podjs/framework/services';
import {VerifiedChunkStore} from '@podjs/framework/verified-chunk-store';
import type {SqlDatabase} from '../../src/core/types';
import {initializeSchema} from '../../src/core/schema';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {hostArticleBodyCodec as codec,hostSyncText as text} from '../../src/sync/article-body-host';
import {WatchAccountStore} from '../../src/account/store';
import {ResumeApplicationService} from '../../src/sync/library-resume/host';
import {ResumeStore} from '../../src/sync/library-resume/store';
import {LibrarySyncSession,type SyncFrameConnection} from '../../src/sync/session';
import {HostSyncByteStream} from '../../src/sync/rfcomm';
import {StreamFrameConnection} from '../../src/sync/stream';
import {hash,type Row} from '../../src/sync/library-resume/wire';
const db:SqlDatabase={query:(q,p)=>sqlite.query(q,p as any),execute:(q,p)=>sqlite.execute(q,p as any),transaction:s=>sqlite.transaction(s as any),transactionChanges:s=>sqlite.transactionChanges(s as any)};
const chunks=new VerifiedChunkStore(<T,>(m:string,a:Row)=>hostOperation<T>(m,a).result),store=new ResumeStore(db);
const account=new WatchAccountStore({get:async k=>(await secureStorage.get(k))??null,set:(k,v)=>secureStorage.set(k,v),remove:k=>secureStorage.delete(k)});
const randomId=async()=>Array.from(base64ToBytes((await hostOperation<{bytesBase64:string}>('crypto.random',{bytes:16}).result).bytesBase64),b=>b.toString(16).padStart(2,'0')).join('');
const repo=new SqlLibrarySessionRepository(db,{codec,text,uri:{parseUri:text.parseUri,parseAndroid:v=>uri.parse(v,'android')},files:{storeText:async(_k,v)=>v,hydrate:async v=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{}});
const resume=new ResumeApplicationService({diagnostic:e=>{errors.push(e instanceof Error?e.message+' cause='+String(e.cause)+' '+JSON.stringify(e)+' '+e.stack:String(e));},assetHost:<T,>(m:string,a:Row)=>hostOperation<T>(m,a).result,store,chunks,account,repository:async()=>repo,randomId,localPermission:()=>true,readFile:async(path,size)=>{const bytes=new Uint8Array(size);for(let at=0;at<size;){const r=await fileChunks.read(path,at,Math.min(65536,size-at)),part=base64ToBytes(r.dataBase64);if(!part.length||r.size!==size)throw Error('LOCAL_IO');bytes.set(part,at);at+=part.length;}return bytes;}});
let drop='';let errors:string[]=[];
function stream(id:string){return new StreamFrameConnection(new HostSyncByteStream(id,byteStreams));}
async function serveData(raw:StreamFrameConnection,first:Row){let initial:Row|undefined=first;const connection:SyncFrameConnection={readFrame:t=>{if(initial){const r=initial;initial=undefined;return Promise.resolve(r);}return raw.readFrame(t);},writeFrame:async r=>{if(drop&&r.action==='syncLibraryResume'&&r.phase===drop&&r.type==='response'&&r.success){drop='';await raw.close();throw Error('RESUMEC intentional lost reply');}await raw.writeFrame(r);},close:()=>raw.close()};
 try{await new LibrarySyncSession(connection,repo,{resume,handleAction:async r=>r.action==='syncAccount'?{action:'syncAccount',success:true,version:14}:{action:r.action,success:false,version:14}}).run();}catch(e){errors.push(String(e));}finally{await raw.close().catch(()=>{});}}
async function control(c:StreamFrameConnection,r:Row){try{let result:unknown;
 if(r.op==='drop'){drop=String(r.phase);result=true;}
 else if(r.op==='inspect'){result={jobs:await db.query('SELECT job_id,state,epoch,completion FROM library_resume_jobs ORDER BY job_id'),objects:await db.query('SELECT object_id,receipt FROM library_resume_objects ORDER BY object_id'),articles:await db.query('SELECT id,title FROM articles'),content:await db.query('SELECT item_id,body_hash FROM article_sync_content'),sources:await db.query("SELECT url FROM channels WHERE url!='watchrss://phone-imports'"),errors};}
 else if(r.op==='receiptFailure'){await db.execute(r.on?"CREATE TRIGGER resumec_receipt_failure BEFORE UPDATE OF receipt ON library_resume_objects BEGIN SELECT RAISE(ABORT,'RESUMEC injected receipt failure'); END":'DROP TRIGGER IF EXISTS resumec_receipt_failure');result=true;}
 else if(r.op==='nativeBounds'){
  const bytes=new Uint8Array([5]),sha256=hash(bytes),scope=(await randomId())+(await randomId()),lease=await chunks.acquire(scope,await randomId(),false,{maxInFlightObjects:1,maxStagingBytes:134217728}),other=await chunks.acquire((await randomId())+(await randomId()),await randomId()),a={id:'a'.repeat(64),size:1,sha256,chunkHashes:[sha256]},b={...a,id:'b'.repeat(64)};
  const first=await chunks.stage(lease,a,0,bytes,{id:await randomId(),digest:'d'.repeat(64)});let window='';try{await chunks.stage(other,b,0,bytes,{id:await randomId(),digest:'e'.repeat(64)});}catch(e){window=String(e);}await chunks.release(lease,a,true);await chunks.stage(other,b,0,bytes,{id:await randomId(),digest:'f'.repeat(64)});await chunks.release(other,b,true);
  const small=await chunks.acquire((await randomId())+(await randomId()),await randomId(),false,{maxInFlightObjects:4,maxStagingBytes:3});let budget='';try{await chunks.stage(small,a,0,bytes,{id:await randomId(),digest:'a'.repeat(64)});}catch(e){budget=String(e);}const four=await chunks.acquire((await randomId())+(await randomId()),await randomId()),items=['1','2','3','4','5'].map(v=>({...a,id:v.repeat(64)}));for(const o of items.slice(0,4))await chunks.stage(four,o,0,bytes,{id:await randomId(),digest:'b'.repeat(64)});let fifth='';try{await chunks.stage(four,items[4]!,0,bytes,{id:await randomId(),digest:'c'.repeat(64)});}catch(e){fifth=String(e);}for(const o of items.slice(0,4))await chunks.release(four,o,true);result={first:first.state,window,budget,peak:4,fifth};
 }
 else if(r.op==='acquire')result=await chunks.acquire('e'.repeat(64),await randomId());
 else if(r.op==='runtime')result=await chunks.runtime();
 else throw Error('Unknown control');await c.writeFrame({success:true,result:result as Row});
 }catch(e){await c.writeFrame({success:false,error:String(e)}).catch(()=>{});}finally{await c.close();}}
let active=0;async function listen(port:number,accept:(id:string)=>Promise<void>){const server=await tcp.listen(port,'127.0.0.1').result;for(;;){while(active>=3)await delay(20).result;try{const peer=await tcp.accept(server.id,600000).result;active++;void accept(peer.id).finally(()=>{active--;});}catch(e){errors.push(String(e));await delay(100).result;}}}
async function run(){await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice('RESUMEC-WATCH');await store.initialize();if(!await account.read())await account.save({userId:'RESUMEC-FIXTURE',phoneMasked:'',installId:'RESUMEC',watchDeviceToken:'SYNTHETIC-OFFLINE',tokenExpiresAtMillis:0,watchRefreshToken:'',refreshTokenExpiresAtMillis:0,backendBaseUrl:'https://resume.invalid',posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},updatedAtMillis:0});
 void listen(18460,async id=>{const c=stream(id);try{const first=await c.readFrame(30000);if(first.op)await control(c,first);else await serveData(c,first);}catch(e){errors.push(String(e));await c.close().catch(()=>{});}});kv.set('resumec-fixture',{state:'listening'});}
mount(()=><Text>RESUMEC dedicated verification</Text>);void run().catch(e=>kv.set('resumec-fixture',{state:'failed',error:String(e)}));
