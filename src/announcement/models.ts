export interface Announcement {
  version: string;
  changelogMarkdown: string;
  forceUpdate: boolean;
  downloadUrl: string;
}
export interface PushMessage { id: number; title: string; body: string }

/** Native compares digit groups, zero-pads, and treats Long overflow as zero. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => (value.match(/\d+/g) ?? []).map(part => {
    const n = BigInt(part);
    return n <= 9223372036854775807n ? n : 0n;
  });
  const a = parts(left), b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0n, y = b[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
export function parseAnnouncement(value: unknown): Announcement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const j = value as Record<string, unknown>;
  const text = (key: string) => typeof j[key] === 'string' ? j[key].trim() : '';
  const version = text('version'), changelogMarkdown = text('changelog_md'), downloadUrl = text('download_url');
  if (!version || !changelogMarkdown || !downloadUrl) return null;
  return {version, changelogMarkdown, downloadUrl, forceUpdate: j.force_update === true || (typeof j.force_update === 'string' && j.force_update.toLowerCase() === 'true')};
}
export function parsePushMessages(value: unknown): PushMessage[] {
  if (!Array.isArray(value)) throw new Error('推送响应不是数组');
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const n = typeof item.id === 'number' || typeof item.id === 'string' ? Number(item.id) : 0;
    const id = Math.trunc(n);
    if (!Number.isFinite(id) || id <= 0 || id > 2147483647) return [];
    return [{id, title: String(item.title ?? ''), body: String(item.body ?? '')}];
  });
}
