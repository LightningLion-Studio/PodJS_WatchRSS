import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import type {Statement} from '@podjs/framework/sql-projection';
import {MemoRepository} from '../../src/notes/repository';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {newConflictId} from '../../src/sync-v2/notes-conflict';
import {digest,jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import type {WatchProjectionStore} from '../../src/sync-v2/store';
import {fixture,scope} from './p6-fix-fixture';

const checkpoints=[
 'choice intent persisted',
 'choice acceptance persisted',
 'projection reserved',
 'projection reservation linked',
 'projection reservation released',
 'recovery reserved',
 'recovery write begins',
 'recovery written',
 'choice commit begins',
 'choice committed',
 'applied acknowledgement persisted',
] as const;
type Checkpoint=typeof checkpoints[number];
const noteId='n',title='Offline memo',markdown='Original offline content';
const cloudText='A'.repeat(40000)+'-0';
const localTexts=Array.from({length:512},(_,i)=>'B'.repeat(290)+'-'+i).sort();

async function checkReopen(checkpoint:Checkpoint,{recover=true,lowQuota=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'wrss-choice-quota-')),path=join(dir,'watch.sqlite');
 const phone=await fixture(),watch=await fixture({path,mode:'WAL'});
 type Client=NonNullable<Awaited<ReturnType<typeof openApplicationSyncV2>>>;
 const opened:Client[]=[];
 const local=recover?localTexts:[];
 const unrelated={id:'cloud-choice:'+'f'.repeat(32),bytes:1024};
 let capacity=1000000,armed=false,stopped=false,hit=false,reserves=0,requests=0,reads=0,readsAtReservation=0,requestId:string|undefined;
 const countsAtStop={requests:0,applied:0};
 const cut=(point:Checkpoint)=>{
  if(!armed||point!==checkpoint)return;
  hit=true;stopped=true;countsAtStop.requests=requests;countsAtStop.applied=phone.server.applied.length;
  throw Error('choice_host_stopped');
 };
 const host:typeof watch.options.host=async(method:string,args:any)=>{
  if(stopped)throw Error('choice_host_stopped');
  if(method==='file.stat')return {usableBytes:capacity+1048576};
  if(method!=='sql.transaction')return watch.options.host(method,args);
  const ops:Statement[]=args.statements;
  const reserved=ops.some(op=>op.sql.includes('SUM(bytes) FROM podjs_resource_quota'));
  if(reserved)readsAtReservation=reads;
  if(!armed)return watch.options.host(method,args);
  const released=ops.some(op=>op.sql==='DELETE FROM podjs_resource_quota WHERE binding=? AND id=? AND bytes=?');
  const recoveryWrite=ops.some(op=>op.sql.startsWith('INSERT INTO podjs_sql_value_chunks')&&String(op.params?.[0]).endsWith('#recovery'));
  const choiceCommit=ops.some(op=>op.sql.startsWith('UPDATE syncv2_state SET body='))&&
   ops.some(op=>('program' in op)||String(op.params?.[1]).startsWith('recovery:'));
  if(recoveryWrite)cut('recovery write begins');
  if(choiceCommit)cut('choice commit begins');
  const result=await watch.options.host(method,args);
  if(reserved)cut(++reserves===1?'projection reserved':'recovery reserved');
  if(released&&reserves===1)cut('projection reservation released');
  if(choiceCommit)cut('choice committed');
  return result;
 };
 const transport={async request(request:Parameters<typeof phone.options.transport.request>[0]){
  const path=new URL(request.url).pathname;
  if(path.endsWith('/negotiate'))reads++;
  if(path.endsWith('/choices/cloud')){
   requests++;
   const payload=parseCanonicalJson(request.body!),account=phone.server.account;
   requestId=payload.requestId;
   return {status:200,headers:{},body:jsonBytes({version:2,scope,choiceId:payload.choiceId,account,confirmedAccount:account,auditRevision:phone.server.serverRevision})};
  }
  return phone.options.transport.request(request);
 }};
 const openWatch=async()=>{
  const client=(await openApplicationSyncV2({...watch.options,host,transport}))!;
  opened.push(client);return client;
 };
 const projectionOf=(client:Client):WatchProjectionStore=>(client.ui as any).o.projection;
 const quotaRows=()=>watch.db.query('SELECT id,bytes FROM podjs_resource_quota ORDER BY id');
 const expectLive=async(texts:string[])=>{
  expect(await watch.db.query('SELECT note_id,title,markdown FROM memo_notes WHERE deleted=0')).toEqual([{note_id:noteId,title,markdown}]);
  const rows=await watch.db.query('SELECT remote_markdown FROM note_merge_conflicts ORDER BY remote_markdown');
  expect(rows.map(row=>row.remote_markdown)).toEqual(texts);
 };
 try{
  for(const [side,texts] of [[phone,[cloudText]],[watch,local]] as const){
   await side.db.execute('DELETE FROM memo_notes');
   await side.db.execute('INSERT INTO memo_folders VALUES(?,?,0,200,?,0,0)',['choice-folder',side===phone?'Cloud folder':'Local folder','p']);
   await new MemoRepository(side.db,side.options.legacyDeviceId,()=>noteId,()=>side===watch&&recover?201:200).save({title,markdown});
   await side.db.execute("UPDATE memo_notes SET base_markdown='',plain_text=''");
   await side.db.execute('CREATE TABLE IF NOT EXISTS note_merge_conflicts(conflict_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,base_markdown TEXT NOT NULL,local_markdown TEXT NOT NULL,remote_markdown TEXT NOT NULL,remote_device_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
   await side.db.transaction(texts.map((text,i)=>({
    sql:'INSERT INTO note_merge_conflicts VALUES(?,?,?,?,?,?,?)',
    params:[newConflictId(noteId,'','x',text,'p'),noteId,'','x',text,'p',250+i],
   })));
  }
  const remote=(await openApplicationSyncV2(phone.options))!;
  opened.push(remote);
  expect(remote.initialResult.completionError).toBeNull();

  const client=await openWatch(),projection=projectionOf(client);
  expect(client.initialResult.completionError).toBe('choice_pending');
  await client.ui.setKeepDiscarded(false);
  const preview=await client.ui.openChoice();
  const recovery=(client.ui as any).o.control.o.recovery;
  await watch.db.execute('CREATE TABLE IF NOT EXISTS podjs_resource_quota(binding TEXT NOT NULL,id TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(binding,id))');
  await watch.db.execute('INSERT INTO podjs_resource_quota VALUES(?,?,?)',[recovery.cache.binding,unrelated.id,unrelated.bytes]);

  const controlUpdate=projection.controlUpdate.bind(projection);
  projection.controlUpdate=async(...args)=>{
   await controlUpdate(...args);
   const [before,next]=args,intent=next.cloud?.pendingCloudChoice;
   if(intent&&!before.cloud?.pendingCloudChoice)cut('choice intent persisted');
   if(intent?.phase==='accepted'&&before.cloud?.pendingCloudChoice?.phase!=='accepted')cut('choice acceptance persisted');
  };
  const keepPlanReservation=projection.keepPlanReservation.bind(projection);
  projection.keepPlanReservation=async(...args)=>{
   const ref=await keepPlanReservation(...args);
   cut('projection reservation linked');return ref;
  };
  const choiceUpdate=projection.choiceUpdate.bind(projection);
  projection.choiceUpdate=async(...args)=>{
   if(args[1].recoveryCopies?.length)cut('recovery written');
   return choiceUpdate(...args);
  };
  const observationUpdate=projection.observationUpdate.bind(projection);
  projection.observationUpdate=async(...args)=>{
   await observationUpdate(...args);
   if(args[0].cloud?.pendingApplied&&!args[1].cloud?.pendingApplied)cut('applied acknowledgement persisted');
  };

  armed=true;
  await expect(client.ui.chooseCloud(preview)).rejects.toThrow();
  expect(hit).toBe(true);
  expect(countsAtStop.requests).toBe(checkpoint==='choice intent persisted'?0:1);
  const committed=checkpoint==='choice committed'||checkpoint==='applied acknowledgement persisted';
  await expectLive(committed?[cloudText]:local);
  expect(countsAtStop.applied).toBe(checkpoint==='applied acknowledgement persisted'?1:0);
  if(committed)expect(await quotaRows()).toEqual([unrelated]);

  await client.close().catch(()=>{});
  opened.pop();
  watch.db.close();
  Object.assign(watch.db,{raw:new Database(path)});
  watch.db.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  armed=false;stopped=false;
  capacity=lowQuota?700000:1500000;
  const retry=await openWatch(),reopened=projectionOf(retry);
  if(lowQuota){
   expect(retry.initialResult.completionError).toBe('choice_pending');
   expect((await reopened.readState()).cloud.pendingCloudChoice).toMatchObject({requestId,phase:'accepted'});
   expect(await quotaRows()).toEqual([unrelated]);
   expect(reads).toBeGreaterThan(readsAtReservation);
   await expectLive(local);
   expect(phone.server.applied).toHaveLength(0);
   capacity=1500000;
  }else expect(retry.initialResult.completionError).toBeNull();

  for(let round=0;round<2;round++)expect((await retry.sync()).completionError).toBeNull();
  const after=await reopened.readState();
  expect(after.cloud.pendingCloudChoice).toBeNull();
  expect(after.cloud.pendingApplied).toBeNull();
  expect(await quotaRows()).toEqual([unrelated]);
  expect(requests).toBe(1);
  expect(phone.server.applied).toHaveLength(1);
  await expectLive([cloudText]);
  const copies=after.recoveryCopies??[];
  expect(copies).toHaveLength(recover?1:0);
  if(recover){
   expect(copies[0].copyId).toBe(digest(['retain-unsent-notes',after.account!.oid,requestId]).slice(0,32));
   const delta=await (retry.ui as any).o.control.o.recovery.read(copies[0]);
   const changes=delta.changes.filter((change:any)=>change.value?.noteId===noteId);
   expect(changes).toHaveLength(1);
   expect(changes[0].value.markdown).toBe(markdown);
   expect(changes[0].value.noteConflicts.records.map((c:any)=>c.remoteMarkdown).sort()).toEqual(local);
  }
 }finally{
  for(const client of opened.reverse()){
   try{await client.close();}catch(error){if(!stopped)throw error;}
  }
  watch.db.close();phone.db.close();
  rmSync(dir,{recursive:true,force:true});
 }
}

for(const point of checkpoints)test('cloud choice reopens after '+point,()=>checkReopen(point),30000);
test('reopened choice defers under low quota and still reads cloud',()=>checkReopen('recovery reserved',{lowQuota:true}),30000);
test('choice commit without recovery releases projection quota atomically',()=>checkReopen('choice committed',{recover:false}),30000);
