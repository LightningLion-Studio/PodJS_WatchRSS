import {expect,test} from 'bun:test';
import {MemoRepository} from '../../src/notes/repository';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {fixture,scope} from './p6-fix-fixture';

const noteId='00000000-0000-0000-0000-000000000099';

for(const when of ['offline','offline title edit','during download','during apply'] as const){
 test(`first cloud follow publishes a saved local memo (${when})`,async()=>{
  const phone=await fixture(),watch=await fixture();
  let remote:Awaited<ReturnType<typeof openApplicationSyncV2>>|undefined;
  let local:typeof remote;
  try{
   remote=await openApplicationSyncV2(phone.options);
   expect(phone.server.events).toBe(1);
   await watch.db.execute('DELETE FROM memo_notes');
   const notes=new MemoRepository(watch.db,watch.options.legacyDeviceId,()=>noteId,()=>200);
   const markdown='This local memo must survive.';
   const title=`watch note: ${when}`;
   if(when.startsWith('offline')){
    expect(await watch.db.query("SELECT name FROM sqlite_master WHERE name='business_sync_revision'")).toEqual([]);
    await notes.save({title:when==='offline'?title:'initial title',markdown});
    if(when==='offline title edit')await notes.save({noteId,title,markdown});
    expect(await watch.db.query('SELECT title FROM memo_notes WHERE content_hash=base_content_hash')).toEqual([{title}]);
   }
   const host=watch.options.host;
   let savedDuringFollow=false;
   watch.options.host=async(method:string,args:{statements?:{sql:string}[]})=>{
    if(when==='during apply'&&!savedDuringFollow&&method==='sql.transaction'&&
      args.statements?.some(statement=>statement.sql.startsWith('UPDATE syncv2_state SET body='))&&
      args.statements.some((statement:{sql:string})=>statement.sql.includes('syncv2_business_basis'))){
     savedDuringFollow=true;
     await notes.save({title,markdown});
    }
    return host(method,args);
   };
   const transport={async request(request:Parameters<typeof phone.options.transport.request>[0]){
    const path=decodeURIComponent(new URL(request.url).pathname).replace('/functions/v1/sync/v2','');
    if(when==='during download'&&!savedDuringFollow&&path==='/account/ancestry'){
     savedDuringFollow=true;
     await notes.save({title,markdown});
    }
    if(path==='/account')return {status:200,headers:{},body:jsonBytes(phone.server.window())};
    const response=await phone.options.transport.request(request);
    if(request.method==='PUT'&&path.includes('/parts/')){
     const oid=path.split('/')[2]!;
     const uploaded=phone.server.partials.get(oid);
     if(uploaded&&uploaded.length===phone.server.totals.get(oid))phone.server.objects.set(oid,uploaded);
    }
    if(path==='/state-refs'){
     const {body}=parseCanonicalJson(request.body!);
     return {...response,body:jsonBytes({version:2,scope,...phone.server.tables.get(body.stateOid),accepted:true})};
    }
    return response;
   }};
   const options={...watch.options,transport,fastSync:()=>when==='during apply'};
   local=await openApplicationSyncV2(options);
   if(when.startsWith('during'))expect(savedDuringFollow).toBe(true);
   expect(local).not.toBeNull();
   expect(await notes.get(noteId)).toMatchObject({title,markdown});
   expect(phone.server.events).toBe(2);
   expect(await notes.get('n')).toMatchObject({title:'title n'});
   await remote!.sync();
   await local!.sync();
   for(const {db} of [phone,watch]){
    expect(await db.query('SELECT title,markdown FROM memo_notes WHERE note_id=? AND deleted=0',[noteId])).toEqual([{title,markdown}]);
    expect(await db.query("SELECT title FROM memo_notes WHERE title='title n' AND deleted=0")).toEqual([{title:'title n'}]);
   }
  }finally{
   await local?.close();
   await remote?.close();
   watch.db.close();
   phone.db.close();
  }
 });
}

for(const change of ['none','resave','older timestamp','newer timestamp'] as const){
 test(`first follow keeps one matching memo (${change})`,async()=>{
  const phone=await fixture(),watch=await fixture();
  let remote:Awaited<ReturnType<typeof openApplicationSyncV2>>|undefined;
  let local:typeof remote;
  const title='Matching memo',markdown='Same saved text.';
  try{
   for(const side of [phone,watch]){
    await side.db.execute('DELETE FROM memo_notes');
    const notes=new MemoRepository(side.db,side.options.legacyDeviceId,()=>'n',()=>200);
    await notes.save({title,markdown});
   }
   remote=await openApplicationSyncV2(phone.options);
   if(change==='resave'){
    const notes=new MemoRepository(watch.db,watch.options.legacyDeviceId,undefined,()=>202);
    await notes.save({noteId:'n',title,markdown});
   }
   if(change==='older timestamp')await watch.db.execute("UPDATE memo_notes SET updated_at=199 WHERE note_id='n'");
   if(change==='newer timestamp')await watch.db.execute("UPDATE memo_notes SET updated_at=201 WHERE note_id='n'");

   local=await openApplicationSyncV2({...watch.options,transport:phone.options.transport});
   expect(local).not.toBeNull();
   expect(local!.initialResult.completionError).not.toBe('choice_pending');
   await local!.sync();
   await remote!.sync();
   await local!.sync();
   const updatedAt=change==='resave'?202:change==='newer timestamp'?201:200;
   for(const {db} of [watch,phone]){
    expect(await db.query('SELECT note_id,title,markdown,updated_at FROM memo_notes WHERE deleted=0')).toEqual([
     {note_id:'n',title,markdown,updated_at:updatedAt},
    ]);
   }
  }finally{
   await local?.close();
   await remote?.close();
   watch.db.close();
   phone.db.close();
  }
 });
}

test('first follow with a shared memo ID keeps both versions through cloud choice',async()=>{
 const phone=await fixture(),watch=await fixture();
 let remote:Awaited<ReturnType<typeof openApplicationSyncV2>>|undefined;
 let local:typeof remote;
 try{
  for(const side of [phone,watch]){
   const matching=new MemoRepository(side.db,side.options.legacyDeviceId,()=>noteId,()=>side===watch?201:200);
   await matching.save({title:'Matching memo',markdown:'Same saved text.'});
  }
  remote=await openApplicationSyncV2(phone.options);
  const notes=new MemoRepository(watch.db,watch.options.legacyDeviceId);
  await notes.save({noteId:'n',title:'offline edit',markdown:'Unpublished watch text.'});
  const transport=cloudChoiceTransport(phone);
  local=await openApplicationSyncV2({...watch.options,transport});
  expect(phone.server.events).toBe(1);
  expect(await notes.get('n')).toMatchObject({title:'offline edit'});
  await local!.ui.setKeepDiscarded(false);
  const preview=await local!.ui.openChoice();
  await local!.ui.chooseCloud(preview!);
  const cloudNotes=new MemoRepository(phone.db,phone.options.legacyDeviceId);
  await cloudNotes.save({noteId:'n',title:'new cloud title',markdown:'New cloud text.'});
  await remote!.sync();
  await local!.sync();
  await local!.sync();
  await remote!.sync();
  expect(phone.server.events).toBe(3);
  for(const {db} of [watch,phone]){
   expect(await db.query('SELECT title,markdown FROM memo_notes WHERE deleted=0 AND note_id!=? ORDER BY title',[noteId])).toEqual([
    {title:'new cloud title',markdown:'New cloud text.'},
    {title:'offline edit',markdown:'Unpublished watch text.'},
   ]);
   expect(await db.query("SELECT note_id,updated_at FROM memo_notes WHERE title='Matching memo' AND deleted=0")).toEqual([
    {note_id:noteId,updated_at:201},
   ]);
  }
 }finally{
  await local?.close();
  await remote?.close();
  watch.db.close();
  phone.db.close();
 }
});


function cloudChoiceTransport(phone:Awaited<ReturnType<typeof fixture>>){
 return {async request(request:Parameters<typeof phone.options.transport.request>[0]){
  if(new URL(request.url).pathname.endsWith('/choices/cloud')){
   const {choiceId}=parseCanonicalJson(request.body!),account=phone.server.account;
   return {status:200,headers:{},body:jsonBytes({version:2,scope,choiceId,account,confirmedAccount:account,auditRevision:phone.server.serverRevision})};
  }
  return phone.options.transport.request(request);
 }};
}

test('cloud choice keeps edited copies and deduplicates a later restore of the same memo',async()=>{
 const phone=await fixture(),first=await fixture(),restored=await fixture(),repeated=await fixture();
 const opened:NonNullable<Awaited<ReturnType<typeof openApplicationSyncV2>>>[]=[];
 const title='Offline memo',markdown='The original unpublished text.';
 try{
  const remote=(await openApplicationSyncV2(phone.options))!;
  opened.push(remote);
  const transport=cloudChoiceTransport(phone);
  const choose=async(side:typeof first,time:number)=>{
   await new MemoRepository(side.db,side.options.legacyDeviceId,undefined,()=>time).save({noteId:'n',title,markdown});
   const client=(await openApplicationSyncV2({...side.options,transport}))!;
   opened.push(client);
   expect((await client.ui.snapshot()).choice).not.toBeNull();
   await client.ui.chooseCloud(await client.ui.openChoice());
   const snapshot=await client.ui.snapshot();
   expect(snapshot.keepDiscardedLocalChanges7Days).toBe(true);
   expect(snapshot.recoveryCopies).toHaveLength(1);
   await client.sync();
   await client.sync();
   await remote.sync();
  };
  const copies=()=>phone.db.query("SELECT note_id,title,markdown FROM memo_notes WHERE note_id!='n' AND deleted=0 ORDER BY note_id");
  await choose(first,200);
  const [original]=await copies();
  const noteId=String(original!.note_id),edited={note_id:noteId,title:'Edited cloud copy',markdown:'This edit must survive.'};
  await new MemoRepository(phone.db,phone.options.legacyDeviceId,undefined,()=>250).save({noteId,title:edited.title,markdown:edited.markdown});
  await remote.sync();
  await remote.sync();
  await choose(restored,200);
  const afterRestore=await copies();
  expect(afterRestore).toHaveLength(2);
  expect(afterRestore).toContainEqual(edited);
  expect(afterRestore.find(row=>row.note_id!==noteId)).toMatchObject({title,markdown});
  const events=phone.server.events;
  await choose(repeated,201);
  expect(await copies()).toEqual(afterRestore);
  expect(phone.server.events).toBe(events);
 }finally{
  for(const client of opened.reverse())await client.close();
  for(const side of [repeated,restored,first,phone])side.db.close();
 }
},30000);

test('cloud choice reuses one retained memo and preserves each offline conflict',async()=>{
 const phone=await fixture(),first=await fixture(),restored=await fixture(),repeated=await fixture();
 const opened:NonNullable<Awaited<ReturnType<typeof openApplicationSyncV2>>>[]=[];
 try{
  const remote=(await openApplicationSyncV2(phone.options))!;
  opened.push(remote);
  const transport=cloudChoiceTransport(phone);
  const copies=(side:typeof first)=>side.db.query("SELECT note_id FROM memo_notes WHERE note_id!='n' AND deleted=0");
  const conflicts=(side:typeof first)=>side.db.query('SELECT note_id,remote_markdown FROM note_merge_conflicts ORDER BY remote_markdown');
  const sync=async(side:typeof first,offlineText:string,expectedTexts:string[])=>{
   const notes=new MemoRepository(side.db,side.options.legacyDeviceId,undefined,()=>200);
   await notes.save({noteId:'n',title:'Offline memo',markdown:'Unpublished text'});
   const note=(await notes.get('n'))!;
   await notes.applyRemote({...note,markdown:offlineText,modifiedBy:'offline-peer',updatedAt:250});
   expect(await conflicts(side)).toEqual([{note_id:'n',remote_markdown:offlineText}]);
   const client=(await openApplicationSyncV2({...side.options,transport}))!;
   opened.push(client);
   await client.ui.setKeepDiscarded(false);
   await client.ui.chooseCloud(await client.ui.openChoice());
   const retained=await copies(side);
   expect(retained).toHaveLength(1);
   const expected=expectedTexts.map(text=>({note_id:retained[0]!.note_id,remote_markdown:text}));
   expect(await conflicts(side)).toEqual(expected);
   await client.sync();
   await client.sync();
   await remote.sync();
   expect(await copies(phone)).toEqual(retained);
   expect(await conflicts(phone)).toEqual(expected);
  };
  await sync(first,'First offline conflict',['First offline conflict']);
  const retained=await copies(phone);
  const conflictsAfterRestore=['First offline conflict','Second offline conflict'];
  await sync(restored,'Second offline conflict',conflictsAfterRestore);
  await sync(repeated,'Second offline conflict',conflictsAfterRestore);
  expect(await copies(phone)).toEqual(retained);
 }finally{
  for(const client of opened.reverse())await client.close();
  for(const side of [repeated,restored,first,phone])side.db.close();
 }
},30000);

test.each([
 ['Shared folder',200,201],
 ['Shared folder',201,200],
 ['Local name',200,201],
] as const)('first follow resolves a shared folder (%s, cloud %d, watch %d)',async(name,cloudTime,watchTime)=>{
 const phone=await fixture(),watch=await fixture();
 let remote:Awaited<ReturnType<typeof openApplicationSyncV2>>|undefined;
 let local:typeof remote;
 try{
  await watch.db.execute('DELETE FROM memo_notes');
  await new MemoRepository(phone.db,phone.options.legacyDeviceId,()=>'shared-folder',()=>cloudTime).createFolder('Shared folder');
  await new MemoRepository(watch.db,watch.options.legacyDeviceId,()=>'shared-folder',()=>watchTime).createFolder(name);
  const notes=new MemoRepository(watch.db,watch.options.legacyDeviceId,()=>'offline-note',()=>202);
  await notes.save({title:'Offline memo',markdown:'Unpublished text'});
  await notes.move('offline-note','shared-folder');
  remote=await openApplicationSyncV2(phone.options);
  local=await openApplicationSyncV2({...watch.options,transport:cloudChoiceTransport(phone)});
  const different=name!=='Shared folder';
  if(different){
   expect((await local!.ui.snapshot()).choice).not.toBeNull();
   expect(phone.server.events).toBe(1);
   await local!.ui.chooseCloud(await local!.ui.openChoice());
   await local!.sync();
  }
  expect((await local!.ui.snapshot()).choice).toBeNull();
  expect(phone.server.events).toBe(2);
  await remote!.sync();
  for(const {db} of [watch,phone]){
   expect(await db.query("SELECT name,updated_at FROM memo_folders WHERE folder_id='shared-folder' AND deleted=0")).toEqual([
    {name:'Shared folder',updated_at:different?cloudTime:Math.max(cloudTime,watchTime)},
   ]);
   expect(await db.query("SELECT folder_id,markdown FROM memo_notes WHERE note_id='offline-note' AND deleted=0")).toEqual([
    {folder_id:'shared-folder',markdown:'Unpublished text'},
   ]);
  }
 }finally{
  await local?.close();
  await remote?.close();
  watch.db.close();
  phone.db.close();
 }
},30000);
