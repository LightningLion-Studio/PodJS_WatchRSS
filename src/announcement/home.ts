import type { AnnouncementRepository } from "./repository.ts";
import type { Announcement, PushMessage } from "./models.ts";

/** PodJS currently cannot validate/install the native package. Keep version
 * announcements wired but hidden until the distribution policy is decided. */
export const VERSION_ANNOUNCEMENTS_ENABLED = false;

export interface HomeNotices {
  announcement: Announcement | null;
  messages: PushMessage[];
}

export async function loadHomeNotices(
  repository: Pick<AnnouncementRepository, "checkHome" | "fetchNewMessages">,
  versionAnnouncements = VERSION_ANNOUNCEMENTS_ENABLED,
): Promise<HomeNotices> {
  if (versionAnnouncements) return repository.checkHome();
  return { announcement: null, messages: await repository.fetchNewMessages() };
}
