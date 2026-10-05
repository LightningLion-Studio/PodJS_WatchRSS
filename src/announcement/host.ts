import {kv, hasCapability} from '@podjs/framework/watch';
import {hostOperation, fileChunks, base64ToBytes, type DownloadResult} from '@podjs/framework/services';
import config from '../../pod.config.json';
import {watchAppVersion} from '../core/app-version.ts';
import type {HttpTransport} from '../cloud/types.ts';
import {AnnouncementClient} from './client.ts';
import {AnnouncementRepository} from './repository.ts';
import {AppUpdateService, UpdateServiceError, requireHttps, type UpdatePort} from './update.ts';
let sequence = 0;
const pathFor = (extension: string) => `announcement/${Date.now()}-${++sequence}.${extension}`;
/** Bounded JSON transport; only GET is permitted and response files are temporary. */
export const announcementTransport: HttpTransport = {
  async request(request) {
    if (request.method !== 'GET') throw new Error('公告客户端仅支持 GET');
    const path = pathFor('json');
    try {
      const response = await hostOperation<DownloadResult>('http.download', {url: request.url, path,
        temporary: true, method: 'GET', headers: request.headers, timeoutMs: 5000, readTimeoutMs: 5000,
        maxBytes: 1024 * 1024}).result;
      const body = new Uint8Array(response.size);
      let offset = 0;
      while (offset < body.length) {
        const chunk = await fileChunks.read(path, offset);
        const bytes = base64ToBytes(chunk.dataBase64);
        if (!bytes.length || offset + bytes.length > body.length || chunk.size !== body.length)
          throw new Error('公告响应下载不完整');
        body.set(bytes, offset); offset += bytes.length;
      }
      return {status: response.status, headers: response.headers, body};
    } finally { await fileChunks.remove(path).catch(() => {}); }
  },
};
/** No invented APK bridge calls. Generic downloads only report completion, not
 * streaming progress. AppUpdateService refuses to download without inspection. */
export function createHostUpdatePort(): UpdatePort {
  return {
    capabilities: {download: hasCapability('net.download'), progress: false, inspectApk: false, installApk: false},
    async download(url, onProgress) {
      requireHttps(url);
      const path = pathFor('apk');
      try {
        const result = await hostOperation<DownloadResult>('http.download', {url, path, temporary: true,
          method: 'GET', timeoutMs: 15000, readTimeoutMs: 60000, maxBytes: 64 * 1024 * 1024}).result;
        requireHttps(result.url);
        onProgress({bytesRead: result.size, totalBytes: result.size > 0 ? result.size : null});
        return result;
      } catch (error) { await fileChunks.remove(path).catch(() => {}); throw error; }
    },
    async inspectApk() { throw new UpdateServiceError('unsupported', '当前宿主未提供 APK 包解析能力'); },
    remove: path => fileChunks.remove(path),
    async launchInstaller() { throw new UpdateServiceError('unsupported', '当前宿主未提供系统安装器能力'); },
  };
}
export function createAnnouncementServices() {
  return {
    repository: new AnnouncementRepository(new AnnouncementClient(announcementTransport, watchAppVersion), kv, config.versionName),
    updater: new AppUpdateService(createHostUpdatePort(), config.appId),
  };
}
