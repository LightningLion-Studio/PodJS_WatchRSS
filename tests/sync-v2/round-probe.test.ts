import {expect,test} from 'bun:test';
import {readCloudSecure} from '../../src/cloud/secure-read';
import {BOOK_SCHEMA} from '../../src/books/schema';
import book from '../fixtures/cli-single-txt-book.json' with {type:'json'};
import {MemoRepository} from '../../src/notes/repository';
import {openApplicationSyncV2Core} from '../../src/sync-v2/application-core';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {watchLocalProjection} from '../../src/sync-v2/index';
import {canonical} from '../../src/sync-v2/protocol';
import {accountIdFromUserId} from '../../src/sync-v2/signing';
import {fixture,f as identity,scope} from './p6-fix-fixture';

const probes=['/capabilities','/checkpoint','/devices/signing-keys'];

async function settledFixture(){
 const f=await fixture();
 const routes:string[]=[],hostCalls:string[]=[];
 const transport=f.options.transport,host=f.options.host;
 let beforeSigning: (()=>Promise<void>)|undefined;
 f.options.transport={async request(request){
  const route=new URL(request.url).pathname.replace('/functions/v1/sync/v2','');
  routes.push(route);
  if(route==='/devices/signing-keys'&&beforeSigning){const next=beforeSigning;beforeSigning=undefined;await next();}
  return transport.request(request);
 }};
 f.options.host=async(method:string,args:Record<string,unknown>)=>{hostCalls.push(method);return host(method,args);};
 const open=()=>openApplicationSyncV2(f.options);
 const first=await open();
 if(!first)throw Error('fixture expected a repository');
 expect(await first.sync()).toEqual({completionError:null});
 const reset=()=>{routes.length=0;hostCalls.length=0;f.db.sql.length=0;};
 reset();
 const projection=await watchLocalProjection({
  enabled:true,scope,libraryId:accountIdFromUserId(f.options.legacyDeviceId),
  accountScope:canonical([f.options.account.backendBaseUrl,f.options.account.userId]),
  host:async(method,args)=>method==='secure.get'?await readCloudSecure(f.options.host,String(args.key)) as any:f.options.host(method,args),
  identity:{installed:async()=>identity},descriptor:identity.descriptor,metadata:f.options.repository,
 }).inspect();
 if(!projection)throw Error('fixture expected a projection');
 reset();
 return {...f,first,open,projection,routes,hostCalls,reset,whenSigning:(fn:()=>Promise<void>)=>{beforeSigning=fn;}};
}

test('settled watch round only probes and performs no database or secure writes',async()=>{
 const f=await settledFixture();
 try{
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes).toEqual(probes);
  expect(f.hostCalls.filter(name=>/^(sql\.(transaction|execute|notify)|secure\.(compareAndSet|set))$/.test(name))).toEqual([]);
  expect(f.db.sql.filter(sql=>/memo_notes|syncv2_cloud_rows|syncv2_candidates|sync_books|article_register_state/.test(sql))).toEqual([]);
 }finally{await f.first.close();f.db.close();}
});

test('a cold headless round skips library setup and recovery capsule download',async()=>{
 const f=await settledFixture();
 try{
  await f.first.close();
  f.reset();
  const opened=await openApplicationSyncV2Core({...f.options,singleRound:true,prepareLibrary:async()=>{throw Error('library initialized');}});
  expect(opened?.initialResult).toEqual({completionError:null});
  await opened?.close();
  expect(f.routes).toEqual(['/repo/descriptor',...probes]);
  expect(f.hostCalls.filter(name=>/^(sql\.(transaction|execute|notify)|secure\.(compareAndSet|set))$/.test(name))).toEqual([]);
 }finally{await f.first.close();f.db.close();}
});

test('a save during the signing probe invalidates the local watermark and publishes the edit',async()=>{
 const f=await settledFixture();
 try{
  f.whenSigning(async()=>{
   const memo=new MemoRepository(f.db,f.options.legacyDeviceId,undefined,()=>200);
   await memo.save({noteId:'n',title:'Saved during the probe',markdown:'Original content'});
  });
  const revision=f.server.account.revision;
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes.slice(0,3)).toEqual(probes);
  expect(f.routes).toContain('/account/publish');
  expect(f.server.account.revision).not.toBe(revision);
  expect(await f.db.query('SELECT title FROM memo_notes')).toEqual([{title:'Saved during the probe'}]);
 }finally{await f.first.close();f.db.close();}
});

test('a same-revision binding change revalidates the cloud index',async()=>{
 const f=await settledFixture();
 try{
  f.server.approvalRevision='1';
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes.slice(0,3)).toEqual(probes);
  expect(f.routes).toContain('/objects/batch-get');
  expect(f.routes).not.toContain('/account/publish');
  f.reset();
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes).toEqual(probes);
 }finally{await f.first.close();f.db.close();}
});

test('a higher revocation revision survives failed revalidation and rejects rollback on reopen',async()=>{
 const f=await settledFixture();
 try{
  f.server.revocationRevision='1';
  const req=f.options.transport.request;
  let failDownload=true;
  f.options.transport.request=async request=>{
   if(failDownload&&new URL(request.url).pathname.includes('/objects/'))throw Error('synthetic_object_failure');
   return req.call(f.options.transport,request);
  };
  await expect(f.first.sync()).rejects.toThrow('synthetic_object_failure');
  await f.first.close();
  failDownload=false;
  f.server.revocationRevision='0';
  f.reset();
  await expect(openApplicationSyncV2Core({...f.options,singleRound:true})).rejects.toThrow('replay_detected');
  expect(f.routes).toEqual(['/repo/descriptor',...probes]);
  expect(f.hostCalls).not.toContain('sql.transaction');
 }finally{await f.first.close();f.db.close();}
});

for(const field of ['revision','rollbackGeneration'] as const)test(`a signed head with a different ${field} cannot reuse the settled round`,async()=>{
 const f=await settledFixture();
 try{
  const old=f.server.account[field];
  f.server.account[field]=field==='revision'?'0':'1';
  await expect(f.first.sync()).rejects.toThrow('replay_detected');
  expect(f.routes).toEqual(probes.slice(0,2));
  f.server.account[field]=old;
 }finally{await f.first.close();f.db.close();}
});

test('a pending choice exits the quick path and remains pending',async()=>{
 const f=await settledFixture();
 try{
  const state=await f.projection.readStableState();
  await f.projection.controlUpdate(state,{...state,pendingChoice:{generation:state.rollbackGeneration,inboxKeys:[]}});
  f.reset();
  expect(await f.first.sync()).toEqual({completionError:'choice_pending'});
  expect(f.routes).toContain('/negotiate');
  expect(f.routes).not.toContain('/account/publish');
 }finally{await f.first.close();f.db.close();}
});

test('a pending applied ACK exits the quick path and is retried',async()=>{
 const f=await settledFixture();
 try{
  const state=await f.projection.readStableState(),account=state.account!;
  await f.projection.controlUpdate(state,{...state,cloud:{...state.cloud,pendingApplied:{
   requestId:'d'.repeat(32),commitOid:account.oid,refRevision:account.revision,rollbackGeneration:account.generation,
  }}});
  f.reset();
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes).toContain('/acks/applied');
  expect((await f.projection.readStableState()).cloud.pendingApplied).toBeNull();
 }finally{await f.first.close();f.db.close();}
});

test('a new remote head exits the quick path and lands in the original database',async()=>{
 const f=await settledFixture(),remote=await fixture();let peer:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;
 try{
  peer=await openApplicationSyncV2({...remote.options,transport:f.server});
  expect(peer).not.toBeNull();
  const memo=new MemoRepository(remote.db,remote.options.legacyDeviceId,undefined,()=>300);
  await memo.save({noteId:'n',title:'New cloud head',markdown:'local\ntext'});
  expect(await peer!.sync()).toEqual({completionError:null});
  f.reset();
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes.slice(0,3)).toEqual(probes);
  expect(f.routes).toContain('/objects/batch-get');
  expect(await f.db.query('SELECT title FROM memo_notes')).toEqual([{title:'New cloud head'}]);
 }finally{await peer?.close();await f.first.close();f.db.close();remote.db.close();}
});

for(const kind of ['book','asset'] as const)test(`an orphan ${kind} stays local while an independent cloud edit lands`,async()=>{
 const f=await settledFixture(),remote=await fixture();let peer:Awaited<ReturnType<typeof openApplicationSyncV2>>=null;
 try{
  const id=kind==='book'?book.bookId:'orphan.png';
  if(kind==='book'){
   // Reopen to discover the book source created after the original projection.
   await f.first.close();
   await f.db.transaction(BOOK_SCHEMA.map(sql=>({sql})));
   const value={bookId:id,fingerprint:book.fingerprint,title:'Orphan book',chapterCount:1,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:5,sourceDeviceId:'watch',sourceUrl:book.sourceUrl,kind:'txt'};
   await f.db.execute('INSERT INTO sync_books(book_id,fingerprint,chapter_count,state_json,registration_complete) VALUES(?,?,?,?,1)',[id,book.fingerprint,1,JSON.stringify(value)]);
   f.first=(await f.open())!;
  }else{
   f.options.repository.cloudNoteAsset=async()=>{throw Error('cloud_note_asset_missing');};
   await f.db.execute("INSERT INTO memo_assets VALUES('orphan.png','image/png','orphan.png',5,'watch',0,0,'')");
  }
  const revision=f.server.account.revision;
  expect(await f.first.sync()).toEqual({completionError:'body_channel_source_missing'});
  expect(f.server.account.revision).toBe(revision);
  peer=await openApplicationSyncV2({...remote.options,transport:f.server});
  const memo=new MemoRepository(remote.db,remote.options.legacyDeviceId,undefined,()=>300);
  await memo.save({noteId:'n',title:'Cloud edit while original is missing',markdown:'local\ntext'});
  expect(await peer!.sync()).toEqual({completionError:null});
  const current={...f.server.account};
  f.reset();
  expect(await f.first.sync()).toEqual({completionError:'body_channel_source_missing'});
  expect(f.routes).not.toContain('/account/publish');
  expect(f.server.account).toEqual(current);
  expect(await f.db.query('SELECT title FROM memo_notes')).toEqual([{title:'Cloud edit while original is missing'}]);
  expect(await f.db.query(kind==='book'?'SELECT book_id AS id FROM sync_books':'SELECT asset_id AS id FROM memo_assets')).toEqual([{id}]);
  const state=await f.projection.readStableState();
  expect(state.activeGeneration).toBe(current.commitOid);
  expect(state.hasUnsentEdits).toBe(true);
 }finally{await peer?.close();await f.first.close();f.db.close();remote.db.close();}
});

test('an interrupted publication is resumed before the next quick path',async()=>{
 const f=await settledFixture();
 try{
  const memo=new MemoRepository(f.db,f.options.legacyDeviceId,undefined,()=>200);
  await memo.save({noteId:'n',title:'Pending publication',markdown:'local\ntext'});
  f.server.failBeforePublishOnce=true;
  await expect(f.first.sync()).rejects.toThrow('synthetic_request_lost');
  expect((await f.projection.readStableState()).cloud.pendingPublish).not.toBeNull();
  f.reset();
  expect(await f.first.sync()).toEqual({completionError:null});
  expect(f.routes.some(route=>route.startsWith('/requests/'))).toBe(true);
  expect(f.routes).toContain('/account/publish');
  expect(await f.db.query('SELECT title FROM memo_notes')).toEqual([{title:'Pending publication'}]);
 }finally{await f.first.close();f.db.close();}
});
