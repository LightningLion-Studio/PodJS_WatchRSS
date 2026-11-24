import {createPublicSnapshotLoader, type PublicSnapshotPorts} from '../core/public-snapshot.ts';

// A watch response may contain several model records. Keep that document
// bounded separately from the much smaller chunks sent over the host bridge.
export const AI_DISCLOSURE_LIMIT = 256 * 1024;
export const AI_DISCLOSURE_PATH = '/functions/v1/ai-disclosure?platform=watch';
export const AI_DISCLOSURE_UNAVAILABLE = '所用模型信息暂不可用，请联网后重试';
export const AI_DISCLOSURE_PLACEHOLDER = '__FILL_BEFORE_RELEASE__';

interface DisclosureEntry {
  displayText: string;
  modelName: string;
  providerName: string | null;
  filingNumber: string | null;
  launchNumber: string | null;
}

interface WatchDisclosureSnapshot {
  revision: number;
  updatedAt: number;
  features: {article_summary?: DisclosureEntry[]};
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !value.includes(AI_DISCLOSURE_PLACEHOLDER);
}

function validEntry(value: unknown): value is DisclosureEntry {
  return object(value) && validText(value.displayText) && validText(value.modelName)
    && [value.providerName, value.filingNumber, value.launchNumber].every(field => field === null || validText(field));
}

export function watchDisclosureSnapshot(value: unknown): WatchDisclosureSnapshot | undefined {
  if (!object(value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !object(value.features)) return;
  const entries = value.features.article_summary;
  if (entries === undefined) return {revision: value.revision, updatedAt: value.updatedAt, features: {}};
  if (!Array.isArray(entries) || !entries.every(validEntry)) return;
  return {revision: value.revision, updatedAt: value.updatedAt, features: {article_summary: entries}};
}

export function watchDisclosureText(snapshot: WatchDisclosureSnapshot | undefined): string {
  return snapshot?.features.article_summary?.map(entry => entry.displayText).join('\n') || AI_DISCLOSURE_UNAVAILABLE;
}


export function createWatchDisclosureLoader(
  ports: PublicSnapshotPorts<WatchDisclosureSnapshot>, bundled: unknown,
): () => Promise<string> {
  const load = createPublicSnapshotLoader(ports, watchDisclosureSnapshot);
  const fallback = watchDisclosureSnapshot(bundled);
  return async () => watchDisclosureText((await load()) ?? fallback);
}
