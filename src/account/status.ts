import type {SnapshotDeferralCode} from '../cloud/snapshot-deferral';
import type {WatchAccountState} from './types.ts';
import type {WatchCloudPhase} from '../cloud/service.ts';

export interface AccountCloudStatus {
  ownerChoiceRequired?:boolean;
  errorCode?:SnapshotDeferralCode|'cloud_host_capability_unavailable'|'cloud_format_upgrade_required'|'library_owner_mismatch'|'cloud_snapshot_progress_stalled'|'cloud_snapshot_unit_capacity';
  formatCompatibility?:import('../cloud/compatibility').CloudCompatibilityStatus;
  message: string;
  usedBytes: number;
  reservedBytes?: number;
  quotaBytes: number;
  /** Optional so older providers stay valid; the cloud page reads them when present. */
  phase?: WatchCloudPhase;
  lastCompletedAt?: number;
  /** Account the status was produced for. Used for filtering only, never displayed. */
  accountId?: string;
  accountScope?: string;
}

const NEUTRAL_CLOUD: AccountCloudStatus = {message: '尚未同步', usedBytes: 0, quotaBytes: 0, phase: 'idle'};

/** Display fields only; a status from another account is replaced by the neutral one. */
function ownCloudStatus(userId: string, cloud: AccountCloudStatus,backendBaseUrl:string): AccountCloudStatus {
  const own = (cloud.accountId === undefined || cloud.accountId === userId)&&(!cloud.accountScope||cloud.accountScope===JSON.stringify([backendBaseUrl.replace(/\/+$/,''),userId])) ? cloud : NEUTRAL_CLOUD;
  return {
    ...(own.formatCompatibility?{formatCompatibility:{...own.formatCompatibility}}:{}),
    ...(own.ownerChoiceRequired?{ownerChoiceRequired:true}:{}),
    ...(own.errorCode?{errorCode:own.errorCode}:{}),
    message: own.message, usedBytes: own.usedBytes, quotaBytes: own.quotaBytes,
    ...(own.reservedBytes!==undefined?{reservedBytes:own.reservedBytes}:{}),
    ...(own.phase ? {phase: own.phase} : {}),
    ...(own.lastCompletedAt ? {lastCompletedAt: own.lastCompletedAt} : {}),
  };
}

/** The account page receives display data only; credentials stay in secure storage. */
export interface AccountStatusSnapshot {
  phoneLabel: string;
  plan: string;
  active: boolean;
  diagnosticsEnabled: boolean;
  accessTokenExpired: boolean;
  refreshTokenStatus: 'legacy' | 'expired' | 'valid';
  /** Absent when no real watch cloud-sync service is connected. */
  cloud?: AccountCloudStatus;
}

export function accountStatusSnapshot(state: WatchAccountState | null, now = Date.now(), cloud?: AccountCloudStatus): AccountStatusSnapshot | null {
  if (!state) return null;
  return {
    phoneLabel: state.phoneMasked || '已绑定账号',
    plan: state.entitlement.plan,
    active: state.entitlement.active,
    diagnosticsEnabled: state.telemetryConfig.diagnosticsEnabled,
    accessTokenExpired: state.tokenExpiresAtMillis > 0 && state.tokenExpiresAtMillis <= now,
    refreshTokenStatus: !state.watchRefreshToken ? 'legacy'
      : state.refreshTokenExpiresAtMillis > 0 && state.refreshTokenExpiresAtMillis <= now ? 'expired' : 'valid',
    ...(cloud ? {cloud: ownCloudStatus(state.userId, cloud,state.backendBaseUrl)} : {}),
  };
}

/** Native hides the whole cloud section when the service is unavailable. */
export function accountCloudLines(status: AccountStatusSnapshot): string[] {
  if (!status.cloud) return [];
  const lines = [`云中继：${status.cloud.message}`];
  if (status.cloud.quotaBytes > 0) lines.push(`空间：${Math.floor(status.cloud.usedBytes / 1048576)} / ${Math.floor(status.cloud.quotaBytes / 1048576)} MiB`);
  lines.push('首次使用需在已登录的手机 App 或微信小程序上批准这块手表。');
  return lines;
}
