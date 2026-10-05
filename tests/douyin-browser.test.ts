import { expect, test } from 'bun:test';
import { clearDouyinBrowserData, douyinBrowserAvailable, DOUYIN_SITE_ORIGINS, type DouyinBrowser } from '../src/douyin/browser.ts';
import { clearDouyinLogoutData } from '../src/media/logout.ts';
import { DouyinClient } from '../src/douyin/client.ts';

function fixture() {
  const calls: string[] = [], logs: string[] = [];
  const browser: DouyinBrowser = {
    hasCapability: () => true,
    clearSiteData: ({ origins }) => {
      expect(origins).toEqual(['https://www.douyin.com', 'https://douyin.com', 'https://creator.douyin.com', 'https://www.iesdouyin.com']);
      calls.push('clear');
      return { result: Promise.resolve(origins.map(origin => ({ origin, cookies: { status: 'root_cleared' as const }, webStorage: { status: 'deletion_requested' as const } }))) };
    },
    availability: () => { calls.push('probe'); return { result: Promise.resolve({ status: 'available' }) }; },
  };
  return { browser, calls, logs, diagnostic: (message: string) => { logs.push(message); } };
}
test('native origins are cleared before media cache, without claiming verified WebStorage deletion', async () => {
  const f = fixture();
  await clearDouyinLogoutData({ async clearBucket(bucket) { f.calls.push(bucket); } }, f.browser, f.diagnostic);
  expect(f.calls).toEqual(['clear', 'douyin-preload']); expect(f.logs).toEqual([]);
});
test('missing siteData capability retains B6 cache cleanup and records a diagnostic', async () => {
  const f = fixture(); f.browser.hasCapability = capability => { expect(capability).toBe('system.browser.siteData'); return false; };
  await clearDouyinLogoutData({ async clearBucket(bucket) { f.calls.push(bucket); } }, f.browser, f.diagnostic);
  expect(f.calls).toEqual(['douyin-preload']); expect(f.logs).toEqual(['siteData capability_missing']);
});
test('remaining/failed statuses are diagnostic only; host messages and cookie names are not logged', async () => {
  const f = fixture();
  f.browser.clearSiteData = () => ({ result: Promise.resolve([
    { origin: DOUYIN_SITE_ORIGINS[0], cookies: { status: 'remaining', remainingNames: ['secret'], message: 'sensitive' }, webStorage: { status: 'deletion_requested' } },
    { origin: DOUYIN_SITE_ORIGINS[1], cookies: { status: 'failed', message: 'sensitive' }, webStorage: { status: 'failed', message: 'sensitive' } },
  ]) });
  const secure = new Map<string, string>([['douyin.cookie', 'sessionid=secret']]);
  const client = new DouyinClient({ transport: { request: async () => { throw Error('unexpected network'); } }, secureStorage: {
    get: async key => secure.get(key) ?? null, set: async (key, value) => { secure.set(key, value); }, remove: async key => { secure.delete(key); },
  }, onLogout: () => clearDouyinLogoutData({ async clearBucket(bucket) { f.calls.push(bucket); } }, f.browser, f.diagnostic) });
  await client.logout(); expect(await client.isLoggedIn()).toBe(false); expect(f.calls).toEqual(['douyin-preload']);
  expect(f.logs).toEqual(['siteData https://www.douyin.com cookies=remaining', 'siteData https://douyin.com cookies=failed', 'siteData https://douyin.com webStorage=failed']);
});
for (const sync of [false, true]) test(`siteData ${sync ? 'throw' : 'rejection'} cannot block cleanup`, async () => {
  const f = fixture(); f.browser.clearSiteData = () => { if (sync) throw Error('secret'); return { result: Promise.reject(Error('secret')) }; };
  await clearDouyinLogoutData({ async clearBucket(bucket) { f.calls.push(bucket); } }, f.browser, f.diagnostic);
  expect(f.calls).toEqual(['douyin-preload']); expect(f.logs).toEqual(['siteData operation_failed']);
  await clearDouyinBrowserData(f.browser, () => { throw Error('logger failed'); });
});
test('media cache errors remain retryable failures after browser cleanup', async () => {
  const f = fixture();
  await expect(clearDouyinLogoutData({ async clearBucket() { throw Error('cache locked'); } }, f.browser, f.diagnostic)).rejects.toThrow('cache locked');
  expect(f.calls).toEqual(['clear']);
});
for (const status of ['available', 'no_provider', 'initialization_failed'] as const) test(`availability ${status}`, async () => {
  const f = fixture(); f.browser.availability = () => ({ result: Promise.resolve({ status }) });
  expect(await douyinBrowserAvailable(f.browser, f.diagnostic)).toBe(status === 'available');
});
test('old hosts retain authorization and log missing availability capability', async () => {
  const f = fixture(); f.browser.hasCapability = capability => { expect(capability).toBe('system.browser.availability'); return false; };
  expect(await douyinBrowserAvailable(f.browser, f.diagnostic)).toBe(true);
  expect(f.calls).toEqual([]); expect(f.logs).toEqual(['availability capability_missing']);
});
test('probe rejection reaches the existing login error handling', async () => {
  const f = fixture(); f.browser.availability = () => ({ result: Promise.reject({ code: 'webview_unavailable' }) });
  await expect(douyinBrowserAvailable(f.browser, f.diagnostic)).rejects.toEqual({ code: 'webview_unavailable' });
});
