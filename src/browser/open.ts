import {followBrowserTheme} from './theme-follow';
import {ReaderPresetStore,activeReaderPreset,onReaderPresetsChanged} from '../reader/preset-store';
import { browser, delay, type BrowserOpenOptions } from '@podjs/framework/services';
import { hasCapability } from '@podjs/framework/watch';
import { readerChrome } from '../reader/chrome.ts';
import type { ReaderPreset } from '../reader/preset.ts';

export type BrowserOrigin = 'article' | 'bili' | 'douyin' | 'rss' | 'information' | 'phone-download';
export interface BrowserPort {
  hasCapability(name: string): boolean;
  open(url: string, options?: BrowserOpenOptions): { result: Promise<void> };
}
let stopThemeFollow: (()=>void)|undefined;
export function followCurrentReaderTheme():void {
  stopThemeFollow?.();
  if(!hasCapability('system.browser.inApp.theme'))return;
  const presets=new ReaderPresetStore();
  stopThemeFollow=followBrowserTheme({
    read:()=>readerBrowserOptions(activeReaderPreset(presets.load())).theme!,
    update:theme=>browser.updateTheme(theme).result,
    subscribe:onReaderPresetsChanged,
    schedule:listener=>{const timer=delay(60000-Date.now()%60000);let cancelled=false;void timer.result.then(()=>{if(!cancelled)listener();}).catch(()=>{});return()=>{cancelled=true;timer.cancel();};},
  });
}
const host: BrowserPort = { hasCapability, open: (url, options) => browser.open(url, options) };

export function usesInAppBrowser(origin: BrowserOrigin, url: string): boolean {
  // RssPlayerActivity alone sends non-HTTP links to ACTION_VIEW.
  return origin === 'article' || origin === 'bili' || origin === 'douyin' ||
    (origin === 'rss' && /^http/i.test(url));
}

export function readerBrowserOptions(preset: ReaderPreset, restoreActivity=false): BrowserOpenOptions {
  return {
    mode: 'inApp', scaleMode: 'standard',...(restoreActivity?{restoreActivity:true}:{}),
    theme: {
      dark: readerChrome(preset).dark,
      // Android wants AARRGGBB, not the renderer's RRGGBBAA color convention.
      backgroundColor: `#${(preset.background.colorArgb >>> 0).toString(16).padStart(8, '0')}`,
      // WebViewActivity does not set textZoom/fontFamily: preserve WebSettings defaults.
    },
  };
}

/** Callers retain their existing error presentation. Only missing capability falls back. */
export async function openBrowserUrl(url: string, origin: BrowserOrigin, preset?: ReaderPreset, port: BrowserPort = host): Promise<void> {
  if (usesInAppBrowser(origin, url) && port.hasCapability('system.browser.inApp')) {
    if (!url.trim()) return; // WebViewActivity.open ignores blank URLs.
    if (!preset) throw new Error('In-app browser requires the current reader preset');
    await port.open(url, readerBrowserOptions(preset,port.hasCapability('system.browser.inApp.state'))).result;
    if(port===host)followCurrentReaderTheme();
  } else {
    await port.open(url).result;
  }
}
