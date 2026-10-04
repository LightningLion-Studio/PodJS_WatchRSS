import { expect, test } from "bun:test";
import { WatchAccountStore, WatchTokenManager, WatchAccountState, SecureStorage } from "../../src/account";
import { utf8Encode } from "../../src/cloud";
import type { HttpTransport, HttpResponse } from "../../src/cloud";

class MemoryStorage implements SecureStorage { value: string | null = null; async get() { return this.value; } async set(_: string, value: string) { this.value = value; } async remove() { this.value = null; } }
const state: WatchAccountState = { userId: "u", phoneMasked: "1****", installId: "i", watchDeviceToken: "old", tokenExpiresAtMillis: 1, watchRefreshToken: "refresh", refreshTokenExpiresAtMillis: 999999, backendBaseUrl: "https://cloud.test", posthogHost: "", posthogProjectApiKey: "", entitlement: { plan: "free", active: true, expiresAtMillis: 0, features: [] }, telemetryConfig: { anonymousEnabled: true, diagnosticsEnabled: false, sampleRate: 1 }, updatedAtMillis: 1 };
const ok = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: utf8Encode(JSON.stringify(value)) });

test("concurrent refresh calls share one request", async () => {
  let calls = 0; const transport: HttpTransport = { async request() { calls++; await new Promise(r => setTimeout(r, 1)); return ok({ watchAccessToken: "new", accessTokenExpiresAt: 100000, watchRefreshToken: "next", refreshTokenExpiresAt: 200000, entitlement: { plan: "member", active: true, expiresAt: 3, features: ["cloud"] } }); } };
  const store = new WatchAccountStore(new MemoryStorage()); await store.save(state); const manager = new WatchTokenManager(store, { backendBaseUrl: "https://cloud.test", transport }, () => 0);
  const result = await Promise.all([manager.freshAccessToken(), manager.freshAccessToken()]); expect(result).toEqual(["new", "new"]); expect(calls).toBe(1);
});

test("transient refresh failure keeps the good session", async () => {
  const storage = new MemoryStorage(); const store = new WatchAccountStore(storage); await store.save(state); const transport: HttpTransport = { async request() { return { status: 503, headers: {}, body: utf8Encode("temporary") }; } }; const manager = new WatchTokenManager(store, { backendBaseUrl: "https://cloud.test", transport }, () => 0);
  await expect(manager.freshAccessToken()).rejects.toThrow(); expect((await store.read())?.watchRefreshToken).toBe("refresh"); expect((await store.read())?.watchDeviceToken).toBe("old");
});
