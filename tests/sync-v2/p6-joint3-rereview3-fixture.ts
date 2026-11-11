import {expect} from 'bun:test';
import {fixture,scope} from './p6-fix-fixture';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {canonical,jsonBytes,parseCanonicalJson,nextD64} from '../../src/sync-v2/protocol';
import {TrustedClock} from '../../src/sync-v2/trusted-time';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// These probes change only SQL-host or synthetic transport scheduling.
// They do not replace any product reader, publisher, guard or apply method.
async function setup(outcome:'unknown'|'accepted'|'none',extra=0,diskMode?:'DELETE'|'WAL'){
 const diskRoot=diskMode?mkdtempSync(join(tmpdir(),'wrr2-cold-')):null,sqlPath=diskRoot?join(diskRoot,'state.sqlite'):undefined;
 const a=await fixture({path:sqlPath,mode:diskMode}),b=await fixture();let opened:any,other:any,started=false,lose=false,lookupFailure=false;
 const hooks:{network?:(r:any,stage:'before'|'after',response?:any)=>Promise<void>;sql?:(method:string,args:any,stage:'before'|'after')=>Promise<void>}={};
 await a.db.execute("UPDATE memo_notes SET note_id='local-a',title='local a'");
 await b.db.execute("UPDATE memo_notes SET note_id='remote-b',title='remote b'");
 for(let i=0;i<extra;i++)await b.db.execute("INSERT INTO memo_notes SELECT ?,folder_id,title,markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes LIMIT 1",['extra-'+i]);
 const service=a.server.request.bind(a.server);
 const transport={request:async(r:any)=>{
  if(new URL(r.url).pathname.endsWith('/capabilities')){const x=await service(r),v=parseCanonicalJson(x.body);v.flags.historyRestore=true;return {...x,body:jsonBytes(v)};}
  if(r.url.endsWith('/choices/cloud')){const body=parseCanonicalJson(r.body);return {status:200,headers:{},body:jsonBytes({version:2,scope,choiceId:body.choiceId,account:a.server.account,confirmedAccount:a.server.account})};}
  return service(r);
 }};
 b.options.transport=transport;
 a.options.transport={request:async(r:any)=>{
  if(!started&&r.url.endsWith('/objects/reserve')){started=true;other=await openApplicationSyncV2(b.options);}
  await hooks.network?.(r,'before');
  if(lookupFailure&&r.url.includes('/requests/'))throw Error('query_unavailable');
  if(lose&&r.url.endsWith('/account/publish')){lose=false;if(outcome==='accepted')await transport.request(r);throw Error('response_lost');}
  const v=await transport.request(r);await hooks.network?.(r,'after',v);return v;
 }};
 const host=a.options.host;a.options.host=async(method:string,args:any)=>{await hooks.sql?.(method,args,'before');const result=await host(method,args);await hooks.sql?.(method,args,'after');return result;};
 opened=await openApplicationSyncV2(a.options);
 if(outcome!=='none'){lose=true;await expect(opened.ui.chooseLocal(await opened.ui.openChoice())).rejects.toThrow('response_lost');}
 const store=()=>opened.ui.o.projection,control=()=>opened.ui.o.control;
 const plan=(await store().readState()).cloud.pendingPublish;
 return {a,b,hooks,plan,store,control,get opened(){return opened;},get other(){return other;},transport,
  blockLookup(){lookupFailure=true;},unblockLookup(){lookupFailure=false;},
  async toggle(open:boolean){await control().setWriteGates({history_restore:true,choice_apply:open});},
  async remoteEdit(){await other.sync();await b.db.execute("UPDATE memo_notes SET title='new remote head',updated_at=95");await other.sync();},
  async reopen(){await opened.close();if(sqlPath){a.db.close();(a.db as any).raw=new Database(sqlPath);a.db.raw.exec('PRAGMA journal_mode='+diskMode);a.db.raw.exec('PRAGMA synchronous=FULL');}a.options.clock=new TrustedClock(()=>100);opened=await openApplicationSyncV2(a.options);},
  async close(){await opened?.close();await other?.close();a.db.close();b.db.close();if(diskRoot)rmSync(diskRoot,{recursive:true,force:true});}};
}
function databaseImage(x:Awaited<ReturnType<typeof setup>>){
 const tables=x.a.db.raw.query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'syncv2_%' OR name LIKE 'podjs_%') ORDER BY name").all() as {name:string}[];
 return canonical(Object.fromEntries(tables.map(({name})=>[name,(x.a.db.raw.query('SELECT * FROM "'+name+'"').all() as any[]).map(canonical).sort()])));
}
function ownSends(x:Awaited<ReturnType<typeof setup>>){return x.a.server.publishedBodies.map(v=>parseCanonicalJson(Buffer.from(v,'base64'))).filter(v=>v.account.body.requestId===x.plan.requestId);}
async function assertFinished(x:Awaited<ReturnType<typeof setup>>){
 const s=await x.store().readState();expect(s.cloud.pendingPublish).toBeNull();expect(s.pendingChoice).toBeNull();expect(s.cloud.pendingApplied).toBeNull();expect(s.hasUnsentEdits).toBe(false);expect(s.activeGeneration).toBe(x.plan.commitOid);expect(s.cloud.detachedPublications?.[x.plan.requestId]).toBeUndefined();expect(ownSends(x)).toHaveLength(1);expect(canonical(ownSends(x)[0])).toBe(canonical(x.plan.request));
}


export {setup,databaseImage,ownSends,assertFinished};
