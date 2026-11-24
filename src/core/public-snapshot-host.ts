import {kv} from '@podjs/framework/watch';
import {fetchLegalDocument} from '../onboarding/legal-document.ts';
import type {PublicSnapshotPorts} from './public-snapshot.ts';

export function hostPublicSnapshotPorts<T>(
  baseUrl: string, path: string, cacheKey: string, maxBytes: number,
): PublicSnapshotPorts<T> {
  return {
    fetch: async () => JSON.parse(await fetchLegalDocument(baseUrl.replace(/\/+$/, '') + path, undefined,
      {maxBytes, chunkBytes: 8 * 1024, revalidate: false}).result),
    read: () => kv.get(cacheKey),
    write: snapshot => kv.set(cacheKey, snapshot),
  };
}
