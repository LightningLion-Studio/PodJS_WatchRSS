import {test,expect} from 'bun:test';
import {bytesToBase64} from '@podjs/framework/bytes';
import {bookId,bookFingerprint,chapterHash,BOOK_CHUNK_SIZE,type BookState} from '../../src/books/protocol';
import {bookPackageLines} from '../../src/books/package';
import {createApplicationActionHandler} from '../../src/sync/application-actions';
import {watchBookSyncAction} from '../../src/sync-v2/local-transfer-intake';
import {localTransferIntakeFixture} from '../helpers/local-transfer-intake';
import vectors from '../fixtures/book-fingerprint.json';
import {bookFixture,seedChapters} from './fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {LibrarySyncSession,type LibrarySessionOptions} from '../../src/sync/session';
import {BookSyncActions} from '../../src/books/actions';
import type {JsonObject} from '../../src/sync/protocol';
const ack={action:'ack',success:true,applied:true,phase:'applied'},v=vectors.cases[0]!;
test('book capability is physical-session scoped and confirmed change callback runs after close',async()=>{const f=await bookFixture();try{const books=new BookSyncActions(f.db,f.store),handler:NonNullable<LibrarySessionOptions['handleAction']>=async(r,_log,ctx)=>books.apply(r,ctx!.session);handler.capabilities={supportsBookSyncV1:true};const probe={action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportsBookSyncV1:true,supportsPersistentSession:true,requestPersistentSession:true},manifest={action:'syncBooks',version:1,phase:'manifest',deviceId:'phone',books:[{bookId:v.bookId,fingerprint:v.fingerprint,title:'Book',chapterCount:2,deletedChapters:[],deleted:false,deletionClock:0,deletedAt:0,updatedAt:1,sourceDeviceId:'phone',contentAvailable:false}]};const input:JsonObject[]=[probe,ack,manifest,ack,{action:'syncSession',phase:'complete'},ack],output:JsonObject[]=[];let closed=false,callbacks=0;
 const results=await new LibrarySyncSession({readFrame:async()=>{const n=input.shift();if(!n)throw Error('EOF');return n;},writeFrame:async r=>{output.push(r);},close:async()=>{closed=true;}},f.repo,{handleAction:handler,onActionCompleted:()=>expect(closed).toBe(false),onSessionClosed:r=>{expect(closed).toBe(true);expect(r.some(x=>x.request.action==='syncBooks'&&x.libraryApplied&&Number(x.response.applied)>0)).toBe(true);callbacks++;}}).run();expect(output[0]?.supportsBookSyncV1).toBe(true);expect(results).toHaveLength(3);expect(callbacks).toBe(1);
 const oldInput:JsonObject[]=[manifest,ack],oldOutput:JsonObject[]=[];await new LibrarySyncSession({readFrame:async()=>oldInput.shift()!,writeFrame:async r=>{oldOutput.push(r);},close:async()=>{}},f.repo,{handleAction:handler}).run();expect(oldOutput[0]?.success).toBe(false);expect(oldOutput[0]?.errorCode).toBe('book_sync_not_negotiated');
 }finally{f.sql.close();}});
test('5500 legacy chapters become one immutable book with no article/source inventory, old-peer fallback retains every chapter',async()=>{const f=await bookFixture();try{const chapters=Array.from({length:5500},(_,i)=>({title:'Chapter '+(i+1),contentText:'Original text '+i,contentHtml:null}));await seedChapters(f,'https://watchrss.local/import-txt-novel/scale',chapters);const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});repo.configurePeer('phone',{supportsBookSyncV1:true});const window=await repo.prepareWindow('phone',0),books=await repo.cloudBooks();expect(books.books).toHaveLength(1);expect(books.books[0]?.chapterCount).toBe(5500);expect(window.fullArticleManifest).toHaveLength(0);expect(window.rssSources).toHaveLength(0);expect((await repo.cloudSnapshot(false)).stateArticles).toHaveLength(0);repo.configurePeer('phone',{});expect((await repo.prepareWindow('phone',0)).fullArticleManifest).toHaveLength(5500);}finally{f.sql.close();}},120000);
test('cancellation awaits the existing transport close before notifying a confirmed book change',async()=>{const f=await bookFixture();try{let release!:()=>void;const close=new Promise<void>(r=>{release=r;});let closed=false,notified=0;const frames:JsonObject[]=[{action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportsBookSyncV1:true,supportsPersistentSession:true,requestPersistentSession:true},ack,{action:'syncBooks',version:1,phase:'manifest',deviceId:'phone'},ack];const handler:NonNullable<LibrarySessionOptions['handleAction']>=async()=>({success:true,action:'syncBooks',applied:1});handler.capabilities={supportsBookSyncV1:true};const session=new LibrarySyncSession({readFrame:async()=>frames.shift()!,writeFrame:async()=>{},close:async()=>{await close;closed=true;}},f.repo,{handleAction:handler,onActionCompleted:r=>{if(r.request.action==='syncBooks')session.cancel();},onSessionClosed:()=>{expect(closed).toBe(true);notified++;}});const done=session.run().catch(e=>e);await Bun.sleep(0);expect(notified).toBe(0);release();expect(String(await done)).toContain('cancelled');expect(notified).toBe(1);}finally{f.sql.close();}});


for(const rollbackAt of ['never','manifest','last chunk'] as const)test('Sync v2 watch applies v1 book intake at '+rollbackAt,async()=>{
 const f=await bookFixture();
 try{
  const deviceId='22000000-0000-0000-0000-000000000000';
  await f.db.execute('UPDATE sync_local_identity SET device_id=? WHERE id=1',[deviceId]);
  const guard=await localTransferIntakeFixture(f.db,{backendBaseUrl:'https://fixture.invalid',userId:'11000000-0000-0000-0000-000000000000'},deviceId);
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});
  const sourceUrl='https://watchrss.local/import-epub/p6-v1-book';
  const chapter={chapterIndex:1,title:'Chapter',contentText:'x'.repeat(BOOK_CHUNK_SIZE),contentHtml:null,url:sourceUrl+'/chapter/1'};
  const sha=f.bookPorts.sha256,fingerprint=await bookFingerprint([await chapterHash(1,chapter.title,chapter.contentText,sha)],sha);
  const id=await bookId(fingerprint,sha);
  const state:BookState={bookId:id,fingerprint,title:'Book',chapterCount:1,deletedChapters:[],deleted:false,deletionClock:0,deletedAt:0,updatedAt:10,sourceDeviceId:'phone',sourceUrl,kind:'epub'};
  const info=await f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:1,sourceUrl,kind:'epub'},[chapter]),2*BOOK_CHUNK_SIZE);
  const raw=f.data.get(info.path)!,request={action:'syncBooks',version:1,deviceId:'phone'};
  const manifest={...request,phase:'manifest',books:[{...state,contentAvailable:true}]};
  const chunks=Array.from({length:Math.ceil(raw.length/BOOK_CHUNK_SIZE)},(_,i)=>({...request,phase:'body',bookId:id,fingerprint,packageSha256:info.sha256,byteCount:raw.length,chunkIndex:i,chunkCount:2,dataBase64:bytesToBase64(raw.subarray(i*BOOK_CHUNK_SIZE,(i+1)*BOOK_CHUNK_SIZE))}));
  expect(chunks).toHaveLength(2);
  const requestAt=rollbackAt==='manifest'?manifest:rollbackAt==='last chunk'?chunks[1]:null;
  const probe={action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportsBookSyncV1:true,supportsPersistentSession:true,requestPersistentSession:true};
  const bodyFrames=rollbackAt==='manifest'?[]:chunks.flatMap(frame=>[frame,ack]);
  const input:JsonObject[]=[probe,ack,manifest,ack,...bodyFrames,{action:'syncSession',phase:'complete'},ack];
  const handler=createApplicationActionHandler({
   books:{apply:watchBookSyncAction(async()=>repo,{
    read:async()=>guard.account,withLibraryAccount:async(expected,run)=>{
     expect(expected).toEqual(guard.account);
     return run();
    },
   },guard.intake)},
   notes:{initialize:async()=>{},merge:async()=>0,allIncludingDeleted:async()=>[]},notesChanged:()=>{},deviceId:()=>repo.deviceId(),
  });
  const output:JsonObject[]=[];
  const results=await new LibrarySyncSession({readFrame:async()=>{
   const frame=input.shift();if(!frame)throw Error('unexpected read');
   if(frame===requestAt)await guard.rollback();
   return frame;
  },writeFrame:async frame=>{output.push(frame);},close:async()=>{}},repo,{handleAction:handler}).run();
  expect(output[0]).toMatchObject({success:true,supportsBookSyncV1:true});
  const lastBook=results.filter(x=>x.request.action==='syncBooks').at(-1)!;
  if(rollbackAt!=='manifest'){
   const firstChunk=results.find(x=>x.request.phase==='body')!;
   expect(firstChunk.response).toMatchObject({success:true,received:true,complete:false});
   expect(firstChunk.libraryApplied).toBe(false);
  }
  if(rollbackAt==='never'){
   expect(lastBook.response).toMatchObject({success:true,complete:true});
   expect(lastBook.libraryApplied).toBe(true);
   expect((await repo.books!.package(id))?.sha256).toBe(info.sha256);
   expect(await repo.cloudBookWitness(id,state)).toEqual({sha256:info.sha256,size:info.size});
   expect((await guard.store.readState()).pendingChoice).toBeNull();
  }else{
   expect(lastBook.response).toMatchObject({success:false,message:'BUSINESS_REJECTED'});
   expect(lastBook.libraryApplied).toBe(false);
   const keys=(await guard.store.readState()).pendingChoice?.inboxKeys;
   expect(keys).toHaveLength(1);
   const {entry}=await guard.store.legacyChoiceEntry(keys![0]!);
   expect(entry.applied).toBe(false);
   expect(await repo.books!.package(id)).toBeUndefined();
   expect(await f.db.query('SELECT id FROM articles')).toEqual([]);
   if(rollbackAt==='manifest'){
    expect(entry.transferBody).toBeUndefined();
    expect(await f.db.query('SELECT book_id FROM sync_books')).toEqual([]);
   }else{
    expect(entry.transferBody).toMatchObject({size:info.size,sha256:info.sha256});
    await guard.store.legacyBodies.verify(entry.transferBody);
   }
  }
  expect(guard.leased()).toBe(false);
 }finally{f.sql.close();}
});


test('FIX1 v1 session cancellation blocks business publication after intake',async()=>{
 const f=await bookFixture();
 try{
  const id='22000000-0000-0000-0000-000000000000';
  await f.db.execute('UPDATE sync_local_identity SET device_id=? WHERE id=1',[id]);
  const guard=await localTransferIntakeFixture(f.db,{backendBaseUrl:'https://fixture.invalid',userId:'11000000-0000-0000-0000-000000000000'},id);
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});
  const input:JsonObject[]=[
   {action:'syncLibrary',phase:'probe',version:14,deviceId:'phone',supportsBookSyncV1:true,supportsPersistentSession:true,requestPersistentSession:true},ack,
   {action:'syncBooks',version:1,phase:'manifest',deviceId:'phone',books:[{bookId:v.bookId,fingerprint:v.fingerprint,title:'Late book',chapterCount:2,deletedChapters:[],deleted:false,deletionClock:0,deletedAt:0,updatedAt:1,sourceDeviceId:'phone',contentAvailable:false}]},ack,
  ];
  let checked!:()=>void,resume!:()=>void;
  const protectedWrite=new Promise<void>(resolve=>{checked=resolve;}),continueWrite=new Promise<void>(resolve=>{resume=resolve;});
  const handler=createApplicationActionHandler({
   books:{apply:watchBookSyncAction(async()=>repo,{read:async()=>guard.account,withLibraryAccount:async(_account,w)=>w()},(a,d,w)=>guard.intake(a,d,protect=>w(async write=>{await protect(write);checked();await continueWrite;})))},
   notes:{initialize:async()=>{},merge:async()=>0,allIncludingDeleted:async()=>[]},notesChanged:()=>{},deviceId:()=>repo.deviceId(),
  });
  const output:JsonObject[]=[];
  const session=new LibrarySyncSession({readFrame:async()=>input.shift()!,writeFrame:async frame=>{output.push(frame);},close:async()=>{}},repo,{handleAction:handler});
  const running=session.run().catch(error=>String(error));
  await protectedWrite;
  session.cancel();
  resume();
  const result=await running,rows=await f.db.query("SELECT book_id FROM sync_books");
  expect(String(result)).toContain('cancelled');expect(rows).toHaveLength(0);expect(output.filter(r=>r.action==='syncBooks')).toHaveLength(0);
 }finally{f.sql.close();}
});

test('FIX1 committed book witness hashes once and invalidates same-size file replacement',async()=>{
 const f=await bookFixture();
 try{
  await seedChapters(f,'https://watchrss.local/import-txt-novel/witness-cache',[{title:'Chapter',contentText:'Original',contentHtml:null}]);
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});
  const {books:[book]}=await repo.cloudBooks();
  expect(book).toBeDefined();
  const file=await f.store.package(book!.bookId);
  expect(file).toBeDefined();
  let token='original',hashes=0;
  const stat=f.files.stat,hash=f.files.hash;
  f.files.stat=async path=>({...await stat(path),changeToken:token});
  f.files.hash=async path=>{hashes++;return hash(path);};
  for(let i=0;i<2;i++)expect(await repo.cloudBookWitness(book!.bookId,book!)).toEqual({size:file!.size,sha256:file!.sha256});
  expect(hashes).toBe(1);
  const changed=f.data.get(file!.path)!.slice();changed[0]^=1;
  f.data.set(file!.path,changed);token='new inode or ctime';
  await expect(repo.cloudBookWitness(book!.bookId,book!)).rejects.toThrow('cloud_book_package_changed');
  expect(hashes).toBe(2);
 }finally{f.sql.close();}
});
