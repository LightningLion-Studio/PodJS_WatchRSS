import type {WatchCloudClient} from './client';
import type {WatchCloudCodec,CloudManifest} from './codec';
import type {WatchCloudKeyManager} from './keys';
import type {WatchCloudCache} from './cache';
import {cloudMergeNeeded,type WatchCloudStateStore} from './state';
import type {SupabaseTusUploader} from './tus';
import type {WatchCloudLibraryAdapter} from './library';
import {utf8Encode,type CloudMemberState,type CloudSnapshotHead} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export type WatchCloudPhase='idle'|'registering'|'waiting-approval'|'downloading'|'merging'|'uploading'|'complete'|'error';
export interface WatchCloudStatus {phase:WatchCloudPhase;message:string;usedBytes:number;quotaBytes:number;lastCompletedAt:number;member?:CloudMemberState}
export interface CloudSession {
 userId:string;deviceId:string;displayName:string;
 client:Pick<WatchCloudClient,'registerDevice'|'bootstrap'|'snapshotHeads'|'snapshot'|'download'|'acknowledge'|'resolveRssSource'|'reserveSnapshot'|'completeSnapshot'>;
 keys:Pick<WatchCloudKeyManager,'publicKeySpki'|'currentKeyVersion'|'acceptBootstrap'|'accountKey'>;
 codec:WatchCloudCodec;cache:WatchCloudCache;state:WatchCloudStateStore;uploader:Pick<SupabaseTusUploader,'upload'>;
 library:Pick<WatchCloudLibraryAdapter,'publicSources'|'mergeInventory'|'exportPayloads'|'restorePayloads'>;
 /** Account identity/revocation must be rechecked after asynchronous IO. */
 assertCurrent():Promise<void>;
}
export interface CloudSyncPorts {
 open():Promise<CloudSession|undefined>;
 network():Promise<{active:boolean;validated:boolean;wifi:boolean;metered:boolean}>;
 hash(bytes:Uint8Array):Promise<string>;uuid():Promise<string>;
 /** Host lease shared by foreground and background guests; release on close. */
 exclusive<T>(action:()=>Promise<T>):Promise<T>;
 now?:()=>number;onChanged?:()=>void;
}
function headValid(h:CloudSnapshotHead){if(!/^[A-Za-z0-9-]{1,128}$/.test(h.id)||!h.sourceDeviceId||!Number.isSafeInteger(h.deviceSequence)||h.deviceSequence<1||!Number.isSafeInteger(h.keyVersion)||h.keyVersion<1||!Number.isSafeInteger(h.manifestSizeBytes)||h.manifestSizeBytes<51||h.manifestSizeBytes>8*1024*1024||!/^[0-9a-f]{64}$/.test(h.manifestSha256))throw Error('无效云端 head');}
const sameRecord=(a:Record<string,unknown>,b:Record<string,unknown>)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
export class WatchCloudSyncService {
 private tail:Promise<unknown>=Promise.resolve();private listeners=new Set<()=>void>();
 private value:WatchCloudStatus={phase:'idle',message:'尚未同步',usedBytes:0,quotaBytes:0,lastCompletedAt:0};
 constructor(private ports:CloudSyncPorts,private guard:CloudGuard=cloudDisabled){}
 get status(){return {...this.value};}
 subscribe(fn:()=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
 reset(){this.value={phase:'idle',message:'尚未同步',usedBytes:0,quotaBytes:0,lastCompletedAt:0};this.emit();}
 private emit(){for(const fn of this.listeners)try{fn();}catch{}}
 private set(phase:WatchCloudPhase,message:string,member?:CloudMemberState){this.value={...this.value,phase,message,...(member?{member,usedBytes:member.usedBytes,quotaBytes:member.quotaBytes}:{}),...(phase==='complete'?{lastCompletedAt:(this.ports.now??Date.now)()}:{} )};this.emit();}
 syncNow(manual=false,mode:'all'|'recent128'='recent128'):Promise<boolean>{
  this.guard.require();const run=this.tail.then(()=>this.ports.exclusive(()=>this.run(manual,mode))).catch(()=>{this.set('error','云同步失败，请稍后重试');return false;});this.tail=run;return run;
 }
 private async manifest(s:CloudSession,h:CloudSnapshotHead,bytes:Uint8Array){
  headValid(h);if(bytes.length!==h.manifestSizeBytes||await this.ports.hash(bytes)!==h.manifestSha256)throw Error('云 manifest 哈希或长度不符');
  const key=await s.keys.accountKey(s.userId,h.keyVersion);if(!key)throw Error('缺少账号密钥，请在手机端重新批准');
  try{const m=await s.codec.decryptManifest(key,h.id,bytes);
   if(m.sourceDeviceId!==h.sourceDeviceId||m.deviceSequence!==h.deviceSequence||m.keyVersion!==h.keyVersion||!sameRecord(m.parentHeads,h.parentHeads)||!sameRecord(m.observedHeads,h.observedHeads))throw Error('云 manifest 身份不符');return m;
  }finally{key.fill(0);}
 }
 private async run(manual:boolean,mode:'all'|'recent128'){
  this.guard.require();const network=await this.ports.network();if(!network.active||!network.validated){this.set('idle','等待网络连接');return false;}
  // Unknown/cellular/ethernet transports do not silently authorize private bodies.
  const full=manual||(network.wifi&&!network.metered);
  const s=await this.ports.open();if(!s){this.reset();return false;}
  const current=async()=>{this.guard.require();await s.assertCurrent();};await current();
  this.set('registering','正在登记手表');const publicKey=await s.keys.publicKeySpki(s.userId,s.deviceId);
  await s.client.registerDevice(s.deviceId,s.displayName,publicKey,await s.keys.currentKeyVersion(s.userId));
  let bootstrap=await s.client.bootstrap();await current();
  this.set('registering','正在核对云空间',bootstrap.member);
  if(!bootstrap.member.readable&&!bootstrap.member.writable){this.set('idle','会员云空间不可用',bootstrap.member);return false;}
  if(bootstrap.devices.some(d=>d.deviceId===s.deviceId&&d.revokedAt))throw Error('云设备已撤销');
  if(await s.keys.acceptBootstrap(s.userId,s.deviceId,bootstrap.keyEnvelopes)==='waiting-approval'){this.set('waiting-approval','请在手机会员云空间中批准此手表',bootstrap.member);return false;}
  await current();await s.client.registerDevice(s.deviceId,s.displayName,publicKey,await s.keys.currentKeyVersion(s.userId));
  bootstrap=await s.client.bootstrap();await current();await s.keys.acceptBootstrap(s.userId,s.deviceId,bootstrap.keyEnvelopes);
  const member=bootstrap.member;if(!member.readable){this.set('idle','云空间暂不可读取',member);return false;}
  if(bootstrap.devices.some(d=>d.deviceId===s.deviceId&&d.revokedAt))throw Error('云设备已撤销');
  const heads=await s.client.snapshotHeads();heads.forEach(headValid);
  if(new Set(heads.map(h=>h.sourceDeviceId)).size!==heads.length)throw Error('重复云设备 head');
  let changed=false;
  for(const h of [...heads].sort((a,b)=>a.deviceSequence-b.deviceSequence)){
   await current();
   if(h.deviceSequence<=await s.state.applied(h.sourceDeviceId,full)){
    // Retrying an ACK after a crash/network failure must not require reapplying data.
    if(full)await s.client.acknowledge(h.id,s.deviceId);continue;
   }
   this.set('downloading','正在接收云快照',member);
   const remote=await s.client.snapshot(h.id);let bytes=await s.cache.manifest(s.userId,h.id);
   if(bytes&&(bytes.length!==h.manifestSizeBytes||await this.ports.hash(bytes)!==h.manifestSha256))bytes=undefined;
   bytes??=await s.client.download(remote.manifestUrl,h.manifestSizeBytes,h.manifestSha256);
   const manifest=await this.manifest(s,h,bytes);
   const selected=manifest.objects.filter(o=>o.name==='rss-state.json'||(full&&o.name==='library-sync.json'));
   const descriptors=new Map(remote.chunks.map(c=>[c.sha256,c]));
   for(const c of selected.flatMap(o=>o.chunks))if(!await s.cache.chunk(s.userId,c.ciphertextSha256)){
    await current();const target=descriptors.get(c.ciphertextSha256);if(!target||target.sizeBytes!==c.ciphertextBytes)throw Error('云快照缺少中继数据块');
    const data=await s.client.download(target.signedUrl,c.ciphertextBytes,c.ciphertextSha256);await s.cache.storeChunk(s.userId,c.ciphertextSha256,data);
   }
   const key=await s.keys.accountKey(s.userId,h.keyVersion);if(!key)throw Error('缺少账号密钥');
   try{const payload=await s.codec.restore(key,{...manifest,objects:selected},async hash=>{const b=await s.cache.chunk(s.userId,hash);if(!b)throw Error('中继缓存缺失');return b;});
    await current();this.set('merging','正在合并手机数据',member);changed=(await s.library.restorePayloads(payload,h.sourceDeviceId)>0)||changed;
   }finally{key.fill(0);}
   await current();await s.cache.storeManifest(s.userId,h.id,bytes);
   if(full){await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,true);await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,false);await s.client.acknowledge(h.id,s.deviceId);}
   else if(selected.some(o=>o.name==='rss-state.json'))await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,false);
  }
  let inventoryFailures=0;
  if(full){this.set('downloading','正在更新公共 RSS 库',member);for(const source of await s.library.publicSources()){
   await current();try{const inventory=await s.client.resolveRssSource(source.url,mode);await current();changed=(await s.library.mergeInventory(inventory)>0)||changed;}catch{inventoryFailures++;}
  }}
  if(changed)this.ports.onChanged?.();await current();
  if(!member.writable){this.set('complete','云资料已恢复；云空间只读',member);return true;}
  const version=await s.keys.currentKeyVersion(s.userId),payload=await s.library.exportPayloads(full);
  const hash=async(prefix:string,parts:Uint8Array[])=>{const header=utf8Encode(prefix);const out=new Uint8Array(header.length+parts.reduce((n,b)=>n+b.length,0));out.set(header);let at=header.length;for(const b of parts){out.set(b,at);at+=b.length;}return this.ports.hash(out);};
  const stateHash=await hash(`keyVersion:${version};state;`,[payload.state]);
  const contentHash=full?await hash(`keyVersion:${version};full:true;`,[payload.state,payload.relay!]):stateHash;
  const fresh=await s.client.snapshotHeads();fresh.forEach(headValid);
  // Do not claim to have observed a head that arrived while we were merging.
  if(fresh.length!==heads.length||fresh.some(h=>!heads.some(old=>old.id===h.id&&old.manifestSha256===h.manifestSha256)))throw Error('云资料已更新，请重试');
  if(contentHash!==await s.state.lastContentHash(full)||cloudMergeNeeded(fresh)){
   let previous:CloudManifest|undefined;
   const own=fresh.find(h=>h.sourceDeviceId===s.deviceId&&h.keyVersion===version);
   if(own){
    let cached=await s.cache.manifest(s.userId,own.id);
    if(cached&&(cached.length!==own.manifestSizeBytes||await this.ports.hash(cached)!==own.manifestSha256))cached=undefined;
    if(!cached){const remote=await s.client.snapshot(own.id);cached=await s.client.download(remote.manifestUrl,own.manifestSizeBytes,own.manifestSha256);}
    previous=await this.manifest(s,own,cached);await s.cache.storeManifest(s.userId,own.id,cached);
   }
   const key=await s.keys.accountKey(s.userId,version);if(!key)throw Error('当前账号主密钥不存在');
   try{
    const snapshot=await s.codec.create({accountKey:key,keyVersion:version,sourceDeviceId:s.deviceId,sequence:await s.state.nextSequence(Math.max(bootstrap.devices.find(d=>d.deviceId===s.deviceId)?.lastSequence??0,...fresh.filter(h=>h.sourceDeviceId===s.deviceId).map(h=>h.deviceSequence))),snapshotId:await this.ports.uuid(),createdAtMillis:(this.ports.now??Date.now)(),objects:[{name:'rss-state.json',bytes:payload.state},...(payload.relay?[{name:'library-sync.json',bytes:payload.relay}]:[])],parentHeads:Object.fromEntries(fresh.map(h=>[h.sourceDeviceId,h.id])),observedHeads:Object.fromEntries(await Promise.all(fresh.map(async h=>[h.sourceDeviceId,Math.min(h.deviceSequence,await s.state.applied(h.sourceDeviceId,full))]))),previous,carried:full?[]:previous?.objects.filter(o=>o.name==='library-sync.json')??[]});
    for(const [hash,bytes] of snapshot.newChunks)await s.cache.storeChunk(s.userId,hash,bytes);
    await current();this.set('uploading','正在上传手表状态',member);
    const reservation=await s.client.reserveSnapshot(snapshot,30);if(reservation.snapshotId!==snapshot.manifest.snapshotId)throw Error('云预留 ID 不匹配');
    const allowed=new Map(snapshot.manifest.allChunks.map(c=>[c.ciphertextSha256,c.ciphertextBytes]));
    const manifestHash=await this.ports.hash(snapshot.encryptedManifest);
    for(const target of reservation.missingObjects){
     await current();if(target.kind==='manifest'?(target.sha256!==manifestHash||target.sizeBytes!==snapshot.encryptedManifest.length):(target.kind!=='chunk'||allowed.get(target.sha256)!==target.sizeBytes))throw Error('无效上传目标');
     const bytes=target.kind==='manifest'?snapshot.encryptedManifest:await s.cache.chunk(s.userId,target.sha256);if(!bytes)throw Error('待上传中继块缺失');await s.uploader.upload(target,bytes);
    }
    await current();await s.client.completeSnapshot(snapshot.manifest.snapshotId,[...allowed.keys()]);
    await current();await s.cache.storeManifest(s.userId,snapshot.manifest.snapshotId,snapshot.encryptedManifest,true);
    await s.state.markApplied(s.deviceId,snapshot.manifest.deviceSequence,false);await s.state.markUploaded(stateHash,false);
    if(full){await s.state.markApplied(s.deviceId,snapshot.manifest.deviceSequence,true);await s.state.markUploaded(contentHash,true);}
   }finally{key.fill(0);}
  }
  this.set('complete',inventoryFailures?'云状态已同步；部分公共 RSS 待重试':full?'云同步完成':'小状态已同步；正文等待Wi-Fi',member);return true;
 }
}
