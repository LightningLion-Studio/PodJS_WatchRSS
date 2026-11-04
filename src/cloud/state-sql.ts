import type {CloudStringStore} from './keys';
import type {CloudHostRequest} from './host-ports';

// UTF-16 chunks keep host messages below the SQL response/bridge byte limits.
// Only changed chunks cross the bridge. SQLite commits the header and shard in
// one transaction; there is no timer or unflushed debounce buffer to lose.
const CHUNK=8192;
const roots=['watchrss.cloud.state.','watchrss.cloud.epoch.','watchrss.cloud.content-generation.'];
const owns=(key:string)=>roots.some(prefix=>key.startsWith(prefix));
type Statement={sql:string;params:unknown[]};
type Snapshot={revision:string;parts:string[]};
function migration(key:string){
 const root=roots.find(prefix=>key.startsWith(prefix));if(!root)return;
 const match=/^(\[.*\])(?:\.restore-v1(?:\.[0-9]+)?|\.restore-window-v1)?$/.exec(key.slice(root.length));
 if(!match)return {group:key,keys:[key]};
 const ids=JSON.parse(match[1]);if(!Array.isArray(ids)||!(root===roots[0]?[2,3]:[2]).includes(ids.length)||ids.some(v=>typeof v!=='string'))throw Error('cloud_snapshot_checkpoint_invalid');
 const group=root+match[1];return {group,keys:root===roots[0]?[group,group+'.restore-v1',...Array.from({length:64},(_,i)=>group+'.restore-v1.'+i),group+'.restore-window-v1']:[group]};
}
const split=(value:string)=>{const parts:string[]=[];let offset=0;while(offset<value.length){let end=Math.min(value.length,offset+CHUNK);const last=value.charCodeAt(end-1);if(end<value.length&&last>=0xd800&&last<=0xdbff)end--;parts.push(value.slice(offset,end));offset=end;}return parts;};
const revision=()=>`${Date.now()}:${Math.random()}:${++serial}`;let serial=0;
export async function clearCloudSqlState(host:CloudHostRequest,prefixes:string[]){
 await schema(host);
 await host('sql.transaction',{statements:prefixes.flatMap(prefix=>[
  {sql:'DELETE FROM cloud_state_chunks WHERE substr(key,1,?)=?',params:[prefix.length,prefix]},
  {sql:'DELETE FROM cloud_state_values WHERE substr(key,1,?)=?',params:[prefix.length,prefix]},
 ])});
 // Keep migration markers: a later login must not import a stale legacy copy.
}
async function schema(host:CloudHostRequest){await host('sql.transaction',{statements:[
 {sql:'CREATE TABLE IF NOT EXISTS cloud_state_values (key TEXT PRIMARY KEY,revision TEXT NOT NULL,parts INTEGER NOT NULL)',params:[]},
 {sql:'CREATE TABLE IF NOT EXISTS cloud_state_chunks (key TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(key,part))',params:[]},
 {sql:'CREATE TABLE IF NOT EXISTS cloud_state_migrations (key TEXT PRIMARY KEY,cleaned INTEGER NOT NULL)',params:[]},
]});}
/** Closed routing list: authorization grants, cookies, tokens and cloud keys
 * always use the secure port. Only non-secret sync bookkeeping reaches SQL. */
export function createCloudStateStore(host:CloudHostRequest,secure:CloudStringStore):CloudStringStore {
 let ready:Promise<void>|undefined;
 const ensure=()=>ready??=(schema(host).catch(error=>{ready=undefined;throw error;}));
 const migrated=new Map<string,Promise<void>>(),cache=new Map<string,Snapshot>();let cachedChars=0;
 const forget=()=>{cache.clear();cachedChars=0;};
 const remember=(key:string,snapshot:Snapshot)=>{const chars=snapshot.parts.reduce((n,v)=>n+v.length,0);if(chars>2*1024*1024)return;if(cachedChars+chars>4*1024*1024)forget();const previous=cache.get(key);if(previous)cachedChars-=previous.parts.reduce((n,v)=>n+v.length,0);cache.set(key,snapshot);cachedChars+=chars;};
 const query=<T=Record<string,unknown>>(sql:string,params:unknown[]=[])=>host<T[]>('sql.query',{sql,params});
 async function migrate(key:string){
  const plan=migration(key);if(!plan)return;await ensure();let task=migrated.get(plan.group);if(!task){task=(async()=>{
   let marker=(await query('SELECT cleaned FROM cloud_state_migrations WHERE key=?',[plan.group]))[0];
   if(!marker){
    const values:Record<string,string>={};for(const k of plan.keys){const value=await secure.get(k);if(value!==undefined)values[k]=value;}
    const statements:Statement[]=[];
    for(const [k,value]of Object.entries(values)){
     const parts=split(value),rev=revision();
     statements.push({sql:'INSERT OR IGNORE INTO cloud_state_values(key,revision,parts) VALUES(?,?,?)',params:[k,rev,parts.length]});
     parts.forEach((part,i)=>statements.push({sql:'INSERT OR IGNORE INTO cloud_state_chunks(key,part,value) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM cloud_state_values WHERE key=? AND revision=?)',params:[k,i,part,k,rev]}));
    }
    statements.push({sql:'INSERT OR IGNORE INTO cloud_state_migrations(key,cleaned) VALUES(?,?)',params:[plan.group,Object.keys(values).length?0:1]});
    await host('sql.transaction',{statements});
    marker=(await query('SELECT cleaned FROM cloud_state_migrations WHERE key=?',[plan.group]))[0];
   }
   if(Number(marker?.cleaned)===0){
    // Publication precedes deletion. A crash here retries only the deletion;
    // SQL receipts may already have advanced and must never be overwritten.
    if(!secure.update)throw Error('client_upgrade_required');
    await secure.update(Object.fromEntries(plan.keys.map(k=>[k,null])));
    await host('sql.execute',{sql:'UPDATE cloud_state_migrations SET cleaned=1 WHERE key=?',params:[plan.group]});
   }
  })().catch(error=>{migrated.delete(plan.group);throw error;});migrated.set(plan.group,task);}await task;
 }
 let globalMigration:Promise<void>|undefined;
 async function prepare(){
  if(!secure.keys)return;
  if(!globalMigration)globalMigration=(async()=>{
   await ensure();const marker='__cloud_plaintext_v1__';if((await query('SELECT cleaned FROM cloud_state_migrations WHERE key=?',[marker]))[0])return;
   // Enumerate names only. Credentials/identity namespaces are never requested.
   // Preserve inactive-account and legacy device journals as well as the active one.
   for(const key of await secure.keys!(roots))await migrate(key);
   await host('sql.execute',{sql:'INSERT OR IGNORE INTO cloud_state_migrations(key,cleaned) VALUES(?,1)',params:[marker]});
  })().catch(error=>{globalMigration=undefined;throw error;});
  await globalMigration;
 }
 async function read(key:string):Promise<Snapshot|undefined>{
  await migrate(key);
  for(let retry=0;retry<8;retry++){
   const meta=(await query('SELECT revision,parts FROM cloud_state_values WHERE key=?',[key]))[0];
   if(!meta)return;const rev=String(meta.revision),count=Number(meta.parts),hit=cache.get(key);if(hit?.revision===rev)return hit;
   if(!Number.isSafeInteger(count)||count<0)throw Error('cloud_snapshot_checkpoint_invalid');
   let valid=true;const parts:string[]=[];for(let offset=0;offset<count;offset+=8){const rows=await query('SELECT part,value FROM cloud_state_chunks WHERE key=? AND part>=? ORDER BY part LIMIT 8',[key,offset]);for(const row of rows){if(Number(row.part)!==parts.length||typeof row.value!=='string')valid=false;parts.push(String(row.value));}}
   const latest=(await query('SELECT revision FROM cloud_state_values WHERE key=?',[key]))[0];if(latest?.revision!==rev)continue;
   if(!valid||parts.length!==count)throw Error('cloud_snapshot_checkpoint_invalid');const snapshot={revision:rev,parts};remember(key,snapshot);return snapshot;
  }throw Error('cloud_state_busy');
 }
 async function write(values:Record<string,string|null>,prefixes:string[]=[],expected?:{key:string;value:string|undefined}):Promise<boolean>{
  await prepare();for(const key of Object.keys(values))await migrate(key);await ensure();
  for(let retry=0;retry<8;retry++){
   const before=new Map<string,Snapshot|undefined>();for(const key of Object.keys(values))before.set(key,await read(key));
   if(expected&&before.get(expected.key)?.parts.join('')!==expected.value)return false;
   // A transaction-wide fence prevents partially applying a multi-key update
   // after another host/guest wins a revision race.
   const keys=[...before.keys()],fence=keys.map(()=>'(SELECT revision FROM cloud_state_values WHERE key=?) IS ?').join(' AND ')||'1';
   const fenceParams=keys.flatMap(key=>[key,before.get(key)?.revision??null]);
   const statements:Statement[]=[{sql:'CREATE TEMP TABLE IF NOT EXISTS cloud_state_fence (ok INTEGER)',params:[]},{sql:'DELETE FROM cloud_state_fence',params:[]},{sql:`INSERT INTO cloud_state_fence(ok) SELECT 1 WHERE ${fence}`,params:fenceParams}];
   const condition='EXISTS(SELECT 1 FROM cloud_state_fence)';
   for(const prefix of prefixes)for(const table of ['cloud_state_chunks','cloud_state_values'])statements.push({sql:`DELETE FROM ${table} WHERE substr(key,1,?)=? AND ${condition}`,params:[prefix.length,prefix]});
   const after=new Map<string,Snapshot>();
   for(const [key,value]of Object.entries(values)){
    const old=before.get(key);if(value===null){for(const table of ['cloud_state_chunks','cloud_state_values'])statements.push({sql:`DELETE FROM ${table} WHERE key=? AND ${condition}`,params:[key]});continue;}
    const parts=split(value),rev=revision();after.set(key,{revision:rev,parts});
    // Prefix replacement deletes the old chunks, even if their bytes match.
    const removed=prefixes.some(prefix=>key.startsWith(prefix));
    parts.forEach((part,i)=>{if(!removed&&old?.parts[i]===part)return;statements.push({sql:`INSERT OR REPLACE INTO cloud_state_chunks(key,part,value) SELECT ?,?,? WHERE ${condition}`,params:[key,i,part]});});
    statements.push({sql:`DELETE FROM cloud_state_chunks WHERE key=? AND part>=? AND ${condition}`,params:[key,parts.length]});
    statements.push({sql:`INSERT OR REPLACE INTO cloud_state_values(key,revision,parts) SELECT ?,?,? WHERE ${condition}`,params:[key,rev,parts.length]});
   }
   statements.push({sql:'DELETE FROM cloud_state_fence',params:[]});
   try{const changes=await host<number[]>('sql.transaction',{statements,reportChanges:true});if(changes.at(-1)!==1){forget();continue;}}catch(error){forget();throw error;}
   if(prefixes.length)forget();for(const key of before.keys()){const next=after.get(key);if(next)remember(key,next);else {forget();break;}}return true;
  }throw Error('cloud_state_busy');
 }
 return {
  get:async key=>{if(!owns(key))return secure.get(key);await prepare();return (await read(key))?.parts.join('');},
  set:async(key,value)=>{if(owns(key))await write({[key]:value});else await secure.set(key,value);},
  compareAndSet:async(key,expected,value)=>owns(key)?write({[key]:value??null},[],{key,value:expected}):secure.compareAndSet!(key,expected,value),
  async update(values,prefixes=[]){
   const plain=Object.fromEntries(Object.entries(values).filter(([key])=>owns(key))),secret=Object.fromEntries(Object.entries(values).filter(([key])=>!owns(key)));
   const plainPrefixes=prefixes.filter(owns),secretPrefixes=prefixes.filter(prefix=>!owns(prefix));
   if(Object.keys(plain).length||plainPrefixes.length)await write(plain,plainPrefixes);
   // Also delete legacy state on scope clear. No-op secure.update does not write.
   if(Object.keys(secret).length||prefixes.length)await secure.update!({...secret},[...secretPrefixes,...plainPrefixes]);
  },
 };
}

/** Lightweight adapter for authorization preflight and UI handoff. Importing
 * it does not load the codec, key manager, or account/runtime modules. */
export function cloudStatePort(host:CloudHostRequest):CloudStringStore {
 return createCloudStateStore(host,{
  get:async key=>{const result=await host<{exists:boolean;value?:string}>('secure.get',{key});return result.exists?result.value:undefined;},
  set:async(key,value)=>{await host('secure.set',{key,value});},
  update:async(values,removePrefixes=[])=>{await host('secure.update',{values,removePrefixes});},
 });
}
