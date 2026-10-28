import {cloudFormatFailure,emitCloudFormat,type CloudFormatFailure} from './format-diagnostic';
import {PRIVATE_OVERLAY_NAME,PRIVATE_OVERLAY_FEATURE,hasPrivateOverlay,decodePrivateOverlay} from './private-overlay';
import {recordFailureDiagnostic,type RecordFailureStage} from './record-diagnostic';
import {cloudCompatibility,cloudHasUnknownData,emptyCompatibilityStatus,type CloudCompatibilityStatus} from './compatibility';
import {CLOUD_SYNC_SUSPENDED,CLOUD_HOST_CAPABILITY_UNAVAILABLE,CloudSyncBudget} from './execution';
import {parseContentState,contentRecovery} from './content-lifecycle';
import type {WatchCloudRecords} from './records';
import {canonicalSpki} from './v2';
import type {WatchCloudClient} from './client';
import type {WatchCloudCodec,CloudManifest} from './codec';
import type {WatchCloudKeyManager} from './keys';
import type {WatchCloudCache} from './cache';
import {type WatchCloudStateStore} from './state';
import type {WatchCloudLibraryAdapter} from './library';
import {utf8Encode,type CloudUploadObject,type CloudMemberState,type CloudSnapshotHead} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export type WatchCloudPhase='idle'|'registering'|'waiting-approval'|'downloading'|'merging'|'uploading'|'complete'|'error';
export interface WatchCloudStatus {errorCode?:'cloud_format_upgrade_required';formatEvolution?:{writeV1Enabled:boolean;migrationV1Enabled:false;privateOverlayHeads:number;acceptedOutputObjects:number};formatCompatibility?:CloudCompatibilityStatus;phase:WatchCloudPhase;message:string;usedBytes:number;reservedBytes:number;quotaBytes:number;lastCompletedAt:number;member?:CloudMemberState;retryAtMillis?:number;pendingItems?:number;abandonedItems?:number;retryable?:boolean}
export interface CloudSession {
 userId:string;deviceId:string;displayName:string;
 client:Partial<Pick<WatchCloudClient,'refreshR48WriteGate'|'r48WriteEnabled'|'requiredFeatures'>>&Pick<WatchCloudClient,'setEpoch'|'setContentGeneration'|'registerDevice'|'bootstrap'|'snapshotHeads'|'snapshot'|'download'|'acknowledge'|'resolveRssSource'|'reserveSnapshot'|'completeSnapshot'>;
 keys:Pick<WatchCloudKeyManager,'publicKeySpki'|'currentKeyVersion'|'acceptBootstrap'|'accountKey'>&Partial<Pick<WatchCloudKeyManager,'prepareLegacyUpgrade'>>;
 codec:WatchCloudCodec;cache:WatchCloudCache;state:WatchCloudStateStore;uploader:{upload(target:CloudUploadObject,bytes:Uint8Array):Promise<void>};
 library:Partial<Pick<WatchCloudLibraryAdapter,'observePrivateOverlay'>>&Pick<WatchCloudLibraryAdapter,'publicSources'|'mergeInventory'|'exportPayloads'|'restorePayloads'>;
 /** Account identity/revocation must be rechecked after asynchronous IO. */
 assertCurrent():Promise<void>;
 assertUpload?():Promise<void>;
 invalidate?():Promise<void>;
 records(bootstrap:import('./types').CloudBootstrap,current:()=>Promise<void>):Promise<WatchCloudRecords>;
}
export interface CloudSyncPorts {
 recordDiagnostic?:(value:string)=>void;
 formatDiagnostic?:(value:string)=>void;
 open(check?:()=>void):Promise<CloudSession|undefined>;
 network():Promise<{active:boolean;validated:boolean;wifi:boolean;metered:boolean}>;
 hash(bytes:Uint8Array):Promise<string>;uuid():Promise<string>;
 /** Host lease shared by foreground and background guests; release on close. */
 exclusive<T>(action:()=>Promise<T>):Promise<T>;
 now?:()=>number;onChanged?:()=>void;report?:(value:{event:'snapshot-created';writeV1:boolean;newChunks:number;reusedChunks:number;uploadBytes:number;constructMillis:number})=>void;
}
function headValid(h:CloudSnapshotHead){if(!/^[A-Za-z0-9-]{1,128}$/.test(h.id)||!h.sourceDeviceId||!Number.isSafeInteger(h.deviceSequence)||h.deviceSequence<1||!Number.isSafeInteger(h.keyVersion)||h.keyVersion<1||!Number.isSafeInteger(h.manifestSizeBytes)||h.manifestSizeBytes<51||h.manifestSizeBytes>8*1024*1024||!/^[0-9a-f]{64}$/.test(h.manifestSha256))throw Error('无效云端 head');}
const sameRecord=(a:Record<string,unknown>,b:Record<string,unknown>)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
export class WatchCloudSyncService {
 private recordFailure?:{code:string;stage:RecordFailureStage;category:CloudFormatFailure};
 private budget?:CloudSyncBudget;
 private usageRefresh:(()=>Promise<void>)|undefined;
 private statusEpoch=0;private runEpoch=0;
 private tail:Promise<unknown>=Promise.resolve();private listeners=new Set<()=>void>();
 private value:WatchCloudStatus={phase:'idle',message:'尚未同步',usedBytes:0,reservedBytes:0,quotaBytes:0,lastCompletedAt:0};
 constructor(private ports:CloudSyncPorts,private guard:CloudGuard=cloudDisabled){}
 get status(){return {...this.value};}
 subscribe(fn:()=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
 reset(){this.statusEpoch++;this.value={phase:'idle',message:'尚未同步',usedBytes:0,reservedBytes:0,quotaBytes:0,lastCompletedAt:0};this.emit();}
 private emit(){for(const fn of this.listeners)try{fn();}catch{}}
 private set(phase:WatchCloudPhase,message:string,member?:CloudMemberState){if(this.runEpoch!==this.statusEpoch)return;this.value={...this.value,phase,message,...(member?{member,usedBytes:member.usedBytes,reservedBytes:member.reservedBytes,quotaBytes:member.quotaBytes}:{}),...(phase==='complete'?{lastCompletedAt:(this.ports.now??Date.now)()}:{} )};this.emit();}
 syncNow(manual=false,mode:'all'|'recent128'='recent128'):Promise<boolean>{
  this.guard.require();const started=(this.ports.now??Date.now)(),epoch=this.statusEpoch;let failure:CloudFormatFailure='none',failureCode:string|undefined;const run=this.tail.then(()=>this.ports.exclusive(()=>{if(epoch!==this.statusEpoch)return Promise.resolve(false);this.runEpoch=epoch;this.budget=new CloudSyncBudget(this.ports.now);this.recordFailure=undefined;return this.recover(manual,mode);})).catch(error=>{failure=cloudFormatFailure(error);failureCode=JSON.parse(recordFailureDiagnostic(error)).code;if(epoch!==this.statusEpoch)return false;const reason=String(error);if(contentRecovery(error)==='upgrade'&&(error as {code?:unknown})?.code==='cloud_format_upgrade_required'){this.value={...this.value,errorCode:'cloud_format_upgrade_required',retryable:false,formatCompatibility:{...(this.value.formatCompatibility??emptyCompatibilityStatus()),editPending:Math.max(1,this.value.formatCompatibility?.editPending??0),upgradeRequired:true}};this.set('error','请升级到最新版本以继续同步');}else if(failure==='timeout'||failure==='concurrent-library-change'||failure==='runtime'){this.value={...this.value,retryable:true,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('error','云同步暂时中断，本机编辑已保留，请稍后重试');}else if(failure==='storage'){this.value={...this.value,retryable:true};this.set('error','本机存储空间不足，请释放空间后重试；本机编辑已保留');}else if(reason.includes(CLOUD_SYNC_SUSPENDED)){this.value={...this.value,retryAtMillis:Math.max(1,(this.ports.now??Date.now)())};this.set('idle','已暂停，回到应用后继续同步');}else if(failure==='gate'){this.value={...this.value,retryable:true,formatCompatibility:{...(this.value.formatCompatibility??emptyCompatibilityStatus()),editPending:1,upgradeRequired:false}};this.set('idle','新格式写入暂未开放，本机编辑已保留');}else if(reason.includes('cloud_format_overlay_resources_pending')){this.value={...this.value,retryable:false,pendingItems:1};this.set('idle','条目资源需要在支持的设备处理，本机编辑已保留');}else if(reason.includes('cloud_format_capacity')){this.value={...this.value,retryable:false};this.set('idle','云资料超过本端处理上限，请先在手机整理；本机编辑已保留');}else if(reason.includes('cloud_format_')){this.value={...this.value,retryable:false,formatCompatibility:{...(this.value.formatCompatibility??emptyCompatibilityStatus()),editPending:Math.max(1,this.value.formatCompatibility?.editPending??0),upgradeRequired:true}};this.set('idle','云资料包含只读格式，本机编辑已保留，请升级后继续');}else if(reason.includes('cloud_private_body_pending'))this.set('idle','正文仍在同步，请稍后重试');else if(reason.includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE)||contentRecovery(error)==='upgrade'||reason.includes('client_upgrade_required')||reason.includes('snapshot_content_layout_unsupported')){this.value={...this.value,retryable:false};this.set('error','请升级腕上RSS以继续云同步');}else if(['rebuild','plan'].includes(contentRecovery(error)??'')){this.value={...this.value,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('idle','云端内容正在重建，已排队重试；本机资料已保留');}else if(reason.includes('library_epoch_mismatch'))this.set('waiting-approval','资料库已重置，请重新批准');else if(reason.includes('rotation_proof_invalid')||reason.includes('device_attestation_invalid'))this.set('waiting-approval','密钥验证失败，请重新批准');else if(reason.includes('device_key_conflict'))this.set('waiting-approval','本机云设备公钥冲突，请重新登记本机');else if(reason.includes('library_owner_mismatch'))this.set('error','本机资料属于其他账号，请先选择清空或合并');else this.set('error','云同步失败，请稍后重试');return false;}).then(result=>{emitCloudFormat(this.ports.formatDiagnostic,{event:'format-sync',outcome:epoch!==this.statusEpoch?'superseded':result?'complete':failure==='none'&&this.value.phase!=='error'?'deferred':'failed',...(failureCode?{code:failureCode}:this.recordFailure?{code:this.recordFailure.code}:{}),...(this.recordFailure?{recordCode:this.recordFailure.code,recordStage:this.recordFailure.stage}:{}),category:failure==='none'&&this.recordFailure?this.recordFailure.category:(!result&&failure==='none'&&this.value.formatCompatibility?.upgradeRequired?'format':!result&&failure==='none'&&this.value.phase==='error'?'other':failure),durationMillis:Math.max(0,(this.ports.now??Date.now)()-started)});return result;});this.tail=run;return run;
 }
 private async refreshUsage(){await this.usageRefresh?.();}
 private async recover(manual:boolean,mode:'all'|'recent128'){let recovery:string|undefined;for(let attempt=0;attempt<2;attempt++){let refreshed=false;this.usageRefresh=undefined;try{const result=await this.run(manual,mode,attempt>0,recovery==='rebuild');refreshed=true;await this.refreshUsage();return result;}catch(original){if(String(original).includes('cloud_sync_deadline_exceeded')||String(original).includes(CLOUD_SYNC_SUSPENDED)||String(original).includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE))throw original;let error=original;if(!refreshed)try{await this.refreshUsage();}catch(latest){if(contentRecovery(latest)==='rebuild'||String(latest).includes('library_epoch_mismatch'))error=latest;}const kind=contentRecovery(error);if(attempt||!['rebuild','plan'].includes(kind??''))throw error;recovery=kind;this.set('idle',kind==='rebuild'?'云端内容已清理，正在从本机重建同步':'云端上传计划已失效，正在重新准备');}}return false;}
 private async manifest(s:CloudSession,h:CloudSnapshotHead,bytes:Uint8Array){
  headValid(h);if(bytes.length!==h.manifestSizeBytes||await this.ports.hash(bytes)!==h.manifestSha256)throw Error('云 manifest 哈希或长度不符');
  const key=await s.keys.accountKey(s.userId,h.keyVersion);if(!key)throw Error('缺少账号密钥，请在手机端重新批准');
  try{const m=await s.codec.decryptManifest(key,h.id,bytes);
   if(!cloudCompatibility(m).opaque&&h.sourceDeviceId.startsWith('reader-migration-')&&m.objects.some(o=>!o.name.startsWith('reader/')||!!o.privateBook))throw Error('无效阅读器迁移对象');
   if(m.sourceDeviceId!==h.sourceDeviceId||m.deviceSequence!==h.deviceSequence||m.keyVersion!==h.keyVersion||!sameRecord(m.parentHeads,h.parentHeads)||!sameRecord(m.observedHeads,h.observedHeads))throw Error('云 manifest 身份不符');return m;
  }finally{key.fill(0);}
 }
 private async run(manual:boolean,mode:'all'|'recent128',freshPlan=false,forceContentReset=false){
  this.value={...this.value,retryAtMillis:undefined,pendingItems:undefined,abandonedItems:undefined,retryable:undefined,errorCode:undefined,formatCompatibility:undefined};this.guard.require();const network=await this.ports.network();if(!network.active||!network.validated){this.set('idle','等待网络连接');return false;}
  // Unknown/cellular/ethernet transports do not silently authorize private bodies.
  const full=manual||(network.wifi&&!network.metered);
  this.budget?.check();const s=await this.ports.open(this.budget?.check);if(!s){this.reset();return false;}
  const current=async()=>{this.budget?.check();this.guard.require();if(this.runEpoch!==this.statusEpoch)throw Error('cloud_operation_superseded');await s.assertCurrent();this.budget?.check();};await current();
  this.set('registering','正在核对云空间');
  let bootstrap=await s.client.bootstrap();await current();
  const changedEpoch=await s.state.acceptEpoch(bootstrap.libraryEpoch);if(changedEpoch){await s.invalidate?.();this.set('waiting-approval','资料库已重置，请重新批准',bootstrap.member);return false;}
  s.client.setEpoch(bootstrap.libraryEpoch);const content=parseContentState(bootstrap);const previousGeneration=await s.state.contentGeneration();
  if(forceContentReset||previousGeneration!==undefined&&previousGeneration!==content.contentGeneration||content.contentEmpty){await current();await s.cache.clear(s.userId);await s.state.clearContent();await current();this.set('registering','云端内容已清理，正在从本机重建同步',bootstrap.member);}
  await s.state.rememberContentGeneration(content.contentGeneration);s.client.setContentGeneration(content.contentGeneration);
  this.usageRefresh=async()=>{const latest=await s.client.bootstrap();await current();if(latest.libraryEpoch!==bootstrap.libraryEpoch)throw Error('library_epoch_mismatch');if(parseContentState(latest).contentGeneration!==content.contentGeneration)throw Object.assign(Error('cloud_content_rebuild_required'),{status:409,code:'cloud_content_rebuild_required'});this.value={...this.value,member:latest.member,usedBytes:latest.member.usedBytes,reservedBytes:latest.member.reservedBytes,quotaBytes:latest.member.quotaBytes};this.emit();};
  let device=bootstrap.devices.find(d=>d.deviceId===s.deviceId);
  if(device?.revokedAt){await s.invalidate?.();this.set('waiting-approval','云设备已撤销，请重新批准',bootstrap.member);return false;}
  const publicKey=await s.keys.publicKeySpki(s.userId,s.deviceId);
  // Reading cloud state does not depend on registration or subscription entitlement.
  if(!device){await current();await s.client.registerDevice(s.deviceId,s.displayName,publicKey,Math.max(bootstrap.keyVersionFloor+1,1));}
  const upgrade=await s.keys.prepareLegacyUpgrade?.(s.userId,s.deviceId,bootstrap);
  if(upgrade&&!device?.attestation){
   if(device&&canonicalSpki(device.publicKeySpki)!==canonicalSpki(publicKey))throw Error('device_key_conflict');
   await s.client.registerDevice(s.deviceId,s.displayName,publicKey,upgrade.keyVersion,upgrade.attestation);
   const epoch=bootstrap.libraryEpoch,generation=content.contentGeneration;bootstrap=await s.client.bootstrap();await current();if(parseContentState(bootstrap).contentGeneration!==generation)throw Object.assign(Error('cloud_content_rebuild_required'),{status:409,code:'cloud_content_rebuild_required'});if(bootstrap.libraryEpoch!==epoch){await s.invalidate?.();throw Error('library_epoch_mismatch');}device=bootstrap.devices.find(d=>d.deviceId===s.deviceId);
  }
  let ready:string;
  try{ready=await s.keys.acceptBootstrap(s.userId,s.deviceId,bootstrap.keyEnvelopes,bootstrap,device?.attestation&&device.attestationKeyVersion?{keyVersion:device.attestationKeyVersion,mac:device.attestation}:undefined);}
  catch(error){if(String(error).includes('library_epoch_mismatch'))await s.invalidate?.();throw error;}
  if(ready==='waiting-approval'){this.set('waiting-approval','请在已登录设备上批准此手表',bootstrap.member);return false;}
  await current();const member=bootstrap.member;
  let records:WatchCloudRecords|undefined,recordFailure='',recordStage:RecordFailureStage='open',recordStarted=(this.ports.now??Date.now)();
  const recordStep=async<T>(stage:RecordFailureStage,run:()=>Promise<T>)=>{recordStage=stage;recordStarted=(this.ports.now??Date.now)();let success=false;try{await current();const result=await run();await current();success=true;return result;}finally{try{this.ports.recordDiagnostic?.(JSON.stringify({event:'records-stage',stage,outcome:success?'complete':'failed',durationMillis:Math.max(0,(this.ports.now??Date.now)()-recordStarted)}));}catch{}}};
  const recordError=(e:unknown)=>{const diagnostic=recordFailureDiagnostic(e,recordStage,(this.ports.now??Date.now)()-recordStarted);const classified=JSON.parse(diagnostic);this.recordFailure={code:classified.code,stage:recordStage,category:cloudFormatFailure(e)};try{this.ports.recordDiagnostic?.(diagnostic);}catch{/* Diagnostics must not change sync. */}const text=String(e);if(String(e).includes('cloud_sync_deadline_exceeded')||String(e).includes(CLOUD_SYNC_SUSPENDED)||contentRecovery(e)||text.includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE))throw e;if(/library_epoch_mismatch|cloud_operation_superseded|账号|client_upgrade_required|device_attestation|commitment|library_owner_mismatch/.test(text))throw e;recordFailure=text.includes('cloud_record_count_limit')?'云记录数量已达上限':text.includes('cloud_quota_exceeded')?'云记录空间不足':text.includes('cloud_records_consent_required')?'请先在手机启用云记录':'云记录待重试';};
  try{records=await recordStep('open',()=>s.records(bootstrap,current));if(await recordStep('pull',()=>records!.pull()))this.ports.onChanged?.();await recordStep('interactions',async()=>records!.flushInteractions?.());}catch(e){recordError(e);}

  await current();const heads=await s.client.snapshotHeads();heads.forEach(headValid);
  if(new Set(heads.map(h=>h.sourceDeviceId)).size!==heads.length)throw Error('重复云设备 head');
  let changed=false,pendingItems=0,abandonedItems=0,formatBlocked=!!s.client.requiredFeatures?.length;const compatibility=emptyCompatibilityStatus();
  const supported=(o:import('./codec').CloudObject)=>o.name===PRIVATE_OVERLAY_NAME||o.name.startsWith('private/articles/')||o.name==='rss-state.json'||o.name==='library-sync.json'||o.name==='private-library.wrss'||o.name.startsWith('reader/')||!!o.privateBook;
  // Preload authenticated overlay decisions from ALL current heads before
  // projecting any backing archive, including heads applied on earlier runs.
  const snapshots=[] as {h:CloudSnapshotHead;remote:Awaited<ReturnType<CloudSession['client']['snapshot']>>;manifest:CloudManifest;overlayPayload:Map<string,Uint8Array>}[];
  let overlayPending=0;
  const load=async(h:CloudSnapshotHead,remote:Awaited<ReturnType<CloudSession['client']['snapshot']>>,manifest:CloudManifest,object:import('./codec').CloudObject)=>{
   const key=await s.keys.accountKey(s.userId,h.keyVersion);if(!key)throw Error('缺少账号密钥');
   try{for(const c of (object.entryRef?manifest.objects.find(o=>o.name===object.entryRef!.object)?.chunks:object.chunks)??[])if(!await s.cache.chunk(s.userId,c.ciphertextSha256)){
     await current();const target=remote.chunks.find(t=>t.sha256===c.ciphertextSha256);if(!target||target.sizeBytes!==c.ciphertextBytes)throw Error('云快照缺少中继数据块');const bytes=await s.client.download(target.signedUrl,c.ciphertextBytes,c.ciphertextSha256);await s.cache.storeChunk(s.userId,c.ciphertextSha256,bytes);
    }
    return (await s.codec.restore(key,manifest,async hash=>{const b=await s.cache.chunk(s.userId,hash);if(!b)throw Error('中继缓存缺失');return b;},[object])).get(object.name)!;
   }finally{key.fill(0);}
  };
  for(const h of [...heads].sort((a,b)=>a.deviceSequence-b.deviceSequence)){
   await current();this.set('downloading','正在接收云快照',member);
   const remote=await s.client.snapshot(h.id);let bytes=await s.cache.manifest(s.userId,h.id);
   if(bytes&&(bytes.length!==h.manifestSizeBytes||await this.ports.hash(bytes)!==h.manifestSha256))bytes=undefined;
   const uncached=!bytes;bytes??=await s.client.download(remote.manifestUrl,h.manifestSizeBytes,h.manifestSha256);
   if(uncached)await s.cache.storeManifest(s.userId,h.id,bytes);const manifest=await this.manifest(s,h,bytes),overlayPayload=new Map<string,Uint8Array>();
   if(!cloudCompatibility(manifest).opaque&&hasPrivateOverlay(manifest)){
    if(!full||!s.library.observePrivateOverlay){overlayPending++;formatBlocked=true;}
    else{const index=manifest.objects.find(o=>o.name===PRIVATE_OVERLAY_NAME)!;
     // An unavailable/opaque index cannot license applying stale backing data.
     if(cloudCompatibility(index).opaque)throw Error('cloud_format_overlay_invalid');
     const bytes=await load(h,remote,manifest,index);overlayPayload.set(index.name,bytes);
     const trustedApplied=h.deviceSequence<=await s.state.applied(h.sourceDeviceId,true);
     const entries=(await decodePrivateOverlay(bytes,this.ports.hash)).entries;
     if(!trustedApplied)for(const e of entries)if(e.object){const object=manifest.objects.find(o=>o.name===e.object);if(object&&!cloudCompatibility(object).opaque)try{overlayPayload.set(object.name,await load(h,remote,manifest,object));}catch{await current();}}
     overlayPending+=(await s.library.observePrivateOverlay(overlayPayload,h.sourceDeviceId,manifest.objects,trustedApplied)).pending;
    }
   }
   snapshots.push({h,remote,manifest,overlayPayload});
  }
  pendingItems+=overlayPending;
  for(const {h,remote,manifest,overlayPayload}of snapshots){
   await current();const alreadyApplied=h.deviceSequence<=await s.state.applied(h.sourceDeviceId,full);
   const rootPolicy=cloudCompatibility(manifest);if(rootPolicy.readOnly){formatBlocked=true;if(rootPolicy.opaque)compatibility.opaque++;else compatibility.readOnly++;compatibility.upgradeRequired=true;if(rootPolicy.opaque){pendingItems++;continue;}}
   const incompatible=manifest.objects.filter(o=>cloudCompatibility(o).opaque||!supported(o));compatibility.opaque+=incompatible.length;compatibility.readOnly+=manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&cloudCompatibility(o).readOnly).length;
   if(alreadyApplied){const blocked=Number(rootPolicy.readOnly)+incompatible.length+manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&cloudCompatibility(o).readOnly).length;if(blocked)pendingItems+=blocked;else if(full&&!overlayPending)await s.client.acknowledge(h.id,s.deviceId);continue;}
   const selected=manifest.objects.filter(o=>!cloudCompatibility(o).opaque).filter(o=>o.name==='rss-state.json'||(full&&(o.name===PRIVATE_OVERLAY_NAME||o.name.startsWith('private/articles/')||o.name==='library-sync.json'||o.name==='private-library.wrss'||o.name.startsWith('reader/')||!!o.privateBook)));
   const descriptors=new Map(remote.chunks.map(c=>[c.sha256,c]));
   const key=await s.keys.accountKey(s.userId,h.keyVersion);if(!key)throw Error('缺少账号密钥');let headPending=Number(overlayPending>0)+Number(rootPolicy.readOnly)+incompatible.length+manifest.objects.filter(o=>!cloudCompatibility(o).opaque&&cloudCompatibility(o).readOnly).length;
   try{const payload=new Map(overlayPayload);for(const object of selected)try{
     if(payload.has(object.name))continue;
     for(const c of (object.entryRef?manifest.objects.find(o=>o.name===object.entryRef!.object)?.chunks:object.chunks)??[])if(!await s.cache.chunk(s.userId,c.ciphertextSha256)){await current();const target=descriptors.get(c.ciphertextSha256);if(!target||target.sizeBytes!==c.ciphertextBytes)throw Error('云快照缺少中继数据块');const data=await s.client.download(target.signedUrl,c.ciphertextBytes,c.ciphertextSha256);await s.cache.storeChunk(s.userId,c.ciphertextSha256,data);}
     for(const [name,bytes]of await s.codec.restore(key,manifest,async hash=>{const b=await s.cache.chunk(s.userId,hash);if(!b)throw Error('中继缓存缺失');return b;},[object]))payload.set(name,bytes);
    }catch{await current();if(!object.name.startsWith('reader/'))headPending++;}
    await current();this.set('merging','正在合并手机数据',member);const restored=await s.library.restorePayloads(payload,h.sourceDeviceId,selected);if(typeof restored==='number')changed=restored>0||changed;else{changed=restored.changed>0||changed;headPending+=restored.pending;if(restored.abandoned&&!await s.state.warned(h.sourceDeviceId,h.id)){await current();await s.state.markWarned(h.sourceDeviceId,h.id);abandonedItems+=restored.abandoned;}}
   }finally{key.fill(0);}pendingItems+=headPending;
   await current();
   if(full&&!headPending){await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,true);await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,false);await s.client.acknowledge(h.id,s.deviceId);}
   else if(!headPending&&selected.some(o=>o.name==='rss-state.json'))await s.state.markApplied(h.sourceDeviceId,h.deviceSequence,false);
  }
  // A different library owner needs an explicit choice before rebuilding the
  // previous account's public-source projection or issuing its RSS requests.
  // Keep read-only cloud recovery above and recheck again before every upload.
  await current();await s.assertUpload?.();
  let inventoryFailures=0;
  {this.set('downloading','正在更新公共 RSS 库',member);for(const source of await s.library.publicSources()){
   await current();try{const inventory=await s.client.resolveRssSource(source.url,mode);await current();changed=(await s.library.mergeInventory({...inventory,url:source.url})>0)||changed;}catch{inventoryFailures++;}
  }}
  if(records&&!recordFailure)try{if(await recordStep('reapply',()=>records!.reapply()))changed=true;}catch(e){recordError(e);}
  if(changed)this.ports.onChanged?.();await current();
  await s.assertUpload?.();
  // Flush after all public refreshes and merges. Failures stay in the records lane.
  if(records&&!recordFailure)try{try{await recordStep('flush',()=>records!.flush());}catch(e){if(!String(e).includes('cloud_record_conflict'))throw e;await recordStep('pull',()=>records!.pull());await recordStep('flush',()=>records!.flush());}}catch(e){recordError(e);}
  const version=await s.keys.currentKeyVersion(s.userId),payload=await s.library.exportPayloads(full);
  const contentHash=await this.ports.hash(utf8Encode(`v3:${bootstrap.libraryEpoch}:${content.contentGeneration}:${version}:${payload.fingerprint}`));
  const fresh=await s.client.snapshotHeads();fresh.forEach(headValid);
  // Do not claim to have observed a head that arrived while we were merging.
  if(fresh.length!==heads.length||fresh.some(h=>!heads.some(old=>old.id===h.id&&old.manifestSha256===h.manifestSha256)))throw Error('云资料已更新，请重试');
  let previous:CloudManifest|undefined;
  const own=fresh.find(h=>h.sourceDeviceId===s.deviceId);
  if(own&&full){let cached=await s.cache.manifest(s.userId,own.id);if(cached&&(cached.length!==own.manifestSizeBytes||await this.ports.hash(cached)!==own.manifestSha256))cached=undefined;
   if(!cached){const remote=await s.client.snapshot(own.id);cached=await s.client.download(remote.manifestUrl,own.manifestSizeBytes,own.manifestSha256);}
   previous=await this.manifest(s,own,cached);await s.cache.storeManifest(s.userId,own.id,cached);
   if(own.keyVersion!==version&&(cloudHasUnknownData(previous)||previous.objects.some(o=>cloudCompatibility(o).readOnly||cloudHasUnknownData(o)||!supported(o)))){formatBlocked=true;compatibility.opaque++;}
  }
  const verifiedSequences=new Map(await Promise.all(snapshots.map(async v=>[v.h.sourceDeviceId,await s.state.applied(v.h.sourceDeviceId,true)] as const)));
  const verifiedParents=snapshots.filter(v=>v.h.deviceSequence<=(verifiedSequences.get(v.h.sourceDeviceId)??0));
  if(!previous&&full)previous=[...verifiedParents].reverse().find(v=>v.manifest.keyVersion===version&&!cloudCompatibility(v.manifest).readOnly&&Array.isArray(v.manifest.objects)&&v.manifest.objects.some(o=>o.name==='private-library.wrss'||o.name===PRIVATE_OVERLAY_NAME||o.name.startsWith('reader/')||!!o.privateBook))?.manifest;
  if(full&&s.client.refreshR48WriteGate)await s.client.refreshR48WriteGate();
  if(snapshots.some(v=>hasPrivateOverlay(v.manifest)||Array.isArray(v.manifest.objects)&&v.manifest.objects.some(o=>!!o.objectKeyEnvelope||!!o.entryRef))&&s.client.r48WriteEnabled!==true)formatBlocked=true;
  const writeBlockedByGate=snapshots.some(v=>hasPrivateOverlay(v.manifest)||Array.isArray(v.manifest.objects)&&v.manifest.objects.some(o=>!!o.objectKeyEnvelope||!!o.entryRef))&&s.client.r48WriteEnabled!==true;
  this.value={...this.value,formatEvolution:{writeV1Enabled:s.client.r48WriteEnabled===true,migrationV1Enabled:false,privateOverlayHeads:snapshots.filter(v=>hasPrivateOverlay(v.manifest)).length,acceptedOutputObjects:snapshots.reduce((n,v)=>n+(Array.isArray(v.manifest.objects)?v.manifest.objects.filter(o=>!!o.objectKeyEnvelope).length:0),0)}};
  const sameContent=!!own&&previous?.settings.snapshotContentLayout===3&&previous.settings.libraryEpoch===bootstrap.libraryEpoch&&previous.settings.snapshotContentHashV3===contentHash;
  // Complete may have committed remotely before a crash/disk-full interrupted
  // latest/pending/cursor writes. Reconcile only a fully verified, applied own
  // head matching the CURRENT local export, without a new publish or write gate.
  if(full&&sameContent&&own&&own.deviceSequence<=(verifiedSequences.get(s.deviceId)??0)){
   const saved=await s.cache.pending(s.userId),latest=await s.cache.latest(s.userId);
   if(saved?.id===own.id||latest?.id!==own.id||await s.state.lastContentHash(true)!==contentHash){
    await current();const bytes=await s.cache.manifest(s.userId,own.id);if(!bytes||bytes.length!==own.manifestSizeBytes||await this.ports.hash(bytes)!==own.manifestSha256)throw Error('云 manifest 缓存缺失或校验失败');
    await s.cache.storeManifest(s.userId,own.id,bytes,true);await s.cache.clearPending(s.userId,own.id);await s.state.markUploaded(contentHash,true);
   }
  }
  const now=(this.ports.now??Date.now)();
  const throttled=!manual&&!!own&&previous&&now-previous.createdAtMillis<10*60*1000;
  let completedPrivateArticleIds:readonly string[]=full&&sameContent?payload.articleIds??[]:[];let completedBookIds:readonly string[]=full&&sameContent&&previous?.settings.privateBodyFingerprintV2===payload.fingerprint&&Array.isArray(previous.settings.privateBodyBookIds)?previous.settings.privateBodyBookIds.filter((id):id is string=>typeof id==='string'&&(payload.bookIds??[]).includes(id)):[];
  if(full&&!formatBlocked&&!records?.compatibility?.readOnly&&!records?.compatibility?.opaque&&!records?.compatibility?.editPending&&!recordFailure&&!sameContent&&!throttled&&(payload.objects.length>0||!!own&&!payload.pendingPrivateArticles)){
   const key=await s.keys.accountKey(s.userId,version);if(!key)throw Error('当前账号主密钥不存在');
   let attemptedId:string|undefined;
   try{
    const saved=await s.cache.pending(s.userId);let pending:CloudManifest|undefined;
    if(saved)try{const m=await s.codec.decryptManifest(key,saved.id,saved.bytes);if(m.sourceDeviceId===s.deviceId&&m.keyVersion===version&&m.settings.libraryEpoch===bootstrap.libraryEpoch&&m.settings.snapshotContentLayout===3&&m.settings.contentGeneration===content.contentGeneration)pending=m;}catch{/* Authentication failure never licenses ciphertext reuse. */}
    if(pending)previous=pending;
    const createStarted=(this.ports.now??Date.now)();let snapshot=await s.codec.create({accountKey:key,keyVersion:version,sourceDeviceId:s.deviceId,sequence:await s.state.nextSequence(Math.max(bootstrap.devices.find(d=>d.deviceId===s.deviceId)?.lastSequence??0,...fresh.filter(h=>h.sourceDeviceId===s.deviceId).map(h=>h.deviceSequence))),snapshotId:await this.ports.uuid(),createdAtMillis:(this.ports.now??Date.now)(),objects:payload.objects,reuseManifests:verifiedParents.filter(v=>v.manifest.keyVersion===version&&!cloudCompatibility(v.manifest).readOnly).map(v=>v.manifest),removedPrivateArticleIds:payload.removedArticleIds,removedPrivateArticleUrls:payload.removedArticleUrls,removedObjectNames:payload.removedObjectNames,readPreviousChunk:previous?.keyVersion!==version?undefined:async hash=>{let bytes=await s.cache.chunk(s.userId,hash);if(bytes)return bytes;const target=snapshots.flatMap(v=>v.remote.chunks).find(c=>c.sha256===hash);if(!target)throw Error('cloud_format_previous_missing');await current();bytes=await s.client.download(target.signedUrl,target.sizeBytes,hash);await s.cache.storeChunk(s.userId,hash,bytes);return bytes;},settings:{contentGeneration:content.contentGeneration,snapshotContentLayout:3,libraryEpoch:bootstrap.libraryEpoch,snapshotContentHashV3:contentHash,podjsPrivateBodyFingerprintV3:payload.fingerprint,privateBodyFingerprintV2:payload.fingerprint,privateBodyBookIds:payload.bookIds??[],privateBodyArticleIds:payload.articleIds??[]},parentHeads:Object.fromEntries(fresh.map(h=>[h.sourceDeviceId,h.id])),observedHeads:Object.fromEntries(await Promise.all(fresh.map(async h=>[h.sourceDeviceId,Math.min(h.deviceSequence,await s.state.applied(h.sourceDeviceId,full))]))),previous});
    if(!freshPlan&&pending&&saved&&JSON.stringify(pending.objects)===JSON.stringify(snapshot.manifest.objects)&&
      sameRecord(pending.parentHeads,snapshot.manifest.parentHeads)&&sameRecord(pending.observedHeads,snapshot.manifest.observedHeads)&&
      (this.ports.now??Date.now)()-pending.createdAtMillis>=0&&(this.ports.now??Date.now)()-pending.createdAtMillis<23*60*60*1000){
     snapshot={manifest:{...pending,allChunks:pending.objects.flatMap(o=>o.chunks??[])},encryptedManifest:saved.bytes,newChunks:new Map()};
    }
    try{this.ports.report?.({event:'snapshot-created',writeV1:!!snapshot.manifest.features?.incompat?.includes(PRIVATE_OVERLAY_FEATURE),newChunks:snapshot.newChunks.size,reusedChunks:new Set(snapshot.manifest.allChunks.map(c=>c.ciphertextSha256)).size-snapshot.newChunks.size,uploadBytes:snapshot.encryptedManifest.length+[...snapshot.newChunks.values()].reduce((n,b)=>n+b.length,0),constructMillis:Math.max(0,(this.ports.now??Date.now)()-createStarted)});}catch{}
    for(const [hash,bytes] of snapshot.newChunks)await s.cache.storeChunk(s.userId,hash,bytes);
    await current();await s.assertUpload?.();attemptedId=snapshot.manifest.snapshotId;await s.cache.storePending(s.userId,attemptedId,snapshot.encryptedManifest);await current();await s.assertUpload?.();this.set('uploading','正在上传手表状态',member);
    const reservation=await s.client.reserveSnapshot(snapshot,30);if(reservation.snapshotId!==snapshot.manifest.snapshotId)throw Error('云预留 ID 不匹配');
    const allowed=new Map(snapshot.manifest.allChunks.map(c=>[c.ciphertextSha256,c.ciphertextBytes]));
    const manifestHash=await this.ports.hash(snapshot.encryptedManifest);
    for(const target of reservation.missingObjects){
     await current();if(target.kind==='manifest'?(target.sha256!==manifestHash||target.sizeBytes!==snapshot.encryptedManifest.length):(target.kind!=='chunk'||allowed.get(target.sha256)!==target.sizeBytes))throw Error('无效上传目标');
     const bytes=target.kind==='manifest'?snapshot.encryptedManifest:await s.cache.chunk(s.userId,target.sha256);if(!bytes)throw Error('待上传中继块缺失');await s.uploader.upload(target,bytes);
    }
    await current();await s.assertUpload?.();await s.client.completeSnapshot(snapshot.manifest.snapshotId,[...allowed.keys()]);completedPrivateArticleIds=payload.articleIds??[];completedBookIds=payload.bookIds??[];
    await current();await s.cache.storeManifest(s.userId,snapshot.manifest.snapshotId,snapshot.encryptedManifest,true);
    await s.cache.clearPending(s.userId,snapshot.manifest.snapshotId);
    await s.state.markApplied(s.deviceId,snapshot.manifest.deviceSequence,false);
    if(full){await s.state.markApplied(s.deviceId,snapshot.manifest.deviceSequence,true);await s.state.markUploaded(contentHash,true);}
   }catch(error){
    if(attemptedId&&!contentRecovery(error)&&/invalid_snapshot|invalid_device_sequence/.test(error instanceof Error?error.message:''))await s.cache.clearPending(s.userId,attemptedId);
    throw error;
   }finally{key.fill(0);}
  }
  if(records&&!recordFailure&&(completedPrivateArticleIds.length||completedBookIds.length))try{await recordStep('confirm',()=>records!.flush(completedPrivateArticleIds,completedBookIds));}catch(e){recordError(e);}
  const recordCompat=records?.compatibility??emptyCompatibilityStatus();compatibility.opaque+=recordCompat.opaque;compatibility.readOnly+=recordCompat.readOnly;compatibility.editPending+=recordCompat.editPending;if(formatBlocked&&!sameContent)compatibility.editPending++;if(s.client.requiredFeatures?.length)compatibility.requiredFeatures=s.client.requiredFeatures;compatibility.upgradeRequired=!!(compatibility.requiredFeatures?.length||compatibility.opaque||compatibility.readOnly||compatibility.editPending&&!writeBlockedByGate);
  this.value={...this.value,formatCompatibility:compatibility,...(compatibility.upgradeRequired?{retryable:false}:{}),...(compatibility.requiredFeatures?.length?{errorCode:'cloud_format_upgrade_required' as const}:{})};
  const deferred=!!(full&&!sameContent&&throttled);
  pendingItems+=payload.pendingPrivateArticles??0;
  this.value={...this.value,pendingItems,abandonedItems,...(deferred?{retryAtMillis:previous!.createdAtMillis+10*60*1000}:{})};
  const abandonedMessage=abandonedItems?`已放弃 ${abandonedItems} 个结构不完整、无法恢复的私有条目`:'';
  const messages=[recordFailure,...(writeBlockedByGate&&compatibility.editPending?['新格式写入暂未开放，本机编辑已保留']:[]),...(compatibility.upgradeRequired?['部分云资料需升级后使用，未应用的原数据和本机编辑已保留']:[]),...(deferred?['稍后合并备份']:[]),...(pendingItems?[`部分私有条目缺少元数据或正文（${pendingItems}），等待重试`]:[])].filter(Boolean);
  if(messages.length){this.set(recordFailure?'error':'idle',[...messages,...(abandonedMessage?[abandonedMessage]:[])].join('；'),member);return false;}
  this.set('complete',(inventoryFailures?'云状态已同步；部分公共 RSS 待重试':full?'云同步完成':'阅读状态已同步；正文等待Wi-Fi')+(abandonedMessage?'；'+abandonedMessage:''),member);return true;
 }
}
