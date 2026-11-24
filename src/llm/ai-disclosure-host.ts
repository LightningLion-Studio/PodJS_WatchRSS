import {hostPublicSnapshotPorts} from '../core/public-snapshot-host.ts';
import bundled from './ai-disclosure-default.json';
import {AI_DISCLOSURE_LIMIT, AI_DISCLOSURE_PATH, createWatchDisclosureLoader} from './ai-disclosure.ts';

const WATCH_PUBLIC_BACKEND = 'https://sly-data-plane.watchrss.cn';

export function createHostWatchDisclosureLoader(baseUrl = WATCH_PUBLIC_BACKEND) {
  return createWatchDisclosureLoader(hostPublicSnapshotPorts(baseUrl, AI_DISCLOSURE_PATH,
    'watchrss.ai-disclosure.watch', AI_DISCLOSURE_LIMIT), bundled);
}
