import {utf8Encode,utf8Decode} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export interface CloudBlobStore {read(path:string):Promise<Uint8Array|undefined>;writeAtomic(path:string,bytes:Uint8Array):Promise<void>;removeTree?(path:string):Promise<void>;}
/** Encrypted bytes only. Chunk reads verify hashes; the coordinator must verify
 * cached manifests against their remote head before passing them to the AEAD codec. */
export class WatchCloudCache {
 constructor(private files:CloudBlobStore,private hash:(b:Uint8Array)=>Promise<string>,private guard:CloudGuard=cloudDisabled,private backendBaseUrl=''){}
 private async root(userId:string){return `watch-cloud-cache/${(await this.hash(utf8Encode(JSON.stringify([this.backendBaseUrl.replace(/\/+$/,''),userId])))).slice(0,32)}`;}
 async clear(userId:string){this.guard.require();if(!this.files.removeTree)throw Error('cache_cleanup_unavailable');await this.files.removeTree(await this.root(userId));}
 private id(id:string){if(!/^[a-zA-Z0-9-]{1,128}$/.test(id))throw Error('无效快照 ID');return id;}
 private digest(hash:string){if(!/^[0-9a-f]{64}$/.test(hash))throw Error('无效块哈希');return hash;}
 async manifest(userId:string,id:string){this.guard.require();return this.files.read(`${await this.root(userId)}/manifests/${this.id(id)}.bin`);}
 async storeManifest(userId:string,id:string,bytes:Uint8Array,localHead=false){this.guard.require();const root=await this.root(userId);await this.files.writeAtomic(`${root}/manifests/${this.id(id)}.bin`,bytes);if(localHead)await this.files.writeAtomic(`${root}/latest`,utf8Encode(id));}
 async latest(userId:string){this.guard.require();const value=await this.files.read(`${await this.root(userId)}/latest`);if(!value)return undefined;const id=this.id(utf8Decode(value).trim()),bytes=await this.manifest(userId,id);return bytes?{id,bytes}:undefined;}
 async chunk(userId:string,hash:string){this.guard.require();this.digest(hash);const bytes=await this.files.read(`${await this.root(userId)}/chunks/${hash.slice(0,2)}/${hash}.bin`);return bytes&&await this.hash(bytes)===hash?bytes:undefined;}
 async storeChunk(userId:string,hash:string,bytes:Uint8Array){this.guard.require();this.digest(hash);if(await this.hash(bytes)!==hash)throw Error('云缓存哈希不匹配');await this.files.writeAtomic(`${await this.root(userId)}/chunks/${hash.slice(0,2)}/${hash}.bin`,bytes);}
}
