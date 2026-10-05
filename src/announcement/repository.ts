import {AnnouncementClient} from './client.ts';
import {compareVersions, type Announcement, type PushMessage} from './models.ts';

export interface AnnouncementStorage { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void }
const DISMISSED = 'announcement.dismissed_version';
const SEEN = 'announcement.last_seen_notification_id';
export class AnnouncementRepository {
  private pendingMessages?: Promise<PushMessage[]>;
  constructor(private readonly client: AnnouncementClient, private readonly storage: AnnouncementStorage, private readonly currentVersion: string) {}
  async checkAnnouncement(): Promise<Announcement | null> {
    try {
      const item = await this.client.announcement();
      if (!item || compareVersions(item.version, this.currentVersion) <= 0) return null;
      return !item.forceUpdate && this.storage.get<string>(DISMISSED) === item.version ? null : item;
    } catch { return null; } // Native startup checks fail quietly and still allow push checks.
  }
  markDismissed(item: Announcement): boolean {
    if (item.forceUpdate) return false;
    this.storage.set(DISMISSED, item.version);
    return true;
  }
  fetchNewMessages(): Promise<PushMessage[]> {
    // Coalesce overlapping checks into one request and one seen-watermark write.
    return this.pendingMessages ??= this.fetchMessages().finally(() => { this.pendingMessages = undefined; });
  }
  private async fetchMessages(): Promise<PushMessage[]> {
    try {
      const messages = await this.client.messages();
      const stored = this.storage.get<number>(SEEN);
      const seen = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
      const unread = messages.filter(message => message.id > seen);
      const maxId = messages.reduce((max, message) => Math.max(max, message.id), seen);
      // Native marks the entire fetched batch seen before showing its first item, not on dismiss.
      if (maxId > seen) this.storage.set(SEEN, maxId);
      return unread.reverse();
    } catch { return []; }
  }
  async checkHome(): Promise<{announcement: Announcement | null; messages: PushMessage[]}> {
    const announcement = await this.checkAnnouncement();
    return {announcement, messages: announcement ? [] : await this.fetchNewMessages()};
  }
}
