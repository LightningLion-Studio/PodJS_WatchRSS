import {utf8Decode, type HttpTransport} from '../cloud/types.ts';
import {parseAnnouncement, parsePushMessages} from './models.ts';

// Android_WatchRSS/app/build.gradle.kts, not the account-configurable backend.
export const ANNOUNCEMENT_BACKEND = 'https://sly-data-plane.watchrss.cn';
export class AnnouncementClient {
  constructor(private readonly transport: HttpTransport, private readonly appVersion: string) {}
  private async get(path: string): Promise<unknown> {
    const response = await this.transport.request({method: 'GET', url: ANNOUNCEMENT_BACKEND + path,
      headers: {'X-WatchRSS-App-Version': this.appVersion}});
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(utf8Decode(response.body));
  }
  async announcement() { return parseAnnouncement(await this.get('/functions/v1/announcement?client=android_watch')); }
  async messages(topic = 'watchrss', limit = 10) {
    if (!topic || !Number.isInteger(limit) || limit < 1) throw new Error('无效的推送查询参数');
    return parsePushMessages(await this.get(`/api/notify/${encodeURIComponent(topic)}?limit=${limit}`));
  }
}
