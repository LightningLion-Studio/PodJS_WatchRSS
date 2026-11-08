/** C7 F2/N1 on an owned emulator: N long notes inside the QuickJS background
 * runtime under a caller-chosen guest memory limit, with the PRODUCT local
 * cipher and the product host bounds (no bypass). The synthetic loopback server
 * owns all keys; nothing here is account material. Only counts and timings are
 * exported.
 *  publish: seed memo_notes, scan, prepare and (with flush) upload.
 *  pull:    fresh database; follow (pull, reassemble, apply to memo_notes),
 *           edit the tail of note 0, scan, prepare and upload.
 *  follow:  fresh database; follow only (R4: peak vs number of long notes).
 * The writer side caps notes at the 2 MiB budget, so an F1 check lowers the
 * watch reader budget (`readerBudget`) below a phone-written note, as the Bun
 * F1 test does; all other runs use the product budget. */
import {createSyncV2Crypto,hex} from '@podjs/framework/crypto';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {SyncV2Http,parseNetwork} from '../../../src/sync-v2/http';
import {WatchServiceKeyPin} from '../../../src/sync-v2/service-key';
import {WatchProjectionStore} from '../../../src/sync-v2/store';
import {ProjectionGate} from '../../../src/sync-v2/gate';
import {localProjectionCipher,projectionSql} from '../../../src/sync-v2/host';
import {WatchCloudIndex} from '../../../src/sync-v2/cloud-index';
import {WatchIndexPublisher} from '../../../src/sync-v2/publisher';
import {WatchAccountControl} from '../../../src/sync-v2/account-control';
import {WatchAccountBusinessSql,noteUpsert} from '../../../src/sync-v2/account-business';
import {WatchRecovery} from '../../../src/sync-v2/recovery';
import {WatchSpaceStore} from '../../../src/sync-v2/space-store';
import {SqlBusinessSource} from '../../../src/sync-v2/source';
import {watchMaterializer} from '../../../src/sync-v2/materializer';
import {fromWire} from '../../../src/sync-v2/business';
import {initializeMemoSchema} from '../../../src/notes/repository';

const scope={repoId:'01'.repeat(16),libraryEpoch:'1',contentGeneration:'2'},libraryId='aa'.repeat(16),idKey=new Uint8Array(32).fill(17),device='a'.repeat(32),accountId='0'.repeat(31)+'1';
const binding={schema:'frozen-v2-rc6',descriptorPin:'repo-descriptor:sha256:'+'a'.repeat(64),accountScope:'synthetic',capability:'local-projection-v1'};
/** Three equal CJK fields of `chars` characters (72222: B about 650 KB). */
const longText=(i:number,chars:number)=>String.fromCharCode(0x4e00+i).repeat(chars-1)+'x';
const noteValue=(i:number,chars:number)=>{const t=longText(i,chars);return {noteId:'n'+i,folderId:null,title:'title n'+i,markdown:t,plainText:t,contentHash:'h'+i,baseContentHash:'base-h',baseMarkdown:t,pinned:false,createdAt:1,updatedAt:2,modifiedBy:'watch',deleted:false,deletedAt:0};};
const check=(v:unknown,code:string)=>{if(!v)throw Error(code);};

(globalThis as any).backgroundHandler=async(ctx:any)=>{
 const f=ctx.payload,origin=f.baseUrl,host:any=(method:string,args:any)=>ctx.request('cloud.host',{method,args});
 let requests=0,stage='setup';
 try{
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)&&['publish','pull','follow'].includes(f.mode)&&f.notes>=1&&f.notes<=64&&f.chars>=1,'isolated_fixture_required');
  const crypto=createSyncV2Crypto(host),keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1},db=projectionSql(host);
  const transport={async request(r:any){requests++;const out=await host('http',{...r,body:r.body?encodeBase64(r.body):null});return {...out,body:decodeBase64(out.body)};}};
  const control=async(path:string)=>{const r=await transport.request({method:'GET',url:origin+'/c7/'+path,headers:{},body:null});check(r.status===200,'control_http');return parseNetwork(r.body);};
  const pinSlots=new Map<string,string>(),pin=new WatchServiceKeyPin({get:async k=>pinSlots.get(k),compareAndSet:async(k,old,value)=>{if((pinSlots.get(k)??null)!==old)return false;pinSlots.set(k,value);return true;}},accountId,async()=>({accountId,syncV2:f.serviceInfo}));
  const http=new SyncV2Http(transport,origin,scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,pin,false,false,true,true);
  const cipher=localProjectionCipher(host,'c7-memory:'+f.runId),spaceCipher=localProjectionCipher(host,'c7-space:'+f.runId),recoveryCipher=localProjectionCipher(host,'c7-recovery:'+f.runId);
  for(const c of [cipher,spaceCipher,recoveryCipher])await c.seal('probe',{});
  await initializeMemoSchema(db as any);
  const store=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true});
  const cache=new WatchSpaceStore(db,spaceCipher,{} as any,'6'.repeat(64));await cache.init();
  const recovery=new WatchRecovery(store,cache,{cipher:recoveryCipher,randomId:async()=>hex(await crypto.random(16)),trustedNow:()=>100,source:async refs=>{if(refs.length)throw Error('closure_incomplete');return [];},reserve:async()=>async()=>{}});
  const native=new WatchAccountBusinessSql(db,store,scope,idKey,{recoveryValue:async id=>{const c=await store.readCandidate(id);return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},async row=>{if(row.bodyRevision!==null)throw Error('closure_incomplete');},async()=>async()=>{});
  await native.initialize();await store.initialize();
  const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:f.publicKeyBase64Url});
  const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>100,undefined,{noteSegments:true}),reader=new WatchCloudIndex(store,http,crypto,keys,approved,async()=>{},()=>100,undefined,{noteSegments:true,...(f.readerBudget?{noteTextBudget:f.readerBudget}:{})});
  const account=new WatchAccountControl({store,http,publisher,reader,crypto,approved,business:native,recovery,trustedNow:()=>100,historyRestore:true,choiceApply:true,author:async()=>{const d=await control('device');return {deviceId:device,alias:'key',own:{commitOid:d.commitOid,revision:d.revision}};}});
  const source=await SqlBusinessSource.open(db,watchMaterializer(db,{cloudRestoreMetadata:async()=>{throw Error('no article body');}} as any));
  const scan=async()=>{const cp=await store.checkpoint();if(!cp)await store.beginScan(binding);else if(cp.phase==='complete')await store.beginTailWindow();for(;;){const c=await store.checkpoint();if(c?.phase==='complete')break;if(c?.phase==='tail')await store.catchUpPage(source,1);else await store.scanPage(source,1);}};
  const prepare=async()=>{const d=await control('device');return publisher.prepare(device,'key',{commitOid:d.commitOid,revision:d.revision},hex(await crypto.random(16)));};
  const timed=async<T>(label:string,run:()=>Promise<T>)=>{stage=label;const started=Date.now(),before=requests,out:any=await run();const step={stage:label,millis:Date.now()-started,requests:requests-before};await host('result',{event:'step',...step});return out;};
  const textLength=async()=>Number((await db.query('SELECT length(markdown)+length(plain_text)+length(base_markdown) AS n FROM memo_notes WHERE note_id=?',['n0']))[0]?.n??-1);
  if(f.mode==='publish'){
   // Seeding stands in for the foreground editor; it uses the same bounded appends.
   await timed('seed',async()=>{for(let i=0;i<f.notes;i++)for(const s of noteUpsert(noteValue(i,f.chars)))await db.transaction([s]);});
   await timed('scan',scan);
   const prepared=await timed('prepare',prepare);check(prepared.segments.uploaded>=2*f.notes,'segments_uploaded');await host('result',{event:'prepared',segments:prepared.segments,objects:prepared.objects});
   if(f.flush)await timed('flush',()=>publisher.flush());
  }else{
   const followed=await timed('follow',async()=>account.follow(await control('window')));check(followed.applied===true,'follow_applied');check(await textLength()===3*f.chars,'follow_text');
   if(f.mode==='follow'){await host('result',{event:'done',mode:f.mode,notes:f.notes,chars:f.chars,requests});return 'success';}
   // F1: an over-budget remote note is held per entity; the other notes apply.
   if(f.oversize){const u=(await store.readState()).cloud?.unopenableNotes?.big;check(u?.code==='storage_pressure','oversize_not_quarantined');await host('result',{event:'quarantined',noteId:'big',code:u.code});}
   await timed('edit',()=>db.transaction([{sql:"UPDATE memo_notes SET markdown=substr(markdown,1,length(markdown)-1)||'y',updated_at=updated_at+1 WHERE note_id=?",params:['n0']}]));
   await timed('scan-edit',scan);
   const prepared=await timed('edit-prepare',prepare);check(prepared.segments.uploaded>=1&&prepared.segments.reused>=1,'edit_segments');await host('result',{event:'prepared',segments:prepared.segments,objects:prepared.objects});
   if(f.flush)await timed('edit-flush',()=>publisher.flush());
  }
  await host('result',{event:'done',mode:f.mode,notes:f.notes,chars:f.chars,requests});
  return 'success';
 }catch(error){
  await host('result',{event:'failed',stage,code:String((error as Error)?.message??error).slice(0,80),stack:String((error as Error)?.stack??'').slice(0,1200),requests});
  throw error;
 }
};
