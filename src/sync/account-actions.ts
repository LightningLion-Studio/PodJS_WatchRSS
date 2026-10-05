import type {AccountSyncTelemetry} from './account-telemetry.ts';
import type {WatchAccountState} from '../account/types.ts';
import type {WatchAccountStore} from '../account/store.ts';
import {uri} from '@podjs/framework/services';
import {nativeTrim} from './local-manifest.ts';
import type {JsonObject} from './protocol.ts';

const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : null;
const string = (value: unknown): string => value === undefined ? '' : value === null ? 'null'
  : typeof value === 'string' ? value : JSON.stringify(value);
const optString = (source: JsonObject | null, key: string) => string(source?.[key]);
const optBoolean = (source: JsonObject | null, key: string, fallback: boolean) => {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : typeof value === 'string' && /^(true|false)$/i.test(value)
    ? value.toLowerCase() === 'true' : fallback;
};
const optNumber = (source: JsonObject | null, key: string, fallback: number) => {
  const value = source?.[key];
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const optLong = (source: JsonObject | null, key: string, fallback = 0) => {
  const value = Math.trunc(optNumber(source, key, fallback));
  if (!Number.isSafeInteger(value)) throw Error('账号时间戳超出可表示范围');
  return value;
};

export type AccountUriParse = (value:string)=>Promise<{valid:boolean;scheme:string|null;host:string|null}>;

/** Uses java.net.URI on Android, matching the native release endpoint policy. */
export async function secureAccountBackend(raw: string, parseJava:AccountUriParse = value=>uri.parse(value,'java')): Promise<string> {
  const normalized = nativeTrim(raw).replace(/\/+$/, '');
  if (!normalized) throw Error('缺少账号后端地址');
  const authority=/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(normalized)?.[1];
  if (!authority || authority.includes('@')) throw Error('账号后端地址无效');
  let parsed:Awaited<ReturnType<AccountUriParse>>;
  try { parsed=await parseJava(normalized); } catch { throw Error('账号后端地址无效'); }
  if (!parsed.valid || !parsed.host) throw Error('账号后端地址无效');
  if (parsed.scheme?.toLowerCase() !== 'https') throw Error('账号后端必须使用 HTTPS');
  return normalized;
}

export async function parseAccountSyncRequest(request: JsonObject, parseJava?:AccountUriParse, now = Date.now()): Promise<WatchAccountState> {
  const account = object(request.account);
  if (!account) throw Error('缺少账号载荷');
  const entitlement = object(request.entitlement), telemetry = object(request.telemetry);
  const token = nativeTrim(optString(account, 'watchAccessToken')) || nativeTrim(optString(account, 'watchDeviceToken'));
  const features = Array.isArray(entitlement?.features)
    ? entitlement.features.map(value => nativeTrim(string(value))).filter(Boolean) : [];
  const state: WatchAccountState = {
    userId:nativeTrim(optString(account,'userId')),
    phoneMasked:nativeTrim(optString(account,'phoneMasked')),
    installId:nativeTrim(optString(account,'installId')),
    watchDeviceToken:token,
    tokenExpiresAtMillis:optLong(account,'accessTokenExpiresAt',optLong(account,'tokenExpiresAt')),
    watchRefreshToken:nativeTrim(optString(account,'watchRefreshToken')),
    refreshTokenExpiresAtMillis:optLong(account,'refreshTokenExpiresAt'),
    backendBaseUrl:await secureAccountBackend(optString(account,'backendBaseUrl'),parseJava),
    posthogHost:nativeTrim(optString(account,'posthogHost')),
    posthogProjectApiKey:nativeTrim(optString(account,'posthogProjectApiKey')),
    entitlement:{plan:nativeTrim(optString(entitlement,'plan')) ? optString(entitlement,'plan') : 'free',
      active:optBoolean(entitlement,'active',true),expiresAtMillis:optLong(entitlement,'expiresAt'),features},
    telemetryConfig:{anonymousEnabled:optBoolean(telemetry,'anonymousEnabled',true),
      diagnosticsEnabled:optBoolean(telemetry,'diagnosticsEnabled',false),
      sampleRate:optNumber(telemetry,'sampleRate',1)},
    updatedAtMillis:now,
  };
  if (!state.userId) throw Error('缺少用户 ID');
  if (!state.watchDeviceToken) throw Error('缺少手表设备 token');
  return state;
}

/** A successful response means the secure-store write has completed. */
export async function syncAccount(request: JsonObject, store: Pick<WatchAccountStore,'save'>,
  deviceId: () => Promise<string>, parseJava?:AccountUriParse, onSaved?: () => void, telemetry?:AccountSyncTelemetry): Promise<JsonObject> {
  const localDeviceId = await deviceId();
  const state = await parseAccountSyncRequest(request,parseJava);
  await store.save(state);
  await telemetry?.recordSyncAccount();
  onSaved?.();
  return {success:true,version:1,action:'syncAccount',deviceId:localDeviceId,
    boundUserId:state.userId,telemetryBacklog:await telemetry?.backlogCount()??0};
}
