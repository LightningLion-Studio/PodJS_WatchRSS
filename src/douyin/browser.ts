import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('browser');
import type { BrowserAvailability, BrowserSiteDataResult } from '@podjs/framework/services';

/** DouyinRepository DOUYIN_COOKIE_URLS / DOUYIN_ORIGINS (native reference). */
export const DOUYIN_SITE_ORIGINS = [
  'https://www.douyin.com',
  'https://douyin.com',
  'https://creator.douyin.com',
  'https://www.iesdouyin.com',
] as const;

export interface DouyinBrowser {
  hasCapability(capability: string): boolean;
  clearSiteData(args: { origins: readonly string[] }): { result: Promise<BrowserSiteDataResult[]> };
  availability(): { result: Promise<BrowserAvailability> };
}
export type BrowserDiagnostic = (message: string) => void;
const warn: BrowserDiagnostic = message => logConsole.warn(`[douyin.browser] ${message}`);
function record(diagnostic: BrowserDiagnostic, message: string): void {
  // Diagnostic failure must never interfere with logout or authorization.
  try { diagnostic(message); } catch {}
}

export async function clearDouyinBrowserData(browser: DouyinBrowser, diagnostic: BrowserDiagnostic = warn): Promise<void> {
  try {
    if (!browser.hasCapability('system.browser.siteData')) {
      record(diagnostic, 'siteData capability_missing');
      return;
    }
    const results = await browser.clearSiteData({ origins: DOUYIN_SITE_ORIGINS }).result;
    for (const result of results) {
      // Only known origins and statuses: never log cookies, names or host error messages.
      if (!DOUYIN_SITE_ORIGINS.some(origin => origin === result.origin)) continue;
      if (result.cookies.status === 'remaining' || result.cookies.status === 'failed')
        record(diagnostic, `siteData ${result.origin} cookies=${result.cookies.status}`);
      if (result.webStorage.status === 'failed')
        record(diagnostic, `siteData ${result.origin} webStorage=failed`);
    }
  } catch {
    record(diagnostic, 'siteData operation_failed');
  }
}

/** Older hosts retain B6 authorization behavior when the probe capability is absent. */
export async function douyinBrowserAvailable(browser: DouyinBrowser, diagnostic: BrowserDiagnostic = warn): Promise<boolean> {
  if (!browser.hasCapability('system.browser.availability')) {
    record(diagnostic, 'availability capability_missing');
    return true;
  }
  const result = await browser.availability().result;
  return result.status === 'available';
}
