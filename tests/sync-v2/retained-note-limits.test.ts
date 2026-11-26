import {expect,test} from 'bun:test';
import {MemoRepository} from '../../src/notes/repository';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {newConflictId} from '../../src/sync-v2/notes-conflict';
import {jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {fixture,scope} from './p6-fix-fixture';

type Side=Awaited<ReturnType<typeof fixture>>;
type Client=NonNullable<Awaited<ReturnType<typeof openApplicationSyncV2>>>;
type Scenario={
 noteId:string;markdown:string;cloudCount:number;localCount:number;
 cloudWidth:number;localWidth:number;standardIds?:boolean;
 expected?:'merged'|'separate'|'recovery';interrupt?:boolean;
};

async function verifyRetention(s:Scenario){
 const phone=await fixture(),watch=await fixture(),opened:Client[]=[];
 const notes=(side:Side)=>new MemoRepository(side.db,side.options.legacyDeviceId,()=>s.noteId,()=>side===phone?200:201);
 const title='Offline memo';
 const makeTexts=(prefix:string,count:number,width:number)=>Array.from({length:count},(_,i)=>prefix.repeat(width+1)+'-'+i);
 const cloudTexts=makeTexts('A',s.cloudCount,s.cloudWidth),localTexts=makeTexts('B',s.localCount,s.localWidth);
 const sorted=(values:string[])=>[...values].sort();
 const liveNotes=(side:Side)=>side.db.query('SELECT note_id,title,markdown FROM memo_notes WHERE deleted=0 ORDER BY note_id');
 const conflicts=(side:Side)=>side.db.query('SELECT note_id,remote_markdown FROM note_merge_conflicts ORDER BY remote_markdown');
 let requests=0;
 const transport={async request(request:Parameters<typeof phone.options.transport.request>[0]){
  const path=new URL(request.url).pathname;
  if(path.endsWith('/choices/cloud')){
   requests++;
   const {choiceId}=parseCanonicalJson(request.body!),account=phone.server.account;
   return {status:200,headers:{},body:jsonBytes({version:2,scope,choiceId,account,confirmedAccount:account,auditRevision:phone.server.serverRevision})};
  }
  return phone.options.transport.request(request);
 }};
 const openWatch=async()=>{
  const client=(await openApplicationSyncV2({...watch.options,transport}))!;
  opened.push(client);
  return client;
 };
 try{
  for(const [side,texts] of [[phone,cloudTexts],[watch,localTexts]] as const){
   await side.db.execute('DELETE FROM memo_notes');
   // The conflicting folder opens the user choice while the memo content
   // remains identical on both devices.
   await side.db.execute('INSERT INTO memo_folders VALUES(?,?,0,200,?,0,0)',['choice-folder',side===phone?'Cloud folder':'Local folder','p']);
   await notes(side).save({title,markdown:s.markdown});
   // Keep the source state within its own record limit. The two sides
   // contribute different conflict text to the proposed union.
   await side.db.execute("UPDATE memo_notes SET base_markdown='',plain_text=''");
   await side.db.execute('CREATE TABLE IF NOT EXISTS note_merge_conflicts(conflict_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,base_markdown TEXT NOT NULL,local_markdown TEXT NOT NULL,remote_markdown TEXT NOT NULL,remote_device_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
   await side.db.transaction(texts.map((text,i)=>({
    sql:'INSERT INTO note_merge_conflicts VALUES(?,?,?,?,?,?,?)',
    params:[s.standardIds?newConflictId(s.noteId,'','x',text,'p'):text[0]+'-'+i,s.noteId,'','x',text,'p',250+i],
   })));
  }
  const remote=(await openApplicationSyncV2(phone.options))!;
  opened.push(remote);
  expect(remote.initialResult.completionError).toBeNull();
  expect(await conflicts(phone)).toHaveLength(cloudTexts.length);

  const client=await openWatch();
  expect(client.initialResult.completionError).toBe('choice_pending');
  await client.ui.setKeepDiscarded(false);
  const {control,projection}=(client.ui as any).o;
  const preview=await client.ui.openChoice();
  let stagedCopyId:string|undefined,stagedAt:number|undefined;
  if(s.interrupt){
   const original=projection.choiceUpdate.bind(projection) as typeof projection.choiceUpdate;
   projection.choiceUpdate=async(...args:any[])=>{
    const copies=args[1].recoveryCopies;
    if(copies?.length&&!stagedCopyId){
     stagedCopyId=copies[0].copyId;
     stagedAt=copies[0].header.createdAtMillis;
     throw Error('test_interrupted_before_choice_commit');
    }
    return original(...args);
   };
   const startedAt=watch.options.clock.now()!;
   await expect(client.ui.chooseCloud(preview)).rejects.toThrow('test_interrupted_before_choice_commit');
   const pending=await projection.readState();
   expect(pending.cloud.pendingCloudChoice.phase).toBe('accepted');
   expect(pending.recoveryCopies??[]).toEqual([]);
   expect((await conflicts(watch)).map(row=>row.remote_markdown)).toEqual(sorted(localTexts));
   expect(stagedCopyId).toEqual(expect.any(String));
   expect(watch.options.clock.observe(startedAt+1000)).toBe(true);
   expect((await client.sync()).completionError).toBeNull();
  }else{
   let apply=()=>client.ui.chooseCloud(preview);
   for(let attempt=0;;attempt++){
    try{
     expect(await apply()).toMatchObject({applied:true});
     break;
    }catch(error){
     // A large SQL plan may take more than one bounded preparation window.
     if((error as Error).message!=='projection_preparing'||attempt>=3)throw error;
     expect((await projection.readState()).cloud.pendingCloudChoice.phase).toBe('accepted');
     expect((await conflicts(watch)).map(row=>row.remote_markdown)).toEqual(sorted(localTexts));
     apply=()=>control.resumeCloudChoice();
    }
   }
  }


  const state=await projection.readState();
  expect(state.cloud.pendingCloudChoice).toBeNull();
  expect(state.pendingChoice).toBeNull();
  expect(state.recoveryPins??[]).toHaveLength(state.recoveryCopies?.length??0);
  expect(requests).toBe(1);
  const copies=state.recoveryCopies??[],native=await liveNotes(watch),live=await conflicts(watch);
  expect(native).toContainEqual({note_id:s.noteId,title,markdown:s.markdown});
  for(const note of native)expect(note).toMatchObject({title,markdown:s.markdown});
  if(copies.length){
   expect(copies).toHaveLength(1);
   const [copy]=copies;
   expect(copy.header.retainedUnsentNotes).toBe(true);
   if(s.interrupt){
    expect(copy.copyId).toBe(stagedCopyId);
    expect(copy.header.createdAtMillis).toBeGreaterThan(stagedAt!);
   }
   expect(await control.recoveryCopies()).toMatchObject([{copyId:copy.copyId}]);
   const delta=await control.o.recovery.read(copy);
   expect(delta.changes).toHaveLength(1);
   expect(delta.changes[0]).toMatchObject({kind:'set',value:{noteId:s.noteId,title,markdown:s.markdown}});
   expect(delta.changes[0].value.noteConflicts.records.map((r:{remoteMarkdown:string})=>r.remoteMarkdown).sort()).toEqual(sorted(localTexts));
   expect(live.map(row=>row.remote_markdown)).toEqual(sorted(cloudTexts));
   expect(native).toHaveLength(1);
   if(s.expected)expect(s.expected).toBe('recovery');
  }else{
   expect(live.map(row=>row.remote_markdown)).toEqual(sorted([...cloudTexts,...localTexts]));
   expect(native.length).toBeLessThanOrEqual(2);
   if(s.expected)expect(native).toHaveLength(s.expected==='merged'?1:2);
  }

  const beforeSync=phone.server.events;
  expect((await client.sync()).completionError).toBeNull();
  expect((await remote.sync()).completionError).toBeNull();
  expect(await liveNotes(phone)).toEqual(native);
  expect(await conflicts(phone)).toEqual(live);
  if(copies.length)expect(phone.server.events).toBe(beforeSync);
  const events=phone.server.events;
  expect(await control.resumeCloudChoice()).toMatchObject({applied:false});
  expect((await client.sync()).completionError).toBeNull();
  expect(phone.server.events).toBe(events);
  expect(requests).toBe(1);
  expect((await projection.readState()).recoveryCopies??[]).toEqual(copies);
  expect(await liveNotes(watch)).toEqual(native);
  expect(await conflicts(watch)).toEqual(live);

  if(s.interrupt){
   expect(await client.ui.restoreRecovery(copies[0].copyId)).toBe(1);
   expect(await notes(watch).get(s.noteId)).toMatchObject({title,markdown:s.markdown});
   expect((await conflicts(watch)).map(row=>row.remote_markdown)).toEqual(sorted(localTexts));
  }
 }finally{
  for(const client of opened.reverse())await client.close();
  watch.db.close();
  phone.db.close();
 }
}

test('retains 1,025 conflicts in two publishable memos',()=>verifyRetention({
 noteId:'n',markdown:'Original offline content',cloudCount:512,localCount:513,
 cloudWidth:0,localWidth:0,expected:'separate',
}),30000);

test('archives the original when the longer copy ID makes it unencodable',()=>verifyRetention({
 noteId:'n',markdown:'Original offline content',cloudCount:1,localCount:512,
 cloudWidth:39999,localWidth:289,standardIds:true,expected:'recovery',interrupt:true,
}),30000);

// Count is the proposed union. Body targets are the sum of both Markdown
// inputs, clipped only when necessary to keep each source record encodable.
for(const count of [0,1,1024,1025,2000])for(const target of [0,260000,264000])for(const noteId of ['n','00000000-0000-0000-0000-000000000099']){
 test(`cloud retention: ${count} conflicts, body target ${target}, ID length ${noteId.length}`,()=>{
  const cloudCount=Math.floor(count/2),localCount=count-cloudCount;
  const conflicts=Array.from({length:localCount},(_,i)=>({
   conflictId:'B-'+i,noteId,baseMarkdown:'',localMarkdown:'x',remoteMarkdown:'B-'+i,
   remoteDeviceId:'p',createdAt:250+i,resolvedAt:0,
  }));
  const available=262144-4096-jsonBytes(conflicts).length;
  const near=Math.min(130000,available-2000);
  const markdown='m'.repeat(target===0?0:near+(target-260000)/2);
  return verifyRetention({noteId,markdown,cloudCount,localCount,cloudWidth:0,localWidth:0});
 },30000);
}
