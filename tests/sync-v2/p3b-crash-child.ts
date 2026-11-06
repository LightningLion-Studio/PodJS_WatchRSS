import {fixture} from './p3b-fixture';
const [root,mode]=process.argv.slice(2),f=await fixture(root),kill=()=>process.kill(process.pid,'SIGKILL');
if(mode==='before-placeholder')f.cache.seal=async()=>{kill();throw Error('unreachable');};
if(mode==='during-placeholder'){
 const original=f.db.transaction.bind(f.db);f.db.transaction=async statements=>{
  if(!statements.some(s=>s.sql.startsWith('UPDATE podjs_resource_rows')))return original(statements);
  f.db.raw.exec('BEGIN IMMEDIATE');for(const s of statements){f.db.raw.query(s.sql).run(...(s.params??[]) as any[]);if(s.sql.startsWith('UPDATE podjs_resource_rows')){kill();throw Error('unreachable');}}
 };
}
if(mode==='after-body-delete')f.host.discardHook=()=>kill();
await f.space.runWindow(1);throw Error('crash_not_reached');
