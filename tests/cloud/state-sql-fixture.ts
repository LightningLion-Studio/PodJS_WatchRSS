import {Database} from 'bun:sqlite';
import type {CloudHostRequest} from '../../src/cloud/host-ports';
import type {CloudStringStore} from '../../src/cloud/keys';
export function stateSqlFixture(path=':memory:',values=new Map<string,string>()){
 const db=new Database(path);const calls:{method:string;args:any}[]=[];
 let fault:((method:string,args:any)=>void)|undefined;
 const host:CloudHostRequest=async<T>(method:string,args:any)=>{
  calls.push({method,args});fault?.(method,args);
  if(method==='sql.query')return db.query(args.sql).all(...args.params) as T;
  if(method==='sql.execute'){db.query(args.sql).run(...args.params);return undefined as T;}
  if(method==='sql.transaction')return db.transaction(()=>{
   const changes:number[]=[];for(const s of args.statements){db.query(s.sql).run(...s.params);changes.push((db.query('SELECT changes() AS n').get() as any).n);}return args.reportChanges?changes:undefined;
  })() as T;
  throw Error('unexpected '+method);
 };
 const secure:CloudStringStore={
  get:async key=>{fault?.('secure.get',{key});calls.push({method:'secure.get',args:{key}});return values.get(key);},
  set:async(key,value)=>{calls.push({method:'secure.set',args:{key,value}});values.set(key,value);},
  compareAndSet:async(key,expected,value)=>{if(values.get(key)!==expected)return false;if(value===undefined)values.delete(key);else values.set(key,value);return true;},
  update:async(entries,prefixes=[])=>{fault?.('secure.update',{values:entries});calls.push({method:'secure.update',args:{values:entries,prefixes}});for(const key of values.keys())if(prefixes.some(p=>key.startsWith(p)))values.delete(key);for(const [key,value]of Object.entries(entries))if(value===null)values.delete(key);else values.set(key,value);},
 };
 return {db,host,secure,values,calls,setFault:(fn:typeof fault)=>{fault=fn;}};
}

/** Inspect durable state in the real fixture database, never the secure map. */
export function cloudStateValues(db:Database):Map<string,string>{
 if(!db.query("SELECT 1 FROM sqlite_master WHERE name='cloud_state_values'").get())return new Map();
 const values=new Map<string,string>();for(const row of db.query('SELECT v.key,c.value FROM cloud_state_values v LEFT JOIN cloud_state_chunks c ON c.key=v.key ORDER BY v.key,c.part').all() as any[])values.set(row.key,(values.get(row.key)??'')+(row.value??''));return values;
}
