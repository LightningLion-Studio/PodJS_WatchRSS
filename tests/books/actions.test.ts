import {test,expect} from 'bun:test';
import {bookFixture} from './fixture';
import {localTransferIntakeFixture} from '../helpers/local-transfer-intake';
import {BookSyncActions} from '../../src/books/actions';
import {bookPackageLines} from '../../src/books/package';
import {chapterHash,bookFingerprint,bookId,BOOK_CHUNK_SIZE,type BookState} from '../../src/books/protocol';
import {bytesToBase64} from '@podjs/framework/bytes';
async function setup(){const f=await bookFixture(),source='https://watchrss.local/import-epub/transfer',chapters=[{chapterIndex:1,title:'章',contentText:'中文/a\n'.repeat(16000),contentHtml:null,url:source+'/chapter/1'}],hashes=await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,f.bookPorts.sha256))),fingerprint=await bookFingerprint(hashes,f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256);const info=await f.files.write(bookPackageLines({format:'watchrss-book',version:1,title:'Book',chapterCount:1,sourceUrl:source,kind:'epub'},chapters),512*1024*1024),bytes=f.data.get(info.path)!;const state:BookState={bookId:id,fingerprint,title:'Book',chapterCount:1,deletedChapters:[],deleted:false,deletionClock:0,deletedAt:0,updatedAt:10,sourceDeviceId:'phone',sourceUrl:source,kind:'epub'};const action=new BookSyncActions(f.db,f.store),request=(phase:string)=>({action:'syncBooks',version:1,phase,deviceId:'phone'}),body=(i:number)=>({...request('body'),bookId:id,fingerprint,packageSha256:info.sha256,byteCount:bytes.length,chunkIndex:i,chunkCount:Math.ceil(bytes.length/BOOK_CHUNK_SIZE),dataBase64:bytesToBase64(bytes.subarray(i*BOOK_CHUNK_SIZE,(i+1)*BOOK_CHUNK_SIZE))});return {...f,action,state,request,body,info,bytes};}
test('out-of-order durable parts, duplicate replay, restart, complete availability and exact pull',async()=>{const f=await setup();try{const m=await f.action.apply({...f.request('manifest'),books:[{...f.state,contentAvailable:true}]});expect(m.missingBookIds).toEqual([f.state.bookId]);const count=f.body(0).chunkCount;expect(count).toBeGreaterThan(1);await f.action.apply(f.body(count-1));expect((await f.store.manifests())[0]?.contentAvailable).toBe(false);const before=f.changes();await f.action.apply(f.body(count-1));expect(f.changes()).toBe(before);const cold=new BookSyncActions(f.db,f.store);for(let i=0;i<count-1;i++)await cold.apply(f.body(i));expect((await f.store.manifests())[0]?.contentAvailable).toBe(true);expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:1}]);expect(await f.db.query('SELECT * FROM sync_book_parts')).toEqual([]);expect((await cold.apply({...f.request('pull'),bookId:f.state.bookId,chunkIndex:0})).dataBase64).toBe(f.body(0).dataBase64);const stable=f.changes();expect((await cold.apply(f.body(count-1))).applied).toBe(0);expect(f.changes()).toBe(stable);}finally{f.sql.close();}});
test('conflicting duplicate and corrupt whole package fail closed; cleared parts allow a correct retry',async()=>{const f=await setup();try{await f.action.apply({...f.request('manifest'),books:[{...f.state,contentAvailable:true}]});await f.action.apply(f.body(0));const wrong=f.bytes.slice(0,BOOK_CHUNK_SIZE);wrong[50]^=1;await expect(f.action.apply({...f.body(0),dataBase64:bytesToBase64(wrong)})).rejects.toThrow();expect((await f.store.manifests())[0]?.contentAvailable).toBe(false);await f.db.execute('DELETE FROM sync_book_parts');const count=f.body(0).chunkCount;await f.action.apply({...f.body(0),dataBase64:bytesToBase64(wrong)});for(let i=1;i<count;i++){if(i===count-1)await expect(f.action.apply(f.body(i))).rejects.toThrow();else await f.action.apply(f.body(i));}expect(await f.db.query('SELECT * FROM sync_book_parts')).toEqual([]);expect(await f.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:0}]);for(let i=0;i<count;i++)await f.action.apply(f.body(i));expect((await f.store.manifests())[0]?.contentAvailable).toBe(true);}finally{f.sql.close();}});
test('reading pagination is session-scoped, strictly bounded, and zero-change manifest has no writes',async()=>{const f=await bookFixture();try{const action=new BookSyncActions(f.db,f.store),id='a'.repeat(64),session={};for(let i=1;i<=205;i++)await f.store.mergeReading({bookId:id,chapterIndex:i,isRead:false,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:i,sourceDeviceId:'watch'});const capture=f.store.captureReading.bind(f.store);let captures=0;f.store.captureReading=async()=>{captures++;await capture();};const req=(after:number)=>({action:'syncBooks',version:1,phase:'reading',deviceId:'phone',after,states:[]});const first=await action.apply(req(0),session);expect((first.states as unknown[]).length).toBe(100);expect(first.nextAfter).toBe(100);expect(first.hasMore).toBe(true);const second=await action.apply(req(100),session);expect((second.states as unknown[]).length).toBe(100);const last=await action.apply(req(200),session);expect((last.states as unknown[]).length).toBe(5);expect(last.hasMore).toBe(false);expect(last.nextAfter).toBe(205);const before=f.changes();await action.apply(req(205),session);expect(f.changes()).toBe(before);expect(captures).toBe(1);await expect(action.apply(req(206),session)).rejects.toThrow();await expect(action.apply({...req(0),states:Array(101).fill({})},{})).rejects.toThrow();}finally{f.sql.close();}});

test('v1 receipts backfill old parts and reject conflicting package dimensions before writing',async()=>{
 const f=await setup();
 try{
  await f.store.merge(f.state);
  const last=f.body(f.body(0).chunkCount-1),bytes=f.bytes.subarray(last.chunkIndex*BOOK_CHUNK_SIZE);
  const part=await f.files.writeBytes(bytes);
  await f.db.execute('INSERT INTO sync_book_parts VALUES(?,?,?,?,?,?,?)',
   [last.bookId,last.packageSha256,last.fingerprint,last.byteCount,last.chunkCount,last.chunkIndex,part.path]);
  const previous=f.writes();
  expect((await f.action.apply(last)).complete).toBe(false);
  expect(f.writes()).toBe(previous);
  const first=f.body(0);
  await expect(f.action.apply({...first,byteCount:first.byteCount+1})).rejects.toThrow('book_request_invalid');
  expect(f.writes()).toBe(previous);
  const restarted=new BookSyncActions(f.db,f.store);
  for(let i=0;i<last.chunkIndex;i++)await restarted.apply(f.body(i));
  const installed=await f.store.package(f.state.bookId);
  expect(installed?.sha256).toBe(f.info.sha256);
  expect(await f.db.query('SELECT * FROM sync_book_part_receipts')).toEqual([]);
 }finally{f.sql.close();}
});

test('replay of a published v1 package resumes interrupted part and receipt cleanup',async()=>{
 const f=await setup();
 try{
  await f.store.merge(f.state);
  const count=f.body(0).chunkCount;
  for(let i=0;i<count-1;i++)await f.action.apply(f.body(i));
  const staged=await f.db.query('SELECT path FROM sync_book_parts ORDER BY chunk_index');
  const firstPath=String(staged[0]?.path),remove=f.files.remove;
  f.files.remove=async path=>{if(path===firstPath)throw Error('interrupted part cleanup');await remove(path);};
  await expect(f.action.apply(f.body(count-1))).rejects.toThrow('interrupted part cleanup');
  expect((await f.store.package(f.state.bookId))?.sha256).toBe(f.info.sha256);
  const pending=await f.db.query('SELECT path FROM sync_book_parts');
  expect(pending).toHaveLength(count);
  expect(await f.db.query('SELECT received FROM sync_book_part_receipts')).toEqual([{received:count}]);
  f.files.remove=remove;
  const reopened=new BookSyncActions(f.db,f.store);
  expect(await reopened.apply(f.body(0))).toMatchObject({received:true,complete:true,applied:0});
  expect(await f.db.query('SELECT * FROM sync_book_parts')).toEqual([]);
  expect(await f.db.query('SELECT * FROM sync_book_part_receipts')).toEqual([]);
  for(const row of pending)expect(f.data.has(String(row.path))).toBe(false);
 }finally{f.sql.close();}
});

test('v1 book replay rechecks rollback protection before confirming a previously installed package',async()=>{
 const f=await setup();
 try{
  const guard=await localTransferIntakeFixture(f.db,{backendBaseUrl:'https://fixture.invalid',userId:'11000000-0000-0000-0000-000000000000'},'22000000-0000-0000-0000-000000000000');
  const receive=(action:BookSyncActions,request:ReturnType<typeof f.body>)=>guard.intake(guard.account,guard.deviceId,check=>action.apply(request,undefined,undefined,check));
  await f.action.apply({...f.request('manifest'),books:[{...f.state,contentAvailable:true}]});
  const count=f.body(0).chunkCount;
  for(let i=0;i<count;i++)await receive(f.action,f.body(i));
  expect((await f.store.package(f.state.bookId))?.sha256).toBe(f.info.sha256);
  await guard.rollback();
  const reopened=new BookSyncActions(f.db,f.store);
  await expect(receive(reopened,f.body(0))).rejects.toThrow('BUSINESS_REJECTED');
  await expect(receive(reopened,f.body(count-1))).rejects.toThrow('BUSINESS_REJECTED');
  const state=await guard.store.readState(),keys=state.pendingChoice?.inboxKeys;
  expect(keys).toHaveLength(1);
  const {entry}=await guard.store.legacyChoiceEntry(keys![0]!);
  expect(entry.transferBody).toMatchObject({sha256:f.info.sha256,size:f.info.size});
  await guard.store.legacyBodies.verify(entry.transferBody);
  const tombstone={...f.state,deleted:true,deletionClock:20,deletedAt:20,updatedAt:20,contentAvailable:false};
  await expect(guard.intake(guard.account,guard.deviceId,check=>reopened.apply({...f.request('manifest'),books:[tombstone]},undefined,undefined,check))).rejects.toThrow('BUSINESS_REJECTED');
  expect((await guard.store.readState()).pendingChoice?.inboxKeys).toHaveLength(2);
  expect((await f.store.transferState(f.state.bookId))?.deleted).toBe(false);
  expect((await f.store.package(f.state.bookId))?.sha256).toBe(f.info.sha256);
 }finally{f.sql.close();}
});
