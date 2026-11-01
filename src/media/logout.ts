import { clearDouyinBrowserData, type DouyinBrowser, type BrowserDiagnostic } from '../douyin/browser.ts';

export interface LogoutCache { clearBucket(bucket: 'bili-preview' | 'douyin-preload'): Promise<unknown> }

/** BiliRepository.logoutAndClearPreviewCache: feed/search/saved data are deliberately retained. */
export async function clearBiliLogoutData(store: { delete(key: string): unknown }, cache: LogoutCache): Promise<void> {
  await store.delete('watchrss.bili.interactions.v1');
  await store.delete('watchrss.bili.playback-progress.v1');
  await cache.clearBucket('bili-preview');
}

/** Cookie and recent-window cleanup live in DouyinClient; watch history and saved items survive logout. */
export async function clearDouyinLogoutData(cache: LogoutCache, browser?: DouyinBrowser, diagnostic?: BrowserDiagnostic): Promise<void> {
  const cleared=browser?await clearDouyinBrowserData(browser, diagnostic):true;
  await cache.clearBucket('douyin-preload');
  if(!cleared)throw Error('douyin_browser_cleanup_failed');
}
