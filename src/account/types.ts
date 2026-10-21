import { HttpTransport } from "../cloud/types";

export interface SecureStorage {revokeCloudScope?(state:WatchAccountState):Promise<void>;clearCloudScope?(state:WatchAccountState):Promise<void>; get(key: string): Promise<string | null> | string | null; set(key: string, value: string): Promise<void> | void; remove(key: string): Promise<void> | void; }
export interface WatchEntitlementSnapshot { plan: string; active: boolean; expiresAtMillis: number; features: string[]; }
export interface WatchTelemetryConfig { anonymousEnabled: boolean; diagnosticsEnabled: boolean; sampleRate: number; }
export interface WatchAccountState { userId: string; phoneMasked: string; installId: string; watchDeviceToken: string; tokenExpiresAtMillis: number; watchRefreshToken: string; refreshTokenExpiresAtMillis: number; backendBaseUrl: string; posthogHost: string; posthogProjectApiKey: string; entitlement: WatchEntitlementSnapshot; telemetryConfig: WatchTelemetryConfig; updatedAtMillis: number; }
export interface AccountClientOptions { backendBaseUrl: string; transport: HttpTransport; appVersion?: string; }
export type { HttpTransport };
