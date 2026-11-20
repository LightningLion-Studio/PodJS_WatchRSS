import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {p5Fixture,dirtyRollback} from './p5-fixture';
import {canonical} from '../../src/sync-v2/protocol';
import {sha256Hex} from '@podjs/framework/crypto';
import {SEVEN_DAYS} from '../../src/sync-v2/eviction';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {fromWire} from '../../src/sync-v2/business';
import {watchSyncV2UiState} from '../../src/sync-v2/ui-state';
const id=()=>randomBytes(16).toString('hex');
async function receive(f:Awaited<ReturnType<typeof p5Fixture>>,cursor:string,title:string){const r=(await f.projection.candidatePage())[0]!,value=fromWire(r.candidate.meta.kind,r.candidate.meta.payload,r.candidate.state.payload);await f.projection.receiveLegacy({peer:'p5-peer',version:14,cursor,entityKeys:[r.entityKey],body:{[r.entityKey]:{identity:'n',...value,title}},bodyRefsByEntity:{[r.entityKey]:[]}},null);return canonical(['p5-peer',14,cursor]);}
test('P5 legacy cloud captures only the incoming set and never changes native rows or applied ACK',async()=>{const f=await p5Fixture();try{await dirtyRollback(f);const a=await receive(f,'one','incoming one'),b=await receive(f,'two','incoming two'),proof=await f.control.pendingLegacyChoice(a),before=(await f.db.query('SELECT title FROM memo_notes'))[0]!.title;await f.control.chooseCloud(proof.proof,id());const s=await f.projection.readStableState();expect((await f.db.query('SELECT title FROM memo_notes'))[0]!.title).toBe(before);expect(s.pendingChoice!.inboxKeys).toEqual([b]);expect(s.applied['p5-peer']).toBeUndefined();const incoming=await f.projection.legacyChoiceEntry(a);expect(incoming.entry.route).toBe('discarded-for-cloud');expect(incoming.entry.applied).toBe(false);expect(incoming.entry.body).toBe('{}');const delta=await f.recovery.read(s.recoveryCopies![0]!);expect((delta.changes[0] as any).value.title).toBe('incoming one');expect(delta.changes).toHaveLength(1);}finally{f.close();}});
test('P5 legacy local second entry cannot advance applied ACK over the first gap',async()=>{const f=await p5Fixture();try{await dirtyRollback(f);const a=await receive(f,'opaque-first','first'),b=await receive(f,'opaque-second','second');await f.control.chooseLocal((await f.control.pendingLegacyChoice(b)).proof,id());let s=await f.projection.readStableState();expect(s.pendingChoice!.inboxKeys).toEqual([a]);expect(s.applied['p5-peer']).toBeUndefined();expect((await f.db.query('SELECT title FROM memo_notes'))[0]!.title).toBe('second');await f.control.chooseLocal((await f.control.pendingLegacyChoice(a)).proof,id());s=await f.projection.readStableState();expect(s.applied['p5-peer']).toBe('opaque-second');expect(s.pendingChoice).toBeNull();}finally{f.close();}});
test('P5 account-wide action refuses a legacy-only preview without consuming input',async()=>{const f=await p5Fixture();try{await dirtyRollback(f);const key=await receive(f,'one','incoming'),p=await f.control.pendingChoice();await expect(f.control.chooseCloud(p!.proof,id())).rejects.toThrow('legacy_choice_required');expect((await f.projection.legacyChoiceEntry(key)).entry.route).toBe('pendingChoice');expect(f.server.choiceCalls).toBe(0);}finally{f.close();}});

for(const version of [2,14] as const)test('the choice screen applies protected book metadata before package data is available, intake '+version,async()=>{
 const f=await p5Fixture();
 try{
  await initializeSchema(f.db as SqlDatabase);
  await f.projection.initialize();
  await dirtyRollback(f);
  const {default:fixture}=await import('../fixtures/cli-single-txt-book.json');
  const {bookId,fingerprint,sourceUrl}=fixture;
  const book={bookId,fingerprint,sourceUrl,title:'Incoming book',chapterCount:1,kind:'txt',deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'phone'};
  const input={peer:'book-phone',version,cursor:'book-state',records:[{kind:'book' as const,logicalId:bookId,value:book}]};
  expect(await f.projection.protectLocalInput(input)).toBe(true);
  const key=canonical([input.peer,input.version,input.cursor]);
  const ui=watchSyncV2UiState({runtime:{pull:async()=>({empty:true}),publish:async()=>({})},control:f.control,projection:f.projection,trustedNow:()=>f.server.clock});
  const preview=await ui.openChoice();
  expect(preview.local).toEqual([{title:'Incoming book',kind:'add'}]);
  await ui.chooseLocal(preview);
  expect(await f.db.query('SELECT book_id,package_path FROM sync_books')).toEqual([{book_id:bookId,package_path:null}]);
  const state=await f.projection.readStableState(),entity=f.projection.entityKeyFor('book',bookId);
  expect((await f.projection.cloudRow(state.cloud.current.treeRoot,entity)).row.bodyRevision).toBeNull();
  expect((await f.projection.legacyChoiceEntry(key)).entry.applied).toBe(true);
  expect(await f.projection.protectLocalInput(input)).toBe(false);
 }finally{f.close();}
});

test('protected book bytes survive transport cleanup and cloud choice until the recovery copy expires',async()=>{
 const f=await p5Fixture();
 try{
  await dirtyRollback(f);
  const {default:fixture}=await import('../fixtures/cli-single-txt-book.json');
  const {bookId,fingerprint,sourceUrl}=fixture,entityKey=f.projection.entityKeyFor('book',bookId);
  const book={identity:bookId,bookId,fingerprint,sourceUrl,title:'Archived book',chapterCount:1,kind:'txt',deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'phone'};
  const input={peer:'book-phone',version:2 as const,cursor:'book-commit',entityKeys:[entityKey],identitiesByEntity:{[entityKey]:{kind:'book' as const,logicalId:bookId}},body:{[entityKey]:book}};
  let staged:Uint8Array|undefined=new Uint8Array(3*65536+1).fill(111);
  const sha256=sha256Hex(staged),size=staged.length;let reads=0;
  const source={sha256,size,read:async(offset:number,length:number)=>{reads++;expect(length).toBeLessThanOrEqual(65536);return staged!.slice(offset,offset+length);}};
  expect(await f.projection.receiveLegacy(input,null,{source})).toEqual({duplicate:false,route:'pendingChoice',ack:false});
  expect(await f.projection.receiveLegacy(input,null,{source})).toEqual({duplicate:true,ack:false});
  expect(reads).toBe(4);
  staged=undefined;
  const inboxKey=canonical([input.peer,input.version,input.cursor]),preview=await f.control.pendingLegacyChoice(inboxKey);
  await f.control.chooseCloud(preview.proof,id());
  const state=await f.projection.readState(),copy=state.recoveryCopies!.at(-1)!;
  expect(state.applied[input.peer]).toBeUndefined();
  expect((await f.projection.legacyChoiceEntry(inboxKey)).entry.transferBody).toBeUndefined();
  const body=new Uint8Array(size);
  await f.db.execute('CREATE TABLE archive_restore_probe(received INTEGER NOT NULL)');
  await f.recovery.restoreAsEdits(copy.copyId,async(delta,archive)=>{
   expect(delta.changes).toHaveLength(1);
   let restored=0;
   await archive!.read(async(part,offset)=>{restored+=part.length;body.set(part,offset);});
   return [{sql:'INSERT INTO archive_restore_probe VALUES(?)',params:[restored]}];
  });
  expect(sha256Hex(body)).toBe(sha256);
  expect(await f.db.query('SELECT received FROM archive_restore_probe')).toEqual([{received:size}]);
  const now=copy.header.createdAtMillis;
  await f.recovery.purgeRecovery(now+SEVEN_DAYS-1);
  expect((await f.db.query('SELECT COUNT(*) AS n FROM syncv2_legacy_body'))[0]!.n).toBe(4);
  await f.recovery.purgeRecovery(now+SEVEN_DAYS);
  expect((await f.db.query('SELECT COUNT(*) AS n FROM syncv2_legacy_body'))[0]!.n).toBe(0);
 }finally{f.close();}
});
