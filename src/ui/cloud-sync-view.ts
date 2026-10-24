import type {AccountStatusSnapshot} from '../account/status.ts';
import type {WatchCloudPhase} from '../cloud/service.ts';

export type CloudSyncTone = 'muted' | 'busy' | 'ok' | 'attention' | 'error';
export type CloudSyncAction = 'sync' | 'phone' | 'reload' | 'approval';
export interface CloudSyncView {
  title: string;
  detail: string;
  tone: CloudSyncTone;
  button?: {label: string; action: CloudSyncAction; enabled: boolean};
  lastSynced?: string;
  space?: {label: string; fraction: number};
}

const BUSY = new Set<WatchCloudPhase>(['registering', 'downloading', 'merging', 'uploading']);

/**
 * Read-only projection of the account snapshot for 我的 → 云同步; mirrors native CloudSyncUiState.
 * `undefined` = still loading, `null` = no bound account, `cloud` absent = this build has no cloud service.
 */
export type CloudHandoffPhase = 'idle' | 'foreground' | 'queued' | 'held';
export function cloudSyncView(status: AccountStatusSnapshot | null | undefined, available: boolean, pending: boolean, now = Date.now(), handoff: CloudHandoffPhase = 'idle'): CloudSyncView {
  const phone = {label: '连接手机', action: 'phone' as const, enabled: true};
  if (status === undefined) return {title: '正在读取', detail: '', tone: 'muted'};
  if (!available) return {title: '暂未开放', detail: '当前版本还不能使用云同步。本机内容和手机同步照常可用。', tone: 'muted'};
  if (status === null) return {title: '未登录账号', detail: '在手机端登录腕上RSS，再把账号同步到手表。', tone: 'muted', button: phone};
  const expired = status.refreshTokenStatus === 'expired' || (status.refreshTokenStatus === 'legacy' && status.accessTokenExpired);
  if (expired) return {title: '登录已过期', detail: '请在手机端重新把账号同步到手表。', tone: 'attention', button: phone};
  if (!status.cloud) return {title: '暂未开放', detail: '当前版本还不能使用云同步。本机内容和手机同步照常可用。', tone: 'muted'};

  const cloud = status.cloud, phase = cloud.phase ?? 'idle';
  const base: CloudSyncView = {
    title: '', detail: '', tone: 'ok', button: {label: '立即同步', action: 'sync', enabled: true},
    ...(cloud.lastCompletedAt ? {lastSynced: `上次同步 ${formatSyncTime(cloud.lastCompletedAt, now)}`} : {}),
    ...(cloud.quotaBytes > 0 ? {space: {label: `已用 ${formatBytes(cloud.usedBytes)} / ${formatBytes(cloud.quotaBytes)}`, fraction: Math.min(1, Math.max(0, cloud.usedBytes / cloud.quotaBytes))}} : {}),
  };
  // A manual sync that left the foreground: queued is with the system, not finished.
  if (handoff === 'held') return {...base, title: '等待手机同步结束', detail: '蓝牙传输结束后会自动继续云同步。', tone: 'attention', button: {label: '同步中…', action: 'sync', enabled: false}};
  if (handoff === 'queued' && !BUSY.has(phase)) return {...base, title: '后台同步中', detail: '已移交系统后台继续，完成后这里会更新。', tone: 'busy', button: {label: '在前台同步', action: 'sync', enabled: true}};
  if (pending || BUSY.has(phase)) return {...base, title: '正在同步', detail: BUSY.has(phase) ? cloud.message : '正在连接云空间', tone: 'busy', button: {label: '同步中…', action: 'sync', enabled: false}};
  if (phase === 'complete') return {...base, title: '已同步', detail: cloud.message.includes('正文') ? '阅读状态已同步，文章正文会在连上 Wi-Fi 后同步。' : cloud.message.includes('只读') ? '已恢复云端资料；云空间当前只读。' : cloud.message.includes('部分') ? '已同步，部分公共 RSS 稍后重试。' : '手表与云端已一致。'};
  if(cloud.message.includes('重新登记本机'))return{...base,title:'需要重新登记本机',detail:'本机设备公钥与云端不一致，请确认后重新登记。',tone:'attention',button:undefined};
  if(cloud.message.includes('属于其他账号'))return{...base,title:'需要选择资料归属',detail:'请选择清空本机资料或明确合并，选择前不会上传。',tone:'attention',button:undefined};
  if(cloud.message.includes('请升级'))return{...base,title:'请升级腕上RSS',detail:'升级后继续云同步，本机资料保持不变。',tone:'attention',button:undefined};
  if (phase === 'waiting-approval') return {...base, title: '需要云密钥授权', detail: '向已授权的手机或小程序请求批准，并核对两端显示的 8 位授权码。', tone: 'attention', button: {label: '请求设备批准', action: 'approval', enabled: true}};
  if (phase === 'error') return {...base, title: '同步失败', detail: '这次没有同步完成，请稍后重试。', tone: 'error', button: {label: '重试', action: 'sync', enabled: true}};
  // Idle carries the service's own reason when it stopped early (network, read-only space).
  if (cloud.message === '等待网络连接') return {...base, title: '等待网络', detail: '连上网络后再试。', tone: 'attention', button: {label: '重试', action: 'sync', enabled: true}};
  if (cloud.message.includes('云空间')) return {...base, title: '云空间不可用', detail: '云空间暂时无法读取，请稍后重试。', tone: 'attention', button: {label: '重试', action: 'sync', enabled: true}};
  return {...base, title: '尚未同步', detail: '同步后，订阅与阅读进度会保存在云空间。', tone: 'muted'};
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const text = unit === 0 || value >= 10 || Number.isInteger(value) ? String(Math.floor(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** Local wall-clock; `今天/昨天` within the same year, otherwise month and day. */
export function formatSyncTime(at: number, now: number): string {
  const then = new Date(at), today = new Date(now);
  const clock = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
  const diff = day(today) - day(then);
  return diff === 0 ? `今天 ${clock}` : diff === 1 ? `昨天 ${clock}` : `${then.getMonth() + 1}月${then.getDate()}日 ${clock}`;
}

/** One user-started sync at a time across page visits; repeated taps join the running one. */
export function coalescedRequest(run: () => Promise<unknown>) {
  let current: Promise<void> | undefined;
  return {
    get pending() { return !!current; },
    start(): Promise<void> {
      return current ??= Promise.resolve().then(run).then(() => {}, () => {}).finally(() => { current = undefined; });
    },
  };
}


export type {CloudApprovalState} from '../cloud/approval-controller';
export interface CloudApprovalControl {readonly state:import('../cloud/approval-controller').CloudApprovalState;subscribe(fn:()=>void):()=>void;request():Promise<boolean>;confirmMatches(matches:boolean):Promise<boolean>;cancel():Promise<boolean>;setForeground(active:boolean):void;}
/** Display-only flags for the Lead's new controls. No credentials or request nonces. */
export function cloudRemediationView(status:AccountStatusSnapshot|null|undefined,approval:import('../cloud/approval-controller').CloudApprovalState){
 const message=status?.cloud?.message??'';
 return{canLogout:!!status,needsOwnerChoice:message.includes('属于其他账号'),needsReregistration:message.includes('重新登记本机'),needsUpgrade:message.includes('请升级'),approvalCode:approval.code,approvalExpiresAt:approval.expiresAt,canConfirm:approval.phase==='code'&&!approval.confirmed,canDisagree:approval.phase==='code',canCancel:['requesting','pending','code'].includes(approval.phase),committing:approval.phase==='committing'};
}
export type CloudRemediationControl=ReturnType<typeof cloudRemediationActions>;
/** Busy/error protection for destructive local actions; confirmation is supplied by the UI. */
export function cloudRemediationActions(ports:{logout():Promise<void>;resolveOwner(choice:'clear'|'merge',confirmed:boolean,clearLocal?:()=>Promise<void>):Promise<void>;reregister(confirmed:boolean):Promise<unknown>}){
 let busy=false,message='';const listeners=new Set<()=>void>(),notify=()=>{for(const fn of listeners)try{fn();}catch{}};const run=async(action:()=>Promise<unknown>)=>{if(busy)return false;busy=true;message='';notify();try{await action();return true;}catch{message='操作没有完成，请检查后重试';return false;}finally{busy=false;notify();}};
 return{subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},get busy(){return busy;},get message(){return message;},logout:()=>run(()=>ports.logout()),resolveOwner:(choice:'clear'|'merge',confirmed:boolean,clearLocal?:()=>Promise<void>)=>confirmed?run(()=>ports.resolveOwner(choice,true,clearLocal)):Promise.resolve(false),reregister:(confirmed:boolean)=>confirmed?run(()=>ports.reregister(true)):Promise.resolve(false)};
}
