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

test('first follow with a shared memo ID keeps both versions through cloud choice',async()=>{
 const phone=await fixture(),watch=await fixture();
 let remote:Awaited<ReturnType<typeof openApplicationSyncV2>>|undefined;
 let local:typeof remote;
 try{
  remote=await openApplicationSyncV2(phone.options);
  const notes=new MemoRepository(watch.db,watch.options.legacyDeviceId);
  await notes.save({noteId:'n',title:'offline edit',markdown:'Unpublished watch text.'});
  const transport={async request(request:Parameters<typeof phone.options.transport.request>[0]){
   if(new URL(request.url).pathname.endsWith('/choices/cloud')){
    const {choiceId}=parseCanonicalJson(request.body!);
    const account=phone.server.account;
    return {status:200,headers:{},body:jsonBytes({version:2,scope,choiceId,account,confirmedAccount:account,auditRevision:phone.server.serverRevision})};
   }
   return phone.options.transport.request(request);
  }};
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
   expect(await db.query('SELECT title,markdown FROM memo_notes WHERE deleted=0 ORDER BY title')).toEqual([
    {title:'new cloud title',markdown:'New cloud text.'},
    {title:'offline edit',markdown:'Unpublished watch text.'},
   ]);
  }
 }finally{
  await local?.close();
  await remote?.close();
  watch.db.close();
  phone.db.close();
 }
});
