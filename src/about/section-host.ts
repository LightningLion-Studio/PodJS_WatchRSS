import {hostPublicSnapshotPorts} from '../core/public-snapshot-host.ts';
import {WATCH_ABOUT_SECTION_LIMIT, WATCH_ABOUT_SECTION_PATH, createWatchAboutSectionLoader} from './section.ts';

let origin: string | undefined;
let load: ReturnType<typeof createWatchAboutSectionLoader>;

export function loadHostWatchAboutSection(baseUrl: string) {
  if (origin !== baseUrl) {
    origin = baseUrl;
    load = createWatchAboutSectionLoader(hostPublicSnapshotPorts(baseUrl, WATCH_ABOUT_SECTION_PATH,
      'watchrss.about-section.watch', WATCH_ABOUT_SECTION_LIMIT));
  }
  return load();
}
