import type {CloudStringStore} from './keys';
import type {CloudSnapshotHead} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
interface State {warned_heads?:Record<string,string>;sequence:number;applied_full:Record<string,number>;applied_state:Record<string,number>;content_hash_full?:string;content_hash_state?:string;}
/** One instance per account/device; durable sequence allocation is serialized with all writes. */
export class WatchCloudStateStore {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private store:CloudStringStore,private userId:string,private deviceId:string,private guard:CloudGuard=cloudDisabled,private backendBaseUrl=''){}
 private get key(){return `watchrss.cloud.state.${JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),this.userId,this.deviceId])}`;}
 private get scope(){return JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),this.userId]);}
 private get epochKey(){return `watchrss.cloud.epoch.${this.scope}`;}
 private get statePrefix(){return `watchrss.cloud.state.${this.scope.slice(0,-1)},`;}
 private async read():Promise<State>{const raw=await this.store.get(this.key);if(!raw)return {sequence:0,applied_full:{},applied_state:{}};const s=JSON.parse(raw);if(!Number.isSafeInteger(s.sequence)||s.sequence<0)throw Error('云同步序列存储损坏');for(const field of ['applied_full','applied_state'])if(!s[field]||typeof s[field]!=='object'||Array.isArray(s[field])||Object.values(s[field]).some(v=>!Number.isSafeInteger(v)||Number(v)<0))throw Error('云同步状态存储损坏');if(s.warned_heads!==undefined&&(!s.warned_heads||typeof s.warned_heads!=='object'||Array.isArray(s.warned_heads)||Object.values(s.warned_heads).some(v=>typeof v!=='string'||!v)))throw Error('云恢复告警存储损坏');return s;}
 private change<T>(fn:(state:State)=>T):Promise<T>{this.guard.require();const task=this.tail.then(async()=>{this.guard.require();const s=await this.read(),value=fn(s);await this.store.set(this.key,JSON.stringify(s));return value;});this.tail=task.catch(()=>{});return task;}
 async clear(){this.guard.require();await this.tail;if(this.store.update)await this.store.update({},[this.statePrefix]);else await this.store.set(this.key,JSON.stringify({sequence:0,applied_full:{},applied_state:{}}));}
 async acceptEpoch(epoch:string){this.guard.require();if(!epoch)throw Error('client_upgrade_required');const epochKey=this.epochKey,old=await this.store.get(epochKey);if(old!==epoch){await this.clear();await this.store.set(epochKey,epoch);}return old!==undefined&&old!==epoch;}
 nextSequence(serverSequence:number){return this.change(s=>{if(!Number.isSafeInteger(serverSequence)||serverSequence<0)throw Error('无效服务端序列');const next=Math.max(s.sequence,serverSequence)+1;if(!Number.isSafeInteger(next))throw Error('云同步序列溢出');return s.sequence=next;});}
 async applied(deviceId:string,full:boolean){this.guard.require();await this.tail;return (await this.read())[full?'applied_full':'applied_state'][deviceId]??0;}
 markApplied(deviceId:string,sequence:number,full:boolean){return this.change(s=>{if(!deviceId||!Number.isSafeInteger(sequence)||sequence<0)throw Error('无效应用序列');const key=full?'applied_full':'applied_state';s[key]={...s[key],[deviceId]:Math.max(s[key][deviceId]??0,sequence)};});}
 async warned(deviceId:string,headId:string){this.guard.require();await this.tail;return (await this.read()).warned_heads?.[deviceId]===headId;}
 markWarned(deviceId:string,headId:string){return this.change(s=>{if(!deviceId||!headId)throw Error('无效告警快照');s.warned_heads={...s.warned_heads,[deviceId]:headId};});}
 async lastContentHash(full:boolean){this.guard.require();await this.tail;return (await this.read())[full?'content_hash_full':'content_hash_state'];}
 markUploaded(hash:string,full:boolean){return this.change(s=>{if(!/^[0-9a-f]{64}$/.test(hash))throw Error('无效内容哈希');s[full?'content_hash_full':'content_hash_state']=hash;});}
}
export function cloudMergeNeeded(heads:CloudSnapshotHead[]):boolean {return heads.length>0&&!heads.some(candidate=>heads.every(current=>current.sourceDeviceId===candidate.sourceDeviceId||current.deviceSequence<=(candidate.observedHeads[current.sourceDeviceId]??0)));}
