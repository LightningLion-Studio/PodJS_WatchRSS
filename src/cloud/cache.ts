import {JsonDeltaJournal} from '@podjs/framework/json-delta-journal';
import {utf8Encode,utf8Decode} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export interface CloudBlobStore {read(path:string):Promise<Uint8Array|undefined>;writeAtomic(path:string,bytes:Uint8Array):Promise<void>;removeTree?(path:string):Promise<void>;append?(path:string,bytes:Uint8Array,offset:number):Promise<void>;hash?(path:string):Promise<string>;}
/** Encrypted bytes only. Chunk reads verify hashes; the coordinator must verify
 * cached manifests against their remote head before passing them to the AEAD codec. */
export class WatchCloudCache {
 constructor(private files:CloudBlobStore,private hash:(b:Uint8Array)=>Promise<string>,private guard:CloudGuard=cloudDisabled,private backendBaseUrl=''){}
 private journals=new Map<string,JsonDeltaJournal>();
 private async journal(userId:string,preparation=false){const id=userId+":"+preparation;let journal=this.journals.get(id);if(!journal){const path=`${await this.root(userId)}/${preparation?"record-preparation":"records"}.json`;journal=new JsonDeltaJournal({fingerprint:async(p,raw)=>raw==='{}'?this.hash(utf8Encode(raw)):this.files.hash?this.files.hash(p):this.hash(utf8Encode(raw)),read:async p=>{const b=await this.files.read(p);return b?utf8Decode(b):undefined;},replace:(p,s)=>this.files.writeAtomic(p,utf8Encode(s)),append:async(p,s,offset)=>{if(!this.files.append)throw Error("cloud_record_journal_unavailable");await this.files.append(p,utf8Encode(s),offset);}},path,preparation?["receipts"]:["records","rows","projections","protectedVersions","protectedRows","pendingEdits","quarantinedRows","replayDone"],v=>preparation?{scope:v.scope,receipts:v.receipts??Object.fromEntries(v.entries??[])}:{...v,projections:Array.isArray(v.projections)?Object.fromEntries(v.projections.map((g:any)=>[g.binding,g])):v.projections??{}},v=>preparation?{scope:v.scope,entries:Object.entries(v.receipts??{})}:{...v,projections:Object.values(v.projections??{})});this.journals.set(id,journal);}return journal;}
 async recordsValue(userId:string){this.guard.require();return (await this.journal(userId)).load();}
 async storeRecordsValue(userId:string,value:Record<string,any>){this.guard.require();return (await this.journal(userId)).commit(value);}
 private roots=new Map<string,Promise<string>>();
 private root(userId:string){let root=this.roots.get(userId);if(!root){root=this.hash(utf8Encode(JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),userId]))).then(h=>`watch-cloud-cache/${h.slice(0,32)}`);if(this.roots.size>=32)this.roots.delete(this.roots.keys().next().value!);this.roots.set(userId,root);void root.catch(()=>this.roots.delete(userId));}return root;}
 private projectionId(id:string){if(!/^[a-f0-9]{64}(?:-[A-Za-z0-9-]{1,160})?$/.test(id))throw Error('cloud_snapshot_checkpoint_invalid');return id;}

 async scope(userId:string){this.guard.require();return this.root(userId);}
 async clear(userId:string){this.guard.require();if(!this.files.removeTree)throw Error('cache_cleanup_unavailable');await this.files.removeTree(await this.root(userId));this.journals.delete(userId+":false");this.journals.delete(userId+":true");}
 private id(id:string){if(!/^[a-zA-Z0-9-]{1,128}$/.test(id))throw Error('无效快照 ID');return id;}
 private digest(hash:string){if(!/^[0-9a-f]{64}$/.test(hash))throw Error('无效块哈希');return hash;}
 async records(userId:string){this.guard.require();if(this.files.append){const value=await this.recordsValue(userId);return value.epoch?JSON.stringify(value):undefined;}const bytes=await this.files.read(`${await this.root(userId)}/records.json`);return bytes?utf8Decode(bytes):undefined;}
 async storeRecords(userId:string,value:string){this.guard.require();if(this.files.append){await this.storeRecordsValue(userId,JSON.parse(value));return;}await this.files.writeAtomic(`${await this.root(userId)}/records.json`,utf8Encode(value));}
 async recordPreparation(userId:string){this.guard.require();if(this.files.append){const v=await (await this.journal(userId,true)).load();return v.scope?JSON.stringify(v):undefined;}const b=await this.files.read(`${await this.root(userId)}/record-preparation.json`);return b?utf8Decode(b):undefined;}
 async storeRecordPreparation(userId:string,value:string){this.guard.require();if(this.files.append){await (await this.journal(userId,true)).commit(JSON.parse(value));return;}await this.files.writeAtomic(`${await this.root(userId)}/record-preparation.json`,utf8Encode(value));}
 async manifest(userId:string,id:string){this.guard.require();return this.files.read(`${await this.root(userId)}/manifests/${this.id(id)}.bin`);}
 async storeManifest(userId:string,id:string,bytes:Uint8Array,localHead=false){this.guard.require();const root=await this.root(userId);await this.files.writeAtomic(`${root}/manifests/${this.id(id)}.bin`,bytes);if(localHead)await this.files.writeAtomic(`${root}/latest`,utf8Encode(id));}
 async latest(userId:string){this.guard.require();const value=await this.files.read(`${await this.root(userId)}/latest`);if(!value)return undefined;const id=this.id(utf8Decode(value).trim()),bytes=await this.manifest(userId,id);return bytes?{id,bytes}:undefined;}
 async pending(userId:string){this.guard.require();const value=await this.files.read(`${await this.root(userId)}/pending`);if(!value?.length)return undefined;const text=utf8Decode(value).trim();if(!text)return undefined;const id=this.id(text),bytes=await this.manifest(userId,id);return bytes?{id,bytes}:undefined;}
 async storePending(userId:string,id:string,bytes:Uint8Array){this.guard.require();await this.storeManifest(userId,id,bytes);await this.files.writeAtomic(`${await this.root(userId)}/pending`,utf8Encode(this.id(id)));}
 async clearPending(userId:string,id:string){this.guard.require();const path=`${await this.root(userId)}/pending`,value=await this.files.read(path);if(value&&utf8Decode(value).trim()===id)await this.files.writeAtomic(path,new Uint8Array());}
 /** Untrusted source bytes: only the AEAD codec may consume this path; it
  * verifies descriptor length/hash/header before decryption. */
 async rawChunk(userId:string,hash:string){this.guard.require();this.digest(hash);return this.files.read(`${await this.root(userId)}/chunks/${hash.slice(0,2)}/${hash}.bin`);}
 async restoreProjection(userId:string,id:string){this.guard.require();this.projectionId(id);return this.files.read(`${await this.root(userId)}/restore-v1/${id}.bin`);}
 async storeRestoreProjection(userId:string,id:string,bytes:Uint8Array){this.guard.require();this.projectionId(id);await this.files.writeAtomic(`${await this.root(userId)}/restore-v1/${id}.bin`,bytes);}
 async chunk(userId:string,hash:string){this.guard.require();this.digest(hash);const bytes=await this.files.read(`${await this.root(userId)}/chunks/${hash.slice(0,2)}/${hash}.bin`);return bytes&&await this.hash(bytes)===hash?bytes:undefined;}
 async storeChunk(userId:string,hash:string,bytes:Uint8Array){this.guard.require();this.digest(hash);if(await this.hash(bytes)!==hash)throw Error('云缓存哈希不匹配');await this.files.writeAtomic(`${await this.root(userId)}/chunks/${hash.slice(0,2)}/${hash}.bin`,bytes);}
}
