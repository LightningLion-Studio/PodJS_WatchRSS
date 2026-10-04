import type {WatchAccountState} from './types.ts';

/** The account page receives display data only; credentials stay in secure storage. */
export interface AccountStatusSnapshot {
  phoneLabel: string;
  plan: string;
  active: boolean;
  diagnosticsEnabled: boolean;
  accessTokenExpired: boolean;
  refreshTokenStatus: 'legacy' | 'expired' | 'valid';
}

export function accountStatusSnapshot(state: WatchAccountState | null, now = Date.now()): AccountStatusSnapshot | null {
  if (!state) return null;
  return {
    phoneLabel: state.phoneMasked || '已绑定账号',
    plan: state.entitlement.plan,
    active: state.entitlement.active,
    diagnosticsEnabled: state.telemetryConfig.diagnosticsEnabled,
    accessTokenExpired: state.tokenExpiresAtMillis > 0 && state.tokenExpiresAtMillis <= now,
    refreshTokenStatus: !state.watchRefreshToken ? 'legacy'
      : state.refreshTokenExpiresAtMillis > 0 && state.refreshTokenExpiresAtMillis <= now ? 'expired' : 'valid',
  };
}
