import type { BiliPlayUrl } from './types.ts';
import type { DetailTarget } from './detail.ts';
import type { ManagedCache } from '../cache/managed.ts';
import { CACHE_ROOT } from '../cache/policy.ts';

export const PREVIEW_QUALITY = 32;
export const PREVIEW_MS = 30 * 60 * 1000;
export const PREVIEW_INDEX = 'watchrss.bili.preview.v1';
const CHUNK_BYTES = 1024 * 1024;
const MAX_RECORDS = 200;
const ROOT = `${CACHE_ROOT}/bili-preview`;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const videoKey = (target: DetailTarget) => target.bvid?.trim() || (positive(target.aid) ? `av${target.aid}` : undefined);
const strongEtag = (value: unknown): value is string => typeof value === 'string' && /^"[^"\r\n]*"$/.test(value);
const validTarget = (target: any): target is DetailTarget => target && typeof target === 'object' &&
  (target.bvid === undefined || typeof target.bvid === 'string') &&
  (target.aid === undefined || positive(target.aid)) && positive(target.cid);
const targetKey = (target: DetailTarget) => JSON.stringify([videoKey(target), target.cid ?? 0, PREVIEW_QUALITY]);
export function previewBytes(size: number | undefined, length: number | undefined): number {
  if (!positive(size) || !positive(length)) throw Error('invalid_preview_length');
  // Same integer arithmetic as native, without overflowing Number's exact integer range.
  return Math.max(1, Number(BigInt(size) * BigInt(Math.min(PREVIEW_MS, length)) / BigInt(length)));
}
interface PreviewRecord {
  key: string; target: DetailTarget; path: string; size: number; offset: number;
  source: string; etag?: string; complete: boolean; updated: number;
}
interface Download { status: number; headers: Record<string, string>; size: number }
export interface PreviewPorts {
  store: { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void };
  digest(value: string): Promise<string>;
  resolve(target: DetailTarget & { cid: number; qn: number; preferMp4: true }): Promise<BiliPlayUrl>;
  headers(): Promise<Record<string, string>>;
  download(url: string, path: string, headers: Record<string, string>, maxBytes: number): { result: Promise<Download>; cancel(): void };
  stat(path: string): Promise<{ file: boolean; size: number }>;
  write(path: string, dataBase64: string): Promise<unknown>;
  read(path: string, offset: number, maxBytes: number): Promise<{ dataBase64: string; size: number; eof: boolean }>;
  append(path: string, dataBase64: string, offset: number): Promise<{ size: number }>;
  hash(path: string): Promise<{ size: number; sha256: string }>;
  commit(path: string, target: string, size: number, sha256: string): Promise<unknown>;
  remove(path: string): Promise<void>;
  touch(path: string): Promise<unknown>;
  wait(ms: number): { result: Promise<unknown>; cancel(): void };
  now?(): number;
}
type Job = {
  key: string; target: DetailTarget; cancelled: boolean; pins: Set<string>;
  current?: { cancel(): void }; result: Promise<string>; resolve(path: string): void; reject(error: unknown): void;
};
/** One worker, eight outstanding jobs, and three attempts per job. Only committed MP4s are playable. */
export class BiliPreviewCache {
  private records: PreviewRecord[];
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active?: Job;
  private clearing = false;
  private now: () => number;
  constructor(private ports: PreviewPorts, private cache: Pick<ManagedCache, 'registerProducer' | 'maintain' | 'limitBytes'>) {
    this.now = ports.now ?? Date.now;
    const raw = ports.store.get(PREVIEW_INDEX);
    this.records = Array.isArray(raw) ? raw.filter((r): r is PreviewRecord =>
      r && typeof r.key === 'string' && validTarget(r.target) && videoKey(r.target) && r.key === targetKey(r.target) &&
      new RegExp(`^${ROOT}/[a-f0-9]{64}\\.mp4$`).test(r.path) && positive(r.size) &&
      Number.isSafeInteger(r.offset) && r.offset >= 0 && r.offset <= r.size &&
      typeof r.source === 'string' && /^[a-f0-9]{64}$/.test(r.source) && typeof r.complete === 'boolean' &&
      (!r.complete || r.offset === r.size) && Number.isFinite(r.updated) &&
      (r.etag === undefined || strongEtag(r.etag))).slice(0, MAX_RECORDS) : [];
    cache.registerProducer('bili-preview', {
      pins: () => new Set([...this.jobs.values()].flatMap(job => [...job.pins])),
      clear: async () => {
        this.clearing = true;
        const jobs = [...this.jobs.values()];
        for (const job of jobs) this.cancel(job);
        await Promise.allSettled(jobs.map(job => job.result));
        this.records = []; this.ports.store.delete(PREVIEW_INDEX);
      },
      cleared: () => { this.clearing = false; },
    });
  }
  private save(record?: PreviewRecord) {
    if (record) {
      const records = [record, ...this.records.filter(row => row.key !== record.key)];
      if (records.length > MAX_RECORDS) throw Error('preview_index_full');
      this.records = records;
    }
    this.ports.store.set(PREVIEW_INDEX, this.records);
  }
  async lookup(target: DetailTarget): Promise<{ path: string; cid: number } | undefined> {
    if (!videoKey(target)) return;
    const candidates = this.records.filter(row => row.complete && videoKey(row.target) === videoKey(target) &&
      (positive(target.cid) ? row.target.cid === target.cid : true)).sort((a, b) => b.updated - a.updated);
    for (const row of candidates) {
      const key = await this.ports.digest(row.key);
      const stat = row.path === `${ROOT}/${key}.mp4` ? await this.ports.stat(row.path) : {file:false,size:0};
      if (!stat.file || stat.size !== row.size) {
        this.records = this.records.filter(record => record !== row); this.save(); continue;
      }
      await this.ports.touch(row.path); row.updated = this.now(); this.save();
      return { path: row.path, cid: row.target.cid! };
    }
  }
  enqueue(target: DetailTarget): { result: Promise<string>; cancel(): void } {
    if (this.clearing || !videoKey(target) || !positive(target.cid)) {
      const result = Promise.reject<string>(Error(this.clearing ? 'preview_clearing' : 'missing_preview_target'));
      void result.catch(() => {}); return { result, cancel() {} };
    }
    const key = targetKey(target), existing = this.jobs.get(key);
    if (existing) return { result: existing.result, cancel: () => this.cancel(existing) };
    if (this.jobs.size >= 8) {
      const result = Promise.reject<string>(Error('preview_queue_full')); void result.catch(() => {});
      return { result, cancel() {} };
    }
    let resolve!: (path: string) => void, reject!: (error: unknown) => void;
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => {});
    const job: Job = { key, target: { ...target }, cancelled: false, pins: new Set(), result, resolve, reject };
    this.jobs.set(key, job); this.queue.push(job); this.pump();
    return { result, cancel: () => this.cancel(job) };
  }
  private cancel(job: Job) {
    job.cancelled = true; job.current?.cancel();
    if (job !== this.active) {
      this.queue = this.queue.filter(row => row !== job); this.jobs.delete(job.key); job.reject(Error('preview_cancelled'));
    }
  }
  private check(job: Job) { if (job.cancelled || this.clearing) throw Error('preview_cancelled'); }
  private pump() {
    if (this.active || this.clearing) return;
    const job = this.queue.shift(); if (!job) return;
    this.active = job;
    void this.run(job).then(job.resolve, job.reject).finally(() => {
      job.current = undefined; this.jobs.delete(job.key); this.active = undefined;
      this.pump(); void this.cache.maintain().catch(() => {});
    });
  }
  async remove(target: DetailTarget): Promise<void> {
    const key = targetKey(target), job = this.jobs.get(key);
    if (job) { this.cancel(job); await job.result.catch(() => {}); }
    const record = this.records.find(row => row.key === key);
    if (!record) return;
    for (const path of [record.path, record.path + '.part', record.path + '.chunk']) await this.ports.remove(path);
    this.records = this.records.filter(row => row.key !== key); this.save();
    void this.cache.maintain().catch(() => {});
  }
  private async run(job: Job): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check(job);
      try { return await this.load(job); }
      catch (error) {
        this.check(job); if (attempt === 2) throw error;
        const pause = this.ports.wait(250 * (attempt + 1)); job.current = pause;
        await pause.result; job.current = undefined;
      }
    }
    throw Error('preview_failed');
  }
  private async load(job: Job): Promise<string> {
    const key = await this.ports.digest(job.key); this.check(job);
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('invalid_preview_key');
    const path = `${ROOT}/${key}.mp4`, part = path + '.part', chunk = path + '.chunk';
    job.pins = new Set([path, part, chunk]);
    const found = await this.lookup(job.target); this.check(job); if (found) return found.path;
    const play = await this.ports.resolve({ ...job.target, cid: job.target.cid!, qn: PREVIEW_QUALITY, preferMp4: true }); this.check(job);
    const durl = play.durl[0], size = previewBytes(durl?.size, durl?.length);
    if (size > this.cache.limitBytes) throw Error('preview_exceeds_cache_limit');
    const url = durl.url?.trim(); if (!url || !/^https?:\/\//i.test(url)) throw Error('missing_preview_mp4');
    const source = await this.ports.digest(JSON.stringify([url, durl.size, durl.length])); this.check(job);
    const old = this.records.find(row => row.key === job.key), stat = await this.ports.stat(part); this.check(job);
    let record: PreviewRecord;
    if (old && !old.complete && old.source === source && old.size === size && old.etag &&
      stat.file && stat.size === old.offset) record = old;
    else {
      await this.ports.write(part, ''); this.check(job);
      record = { key: job.key, target: job.target, path, size, offset: 0, source, complete: false, updated: this.now() };
      // Reconcile stale index entries before admitting another cache file.
      for (const row of [...this.records]) if (row.key !== job.key && !(await this.ports.stat(row.complete ? row.path : row.path + '.part')).file)
        this.records = this.records.filter(value => value !== row);
      this.check(job); this.save(record);
    }
    const headers = await this.ports.headers(); this.check(job);
    try {
      while (record.offset < size) {
        this.check(job);
        if (size > this.cache.limitBytes) throw Error('preview_exceeds_cache_limit');
        const start = record.offset, end = Math.min(size, start + CHUNK_BYTES) - 1;
        const request = this.ports.download(url, chunk, { ...headers, 'Accept-Encoding': 'identity', Range: `bytes=${start}-${end}`,
          ...(record.etag ? { 'If-Range': record.etag } : {}) }, end - start + 1);
        job.current = request;
        const response = await request.result; job.current = undefined; this.check(job);
        const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
        const etag = responseHeaders.etag;
        const validRange = response.status === 206 && responseHeaders['content-range'] === `bytes ${start}-${end}/${durl.size}`;
        const wholeFile = start === 0 && size === durl.size && response.status === 200;
        if ((!validRange && !wholeFile) || response.size !== end - start + 1 ||
          (record.etag && etag !== record.etag)) {
          await this.ports.remove(part); this.records = this.records.filter(row => row.key !== job.key); this.save();
          throw Error('invalid_preview_range');
        }
        // Strong validators allow safe resume across attempts/restarts. Without one, restart on failure.
        if (strongEtag(etag)) record.etag = etag;
        let offset = 0;
        while (offset < response.size) {
          this.check(job);
          const bytes = await this.ports.read(chunk, offset, Math.min(65536, response.size - offset)); this.check(job);
          const appended = await this.ports.append(part, bytes.dataBase64, start + offset); this.check(job);
          const count = appended.size - start - offset;
          if (count <= 0 || count > 65536 || offset + count > response.size) throw Error('invalid_preview_chunk');
          offset += count;
        }
        record = { ...record, offset: end + 1, updated: this.now() }; this.save(record);
        await this.ports.remove(chunk);
      }
      const hash = await this.ports.hash(part); this.check(job);
      if (hash.size !== size) throw Error('invalid_preview_size');
      await this.ports.commit(part, path, size, hash.sha256); this.check(job);
      this.save({ ...record, complete: true, updated: this.now() });
      await this.ports.touch(path); this.check(job); return path;
    } finally { await this.ports.remove(chunk); }
  }
}
