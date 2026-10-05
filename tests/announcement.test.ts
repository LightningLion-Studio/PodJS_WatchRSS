import {describe, expect, test} from 'bun:test';
import {AnnouncementClient, AnnouncementRepository, ANNOUNCEMENT_BACKEND, compareVersions,
  parseAnnouncement, parsePushMessages, AppUpdateService, type Announcement, type AnnouncementStorage,
  type UpdatePort, type DownloadedApk, type DownloadProgress} from '../src/announcement/index.ts';
import {utf8Encode, type HttpRequest} from '../src/cloud/types.ts';

const announcement: Announcement = {version: '2.1', changelogMarkdown: '# 新版', forceUpdate: false, downloadUrl: 'https://example.test/update.apk'};
const wire = {version: '2.1', changelog_md: '# 新版', force_update: false, download_url: announcement.downloadUrl};
function fixture(responses: unknown[]) {
  const requests: HttpRequest[] = [];
  const data = new Map<string, unknown>();
  const storage: AnnouncementStorage = {get: <T>(key: string) => data.get(key) as T | undefined, set: (key, value) => { data.set(key, value); }};
  const client = new AnnouncementClient({async request(request) {
    requests.push(request);
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return {status: 200, headers: {}, body: utf8Encode(JSON.stringify(value))};
  }}, 'watch-1.0+3');
  return {requests, storage, client, repository: new AnnouncementRepository(client, storage, '1.0')};
}

describe('native announcement and push contract', () => {
  test('exact backend, GET paths and native version header', async () => {
    const f = fixture([wire, []]);
    expect(await f.client.announcement()).toEqual(announcement);
    await f.client.messages();
    expect(f.requests.map(r => r.url)).toEqual([
      ANNOUNCEMENT_BACKEND + '/functions/v1/announcement?client=android_watch',
      ANNOUNCEMENT_BACKEND + '/api/notify/watchrss?limit=10',
    ]);
    for (const request of f.requests) {
      expect(request.method).toBe('GET');
      expect(request.body).toBeUndefined();
      expect(request.headers).toEqual({'X-WatchRSS-App-Version': 'watch-1.0+3'});
    }
  });
  test('native digit-group comparison, zero padding and Long overflow', () => {
    expect(compareVersions('v1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.10-beta2', '1.9.99')).toBe(1);
    expect(compareVersions('1.0-rc1', '1.0')).toBe(1);
    expect(compareVersions('unknown', '0')).toBe(0);
    expect(compareVersions('9223372036854775808', '1')).toBe(-1);
    expect(compareVersions('9007199254740993', '9007199254740992')).toBe(1);
  });
  test('required announcement fields, trim and optional force flag', () => {
    expect(parseAnnouncement({...wire, version: ' 2.1 ', force_update: 'TRUE'})).toEqual({...announcement, forceUpdate: true});
    for (const field of ['version', 'changelog_md', 'download_url']) expect(parseAnnouncement({...wire, [field]: ' '})).toBeNull();
    expect(parseAnnouncement(null)).toBeNull();
  });
  test('ignored version persists across repositories; force bypasses ignore', async () => {
    const f = fixture([wire, {...wire, force_update: true}]);
    expect(f.repository.markDismissed(announcement)).toBe(true);
    const reopened = new AnnouncementRepository(f.client, f.storage, '1.0');
    expect(await reopened.checkAnnouncement()).toBeNull();
    expect(await reopened.checkAnnouncement()).toEqual({...announcement, forceUpdate: true});
    expect(reopened.markDismissed({...announcement, forceUpdate: true})).toBe(false);
  });
  test('old or equal versions never show even when forced', async () => {
    const f = fixture([{...wire, version: '1.0.0', force_update: true}, {...wire, version: '0.9'}]);
    expect(await f.repository.checkAnnouncement()).toBeNull();
    expect(await f.repository.checkAnnouncement()).toBeNull();
  });
  test('announcement takes priority and does not consume push state', async () => {
    const f = fixture([wire]);
    expect(await f.repository.checkHome()).toEqual({announcement, messages: []});
    expect(f.requests).toHaveLength(1);
  });
  test('failed announcement check falls through to pushes; seen on fetch, reversed server order', async () => {
    const messages = [{id: 8, title: 'eight', body: '8'}, {id: 6, title: 'six', body: '6'}];
    const f = fixture([new Error('offline'), messages, messages]);
    expect(await f.repository.checkHome()).toEqual({announcement: null, messages: [...messages].reverse()});
    const reopened = new AnnouncementRepository(f.client, f.storage, '1');
    expect(await reopened.fetchNewMessages()).toEqual([]);
  });
  test('push errors and malformed responses do not advance seen state', async () => {
    const f = fixture([new Error('offline'), {}, [{id: 1}]]);
    expect(await f.repository.fetchNewMessages()).toEqual([]);
    expect(await f.repository.fetchNewMessages()).toEqual([]);
    expect(await f.repository.fetchNewMessages()).toEqual([{id: 1, title: '', body: ''}]);
  });
  test('concurrent push reads share a request', async () => {
    const f = fixture([[{id: 1}]]);
    await Promise.all([f.repository.fetchNewMessages(), f.repository.fetchNewMessages()]);
    expect(f.requests).toHaveLength(1);
  });
  test('non-2xx and malformed JSON fail softly at repository boundary', async () => {
    for (const response of [{status: 503, body: utf8Encode('{}')}, {status: 200, body: utf8Encode('{')}]) {
      const client = new AnnouncementClient({async request() { return {...response, headers: {}}; }}, 'watch-1+1');
      const repository = new AnnouncementRepository(client, fixture([]).storage, '1');
      expect(await repository.checkAnnouncement()).toBeNull();
      expect(await repository.fetchNewMessages()).toEqual([]);
    }
  });
  test('push parser ignores invalid IDs and supports native numeric string ID', () => {
    expect(parsePushMessages([null, [], {id: -1}, {id: '4', title: 'hello'}, {id: 'bad'}])).toEqual([{id: 4, title: 'hello', body: ''}]);
  });
});

function updateFixture(overrides: Partial<UpdatePort> = {}) {
  const removed: string[] = [];
  const calls = {download: 0, inspect: 0, install: 0};
  const apk: DownloadedApk = {path: 'updates/test.apk', size: 20, status: 200, url: announcement.downloadUrl};
  const port: UpdatePort = {
    capabilities: {download: true, progress: true, inspectApk: true, installApk: true},
    async download(_url, onProgress) { calls.download++; onProgress({bytesRead: 10, totalBytes: 20}); return apk; },
    async inspectApk() { calls.inspect++; return {packageName: 'test.app'}; },
    async remove(path) { removed.push(path); },
    async launchInstaller() { calls.install++; return {status: 'launched'}; },
    ...overrides,
  };
  const service = new AppUpdateService(port, 'test.app');
  return {service, calls, removed, apk, port};
}

describe('update service via injected APK host port (not device evidence)', () => {
  test('progress, validation, ready and explicit installer launch', async () => {
    const f = updateFixture();
    const states: string[] = [];
    f.service.subscribe(state => states.push(state.kind));
    expect((await f.service.download(announcement.downloadUrl)).kind).toBe('ready');
    expect(states).toEqual(['downloading', 'downloading', 'validating', 'ready']);
    expect(f.calls.install).toBe(0);
    expect((await f.service.launchInstaller()).kind).toBe('installer-launched');
    expect(f.calls.inspect).toBe(2);
  });
  test('unsupported APK inspection fails before any download or installer call', async () => {
    const f = updateFixture({capabilities: {download: true, progress: false, inspectApk: false, installApk: false}});
    expect(await f.service.download(announcement.downloadUrl)).toMatchObject({kind: 'failed', code: 'unsupported'});
    expect(f.calls.download).toBe(0);
    expect(await f.service.launchInstaller()).toMatchObject({kind: 'failed', code: 'unsupported'});
    expect(f.calls.install).toBe(0);
  });
  test('rejects HTTP and invalid URLs before network', async () => {
    const f = updateFixture();
    for (const url of ['http://example.test/a.apk', 'https://', 'file:///a', 'https://x\\y/a', 'https://user:pass@x/a']) {
      expect(await f.service.download(url)).toMatchObject({kind: 'failed', code: 'invalid-url'});
    }
    expect(f.calls.download).toBe(0);
  });
  test('bad HTTP, empty files, HTTPS downgrade and mismatched packages are removed', async () => {
    for (const variant of [{status: 500}, {size: 0}, {url: 'http://example.test/file'}, {}]) {
      const f = updateFixture({async inspectApk() { return {packageName: 'another.app'}; }});
      Object.assign(f.apk, variant);
      expect((await f.service.download(announcement.downloadUrl)).kind).toBe('failed');
      expect(f.removed).toEqual([f.apk.path]);
      expect(f.calls.install).toBe(0);
    }
  });
  test('invalid APK parse failure and cleanup failure are surfaced', async () => {
    const f = updateFixture({async inspectApk() { throw new Error('invalid ZIP'); }, async remove() { throw new Error('disk error'); }});
    expect(await f.service.download(announcement.downloadUrl)).toMatchObject({kind: 'failed', message: 'invalid ZIP', cleanupError: 'Error: disk error'});
  });
  test('download failure can reset and explicitly retry; no automatic retries', async () => {
    let attempt = 0;
    const f = updateFixture({async download() { if (++attempt === 1) throw new Error('timeout'); return f.apk; }});
    expect(await f.service.download(announcement.downloadUrl)).toMatchObject({kind: 'failed', message: 'timeout'});
    expect(attempt).toBe(1);
    f.service.resetFailure();
    expect(f.service.state.kind).toBe('idle');
    expect((await f.service.retry()).kind).toBe('ready');
    expect(attempt).toBe(2);
  });
  test('permission flow retains validated APK and allows installer retry', async () => {
    let attempt = 0;
    const f = updateFixture({async launchInstaller() { return {status: ++attempt === 1 ? 'permission-required' : 'launched'}; }});
    await f.service.download(announcement.downloadUrl);
    expect((await f.service.launchInstaller()).kind).toBe('permission-required');
    expect((await f.service.launchInstaller()).kind).toBe('installer-launched');
    expect(f.calls.download).toBe(1);
  });
  test('installer exception becomes failed and can be retried without redownload', async () => {
    let attempt = 0;
    const f = updateFixture({async launchInstaller() { if (++attempt === 1) throw new Error('no installer'); return {status: 'launched'}; }});
    await f.service.download(announcement.downloadUrl);
    expect(await f.service.launchInstaller()).toMatchObject({kind: 'failed', message: 'no installer'});
    expect((await f.service.launchInstaller()).kind).toBe('installer-launched');
  });
  test('unknown total, stale progress, observer exceptions and overlapping download', async () => {
    let finish!: (apk: DownloadedApk) => void;
    let progress!: (value: DownloadProgress) => void;
    let downloads = 0;
    const f = updateFixture({download(_url, callback) { downloads++; progress = callback; return new Promise(resolve => { finish = resolve; }); }});
    f.service.subscribe(() => { throw new Error('observer'); });
    const running = f.service.download(announcement.downloadUrl);
    await f.service.download(announcement.downloadUrl);
    expect(downloads).toBe(1);
    progress({bytesRead: 5, totalBytes: null});
    expect(f.service.state).toEqual({kind: 'downloading', bytesRead: 5, totalBytes: null});
    progress({bytesRead: 4, totalBytes: 20});
    expect(f.service.state).toEqual({kind: 'downloading', bytesRead: 5, totalBytes: null});
    finish(f.apk); await running;
    progress({bytesRead: 20, totalBytes: 20});
    expect(f.service.state.kind).toBe('ready');
  });
  test('new download removes previous APK; installer refuses before ready', async () => {
    const f = updateFixture();
    expect(await f.service.launchInstaller()).toMatchObject({kind: 'failed', code: 'not-ready'});
    await f.service.download(announcement.downloadUrl);
    await f.service.retry();
    expect(f.removed).toEqual([f.apk.path]);
  });
});
