import { fileChunks, hostOperation, delay, bytesToBase64, base64ToBytes, stringToUtf8, type DownloadResult } from '@podjs/framework/services';
import { kv } from '@podjs/framework/watch';
import type { BiliClient } from './client.ts';
import { BiliPreviewCache } from './preview.ts';
import { managedCache } from '../cache/host.ts';
import {biliCdnHeaders} from './cdn.ts';

/** The video host resolves this app-root relative path to a checked file URI. */
export function createHostBiliPreview(client: Pick<BiliClient, 'resolvePlayback' | 'getSession'>) {
  return new BiliPreviewCache({
    store: kv,
    async digest(value) {
      const result = await hostOperation<{ digestBase64: string }>('crypto.hash', {
        algorithm: 'SHA-256', dataBase64: bytesToBase64(stringToUtf8(value)),
      }).result;
      return Array.from(base64ToBytes(result.digestBase64), byte => byte.toString(16).padStart(2, '0')).join('');
    },
    resolve: target => client.resolvePlayback(target),
    async headers(source) {
      if(source.apiSource==='watch')return biliCdnHeaders(source,{});
      const session = await client.getSession();
      return { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0',
        ...(session ? { Cookie: Object.entries(session.cookies).map(([key, value]) => `${key}=${value}`).join('; ') } : {}) };
    },
    download: (url, path, headers, maxBytes) => hostOperation<DownloadResult>('http.download', {
      url, path, headers, maxBytes, callTimeoutMs: 120000,
    }),
    stat: fileChunks.stat, write: fileChunks.write, read: fileChunks.read, append: fileChunks.append,
    hash: fileChunks.hash, commit: fileChunks.commit, remove: fileChunks.remove, touch: fileChunks.touch, wait: delay,
  }, managedCache);
}
