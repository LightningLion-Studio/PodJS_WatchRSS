import {idleHit} from '../diagnostics/idle-counters';
import {cloudChangeUnchanged,cloudRemoteUnchanged,cloudLocalUnchanged,type CloudChangeDetection,type CloudChangeRead,type CloudChangeStamp} from './change-detection';
import {emptyRestoreProgress,restoreProgressDiagnostic,type RestoreProgress} from './restore-progress';
import {snapshotDeferred,SNAPSHOT_DEFER_CODES} from './snapshot-deferral';
import {cloudSyncFailure,cloudFailureStage,type CloudSyncFailureStage} from './failure';
import {restoreSnapshots,openAppliedSnapshotInputs} from './snapshot-restore';
import {SnapshotRestoreCheckpoint} from './snapshot-checkpoint';
import {isLibraryOwnerMismatch} from '../account/store';
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
import {utf8Encode,utf8Decode,type CloudUploadObject,type CloudMemberState,type CloudSnapshotHead,type RssInventory} from './types';
import {cloudDisabled,type CloudGuard} from './guard';
export type WatchCloudPhase='idle'|'waiting'|'registering'|'waiting-approval'|'downloading'|'merging'|'uploading'|'complete'|'error';
export interface WatchCloudStatus {restoreProgress?:RestoreProgress;/** A soft deadline after a newly persisted restore unit, not begin/cycle counters. */continuationReady?:boolean;yieldedToWriter?:boolean;ownerChoiceRequired?:boolean;errorCode?:typeof SNAPSHOT_DEFER_CODES[number]|'cloud_host_capability_unavailable'|'cloud_format_upgrade_required'|'library_owner_mismatch'|'cloud_snapshot_progress_stalled'|'cloud_snapshot_unit_capacity';formatEvolution?:{writeV1Enabled:boolean;migrationV1Enabled:false;privateOverlayHeads:number;acceptedOutputObjects:number};formatCompatibility?:CloudCompatibilityStatus;phase:WatchCloudPhase;message:string;usedBytes:number;reservedBytes:number;quotaBytes:number;lastCompletedAt:number;member?:CloudMemberState;retryAtMillis?:number;pendingItems?:number;abandonedItems?:number;retryable?:boolean}
export interface CloudSession {
 userId:string;deviceId:string;displayName:string;
 changes?:CloudChangeDetection;prepareRestore?():Promise<void>;
 restoreCheckpoint?:{receipt?:(id:number)=>void;guardVersion?:string;stalled?:(value:boolean)=>void;readBatch?:<T>(action:()=>Promise<T>)=>Promise<T>;assertCurrent?:()=>Promise<void>;state:WatchCloudStateStore;cache:WatchCloudCache;codec:WatchCloudCodec};
 client:Partial<Pick<WatchCloudClient,'recordsHead'|'refreshR48WriteGate'|'r48WriteEnabled'|'requiredFeatures'>>&Pick<WatchCloudClient,'setEpoch'|'setContentGeneration'|'registerDevice'|'bootstrap'|'snapshotHeads'|'snapshot'|'download'|'acknowledge'|'resolveRssSource'|'reserveSnapshot'|'completeSnapshot'>;
 keys:Pick<WatchCloudKeyManager,'publicKeySpki'|'currentKeyVersion'|'acceptBootstrap'|'accountKey'>&Partial<Pick<WatchCloudKeyManager,'prepareLegacyUpgrade'>>;
 codec:WatchCloudCodec;cache:WatchCloudCache;state:WatchCloudStateStore;uploader:{upload(target:CloudUploadObject,bytes:Uint8Array):Promise<void>};
 library:Partial<Pick<WatchCloudLibraryAdapter,'observePrivateOverlay'|'readingInventoryMode'|'trackProgress'>>&Pick<WatchCloudLibraryAdapter,'publicSources'|'mergeInventory'|'exportPayloads'|'restorePayloads'>;
 /** Account identity/revocation must be rechecked after asynchronous IO. */
 assertCurrent():Promise<void>;
 assertUpload?():Promise<void>;
 assertOwnership?():Promise<void>;
 invalidate?():Promise<void>;
 records(bootstrap:import('./types').CloudBootstrap,current:()=>Promise<void>):Promise<WatchCloudRecords>;
}
export interface CloudSyncPorts {
 snapshotDiagnostic?:(value:string)=>void;
 recordDiagnostic?:(value:string)=>void;
 formatDiagnostic?:(value:string)=>void;
 open(check?:()=>void):Promise<CloudSession|undefined>;
 network():Promise<{active:boolean;validated:boolean;wifi:boolean;metered:boolean}>;
 hash(bytes:Uint8Array):Promise<string>;uuid():Promise<string>;
 /** Host lease shared by foreground and background guests; release on close. */
 exclusive<T>(action:()=>Promise<T>):Promise<T>;
 now?:()=>number;onChanged?:()=>void|Promise<void>;report?:(value:{event:'snapshot-created';writeV1:boolean;newChunks:number;reusedChunks:number;uploadBytes:number;constructMillis:number})=>void;
}
function headValid(h:CloudSnapshotHead){if(!/^[A-Za-z0-9-]{1,128}$/.test(h.id)||!h.sourceDeviceId||!Number.isSafeInteger(h.deviceSequence)||h.deviceSequence<1||!Number.isSafeInteger(h.keyVersion)||h.keyVersion<1||!Number.isSafeInteger(h.manifestSizeBytes)||h.manifestSizeBytes<51||h.manifestSizeBytes>8*1024*1024||!/^[0-9a-f]{64}$/.test(h.manifestSha256))throw Error('无效云端 head');}
const headsToken=(heads:CloudSnapshotHead[],recordsFormat:number)=>JSON.stringify([recordsFormat,[...heads].sort((a,b)=>a.sourceDeviceId<b.sourceDeviceId?-1:a.sourceDeviceId>b.sourceDeviceId?1:0).map(h=>[h.sourceDeviceId,h.id,h.manifestSha256,h.deviceSequence])]);
const sameRecord=(a:Record<string,unknown>,b:Record<string,unknown>)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
export class WatchCloudSyncService {
 private failureStage:CloudSyncFailureStage='lease_acquire';
 private durableProgress=false;private continuationExpected=false;private transportFailed=false;
 private recordFailure?:{code:string;stage:RecordFailureStage;category:CloudFormatFailure};
 private budget?:CloudSyncBudget;
 private usageRefresh:(()=>Promise<void>)|undefined;
 private statusEpoch=0;private runEpoch=0;
 private tail:Promise<unknown>=Promise.resolve();private listeners=new Set<()=>void>();
 private value:WatchCloudStatus={phase:'idle',message:'尚未同步',usedBytes:0,reservedBytes:0,quotaBytes:0,lastCompletedAt:0};
 constructor(private ports:CloudSyncPorts,private guard:CloudGuard=cloudDisabled){}
 get status(){return {...this.value,...(this.value.restoreProgress?{restoreProgress:JSON.parse(JSON.stringify(this.value.restoreProgress)) as RestoreProgress}:{})};}
 subscribe(fn:()=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
 reset(){this.statusEpoch++;this.value={phase:'idle',message:'尚未同步',usedBytes:0,reservedBytes:0,quotaBytes:0,lastCompletedAt:0};this.emit();}
 /** Explicit display state. No user IDs, owner IDs or credentials. */
 requireOwnerChoice(){this.value={...this.value,phase:'error',errorCode:'library_owner_mismatch',ownerChoiceRequired:true,retryable:false,retryAtMillis:undefined,message:'本机资料属于其他账号，请先选择清空或合并'};this.emit();}
 ownerResolved(){if(!this.value.ownerChoiceRequired)return;this.value={...this.value,phase:'idle',errorCode:undefined,ownerChoiceRequired:false,retryable:undefined,retryAtMillis:undefined,message:'资料归属已确认，等待继续同步'};this.emit();}
 private emit(){for(const fn of this.listeners)try{fn();}catch{}}
 /** Records replay reports how much of the cloud revision range is done; shown on the cloud sync page. */
 recordProgress(done:number,total:number){
  if(this.value.phase!=='downloading'||!(total>0)||!(done>=0))return;
  const percent=Math.min(99,Math.floor(done*100/total));
  this.set('downloading',`正在恢复收藏和阅读进度 ${percent}%`);
 }
 private set(phase:WatchCloudPhase,message:string,member?:CloudMemberState){if(this.runEpoch!==this.statusEpoch)return;this.value={...this.value,phase,message,...(member?{member,usedBytes:member.usedBytes,reservedBytes:member.reservedBytes,quotaBytes:member.quotaBytes}:{}),...(phase==='complete'?{lastCompletedAt:(this.ports.now??Date.now)()}:{} )};this.emit();}
 syncNow(manual=false,mode:'all'|'recent128'='recent128'):Promise<boolean>{
  try{this.guard.require();}catch(error){throw cloudSyncFailure(error,'guard');}const started=(this.ports.now??Date.now)(),epoch=this.statusEpoch;let failure:CloudFormatFailure='none',failureCode:string|undefined,failureMethod:string|undefined,cleanupCode:string|undefined;const run=this.tail.then(()=>{if(epoch!==this.statusEpoch)return false;this.runEpoch=epoch;this.durableProgress=false;this.continuationExpected=false;this.transportFailed=false;this.failureStage='lease_acquire';this.value={...this.value,restoreProgress:undefined,continuationReady:false,yieldedToWriter:false};this.budget=new CloudSyncBudget(this.ports.now);this.recordFailure=undefined;return this.ports.exclusive(()=>this.recover(manual,mode));}).catch(original=>{const error=cloudSyncFailure(original,this.failureStage);this.failureStage=cloudFailureStage(error,this.failureStage);failure=cloudFormatFailure(error);const diagnostic=JSON.parse(recordFailureDiagnostic(error));failureCode=diagnostic.code;failureMethod=diagnostic.method;const cleanup=(error as {cleanupCode?:unknown})?.cleanupCode;if(typeof cleanup==='string'&&JSON.parse(recordFailureDiagnostic(Error(cleanup))).code!=='unclassified')cleanupCode=cleanup;if(epoch!==this.statusEpoch)return false;const reason=String(error);if(isLibraryOwnerMismatch(error)){this.requireOwnerChoice();}else if(contentRecovery(error)==='upgrade'&&(error as {code?:unknown})?.code==='cloud_format_upgrade_required'){this.value={...this.value,errorCode:'cloud_format_upgrade_required',retryable:false,formatCompatibility:{...(this.value.formatCompatibility??emptyCompatibilityStatus()),editPending:Math.max(1,this.value.formatCompatibility?.editPending??0),upgradeRequired:true}};this.set('error','请升级到最新版本以继续同步');}else if(reason.includes('cloud_snapshot_unit_capacity')){this.value={...this.value,errorCode:'cloud_snapshot_unit_capacity',retryable:false};this.set('error','旧快照单个对象超过本端连续解压上限，请在手机处理后重试');}else if(snapshotDeferred(error)){const abandoned=(error as {snapshotAbandonedItems?:number}).snapshotAbandonedItems;const abandonedItems=Number.isSafeInteger(abandoned)&&abandoned!>0?abandoned!:0;this.value={...this.value,abandonedItems,errorCode:failureCode as typeof SNAPSHOT_DEFER_CODES[number],pendingItems:Math.max(1,this.value.pendingItems??0),retryable:true,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('waiting',(abandonedItems?'部分私有条目结构不完整，已放弃（'+abandonedItems+'）；':'')+(this.recordFailure?'云记录待重试；':'')+(['cloud_snapshot_object_missing','cloud_snapshot_object_integrity'].includes(failureCode??'')?'私有条目缺少元数据或正文，等待重试':'云快照暂时无法恢复，等待重试'));}else if(reason.includes('cloud_snapshot_progress_stalled')){this.value={...this.value,errorCode:'cloud_snapshot_progress_stalled',retryable:true,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('waiting','云快照恢复暂未推进，稍后自动继续');}else if(failureCode===CLOUD_HOST_CAPABILITY_UNAVAILABLE){this.value={...this.value,errorCode:CLOUD_HOST_CAPABILITY_UNAVAILABLE,retryable:false,retryAtMillis:undefined};this.set('error','请升级腕上RSS以继续云同步');}else if(failure==='busy'){this.value={...this.value,yieldedToWriter:failureCode==='cloud_writer_busy',retryable:true,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('idle',failureCode==='cloud_account_busy'?'账号正在更新，稍后自动继续同步':'其他同步正在运行，稍后自动继续同步');}else if(failure==='timeout'||failure==='concurrent-library-change'||failure==='runtime'){this.value={...this.value,retryable:true,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('error','云同步暂时中断，本机编辑已保留，请稍后重试');}else if(failure==='storage'){this.value={...this.value,retryable:true};this.set('error','本机存储空间不足，请释放空间后重试；本机编辑已保留');}else if(failure==='suspended'){this.value={...this.value,retryable:true,retryAtMillis:Math.max(1,(this.ports.now??Date.now)())};this.set('waiting','等待继续，回到应用或系统后台接手后自动续做');}else if(failure==='gate'){this.value={...this.value,retryable:true,formatCompatibility:{...(this.value.formatCompatibility??emptyCompatibilityStatus()),editPending:1,upgradeRequired:false}};this.set('idle','新格式写入暂未开放，本机编辑已保留');}else if(reason.includes('cloud_format_overlay_resources_pending')){this.value={...this.value,retryable:false,pendingItems:1};this.set('idle','条目资源需要在支持的设备处理，本机编辑已保留');}else if(reason.includes('cloud_format_capacity')){this.value={...this.value,retryable:false};this.set('idle','云资料超过本端处理上限，请先在手机整理；本机编辑已保留');}else if(reason.includes('cloud_format_')){this.value={...this.value,retryable:false,formatCompatibility:{...(this.value.formatCompatibility??emptyCompatibilityStatus()),editPending:Math.max(1,this.value.formatCompatibility?.editPending??0),upgradeRequired:true}};this.set('idle','云资料包含只读格式，本机编辑已保留，请升级后继续');}else if(reason.includes('cloud_private_body_pending'))this.set('idle','正文仍在同步，请稍后重试');else if(contentRecovery(error)==='upgrade'||reason.includes('client_upgrade_required')||reason.includes('snapshot_content_layout_unsupported')){this.value={...this.value,retryable:false};this.set('error','请升级腕上RSS以继续云同步');}else if(['rebuild','plan'].includes(contentRecovery(error)??'')){this.value={...this.value,retryAtMillis:(this.ports.now??Date.now)()+30000};this.set('idle','云端内容正在重建，已排队重试；本机资料已保留');}else if(reason.includes('library_epoch_mismatch'))this.set('waiting-approval','资料库已重置，请重新批准');else if(reason.includes('rotation_proof_invalid')||reason.includes('device_attestation_invalid'))this.set('waiting-approval','密钥验证失败，请重新批准');else if(reason.includes('device_key_conflict'))this.set('waiting-approval','本机云设备公钥冲突，请重新登记本机');else if(reason.includes('library_owner_mismatch'))this.set('error','本机资料属于其他账号，请先选择清空或合并');else this.set('error','云同步失败，请稍后重试');return false;}).then(result=>{try{this.ports.snapshotDiagnostic?.(JSON.stringify(restoreProgressDiagnostic(this.value.restoreProgress??emptyRestoreProgress())));}catch{}if(epoch===this.statusEpoch)this.value={...this.value,continuationReady:!result&&this.durableProgress&&!this.transportFailed&&(failureCode==='cloud_sync_deadline_exceeded'||this.continuationExpected&&failure==='none')};if(this.value.continuationReady){idleHit(failureCode==='cloud_sync_deadline_exceeded'?88:89);this.value={...this.value,phase:'waiting',message:'等待继续，正在续接恢复',retryable:true,retryAtMillis:(this.ports.now??Date.now)()+1000};this.emit();}emitCloudFormat(this.ports.formatDiagnostic,{event:'format-sync',outcome:this.value.continuationReady?'deferred':epoch!==this.statusEpoch?'superseded':result?'complete':failure==='busy'||failure==='suspended'||snapshotDeferred({code:failureCode})||failureCode==='cloud_snapshot_progress_stalled'||failureCode==='cloud_sync_deadline_exceeded'?'deferred':failure==='none'&&this.value.phase!=='error'?'deferred':'failed',...(failureCode?{code:failureCode,stage:this.failureStage,...(failureMethod?{method:failureMethod}:{}),...(cleanupCode?{cleanupCode}:{})}:this.recordFailure?{code:this.recordFailure.code}:{}),...(this.recordFailure?{recordCode:this.recordFailure.code,recordStage:this.recordFailure.stage}:{}),category:failure==='none'&&this.recordFailure?this.recordFailure.category:(!result&&failure==='none'&&this.value.formatCompatibility?.upgradeRequired?'format':!result&&failure==='none'&&this.value.phase==='error'?'other':failure),durationMillis:Math.max(0,(this.ports.now??Date.now)()-started)});return result;});this.tail=run;return run;
 }
 private async refreshUsage(){await this.usageRefresh?.();}
 private async recover(manual:boolean,mode:'all'|'recent128'){let recovery:string|undefined;for(let attempt=0;attempt<2;attempt++){let refreshed=false;this.usageRefresh=undefined;try{const result=await this.run(manual,mode,attempt>0,recovery==='rebuild');refreshed=true;await this.refreshUsage();return result;}catch(original){if(isLibraryOwnerMismatch(original))throw original;if(String(original).includes('cloud_sync_deadline_exceeded')||cloudFormatFailure(original)==='suspended'||String(original).includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE))throw original;let error=original;if(!refreshed)try{await this.refreshUsage();}catch(latest){if(contentRecovery(latest)==='rebuild'||String(latest).includes('library_epoch_mismatch'))error=latest;}const kind=contentRecovery(error);if(attempt||!['rebuild','plan'].includes(kind??''))throw error;recovery=kind;this.set('idle',kind==='rebuild'?'云端内容已清理，正在从本机重建同步':'云端上传计划已失效，正在重新准备');}}return false;}
 private async manifest(s:CloudSession,h:CloudSnapshotHead,bytes:Uint8Array){
  headValid(h);if(bytes.length!==h.manifestSizeBytes||await this.ports.hash(bytes)!==h.manifestSha256)throw Error('云 manifest 哈希或长度不符');
  const key=await s.keys.accountKey(s.userId,h.keyVersion);if(!key)throw Error('缺少账号密钥，请在手机端重新批准');
  try{const m=await s.codec.decryptManifest(key,h.id,bytes);
   if(!cloudCompatibility(m).opaque&&h.sourceDeviceId.startsWith('reader-migration-')&&m.objects.some(o=>!o.name.startsWith('reader/')||!!o.privateBook))throw Error('无效阅读器迁移对象');
   if(m.sourceDeviceId!==h.sourceDeviceId||m.deviceSequence!==h.deviceSequence||m.keyVersion!==h.keyVersion||!sameRecord(m.parentHeads,h.parentHeads)||!sameRecord(m.observedHeads,h.observedHeads))throw Error('云 manifest 身份不符');return m;
  }finally{key.fill(0);}
 }
 private async run(manual:boolean,mode:'all'|'recent128',freshPlan=false,forceContentReset=false){
  this.value={...this.value,retryAtMillis:undefined,pendingItems:undefined,abandonedItems:undefined,retryable:undefined,errorCode:this.value.ownerChoiceRequired?'library_owner_mismatch':undefined,formatCompatibility:undefined};this.failureStage='network';this.guard.require();const network=await this.ports.network();if(!network.active||!network.validated){this.set('idle','等待网络连接');return false;}
  // Unknown/cellular/ethernet transports do not silently authorize private bodies.
  const full=manual||(network.wifi&&!network.metered);
  this.failureStage='session_open';this.budget?.check();const s=await this.ports.open(this.budget?.check);if(!s){this.reset();return false;}
  const current=async()=>{this.budget?.check();this.guard.require();if(this.runEpoch!==this.statusEpoch)throw Error('cloud_operation_superseded');await s.assertCurrent();this.budget?.check();};await current();
  this.failureStage='owner';if(s.assertOwnership){await s.assertOwnership();this.ownerResolved();}await current();this.set('registering','正在核对云空间');
  this.failureStage='bootstrap';let bootstrap=await s.client.bootstrap();await current();
  this.failureStage='content';const content=parseContentState(bootstrap);
  s.client.setEpoch(bootstrap.libraryEpoch);s.client.setContentGeneration(content.contentGeneration);
  let changeRead:CloudChangeRead|undefined,changeContext='',checkedHeads:CloudSnapshotHead[]|undefined,checkedRecordsFormat:number|undefined,checkedRecordsRevision:string|undefined,remoteSame=false,remoteVerifiedAt:number|undefined;
  const probeDevice=bootstrap.devices.find(d=>d.deviceId===s.deviceId);
  if(s.changes&&s.client.recordsHead&&probeDevice&&!probeDevice.revokedAt&&!forceContentReset&&!freshPlan){
   try{
    idleHit(80);changeContext=JSON.stringify([bootstrap.libraryEpoch,content.contentGeneration,content.contentEmpty,content.contentClearedAt,full,mode,bootstrap.keyVersionFloor,bootstrap.keyCommitments,bootstrap.keyEnvelopes.map(e=>[e.id,e.envelope.keyVersion]),probeDevice.attestationKeyVersion??null,probeDevice.publicKeySpki,probeDevice.attestation,bootstrap.member.plan,bootstrap.member.readable,bootstrap.member.writable,bootstrap.member.active]);
    changeRead=await s.changes.read(changeContext);checkedHeads=await s.client.snapshotHeads();checkedHeads.forEach(headValid);
    const page=await s.client.recordsHead(changeRead.remote?.recordsRevision??changeRead.checkpoint?.recordsRevision??'0',s.deviceId);
    if(![0,1].includes(page.formatVersion)||!/^(0|[1-9][0-9]*)$/.test(page.headRevision)||page.libraryEpoch!==bootstrap.libraryEpoch||page.keyVersionFloor!==bootstrap.keyVersionFloor||JSON.stringify(page.keyCommitments)!==JSON.stringify(bootstrap.keyCommitments))throw Error('cloud_change_remote_fence_changed');
    checkedRecordsFormat=page.formatVersion;checkedRecordsRevision=page.headRevision;
    remoteSame=!manual&&cloudRemoteUnchanged(changeRead,headsToken(checkedHeads,page.formatVersion),page.headRevision,(this.ports.now??Date.now)());
    if(remoteSame)remoteVerifiedAt=(changeRead.remote??changeRead.checkpoint)!.verifiedAt;
    if(!manual&&cloudChangeUnchanged(changeRead,headsToken(checkedHeads,page.formatVersion),page.headRevision,(this.ports.now??Date.now)())){await current();idleHit(81);this.set('complete',full?'云同步完成':'阅读状态已同步；正文等待Wi-Fi',bootstrap.member);return true;}
    idleHit(82);
   }catch{await current();idleHit(84);changeRead=undefined;checkedHeads=undefined;checkedRecordsFormat=undefined;remoteSame=false;remoteVerifiedAt=undefined;}
  }
  await s.prepareRestore?.();
  const changedEpoch=await s.state.acceptEpoch(bootstrap.libraryEpoch);if(changedEpoch){await s.invalidate?.();this.set('waiting-approval','资料库已重置，请重新批准',bootstrap.member);return false;}
  const previousGeneration=await s.state.contentGeneration();
  if(forceContentReset||previousGeneration!==undefined&&previousGeneration!==content.contentGeneration||content.contentEmpty){await current();await s.cache.clear(s.userId);await s.state.clearContent();await current();this.set('registering','云端内容已清理，正在从本机重建同步',bootstrap.member);}
  await s.state.rememberContentGeneration(content.contentGeneration);s.client.setContentGeneration(content.contentGeneration);
  this.usageRefresh=async()=>{const latest=await s.client.bootstrap();await current();if(latest.libraryEpoch!==bootstrap.libraryEpoch)throw Error('library_epoch_mismatch');if(parseContentState(latest).contentGeneration!==content.contentGeneration)throw Object.assign(Error('cloud_content_rebuild_required'),{status:409,code:'cloud_content_rebuild_required'});this.value={...this.value,member:latest.member,usedBytes:latest.member.usedBytes,reservedBytes:latest.member.reservedBytes,quotaBytes:latest.member.quotaBytes};this.emit();};
  this.failureStage='device';let device=bootstrap.devices.find(d=>d.deviceId===s.deviceId);
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
  this.failureStage='keys';let ready:string;
  try{ready=await s.keys.acceptBootstrap(s.userId,s.deviceId,bootstrap.keyEnvelopes,bootstrap,device?.attestation&&device.attestationKeyVersion?{keyVersion:device.attestationKeyVersion,mac:device.attestation}:undefined);}
  catch(error){if(String(error).includes('library_epoch_mismatch'))await s.invalidate?.();throw error;}
  if(ready==='waiting-approval'){this.set('waiting-approval','请在已登录设备上批准此手表',bootstrap.member);return false;}
  await current();const member=bootstrap.member;
  this.failureStage='checkpoint';const restore=await new SnapshotRestoreCheckpoint(s,this.ports.hash,current,this.ports.now??Date.now,metric=>{try{this.ports.snapshotDiagnostic?.(JSON.stringify(metric));}catch{}}).open(bootstrap.libraryEpoch,content.contentGeneration);
  this.failureStage='run';const resumed=!remoteSame&&restore.active&&restore.phase!=='records';
  try{

  let records:WatchCloudRecords|undefined,recordFailure='',recordStage:RecordFailureStage='open',recordStarted=(this.ports.now??Date.now)();
  const recordStep=async<T>(stage:RecordFailureStage,run:()=>Promise<T>)=>{recordStage=stage;recordStarted=(this.ports.now??Date.now)();let success=false;try{await current();const result=await run();await current();success=true;return result;}finally{try{this.ports.recordDiagnostic?.(JSON.stringify({event:'records-stage',stage,outcome:success?'complete':'failed',durationMillis:Math.max(0,(this.ports.now??Date.now)()-recordStarted)}));}catch{}}};
  const recordError=(e:unknown)=>{if(cloudFormatFailure(e)==='transport')this.transportFailed=true;const diagnostic=recordFailureDiagnostic(e,recordStage,(this.ports.now??Date.now)()-recordStarted);const classified=JSON.parse(diagnostic);this.recordFailure={code:classified.code,stage:recordStage,category:cloudFormatFailure(e)};try{this.ports.recordDiagnostic?.(diagnostic);}catch{/* Diagnostics must not change sync. */}const text=String(e);if(isLibraryOwnerMismatch(e)||String(e).includes('cloud_sync_deadline_exceeded')||cloudFormatFailure(e)==='suspended'||contentRecovery(e)||text.includes(CLOUD_HOST_CAPABILITY_UNAVAILABLE))throw e;if(/library_epoch_mismatch|cloud_operation_superseded|账号|cloud_account_|client_upgrade_required|device_attestation|commitment|library_owner_mismatch/.test(text))throw e;recordFailure=text.includes('cloud_record_count_limit')?'云记录数量已达上限':text.includes('cloud_quota_exceeded')?'云记录空间不足':text.includes('cloud_records_consent_required')?'请先在手机启用云记录':'云记录待重试';};
  s.library.trackProgress?.(async unit=>restore.commit('library:'+unit));
  const openRecords=async()=>{const value=await s.records(bootstrap,current);value.trackProgress?.(unit=>restore.commit('records:'+restore.cycle+':'+unit));if(remoteSame&&(!checkedRecordsRevision||!value.openForPublish||!await value.openForPublish(checkedRecordsRevision))){remoteSame=false;remoteVerifiedAt=undefined;}return value;};
  // Account checks are done; say what the long part actually is.
  this.set('downloading','正在恢复收藏和阅读进度',member);
  if(!resumed)try{records=await recordStep('open',openRecords);if(!remoteSame){if(await recordStep('pull',()=>records!.pull()))await this.ports.onChanged?.();await recordStep('interactions',async()=>records!.flushInteractions?.());}}catch(e){recordError(e);}

  if(!restore.active)await restore.begin();
  await current();const heads=checkedHeads??await s.client.snapshotHeads();heads.forEach(headValid);
  if(new Set(heads.map(h=>h.sourceDeviceId)).size!==heads.length)throw Error('重复云设备 head');
  const supported=(o:import('./codec').CloudObject)=>o.name==='notes-state.json'||o.name==='notes-assets.zip'||o.name===PRIVATE_OVERLAY_NAME||o.name.startsWith('private/articles/')||o.name==='rss-state.json'||o.name==='library-sync.json'||o.name==='private-library.wrss'||o.name.startsWith('reader/')||!!o.privateBook;
  const restored=await (remoteSame?openAppliedSnapshotInputs:restoreSnapshots)({session:s,heads,full,journal:restore,current,progress:value=>{this.value={...this.value,restoreProgress:value};this.emit();},manifest:(h,b)=>this.manifest(s,h,b),hash:this.ports.hash,supported,now:this.ports.now??Date.now,status:(percent,phase)=>this.set(phase==='apply'?'merging':'downloading',phase==='apply'?`正在落盘私有资料 ${percent}%`:`正在恢复云快照 ${percent}%`,member),changed:()=>this.ports.onChanged?.()});
  const {snapshots,compatibility}=restored;let {changed,pendingItems,abandonedItems,formatBlocked}=restored;
  // A different library owner needs an explicit choice before rebuilding the
  // previous account's public-source projection or issuing its RSS requests.
  // Keep read-only cloud recovery above and recheck again before every upload.
  await current();await s.assertUpload?.();
  const readingPlans:{unit:string;payloadKey:string;url:string;mode:'all'|'recent128'}[]=[];
  let inventoryFailures=0;
  if(restore.phase==='snapshots')await restore.phaseDone('inventory');
  if(!remoteSame){this.set('downloading','正在更新公共 RSS 库',member);const sources=await s.library.publicSources();let completed=0;for(const source of sources){
   const inventoryMode=full&&!manual?await s.library.readingInventoryMode?.(source.url,mode)??mode:mode;
   const unit='inventory:'+restore.cycle+':'+await restore.token(JSON.stringify([heads.map(h=>[h.id,h.manifestSha256]).sort((a,b)=>a[0].localeCompare(b[0])),inventoryMode,source.url])),payloadKey=await restore.token(unit);readingPlans.push({unit,payloadKey,url:source.url,mode:inventoryMode});if(restore.has(unit)){completed++;continue;}
   await current();try{const saved=await restore.read(payloadKey);const inventory:Awaited<ReturnType<CloudSession['client']['resolveRssSource']>>=saved?JSON.parse(utf8Decode(saved)):await restore.timed('inventory',0,()=>s.client.resolveRssSource(source.url,inventoryMode));if(!saved)await restore.write(payloadKey,utf8Encode(JSON.stringify(inventory)));await current();changed=(await s.library.mergeInventory({...inventory,url:source.url},{checkpoint:restore.apply(unit,(done,total)=>this.set('downloading',`正在更新公共 RSS 库 ${Math.floor((completed+(total?done/total:0))*100/Math.max(1,sources.length))}%`,member)),skipReading:true})>0)||changed;await restore.commit(unit);completed++;this.set('downloading',`正在更新公共 RSS 库 ${Math.floor(completed*100/Math.max(1,sources.length))}%`,member);}catch{this.transportFailed=true;await current();inventoryFailures++;}
  }}
  if(resumed){await restore.phaseDone('records');
   // Measured warm records cost ~120s on the watch. Do not start that lane in a
   // nearly exhausted snapshot window; never reset/extend the 300s budget.
   if((this.budget?.remainingMillis()??0)<150000){this.continuationExpected=true;this.value={...this.value,retryAtMillis:(this.ports.now??Date.now)()+1};this.set('idle','云快照检查点已保存，继续恢复阅读状态',member);return false;}
   try{records=await recordStep('open',openRecords);if(await recordStep('pull',()=>records!.pull()))await this.ports.onChanged?.();await recordStep('interactions',async()=>records!.flushInteractions?.());}catch(e){recordError(e);}
  }
  const recordScope='heads:'+await restore.token(JSON.stringify(heads.map(h=>[h.id,h.manifestSha256]).sort((a,b)=>a[0].localeCompare(b[0]))));
  if(!remoteSame&&records&&!recordFailure)try{if(await recordStep('reapply',()=>records!.reapply(recordScope,unit=>restore.commit('records-replay:'+recordScope+':'+unit))))changed=true;}catch(e){recordError(e);}
  if(records&&!recordFailure)try{for(const plan of readingPlans){const unit=plan.unit+':reading-v2';if(restore.has(unit)||!restore.has(plan.unit))continue;await current();let bytes=await restore.read(plan.payloadKey);let inventory:RssInventory;
   if(bytes)inventory={...JSON.parse(utf8Decode(bytes)),url:plan.url};else{inventory={...await s.client.resolveRssSource(plan.url,plan.mode),url:plan.url};await restore.write(plan.payloadKey,utf8Encode(JSON.stringify(inventory)));const repair=unit+':metadata:'+await restore.token(JSON.stringify(inventory));changed=(await s.library.mergeInventory(inventory,{checkpoint:restore.apply(repair),skipReading:true})>0)||changed;await restore.commit(repair);}
   changed=(await records.reapplyInventory?.(inventory)>0)||changed;await restore.commit(unit);
  }}catch(e){recordError(e);}
  if(changed)await this.ports.onChanged?.();await current();
  await s.assertUpload?.();
  // Certify remote application independently of publication. An interrupted
  // local export must not force the same remote journals to replay next time.
  if(!remoteSame&&s.changes&&changeRead&&checkedRecordsFormat!==undefined&&!recordFailure&&!inventoryFailures&&!pendingItems&&!abandonedItems&&!formatBlocked&&records?.fullyAppliedRevision!==undefined&&!records.compatibility?.upgradeRequired)try{
   const observed=await s.changes.read(changeContext),at=Math.floor((this.ports.now??Date.now)());
   if(await s.changes.commitRemote(observed.stamp,headsToken(heads,checkedRecordsFormat),records.fullyAppliedRevision,at))remoteVerifiedAt=at;
  }catch{/* Missing metadata forces the safe full path on the next attempt. */}
  // A new remote descriptor need not change canonical local data. Preserve the
  // successful publish witness and its original safety deadline in that case.
  if(!manual&&s.changes&&changeRead&&checkedRecordsFormat!==undefined&&!recordFailure&&!inventoryFailures&&!pendingItems&&!abandonedItems&&!formatBlocked){
   let reuse:CloudChangeRead|undefined;
   try{const observed=await s.changes.read(changeContext),recordCompat=records?.compatibility??emptyCompatibilityStatus();if(cloudLocalUnchanged(observed,(this.ports.now??Date.now)())&&!recordCompat.upgradeRequired&&records?.fullyAppliedRevision!==undefined)reuse=observed;}catch{}
   if(reuse&&records?.fullyAppliedRevision!==undefined){
    await restore.finish();try{const committed=await s.changes.commit(reuse.stamp,headsToken(heads,checkedRecordsFormat),records.fullyAppliedRevision,reuse.checkpoint!.verifiedAt,remoteVerifiedAt);idleHit(committed?83:99);}catch{}
    idleHit(64);this.set('complete',full?'云同步完成':'阅读状态已同步；正文等待Wi-Fi',member);return true;
   }
  }
  // Flush after all public refreshes and merges. Failures stay in the records lane.
  if(records&&!recordFailure)try{try{await recordStep('flush',()=>records!.flush());}catch(e){if(!String(e).includes('cloud_record_conflict'))throw e;await recordStep('pull',()=>records!.pull());await recordStep('flush',()=>records!.flush());}}catch(e){recordError(e);}
  let exportStamp:CloudChangeStamp|undefined;if(s.changes&&changeRead)try{exportStamp=(await s.changes.read(changeContext)).stamp;}catch{}
  let publishedHead:CloudSnapshotHead|undefined;
  const version=await s.keys.currentKeyVersion(s.userId),payload=await restore.timed('export',0,()=>s.library.exportPayloads(full,true));await current();
  const contentHash=await this.ports.hash(utf8Encode(`v3:${bootstrap.libraryEpoch}:${content.contentGeneration}:${version}:${payload.fingerprint}`));
  const fresh=await s.client.snapshotHeads();fresh.forEach(headValid);
  // Do not claim to have observed a head that arrived while we were merging.
  if(fresh.length!==heads.length||fresh.some(h=>!heads.some(old=>old.id===h.id&&old.manifestSha256===h.manifestSha256)))throw Error('云资料已更新，请重试');
  let previous:CloudManifest|undefined;
  const own=fresh.find(h=>h.sourceDeviceId===s.deviceId);
  if(own&&full){let cached=await s.cache.manifest(s.userId,own.id);if(cached&&(cached.length!==own.manifestSizeBytes||await this.ports.hash(cached)!==own.manifestSha256))cached=undefined;
   if(!cached){const remote=await s.client.snapshot(own.id);cached=await s.client.download(remote.manifestUrl,own.manifestSizeBytes,own.manifestSha256);}
   previous=snapshots.find(v=>v.h.id===own.id)?.manifest??await this.manifest(s,own,cached);await s.cache.storeManifest(s.userId,own.id,cached);
   if(own.keyVersion!==version&&(cloudHasUnknownData(previous)||previous.objects.some(o=>cloudCompatibility(o).readOnly||cloudHasUnknownData(o)||o.name==='notes-state.json'||o.name==='notes-assets.zip'||!supported(o)))){formatBlocked=true;compatibility.opaque++;}
  }
  const verifiedSequences=new Map(await Promise.all(snapshots.map(async v=>[v.h.sourceDeviceId,await s.state.applied(v.h.sourceDeviceId,true)] as const)));
  const verifiedParents=snapshots.filter(v=>v.h.deviceSequence<=(verifiedSequences.get(v.h.sourceDeviceId)??0));
  if(!previous&&full)previous=[...verifiedParents].reverse().find(v=>v.manifest.keyVersion===version&&!cloudCompatibility(v.manifest).readOnly&&Array.isArray(v.manifest.objects)&&v.manifest.objects.some(o=>o.name==='private-library.wrss'||o.name===PRIVATE_OVERLAY_NAME||o.name.startsWith('reader/')||!!o.privateBook))?.manifest;
  if(full&&s.client.refreshR48WriteGate)await s.client.refreshR48WriteGate();
  if(snapshots.some(v=>hasPrivateOverlay(v.manifest)||Array.isArray(v.manifest.objects)&&v.manifest.objects.some(o=>!!o.objectKeyEnvelope||!!o.entryRef))&&s.client.r48WriteEnabled!==true)formatBlocked=true;
  const writeBlockedByGate=snapshots.some(v=>hasPrivateOverlay(v.manifest)||Array.isArray(v.manifest.objects)&&v.manifest.objects.some(o=>!!o.objectKeyEnvelope||!!o.entryRef))&&s.client.r48WriteEnabled!==true;
  this.value={...this.value,formatEvolution:{writeV1Enabled:s.client.r48WriteEnabled===true,migrationV1Enabled:false,privateOverlayHeads:snapshots.filter(v=>hasPrivateOverlay(v.manifest)).length,acceptedOutputObjects:snapshots.reduce((n,v)=>n+(Array.isArray(v.manifest.objects)?v.manifest.objects.filter(o=>!!o.objectKeyEnvelope).length:0),0)}};
  const sameContent=!!own&&previous?.settings?.snapshotContentLayout===3&&previous.settings.libraryEpoch===bootstrap.libraryEpoch&&previous.settings.snapshotContentHashV3===contentHash;
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
    await payload.materialize?.();await current();
    const saved=await s.cache.pending(s.userId);let pending:CloudManifest|undefined;
    if(saved)try{const m=await s.codec.decryptManifest(key,saved.id,saved.bytes);if(m.sourceDeviceId===s.deviceId&&m.keyVersion===version&&m.settings.libraryEpoch===bootstrap.libraryEpoch&&m.settings.snapshotContentLayout===3&&m.settings.contentGeneration===content.contentGeneration)pending=m;}catch{/* Authentication failure never licenses ciphertext reuse. */}
    if(pending)previous=pending;
    const createStarted=(this.ports.now??Date.now)();let snapshot=await s.codec.create({accountKey:key,keyVersion:version,sourceDeviceId:s.deviceId,sequence:await s.state.nextSequence(Math.max(bootstrap.devices.find(d=>d.deviceId===s.deviceId)?.lastSequence??0,...fresh.filter(h=>h.sourceDeviceId===s.deviceId).map(h=>h.deviceSequence))),snapshotId:await this.ports.uuid(),createdAtMillis:(this.ports.now??Date.now)(),objects:payload.objects,reuseManifests:verifiedParents.filter(v=>v.manifest.keyVersion===version&&!cloudCompatibility(v.manifest).readOnly).map(v=>v.manifest),removedPrivateArticleIds:payload.removedArticleIds,removedPrivateArticleUrls:payload.removedArticleUrls,removedObjectNames:payload.removedObjectNames,restoreInflate:restored.inflateArchive,readRestoreObject:(manifest,object,site)=>restored.readObject(manifest,object,site),readPreviousChunk:previous?.keyVersion!==version?undefined:async hash=>{let bytes=await s.cache.chunk(s.userId,hash);if(bytes)return bytes;const target=snapshots.flatMap(v=>v.remote.chunks).find(c=>c.sha256===hash);if(!target)throw Error('cloud_format_previous_missing');await current();bytes=await s.client.download(target.signedUrl,target.sizeBytes,hash);await s.cache.storeChunk(s.userId,hash,bytes);return bytes;},settings:{contentGeneration:content.contentGeneration,snapshotContentLayout:3,libraryEpoch:bootstrap.libraryEpoch,snapshotContentHashV3:contentHash,podjsPrivateBodyFingerprintV3:payload.fingerprint,privateBodyFingerprintV2:payload.fingerprint,privateBodyBookIds:payload.bookIds??[],privateBodyArticleIds:payload.articleIds??[]},parentHeads:Object.fromEntries(fresh.map(h=>[h.sourceDeviceId,h.id])),observedHeads:Object.fromEntries(await Promise.all(fresh.map(async h=>[h.sourceDeviceId,Math.min(h.deviceSequence,await s.state.applied(h.sourceDeviceId,full))]))),previous});
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
    await current();await s.assertUpload?.();await s.client.completeSnapshot(snapshot.manifest.snapshotId,[...allowed.keys()]);publishedHead={id:snapshot.manifest.snapshotId,sourceDeviceId:s.deviceId,deviceSequence:snapshot.manifest.deviceSequence,keyVersion:version,manifestSha256:manifestHash,manifestSizeBytes:snapshot.encryptedManifest.length,parentHeads:snapshot.manifest.parentHeads,observedHeads:snapshot.manifest.observedHeads};completedPrivateArticleIds=payload.articleIds??[];completedBookIds=payload.bookIds??[];
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
  if(recordFailure)idleHit(93);if(compatibility.upgradeRequired)idleHit(94);if(inventoryFailures)idleHit(95);if(pendingItems)idleHit(96);if(deferred)idleHit(97);if(abandonedItems)idleHit(98);
  if(messages.length){await restore.finish();this.set(recordFailure?'error':'idle',[...messages,...(abandonedMessage?[abandonedMessage]:[])].join('；'),member);return false;}
  await restore.finish();
  if(s.changes&&exportStamp&&checkedRecordsFormat!==undefined&&!inventoryFailures&&!abandonedItems&&records?.fullyAppliedRevision!==undefined)try{
   const finalHeads=publishedHead?[...heads.filter(h=>h.sourceDeviceId!==s.deviceId),publishedHead]:heads;
   const committed=await s.changes.commit(exportStamp,headsToken(finalHeads,checkedRecordsFormat),records.fullyAppliedRevision,Math.floor((this.ports.now??Date.now)()),remoteVerifiedAt);idleHit(committed?83:99);
  }catch{/* A missing optimization receipt never changes a committed sync result. */}
  this.set('complete',(inventoryFailures?'云状态已同步；部分公共 RSS 待重试':full?'云同步完成':'阅读状态已同步；正文等待Wi-Fi')+(abandonedMessage?'；'+abandonedMessage:''),member);return true;
  }catch(error){if(this.recordFailure?.code==='cloud_sync_deadline_exceeded')throw error;throw await restore.noProgress(error);}finally{this.durableProgress ||= restore.committed;s.library.trackProgress?.();restore.close();}
 }
}
