import {createPublicSnapshotLoader, type PublicSnapshotPorts} from '../core/public-snapshot.ts';

export const WATCH_ABOUT_SECTION_PATH = '/functions/v1/about-section?platform=watch';
export const WATCH_ABOUT_SECTION_LIMIT = 128 * 1024;

export interface AboutSectionItem {
  title: string | null;
  body: string;
}

export interface WatchAboutSectionSnapshot {
  revision: number;
  items: AboutSectionItem[];
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit * 2 && Array.from(value).length <= limit;
}

function aboutItem(value: unknown): value is AboutSectionItem {
  return object(value) && (value.title === null || isText(value.title, 40)) && isText(value.body, 1000);
}

function watchAboutSectionSnapshot(value: unknown): WatchAboutSectionSnapshot | undefined {
  if (!object(value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.items) || value.items.length > 20 || !value.items.every(aboutItem)) return;
  return {revision: value.revision, items: value.items};
}

export function createWatchAboutSectionLoader(ports: PublicSnapshotPorts<WatchAboutSectionSnapshot>) {
  const load = createPublicSnapshotLoader(ports, watchAboutSectionSnapshot);
  return async (): Promise<AboutSectionItem[]> => (await load())?.items ?? [];
}
