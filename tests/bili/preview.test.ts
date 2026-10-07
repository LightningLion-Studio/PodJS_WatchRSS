import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, readdirSync, statSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BiliPreviewCache, PREVIEW_INDEX, PREVIEW_MS, previewBytes, type PreviewPorts } from '../../src/bili/preview.ts';
import { ManagedCache } from '../../src/cache/managed.ts';
import { createBiliPlaybackRetry, resolveBiliPlaybackWithPreview } from '../../src/playback.ts';

const MiB = 1024 * 1024;
const target = { aid: 7, bvid: 'BVfixture', cid: 19 };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(size = 3 * MiB, length = 2 * PREVIEW_MS) {
  const root = mkdtempSync(join(tmpdir(), 'wrss-preview-'));
  const body = Buffer.alloc(size); for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const stored = new Map<string, unknown>();
  const requests: { range: string; headers: Headers }[] = [];
  let responseMode: 'good' | 'badRange' | 'ignored' | 'noEtag' | 'changedEtag' = 'good';
  let failAfter = Infinity, active = 0, peak = 0, cancelled = 0;
  let gate: ReturnType<typeof deferred> | undefined;
  const started = deferred();
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const range = request.headers.get('range')!; requests.push({ range, headers: request.headers }); started.resolve();
    if (gate) await gate.promise;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(match[1]), end = Number(match[2]);
    if (start >= failAfter) return new Response('fixture_failure', { status: 500 });
    if (responseMode === 'ignored') return new Response(body);
    const etag = responseMode === 'changedEtag' && start > 0 ? '"v2"' : '"v1"';
    return new Response(body.subarray(start, end + 1), { status: 206, headers: {
      'Content-Range': responseMode === 'badRange' ? `bytes 1-${end}/${size}` : `bytes ${start}-${end}/${size}`,
      ...(responseMode === 'noEtag' ? {} : { ETag: etag }),
    } });
  } });
  const disk = (path: string) => join(root, path);
  const put = (path: string, bytes: Uint8Array) => { mkdirSync(join(disk(path), '..'), { recursive: true }); writeFileSync(disk(path), bytes); };
  const stat = async (path: string) => {
    try { const value = statSync(disk(path)); return { exists: true, file: value.isFile(), directory: value.isDirectory(), size: value.size, modified: value.mtimeMs }; }
    catch { return { exists: false, file: false, directory: false, size: 0, modified: 0 }; }
  };
  const remove = async (path: string) => { rmSync(disk(path), { force: true }); };
  const touch = async (path: string) => { utimesSync(disk(path), new Date(), new Date()); };
  const ports: PreviewPorts = {
    store: { get: key => structuredClone(stored.get(key)), set: (key, value) => { stored.set(key, structuredClone(value)); }, delete: key => { stored.delete(key); } },
    digest: async value => sha(value),
    resolve: async input => { expect(input.qn).toBe(32); expect(input.preferMp4).toBe(true); return { durl: [{ url: `${server.url}video`, size, length, backupUrl: [] }], acceptQuality: [], acceptDescription: [] }; },
    headers: async () => ({ Cookie: 'fixture_cookie', Referer: 'fixture_referer' }),
    download(url, path, headers, maxBytes) {
      const controller = new AbortController(); active++; peak = Math.max(peak, active);
      const result = (async () => {
        try {
          const response = await fetch(url, { headers, signal: controller.signal });
          if (!response.ok) throw Error(`fixture_http:${response.status}`);
          const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
          for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
            if (size > maxBytes) { await reader.cancel(); throw Error('download_too_large'); } chunks.push(next.value); }
          put(path, Buffer.concat(chunks));
          return { status: response.status, size, headers: Object.fromEntries(response.headers.entries()) };
        } finally { active--; }
      })();
      return { result, cancel() { cancelled++; controller.abort(); } };
    },
    stat, remove, touch,
    write: async (path, data) => { put(path, Buffer.from(data, 'base64')); },
    read: async (path, offset, count) => { const body = readFileSync(disk(path)), end = Math.min(body.length, offset + count); return { dataBase64: body.subarray(offset, end).toString('base64'), size: body.length, eof: end === body.length }; },
    append: async (path, data, offset) => { expect(statSync(disk(path)).size).toBe(offset); appendFileSync(disk(path), Buffer.from(data, 'base64')); return { size: statSync(disk(path)).size }; },
    hash: async path => { const body = readFileSync(disk(path)); return { size: body.length, sha256: sha(body) }; },
    commit: async (path, destination, size, hash) => { const value = readFileSync(disk(path)); expect(value.length).toBe(size); expect(sha(value)).toBe(hash); renameSync(disk(path), disk(destination)); },
    wait: () => ({ result: Promise.resolve(), cancel() {} }),
  };
  const newManaged = () => new ManagedCache({ stat, remove, touch, digest: ports.digest,
    list: async path => ({ entries: existsSync(disk(path)) ? await Promise.all(readdirSync(disk(path)).map(async name => ({ path: path + '/' + name, ...await stat(path + '/' + name) }))) : [] }),
    download() { throw Error('unused_image_download'); },
  });
  const managed = newManaged(), cache = new BiliPreviewCache(ports, managed);
  return { ports, managed, cache, stored, requests, body, disk, put, newManaged, started,
    setMode(mode: typeof responseMode) { responseMode = mode; }, setFailure(start: number) { failAfter = start; },
    block() { gate = deferred(); }, unblock() { gate?.resolve(); gate = undefined; },
    get peak() { return peak; }, get cancelled() { return cancelled; },
    async cleanup() { gate?.resolve(); await managed.clearBucket('bili-preview'); server.stop(true); rmSync(root, { recursive: true, force: true }); },
  };
}

test('native qn32 estimate is a 30-minute prefix, uses exact arithmetic, rejects absent/invalid metadata', () => {
  expect(previewBytes(300, PREVIEW_MS * 2)).toBe(150);
  expect(previewBytes(1, PREVIEW_MS * 2)).toBe(1);
  expect(previewBytes(Number.MAX_SAFE_INTEGER, PREVIEW_MS * 2)).toBe(Number(BigInt(Number.MAX_SAFE_INTEGER) / 2n));
  expect(previewBytes(99, 100)).toBe(99);
  for (const bad of [0, -1, NaN, 1.5, undefined]) expect(() => previewBytes(bad, PREVIEW_MS)).toThrow();
});

test('local Range server produces only the estimated prefix, indexes commits, reuses disk, and selects exact CID', async () => {
  const f = fixture(); try {
    const path = await f.cache.enqueue(target).result;
    expect(readFileSync(f.disk(path))).toEqual(f.body.subarray(0, f.body.length / 2));
    expect(f.requests.map(row => row.range)).toEqual(['bytes=0-1048575', 'bytes=1048576-1572863']);
    expect(f.requests[1].headers.get('if-range')).toBe('"v1"');
    expect(f.requests[0].headers.get('cookie')).toBe('fixture_cookie');
    expect(f.requests[0].headers.get('referer')).toBe('fixture_referer');
    expect(await f.cache.lookup({ ...target, cid: 20 })).toBeUndefined();
    expect(await f.cache.lookup({ bvid: target.bvid })).toEqual({ path, cid: target.cid });
    const restarted = new BiliPreviewCache(f.ports, f.newManaged());
    expect(await restarted.enqueue(target).result).toBe(path); expect(f.requests).toHaveLength(2);
    expect(await f.managed.inspect()).toBe(f.body.length / 2);
    await f.managed.configure(0); expect(await f.cache.lookup(target)).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('bounded retries retain a validated chunk boundary and resume after restart with strong ETag', async () => {
  const f = fixture(); try {
    f.setFailure(MiB);
    await expect(f.cache.enqueue(target).result).rejects.toThrow('fixture_http');
    expect(f.requests.map(row => row.range)).toEqual(['bytes=0-1048575', ...Array(3).fill('bytes=1048576-1572863')]);
    expect(await f.cache.lookup(target)).toBeUndefined(); expect(await f.managed.inspect()).toBe(MiB);
    f.setFailure(Infinity);
    const managed = f.newManaged(), restarted = new BiliPreviewCache(f.ports, managed);
    const path = await restarted.enqueue(target).result;
    expect(f.requests[4].range).toBe('bytes=1048576-1572863'); expect(f.requests[4].headers.get('if-range')).toBe('"v1"');
    expect(readFileSync(f.disk(path))).toEqual(f.body.subarray(0, f.body.length / 2));
    await managed.clearBucket('bili-preview'); expect(f.stored.has(PREVIEW_INDEX)).toBe(false);
  } finally { await f.cleanup(); }
});

test('missing validator restarts rather than appending an unverifiable partial file', async () => {
  const f = fixture(); try {
    f.setMode('noEtag'); f.setFailure(MiB);
    await expect(f.cache.enqueue(target).result).rejects.toThrow();
    expect(f.requests.filter(row => row.range.startsWith('bytes=0-'))).toHaveLength(3);
    f.setFailure(Infinity);
    const restarted = new BiliPreviewCache(f.ports, f.newManaged());
    const path = await restarted.enqueue(target).result;
    expect(f.requests[6].range.startsWith('bytes=0-')).toBe(true);
    expect(readFileSync(f.disk(path))).toEqual(f.body.subarray(0, f.body.length / 2));
  } finally { await f.cleanup(); }
});

test('wrong Range, changed ETag, and ignored Range never publish a playable file; attempts remain bounded', async () => {
  for (const mode of ['badRange', 'changedEtag', 'ignored'] as const) {
    const f = fixture(); try {
      f.setMode(mode); await expect(f.cache.enqueue(target).result).rejects.toThrow();
      expect(await f.cache.lookup(target)).toBeUndefined();
      expect(f.requests.length).toBe(mode === 'changedEtag' ? 6 : 3);
      expect((f.stored.get(PREVIEW_INDEX) as any[] ?? []).every(row => !row.complete)).toBe(true);
    } finally { await f.cleanup(); }
  }
});

test('single-worker queue deduplicates, caps at eight, cancels queued and active jobs, and clear stops all writes', async () => {
  const f = fixture(); try {
    f.block(); const first = f.cache.enqueue(target), duplicate = f.cache.enqueue(target);
    expect(duplicate.result).toBe(first.result);
    const rest = Array.from({ length: 7 }, (_, i) => f.cache.enqueue({ ...target, cid: target.cid + i + 1 }));
    await expect(f.cache.enqueue({ ...target, cid: 999 }).result).rejects.toThrow('queue_full');
    await f.started.promise; expect(f.peak).toBe(1);
    rest[0].cancel(); await expect(rest[0].result).rejects.toThrow('cancelled');
    const clear = f.managed.clearBucket('bili-preview');
    await Promise.allSettled([first.result, ...rest.map(row => row.result)]); f.unblock(); await clear;
    expect(f.cancelled).toBe(1); expect(f.requests).toHaveLength(1);
    expect(await f.managed.inspect()).toBe(0); expect(f.stored.has(PREVIEW_INDEX)).toBe(false);
    await expect(f.cache.enqueue(target).result).resolves.toBeString();
  } finally { await f.cleanup(); }
});

test('managed settings cap blocks oversized preview; cancelled partials count toward usage and eviction', async () => {
  const f = fixture(); try {
    await f.managed.configure(1024); await expect(f.cache.enqueue(target).result).rejects.toThrow('cache_limit');
    expect(f.requests).toHaveLength(0);
    await f.managed.configure(4 * MiB); f.setFailure(MiB);
    await expect(f.cache.enqueue(target).result).rejects.toThrow();
    expect(await f.managed.inspect()).toBe(MiB);
    await f.managed.configure(0); expect(await f.managed.inspect()).toBe(0);
  } finally { await f.cleanup(); }
});

test('removing saved preview deletes indexed MP4 and corrupt or evicted files are not playable', async () => {
  const f = fixture(512); try {
    const path = await f.cache.enqueue(target).result;
    f.put(path, Buffer.from('truncated')); expect(await f.cache.lookup(target)).toBeUndefined();
    await f.cache.enqueue(target).result;
    await f.cache.remove(target); expect(existsSync(f.disk(path))).toBe(false); expect(await f.cache.lookup(target)).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('playback resolves remote first, uses local offline or on empty source, and rejects unavailable preview', async () => {
  const remote = { durl: [{ url: 'https://fixture.invalid/primary', backupUrl: ['https://fixture.invalid/backup'] }], acceptQuality: [], acceptDescription: [] };
  const local = { url: 'managed-cache/bili-preview/fixture.mp4', type: 'video/mp4', headers: {}, title: 'fixture' };
  expect((await resolveBiliPlaybackWithPreview(async () => remote, async () => local, 'fixture', {})).source.url).toBe(remote.durl[0].url);
  expect((await resolveBiliPlaybackWithPreview(async () => { throw Error('offline'); }, async () => local, 'fixture', {})).source).toBe(local);
  expect((await resolveBiliPlaybackWithPreview(async () => ({ ...remote, durl: [] }), async () => local, 'fixture', {})).source).toBe(local);
  await expect(resolveBiliPlaybackWithPreview(async () => { throw Error('offline'); }, async () => undefined, 'fixture', {})).rejects.toThrow('offline');
});

test('playback failure uses backups, one refresh, then one local candidate with no local failure loop', async () => {
  const remote = { durl: [{ url: 'https://fixture.invalid/primary', backupUrl: ['https://fixture.invalid/backup'] }], acceptQuality: [], acceptDescription: [] };
  const local = { url: 'managed-cache/bili-preview/fixture.mp4', headers: {}, title: 'fixture' };
  let resolves = 0;
  const retry = createBiliPlaybackRetry(remote, async () => { resolves++; throw Error('offline'); }, 'fixture', {}, async () => local);
  expect((await retry()).url).toBe(remote.durl[0].backupUrl[0]); expect((await retry()).url).toBe(local.url);
  await expect(retry()).rejects.toThrow('新的可播放地址'); expect(resolves).toBe(1);
  const retryLocal = createBiliPlaybackRetry({ ...remote, durl: [] }, async () => { throw Error('offline'); }, 'fixture', {}, async () => local, local);
  await expect(retryLocal()).rejects.toThrow('新的可播放地址');
});

test('malformed index and forged target-to-file association cannot escape the cache or produce a source', async () => {
  const f = fixture(512); try {
    const path = await f.cache.enqueue(target).result;
    const valid = (f.stored.get(PREVIEW_INDEX) as any[])[0];
    f.stored.set(PREVIEW_INDEX, [{ ...valid, target: { bvid: 42, cid: 19 } }, { ...valid, path: '../user-file' }, { ...valid, etag: '"bad\nheader"' }]);
    const corrupt = new BiliPreviewCache(f.ports, f.newManaged());
    expect(await corrupt.lookup(target)).toBeUndefined();
    const other = `${path.slice(0, path.lastIndexOf('/') + 1)}${'e'.repeat(64)}.mp4`;
    f.put(other, f.body.subarray(0, 256));
    f.stored.set(PREVIEW_INDEX, [{ ...valid, path: other }]);
    const forged = new BiliPreviewCache(f.ports, f.newManaged());
    expect(await forged.lookup(target)).toBeUndefined(); expect(existsSync(f.disk(other))).toBe(true);
    expect(existsSync(f.disk(path))).toBe(true);
  } finally { await f.cleanup(); }
});

test('cancelled chunks stay pinned until cancellation and restart safely discards an evicted checkpoint', async () => {
  const f = fixture(); try {
    const download = f.ports.download, second = deferred(); let reject!: (error: unknown) => void;
    f.ports.download = (url, path, headers, maxBytes) => {
      if (headers.Range.startsWith('bytes=1048576-')) {
        second.resolve(); return { result: new Promise((_yes, no) => reject = no), cancel() { reject(Error('cancelled_fixture')); } };
      }
      return download(url, path, headers, maxBytes);
    };
    const request = f.cache.enqueue(target); await second.promise;
    await f.managed.configure(0); // Writer pins protect its retained first chunk.
    expect(await f.managed.inspect()).toBe(MiB);
    request.cancel(); await expect(request.result).rejects.toThrow('preview_cancelled');
    // Do not start a resumed job until the owning worker has released its pins.
    await f.managed.maintain();
    expect(await f.managed.inspect()).toBe(0); // Cancelled chunk is now evictable.
    f.ports.download = download; await f.managed.configure(4 * MiB);
    const restarted = new BiliPreviewCache(f.ports, f.newManaged());
    const path = await restarted.enqueue(target).result;
    expect(readFileSync(f.disk(path))).toEqual(f.body.subarray(0, f.body.length / 2));
    expect(f.requests[1].range).toBe('bytes=0-1048575'); // Evicted checkpoint requires a clean restart.
  } finally { await f.cleanup(); }
});

test('server may ignore Range only when the whole small file is the requested preview', async () => {
  const f = fixture(512, 1000); try {
    f.setMode('ignored'); const path = await f.cache.enqueue(target).result;
    expect(readFileSync(f.disk(path))).toEqual(f.body); expect(f.requests).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('M3 diagnostics expose real index offsets and workers without source or credential data',async()=>{
 const f=fixture();try{f.block();const request=f.cache.enqueue(target);await f.started.promise;const working=f.cache.diagnostics();expect(working.indexScope).toBe('bili-preview');expect(working.jobs.filter(j=>j.active)).toHaveLength(1);expect(working.records[0]?.offset).toBe(0);expect(working.records[0]?.complete).toBe(false);expect(JSON.stringify(working)).not.toContain('fixture_cookie');expect(JSON.stringify(working)).not.toContain('http://');f.unblock();await request.result;const done=f.cache.diagnostics();expect(done.records[0]?.offset).toBe(f.body.length/2);expect(done.records[0]?.complete).toBe(true);done.records[0]!.offset=0;expect(f.cache.diagnostics().records[0]?.offset).toBe(f.body.length/2);}finally{await f.cleanup();}
});
