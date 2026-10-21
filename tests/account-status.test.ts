import {expect, test} from 'bun:test';
import {accountCloudLines, accountStatusSnapshot} from '../src/account/status.ts';
import type {WatchAccountState} from '../src/account/types.ts';

const account: WatchAccountState = {
  userId: 'private-user', phoneMasked: '138****1234', installId: 'private-install',
  watchDeviceToken: 'private-access-token', tokenExpiresAtMillis: 100,
  watchRefreshToken: 'private-refresh-token', refreshTokenExpiresAtMillis: 200,
  backendBaseUrl: 'https://private.example', posthogHost: '', posthogProjectApiKey: 'private-key',
  entitlement: {plan: 'member', active: true, expiresAtMillis: 0, features: []},
  telemetryConfig: {anonymousEnabled: true, diagnosticsEnabled: false, sampleRate: 1}, updatedAtMillis: 50,
};

test('account status uses the native expiry boundaries and never exposes credentials', () => {
  const before = accountStatusSnapshot(account, 99)!;
  expect(before).toEqual({phoneLabel:'138****1234',plan:'member',active:true,diagnosticsEnabled:false,
    accessTokenExpired:false,refreshTokenStatus:'valid'});
  expect(accountStatusSnapshot(account, 100)?.accessTokenExpired).toBe(true);
  expect(accountStatusSnapshot(account, 200)?.refreshTokenStatus).toBe('expired');
  expect(accountStatusSnapshot({...account,watchRefreshToken:''}, 99)?.refreshTokenStatus).toBe('legacy');
  expect(accountStatusSnapshot({...account,tokenExpiresAtMillis:0,refreshTokenExpiresAtMillis:0}, 300))
    .toMatchObject({accessTokenExpired:false,refreshTokenStatus:'valid'});
  expect(JSON.stringify(before)).not.toMatch(/private-/);
  expect(accountStatusSnapshot(null)).toBeNull();
});

test('account status only presents real cloud-service data with free quota semantics', () => {
  const withoutCloud = accountStatusSnapshot(account, 99)!;
  expect(withoutCloud.cloud).toBeUndefined();
  expect(accountCloudLines(withoutCloud)).toEqual([]);

  const member = accountStatusSnapshot(account, 99, {
    message: '同步完成', usedBytes: 3 * 1048576 + 123, quotaBytes: 10 * 1048576,
  })!;
  expect(accountCloudLines(member)).toEqual([
    '云中继：同步完成', '空间：3 / 10 MiB', '首次使用需在已登录设备上批准这块手表。',
  ]);
  expect(accountCloudLines({...member, cloud: {...member.cloud!, quotaBytes: 0}})).toEqual([
    '云中继：同步完成', '首次使用需在已登录设备上批准这块手表。',
  ]);
  expect(accountCloudLines({...member, plan: 'free'})).toEqual(accountCloudLines(member));
});
