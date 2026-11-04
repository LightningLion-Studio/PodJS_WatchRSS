import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCloudStateStore,clearCloudSqlState} from '../../src/cloud/state-sql';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {stateSqlFixture} from './state-sql-fixture';
const key='watchrss.cloud.state.["https://fixture.invalid","user","watch"]',head=key+'.restore-v1',shard=head+'.0';
const guard={require(){}};

test('migrates every in-progress header/shard/window once, preserving secrets and account isolation',async()=>{
 const values=new Map([[key,JSON.stringify({sequence:9,applied_full:{phone:7},applied_state:{}})],[head,'active header'],[shard,'committed units'],[head+'.63','tail receipts'],[key+'.restore-window-v1','window'],['douyin.cookie','secret'],['watchrss.cloud.keys.fixture','key'],[key.replace('"user"','"other"'),'other']]);
 const f=stateSqlFixture(':memory:',values);try{const store=createCloudStateStore(f.host,f.secure),state=new WatchCloudStateStore(store,'user','watch',guard,'https://fixture.invalid/');
 expect(await state.restoreJournal()).toBe('active header');expect(await state.restoreJournal(0)).toBe('committed units');expect(await state.restoreJournal(63)).toBe('tail receipts');expect(await state.nextSequence(3)).toBe(10);expect(await state.applied('phone',true)).toBe(7);
 expect([...values]).toEqual([['douyin.cookie','secret'],['watchrss.cloud.keys.fixture','key'],[key.replace('"user"','"other"'),'other']]);expect(f.calls.filter(c=>c.method==='secure.update')).toHaveLength(1);
 const reopened=createCloudStateStore(f.host,f.secure);expect(await reopened.get(head)).toBe('active header');expect(f.calls.filter(c=>c.method==='secure.update')).toHaveLength(1);
 await reopened.set('douyin.cookie','rotated');expect(values.get('douyin.cookie')).toBe('rotated');expect(f.db.query("SELECT count(*) n FROM cloud_state_values WHERE key='douyin.cookie'").get()).toEqual({n:0});
 }finally{f.db.close();}
});

test('migration failure before SQL publication leaves legacy intact; cleanup retry never overwrites advanced SQL',async()=>{
 const f=stateSqlFixture(':memory:',new Map([[head,'old header'],[shard,'old shard']]));try{
 f.setFault((m,a)=>{if(m==='sql.transaction'&&a.statements.some((s:any)=>s.sql.startsWith('INSERT OR IGNORE INTO cloud_state_values')))throw Error('disk full');});
 await expect(createCloudStateStore(f.host,f.secure).get(head)).rejects.toThrow('disk full');expect(f.values.get(shard)).toBe('old shard');
 f.setFault(m=>{if(m==='secure.update')throw Error('cleanup interrupted');});await expect(createCloudStateStore(f.host,f.secure).get(head)).rejects.toThrow('cleanup interrupted');
 expect(f.db.query('SELECT cleaned FROM cloud_state_migrations').get()).toEqual({cleaned:0});
 // Model a committed newer receipt after publication, before cleanup retry.
 f.db.query('UPDATE cloud_state_chunks SET value=? WHERE key=?').run('new shard',shard);
 f.setFault(undefined);const store=createCloudStateStore(f.host,f.secure);expect(await store.get(shard)).toBe('new shard');expect(f.values.size).toBe(0);
 expect(f.db.query('SELECT cleaned FROM cloud_state_migrations').get()).toEqual({cleaned:1});
 }finally{f.db.close();}
});

test('a 1 MiB changing checkpoint sends only changed chunks after the initial commit, with atomic header and no secure writes',async()=>{
 const f=stateSqlFixture();try{const store=createCloudStateStore(f.host,f.secure),state=new WatchCloudStateStore(store,'user','watch',guard,'https://fixture.invalid');const large='x'.repeat(1024*1024-1)+'😀';
 await state.storeRestoreJournalEntry('header0',0,large+'0');f.calls.length=0;
 for(let i=1;i<=12;i++)await state.storeRestoreJournalEntry('header'+i,0,large+i);
 expect(f.calls.filter(c=>c.method.startsWith('secure.'))).toHaveLength(0);
 const tx=f.calls.filter(c=>c.method==='sql.transaction');expect(tx).toHaveLength(12);
 for(const call of tx){const chunks=call.args.statements.filter((s:any)=>s.sql.startsWith('INSERT OR REPLACE INTO cloud_state_chunks'));expect(chunks.length).toBe(2);expect(JSON.stringify(call.args).length).toBeLessThan(12000);}
 expect(await createCloudStateStore(f.host,f.secure).get(shard)).toBe(large+'12');expect(await store.get(head)).toBe('header12');
 }finally{f.db.close();}
});

test('transaction failure rolls back both values and invalidates cached candidate bytes',async()=>{
 const f=stateSqlFixture();try{const store=createCloudStateStore(f.host,f.secure);await store.update!({[head]:'before',[shard]:'old'});
 f.setFault((m,a)=>{if(m==='sql.transaction'&&a.reportChanges)a.statements.splice(a.statements.length-1,0,{sql:'INSERT INTO missing_table VALUES(1)',params:[]});});
 await expect(store.update!({[head]:'after',[shard]:'new'})).rejects.toThrow('missing_table');f.setFault(undefined);expect(await store.get(head)).toBe('before');expect(await store.get(shard)).toBe('old');
 }finally{f.db.close();}
});

test('independent guests observe revisions, CAS has one winner, prefix clear prevents resurrection and preserves peers',async()=>{
 const f=stateSqlFixture();try{const a=createCloudStateStore(f.host,f.secure),b=createCloudStateStore(f.host,f.secure);await a.set(head,'old');expect(await b.get(head)).toBe('old');await a.set(head,'new');expect(await b.get(head)).toBe('new');
 const results=await Promise.all([a.compareAndSet!(head,'new','a'),b.compareAndSet!(head,'new','b')]);expect(results.filter(Boolean)).toHaveLength(1);
 await a.set(shard,'tail');await a.update!({[head]:'replacement'},[key]);expect(await b.get(head)).toBe('replacement');expect(await b.get(shard)).toBeUndefined();
 await b.set(shard,'x');await a.set(shard,'short');expect(await b.get(shard)).toBe('short');await clearCloudSqlState(f.host,[key]);expect(await b.get(head)).toBeUndefined();expect(await b.get(shard)).toBeUndefined();
 }finally{f.db.close();}
});

test('SIGKILL after commit resumes both receipts; SIGKILL inside a transaction rolls back the entire update',()=>{
 const root=mkdtempSync(join(tmpdir(),'cloud-state-kill-')),path=join(root,'state.sqlite');
 try{for(const mode of ['commit','transaction']){
  const script=`import {stateSqlFixture} from ${JSON.stringify(join(import.meta.dir,'state-sql-fixture.ts'))};import {createCloudStateStore} from ${JSON.stringify(join(import.meta.dir,'../../src/cloud/state-sql.ts'))};const f=stateSqlFixture(${JSON.stringify(path)});const s=createCloudStateStore(f.host,f.secure);await s.update!({[${JSON.stringify(head)}]:'stable',[${JSON.stringify(shard)}]:'stable receipt'});${mode==='commit'?`await s.update!({[${JSON.stringify(head)}]:'committed',[${JSON.stringify(shard)}]:'committed receipt'});process.kill(process.pid,'SIGKILL');`:`f.db.transaction(()=>{f.db.query('UPDATE cloud_state_chunks SET value=? WHERE key=?').run('partial',${JSON.stringify(head)});process.kill(process.pid,'SIGKILL');})();`}`;
  const result=Bun.spawnSync([process.execPath,'--eval',script]);expect(result.signalCode).toBe('SIGKILL');
  const db=new Database(path);try{expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});const rows=db.query('SELECT key,value FROM cloud_state_chunks ORDER BY key').all() as any[];expect(rows.map(r=>r.value)).toEqual(mode==='commit'?['committed','committed receipt']:['stable','stable receipt']);}finally{db.close();}
 }}finally{rmSync(root,{recursive:true,force:true});}
});

test('an active legacy restore keeps its authenticated projection and row receipts across SQL migration and a fresh session',async()=>{
 const {fixture}=await import('./service-fixture');const {SnapshotRestoreCheckpoint}=await import('../../src/cloud/snapshot-checkpoint');const {crypto}=await import('./k2-crypto');
 const f=await fixture(),old=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch','generation');
 await old.begin();const token=await old.token('migration-object');await old.write(token,new TextEncoder().encode('authenticated fixture body'));await old.commit('rows:fixture:1',3);const work=old.work,cycle=old.cycle;old.close();
 f.store.set('douyin.cookie','synthetic cookie');const sql=stateSqlFixture(':memory:',f.store);
 try{
  f.session.state=new WatchCloudStateStore(createCloudStateStore(sql.host,sql.secure),'user','watch',guard);
  const restored=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch','generation');
  expect(restored.active).toBe(true);expect(restored.work).toBe(work);expect(restored.cycle).toBe(cycle);expect(restored.has('rows:fixture:1')).toBe(true);expect(restored.apply('rows:fixture').result('1')).toBe(3);
  expect(new TextDecoder().decode((await restored.read(token))!)).toBe('authenticated fixture body');expect([...f.store.keys()].some(k=>k.startsWith('watchrss.cloud.state.'))).toBe(false);expect(f.store.get('douyin.cookie')).toBe('synthetic cookie');
  await restored.finish();restored.close();f.session.state=new WatchCloudStateStore(createCloudStateStore(sql.host,sql.secure),'user','watch',guard);
  const reopened=await new SnapshotRestoreCheckpoint(f.session,crypto.sha256,async()=>{},()=>0).open('epoch','generation');expect(reopened.active).toBe(false);expect(reopened.has('rows:fixture:1')).toBe(true);reopened.close();
 }finally{sql.db.close();}
});

test('first production scan migrates inactive and legacy non-secret scopes, then skips enumeration after restart',async()=>{
 const inactive=head.replace('"user"','"inactive"'),legacy='watchrss.cloud.state.["legacy-user","old-watch"].restore-v1';
 const f=stateSqlFixture(':memory:',new Map([[head,'active'],[inactive,'inactive receipt'],[legacy,'old receipt'],['watchrss.cloud.epoch.["https://fixture.invalid","inactive"]','epoch'],['watchrss.cloud.content-generation.["https://fixture.invalid","inactive"]','generation'],['watchrss.cloud.keys.fixture','secret key'],['douyin.cookie','secret cookie']]));let scans=0;
 f.secure.keys=async prefixes=>{scans++;return [...f.values.keys()].filter(key=>prefixes.some(prefix=>key.startsWith(prefix)));};
 try{const store=createCloudStateStore(f.host,f.secure);expect(await store.get(head)).toBe('active');expect(await store.get(inactive)).toBe('inactive receipt');expect(await store.get(legacy)).toBe('old receipt');expect([...f.values]).toEqual([['watchrss.cloud.keys.fixture','secret key'],['douyin.cookie','secret cookie']]);expect(scans).toBe(1);
 f.secure.keys=async()=>{throw Error('repeat scan');};expect(await createCloudStateStore(f.host,f.secure).get(inactive)).toBe('inactive receipt');
 }finally{f.db.close();}
});

test('production port migrates a 1 MiB legacy value through bounded service replies without losing bytes',async()=>{
 const {createCloudHostPorts}=await import('../../src/cloud/host-ports');const large='x'.repeat(1024*1024)+'😀';const f=stateSqlFixture(':memory:',new Map([[head,'active'],[shard,large]]));let maxReply=0;
 const host=async<T>(method:string,args:any):Promise<T>=>{
  if(method==='secure.keys')return {keys:[...f.values.keys()],hasMore:false} as T;
  if(method==='secure.get'){const value=f.values.get(args.key);if(value===undefined)return {exists:false} as T;const reply={exists:true,value:value.slice(args.offset,args.offset+args.maxChars),offset:args.offset,totalChars:value.length,version:1};maxReply=Math.max(maxReply,JSON.stringify(reply).length);return reply as T;}
  if(method==='secure.update'){await f.secure.update!(args.values,args.removePrefixes);return {} as T;}return f.host<T>(method,args);
 };
 try{const ports=createCloudHostPorts(host,guard);expect(await ports.store.get(shard)).toBe(large);expect(maxReply).toBeLessThan(32768);expect(f.values.size).toBe(0);}finally{f.db.close();}
});
