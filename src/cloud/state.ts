import {MANUAL_INTENT_KEY,readManualIntent,manualScopeMatches} from './manual-handoff';
import type {CloudStringStore} from './keys';
import type {CloudSnapshotHead} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
interface State {warned_heads?:Record<string,string>;sequence:number;applied_full:Record<string,number>;applied_state:Record<string,number>;content_hash_full?:string;content_hash_state?:string;}
/** One instance per account/device; durable sequence allocation is serialized with all writes. */
export class WatchCloudStateStore {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private store:CloudStringStore,private userId:string,private deviceId:string,private guard:CloudGuard=cloudDisabled,private backendBaseUrl='',private finishStore?:Pick<CloudStringStore,'get'|'compareAndSet'>){}
 private get key(){return `watchrss.cloud.state.${JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),this.userId,this.deviceId])}`;}
 private get scope(){return JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),this.userId]);}
 private get epochKey(){return `watchrss.cloud.epoch.${this.scope}`;}
 private get statePrefix(){return `watchrss.cloud.state.${this.scope.slice(0,-1)},`;}
 private async read():Promise<State>{const raw=await this.store.get(this.key);if(!raw)return {sequence:0,applied_full:{},applied_state:{}};const s=JSON.parse(raw);if(!Number.isSafeInteger(s.sequence)||s.sequence<0)throw Error('云同步序列存储损坏');for(const field of ['applied_full','applied_state'])if(!s[field]||typeof s[field]!=='object'||Array.isArray(s[field])||Object.values(s[field]).some(v=>!Number.isSafeInteger(v)||Number(v)<0))throw Error('云同步状态存储损坏');if(s.warned_heads!==undefined&&(!s.warned_heads||typeof s.warned_heads!=='object'||Array.isArray(s.warned_heads)||Object.values(s.warned_heads).some(v=>typeof v!=='string'||!v)))throw Error('云恢复告警存储损坏');return s;}
 private change<T>(fn:(state:State)=>T):Promise<T>{this.guard.require();const task=this.tail.then(async()=>{this.guard.require();const s=await this.read(),value=fn(s);await this.store.set(this.key,JSON.stringify(s));return value;});this.tail=task.catch(()=>{});return task;}
 async restoreJournal(shard?:number){this.guard.require();if(shard!==undefined&&(!Number.isInteger(shard)||shard<0||shard>=64))throw Error('cloud_snapshot_checkpoint_invalid');return (await this.store.get(this.key+'.restore-v1'+(shard===undefined?'':'.'+shard)))||undefined;}
 async storeRestoreJournal(value:string,shard?:number){this.guard.require();if(shard!==undefined&&(!Number.isInteger(shard)||shard<0||shard>=64))throw Error('cloud_snapshot_checkpoint_invalid');await this.store.set(this.key+'.restore-v1'+(shard===undefined?'':'.'+shard),value);}
 /** Publish a receipt and its monotonic header in one secure-store commit.
  * Legacy test/storage ports retain the ordered fallback. */
 async storeRestoreJournalEntry(header:string,shard:number,value:string){
  this.guard.require();if(!Number.isInteger(shard)||shard<0||shard>=64)throw Error('cloud_snapshot_checkpoint_invalid');
  if(this.store.update)await this.store.update({[this.key+'.restore-v1']:header,[this.key+'.restore-v1.'+shard]:value},[]);
  else{await this.storeRestoreJournal(value,shard);try{await this.storeRestoreJournal(header);}catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{restoreEntryCommitted:true});}}
 }
 async restoreWindowStalled(scope:string,work:number){
  this.guard.require();const raw=await this.store.get(this.key+'.restore-window-v1');let previous:any;try{previous=raw?JSON.parse(raw):undefined;}catch{}
  return previous?.scope===scope&&previous.work===work&&Number.isSafeInteger(previous.zeros)&&previous.zeros>=2;
 }
 async observeRestoreWindow(scope:string,work:number,progress:boolean){
  this.guard.require();const store=this.finishStore??this.store,key=this.key+'.restore-window-v1',raw=await store.get(key);let previous:any;try{previous=raw?JSON.parse(raw):undefined;}catch{}
  const same=previous?.scope===scope&&previous.work===work&&Number.isSafeInteger(previous.zeros)&&previous.zeros>=0;
  const zeros=progress?0:same?Math.min(1000000,previous.zeros+1):1,value=JSON.stringify({scope,work,zeros});
  if(store.compareAndSet){if(!await store.compareAndSet(key,raw,value))return 0;}
  else await this.store.set(key,value);
  return zeros;
 }
 async clear(){this.guard.require();await this.tail;if(this.store.update)await this.store.update({},[this.statePrefix]);else{await this.store.set(this.key,JSON.stringify({sequence:0,applied_full:{},applied_state:{}}));await this.store.set(this.key+'.restore-v1','');for(let i=0;i<64;i++)await this.store.set(this.key+'.restore-v1.'+i,'');}}
 async contentGeneration(){this.guard.require();await this.tail;return this.store.get(`watchrss.cloud.content-generation.${this.scope}`);}
 async rememberContentGeneration(generation:string){this.guard.require();if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(generation))throw Error('invalid_content_generation');await this.tail;await this.store.set(`watchrss.cloud.content-generation.${this.scope}`,generation.toLowerCase());}
 async clearContent(){this.guard.require();await this.tail;const sequence=(await this.read()).sequence,value=JSON.stringify({sequence,applied_full:{},applied_state:{}});if(this.store.update)await this.store.update({[this.key]:value},[this.statePrefix]);else{await this.store.set(this.key,value);await this.store.set(this.key+'.restore-v1','');for(let i=0;i<64;i++)await this.store.set(this.key+'.restore-v1.'+i,'');}}
 async acceptEpoch(epoch:string){this.guard.require();if(!epoch)throw Error('client_upgrade_required');const epochKey=this.epochKey,old=await this.store.get(epochKey);
  const raw=await this.store.get(MANUAL_INTENT_KEY),intent=readManualIntent(raw);
  if(intent&&manualScopeMatches(intent.scope,this.userId,this.backendBaseUrl)){
   const changed=old!==undefined&&old!==epoch||intent.version===2&&intent.epoch!==null&&intent.epoch!==epoch;
   const value=changed?undefined:intent.version===1||intent.epoch===null?JSON.stringify({...intent,version:2,epoch}):raw;
   if(value!==raw){if(this.store.compareAndSet)await this.store.compareAndSet(MANUAL_INTENT_KEY,raw,value);else if(await this.store.get(MANUAL_INTENT_KEY)===raw)await this.store.set(MANUAL_INTENT_KEY,value??'');}
  }
  if(old!==epoch){await this.clear();await this.store.set(epochKey,epoch);}return old!==undefined&&old!==epoch;}
 nextSequence(serverSequence:number){return this.change(s=>{if(!Number.isSafeInteger(serverSequence)||serverSequence<0)throw Error('无效服务端序列');const next=Math.max(s.sequence,serverSequence)+1;if(!Number.isSafeInteger(next))throw Error('云同步序列溢出');return s.sequence=next;});}
 async applied(deviceId:string,full:boolean){this.guard.require();await this.tail;return (await this.read())[full?'applied_full':'applied_state'][deviceId]??0;}
 markApplied(deviceId:string,sequence:number,full:boolean){return this.change(s=>{if(!deviceId||!Number.isSafeInteger(sequence)||sequence<0)throw Error('无效应用序列');const key=full?'applied_full':'applied_state';s[key]={...s[key],[deviceId]:Math.max(s[key][deviceId]??0,sequence)};});}
 async warned(deviceId:string,headId:string){this.guard.require();await this.tail;return (await this.read()).warned_heads?.[deviceId]===headId;}
 markWarned(deviceId:string,headId:string){return this.change(s=>{if(!deviceId||!headId)throw Error('无效告警快照');s.warned_heads={...s.warned_heads,[deviceId]:headId};});}
 async lastContentHash(full:boolean){this.guard.require();await this.tail;return (await this.read())[full?'content_hash_full':'content_hash_state'];}
 markUploaded(hash:string,full:boolean){return this.change(s=>{if(!/^[0-9a-f]{64}$/.test(hash))throw Error('无效内容哈希');s[full?'content_hash_full':'content_hash_state']=hash;});}
}
export function cloudMergeNeeded(heads:CloudSnapshotHead[]):boolean {return heads.length>0&&!heads.some(candidate=>heads.every(current=>current.sourceDeviceId===candidate.sourceDeviceId||current.deviceSequence<=(candidate.observedHeads[current.sourceDeviceId]??0)));}
