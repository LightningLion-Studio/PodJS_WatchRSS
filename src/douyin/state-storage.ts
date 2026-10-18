import type {SqlDatabase} from '../core/types.ts';
import type {DouyinHistoryStorage} from './types.ts';

export interface DouyinStateChange {key:string;value:string|null}
export interface DouyinStateStorage extends DouyinHistoryStorage {
  apply?(changes:readonly DouyinStateChange[]):Promise<void>;
  getMany?(keys:readonly string[]):Promise<(string|null)[]>;
}
export async function applyDouyinState(storage:DouyinStateStorage,changes:readonly DouyinStateChange[]):Promise<void>{
  if(storage.apply)return storage.apply(changes);
  // Portable storage adapters publish the index last; Android uses an atomic SQL transaction.
  for(const {key,value} of changes)if(value===null)await storage.remove(key);else await storage.set(key,value);
}
export async function readDouyinState(storage:DouyinStateStorage,keys:readonly string[]):Promise<(string|null)[]>{
  return storage.getMany?storage.getMany(keys):Promise.all(keys.map(key=>storage.get(key)));
}
const LEGACY=new Set(['douyin.history.v1','douyin.watched.v1','douyin.feed.v1','douyin.recent-window.v1','douyin.playback-queue.v1']);
/** WatchRSS playback records use the existing worker-backed SQL service. The
 * legacy KV adapter is read/deleted only during a one-time, resumable migration. */
export class DouyinSqlStateStorage implements DouyinStateStorage {
  private ready?:Promise<SqlDatabase>;
  constructor(private readonly database:()=>Promise<SqlDatabase>,private readonly legacy:DouyinHistoryStorage){}
  private db():Promise<SqlDatabase>{return this.ready??=(async()=>{const db=await this.database();await db.execute('CREATE TABLE IF NOT EXISTS douyin_local_state (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');return db;})().catch(error=>{this.ready=undefined;throw error;});}
  async get(key:string):Promise<string|null>{
    if(LEGACY.has(key))return this.legacy.get(key);
    return (await this.getMany([key]))[0]??null;
  }
  async getMany(keys:readonly string[]):Promise<(string|null)[]>{
    if(!keys.length)return [];
    const rows=await (await this.db()).query(`SELECT key,value FROM douyin_local_state WHERE key IN (${keys.map(()=>'?').join(',')})`,keys);
    const values=new Map(rows.map(row=>[String(row.key),String(row.value)]));return keys.map(key=>values.get(key)??null);
  }
  set(key:string,value:string):Promise<void>{return this.apply([{key,value}]);}
  remove(key:string):Promise<void>{return this.apply([{key,value:null}]);}
  async apply(changes:readonly DouyinStateChange[]):Promise<void>{
    if(!changes.length)return;
    if(changes.some(change=>LEGACY.has(change.key)&&change.value!==null))throw Error("Legacy Douyin records are read-only");
    const db=await this.db();
    await db.transaction(changes.filter(change=>!LEGACY.has(change.key)).map(({key,value})=>value===null
      ?{sql:'DELETE FROM douyin_local_state WHERE key=?',params:[key]}
      :{sql:'INSERT OR REPLACE INTO douyin_local_state(key,value) VALUES(?,?)',params:[key,value]}));
    // Publication precedes cleanup. A failed cleanup never destroys the only copy.
    for(const {key,value} of changes)if(LEGACY.has(key)){
      if(value!==null)throw Error('Legacy Douyin records are read-only');
      await this.legacy.remove(key);
    }
  }
}
