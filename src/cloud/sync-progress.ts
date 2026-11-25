export const SYNC_STAGE_LABEL = {
 connecting: '正在连接云端',
 keys: '正在检查设备与密钥',
 compare: '正在比对清单',
 download: '正在下载变更',
 write: '正在写入本机',
 upload: '正在上传变更',
 bodies: '正在同步正文与附件',
 complete: '同步完成',
} as const;

type Stage = Exclude<keyof typeof SYNC_STAGE_LABEL, 'complete'>;
type Outcome = 'complete' | 'incomplete' | 'superseded';
type Count = {done: number; total?: number; unit: 'items' | 'received' | 'sent'};
export type SyncProgressSnapshot = Readonly<{stage: Stage | 'complete'; count?: Readonly<Count>}>;
export type NoteSyncTimes = {savedAt: number; publishStartedAt?: number; syncedAt?: number};

const CLOUD = '/functions/v1/cloud', V2 = '/functions/v1/sync/v2', BODY = CLOUD + '/bodies/v1';
const STATIC_ROUTES = new Set([
 ...['/bootstrap', '/devices/register', '/records', '/format-capabilities', '/snapshots/heads',
  '/snapshots/reserve', '/snapshots/complete'].map(path => CLOUD + path),
 ...['/capabilities', '/checkpoint', '/negotiate', '/account', '/account/ancestry', '/account/publish',
  '/acks/applied', '/availability/check', '/availability/custody', '/choices/cloud',
  '/devices/signing-key', '/devices/signing-keys', '/events', '/history', '/history/prepare',
  '/objects/batch-get', '/objects/have-want', '/objects/reserve', '/recipe-refs', '/refs', '/refs/cas',
  '/repo/descriptor', '/state-refs', '/trees/diff'].map(path => V2 + path),
 BODY + '/carriers', BODY + '/reserve',
 '/functions/v1/account/watch-token/refresh', '/functions/v1/rss/sources/resolve',
]);
const PARAMETER_ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
 [/^\/functions\/v1\/sync\/v2\/objects\/[^/]+\/parts\/[^/]+$/, V2 + '/objects/{oid}/parts/{offset}'],
 [/^\/functions\/v1\/sync\/v2\/objects\/[^/]+\/complete$/, V2 + '/objects/{oid}/complete'],
 [/^\/functions\/v1\/sync\/v2\/objects\/[^/]+$/, V2 + '/objects/{oid}'],
 [/^\/functions\/v1\/sync\/v2\/repo\/id-key-recovery\/[^/]+$/, V2 + '/repo/id-key-recovery/{oid}'],
 [/^\/functions\/v1\/sync\/v2\/requests\/[^/]+$/, V2 + '/requests/{id}'],
 [/^\/functions\/v1\/sync\/v2\/state-refs\/[^/]+$/, V2 + '/state-refs/{oid}'],
 [/^\/functions\/v1\/sync\/v2\/recipe-refs\/[^/]+$/, V2 + '/recipe-refs/{oid}'],
 [/^\/functions\/v1\/sync\/v2\/availability\/custody\/[^/]+$/, V2 + '/availability/custody/{id}'],
 [/^\/functions\/v1\/cloud\/bodies\/v1\/carriers\/[^/]+\/objects\/[^/]+\/parts\/[^/]+$/, BODY + '/carriers/{id}/objects/{hash}/parts/{offset}'],
 [/^\/functions\/v1\/cloud\/bodies\/v1\/carriers\/[^/]+\/objects\/[^/]+$/, BODY + '/carriers/{id}/objects/{hash}'],
 [/^\/functions\/v1\/cloud\/bodies\/v1\/carriers\/[^/]+\/complete$/, BODY + '/carriers/{id}/complete'],
 [/^\/functions\/v1\/cloud\/uploads\/[^/]+$/, CLOUD + '/uploads/{id}'],
 [/^\/functions\/v1\/cloud\/snapshots\/[^/]+$/, CLOUD + '/snapshots/{id}'],
 [/^\/functions\/v1\/cloud\/snapshots\/[^/]+\/ack$/, CLOUD + '/snapshots/{id}/ack'],
 [/^\/functions\/v1\/rss\/sources\/[^/]+\/entries$/, '/functions/v1/rss/sources/{id}/entries'],
];

function requestRoute(method: string, url: string) {
 const path = /^https?:\/\/[^/]+(\/[^?#]*)/i.exec(url)?.[1] ?? '';
 const route = STATIC_ROUTES.has(path) ? path : PARAMETER_ROUTES.find(([pattern]) => pattern.test(path))?.[1];
 const verb = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method) ? method : 'OTHER';
 return route ? verb + ' ' + route : 'other';
}

type Metrics = {
 stage: Stage; startedAt: number; durationMs: number; requests: number; routes: Record<string, number>;
 objects: number; sentBytes: number; receivedBytes: number; httpMs: number;
};
type StageRun = {metrics: Metrics; startedAt: number; receivedBytes: number; count?: Count};
const COUNT_INTERVAL = 500;
// Retain the first transitions in order, then aggregate repeated phases by name.
const MAX_ORDERED_STAGES = 16;
const MAX_ROUTES_PER_STAGE = 16;
let sequence = 0;

export interface SyncProgressPort {
 readonly snapshot: SyncProgressSnapshot | undefined;
 subscribe(listener: (snapshot: SyncProgressSnapshot | undefined) => void): () => void;
}

export class SyncProgress implements SyncProgressPort {
 private round?: {id: string; stages: Metrics[]; overflow: Map<Stage, Metrics>; note?: NoteSyncTimes};
 private current?: StageRun;
 private latest?: SyncProgressSnapshot;
 private published?: SyncProgressSnapshot;
 private lastPush = -Infinity;
 private cancelTimer?: () => void;
 private listeners = new Set<(snapshot: SyncProgressSnapshot | undefined) => void>();
 constructor(
  private readonly now: () => number,
  private readonly delay: (ms: number, callback: () => void) => () => void,
  private readonly log: (summary: string) => void,
  private readonly source: 'foreground' | 'background' = 'foreground',
 ) {}
 get snapshot() { return this.latest; }
 subscribe(listener: (snapshot: SyncProgressSnapshot | undefined) => void) {
  if (!this.listeners.size) this.published = this.latest;
  this.listeners.add(listener);
  return () => {
   this.listeners.delete(listener);
   if (!this.listeners.size) this.stopTimer();
  };
 }
 start(note?: NoteSyncTimes) {
  this.round = {id: `${Math.floor(Math.random() * 0x100000000).toString(36)}-${(++sequence).toString(36)}`, stages: [], overflow: new Map(), note};
  this.stage('connecting');
 }
 stage(stage: Stage) {
  const round = this.round;
  if (!round || this.current?.metrics.stage === stage) return;
  this.closeStage();
  const at = this.now();
  let metrics = round.overflow.get(stage);
  if (!metrics) {
   metrics = {stage, startedAt: at, durationMs: 0, requests: 0, routes: {}, objects: 0, sentBytes: 0, receivedBytes: 0, httpMs: 0};
   if (round.stages.length < MAX_ORDERED_STAGES) round.stages.push(metrics);
   else round.overflow.set(stage, metrics);
  }
  if (stage === 'upload' && round.note) round.note.publishStartedAt ??= at;
  this.current = {metrics, startedAt: at, receivedBytes: 0};
  this.update(true);
 }
 plan(unit: Count['unit'], total: number) {
  if (!this.current || !Number.isSafeInteger(total) || total <= 0) return;
  this.current.count = {unit, total, done: 0};
  this.update();
 }
 advance(objects: number, bytes = 0) {
  const stage = this.current;
  if (!stage) return;
  stage.metrics.objects += objects;
  if (!stage.count && objects > 0) stage.count = {unit: 'items', done: 0};
  if (stage.count) stage.count.done += stage.count.unit === 'items' ? objects : bytes;
  this.update();
 }
 request(method: string, url: string) {
  const round = this.round, stage = this.current;
  if (!round || !stage) return;
  const metric = stage.metrics, started = this.now();
  const route = requestRoute(method, url);
  const key = Object.hasOwn(metric.routes, route) || Object.keys(metric.routes).length < MAX_ROUTES_PER_STAGE ? route : 'other';
  metric.routes[key] = (metric.routes[key] ?? 0) + 1;
  metric.requests++;
  return (sent: number, received: number) => {
   if (this.round !== round) return;
   metric.sentBytes += sent;
   metric.receivedBytes += received;
   stage.receivedBytes += received;
   metric.httpMs += Math.max(0, this.now() - started);
   if (this.current === stage) this.update();
  };
 }
 finish(outcome: Outcome, completedAt = this.now()) {
  const round = this.round;
  if (!round) return;
  this.closeStage();
  this.round = undefined;
  if (outcome === 'complete' && round.note?.publishStartedAt !== undefined) round.note.syncedAt = completedAt;
  this.show(outcome === 'complete' ? {stage: 'complete'} : undefined, true);
  try {
   const stages = [...round.stages, ...round.overflow.values()];
   const summary = {roundId: round.id, source: this.source, outcome, endedAt: completedAt,
    stages: round.stages, ...(round.overflow.size ? {additionalStages: [...round.overflow.values()]} : {}),
    ...(round.note ? {note: {savedAt: round.note.savedAt, publishStartedAt: round.note.publishStartedAt, syncedAt: round.note.syncedAt}} : {}),
   };
   let line = JSON.stringify(summary);
   // The native worker's log append accepts at most 8192 bytes. The schema is ASCII.
   for (const stage of stages.reverse()) {
    if (line.length <= 7800) break;
    stage.routes = {other: stage.requests};
    line = JSON.stringify(summary);
   }
   this.log(line);
  } catch { /* Diagnostics must not change the outcome. */ }
 }
 reset() {
  this.finish('superseded');
  this.show(undefined, true);
 }
 private closeStage() {
  if (this.current) this.current.metrics.durationMs += Math.max(0, this.now() - this.current.startedAt);
  this.current = undefined;
 }
 private stopTimer() {
  const cancel = this.cancelTimer;
  this.cancelTimer = undefined;
  try { cancel?.(); } catch { /* The host can close with a timer pending. */ }
 }
 private update(immediate = false) {
  const stage = this.current;
  if (!stage) return;
  const count = stage.count ?? (stage.metrics.stage !== 'upload' && stage.receivedBytes > 0 ? {unit: 'received' as const, done: stage.receivedBytes} : undefined);
  this.show({stage: stage.metrics.stage, ...(count ? {count: {...count}} : {})}, immediate);
 }
 private show(next: SyncProgressSnapshot | undefined, immediate: boolean) {
  const same = (a: typeof next, b: typeof next) => a?.stage === b?.stage &&
   a?.count?.done === b?.count?.done && a?.count?.total === b?.count?.total && a?.count?.unit === b?.count?.unit;
  if (!same(this.latest, next)) this.latest = next;
  if (!this.listeners.size || same(this.published, this.latest)) return;
  const remaining = COUNT_INTERVAL - (this.now() - this.lastPush);
  if (immediate || remaining <= 0) {
   this.stopTimer();
   this.published = this.latest;
   this.lastPush = this.now();
   for (const fn of this.listeners) try { fn(this.latest); } catch {}
  } else if (!this.cancelTimer) {
   this.cancelTimer = this.delay(remaining, () => {
    this.cancelTimer = undefined;
    this.show(this.latest, false);
   });
  }
 }
}
