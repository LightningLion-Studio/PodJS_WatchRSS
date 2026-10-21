import type {WatchAccountState} from './types.ts';

export interface AccountCloudStatus {
  message: string;
  usedBytes: number;
  quotaBytes: number;
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
    ...(cloud ? {cloud} : {}),
  };
}

/** Native hides the whole cloud section when the service is unavailable. */
export function accountCloudLines(status: AccountStatusSnapshot): string[] {
  if (!status.cloud) return [];
  const lines = [`云中继：${status.cloud.message}`];
  if (status.cloud.quotaBytes > 0) lines.push(`空间：${Math.floor(status.cloud.usedBytes / 1048576)} / ${Math.floor(status.cloud.quotaBytes / 1048576)} MiB`);
  lines.push('首次使用需在已登录设备上批准这块手表。');
  return lines;
}
