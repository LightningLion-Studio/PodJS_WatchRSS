import { expect, test } from 'bun:test';
import { openBrowserUrl, readerBrowserOptions, usesInAppBrowser, type BrowserOrigin, type BrowserPort } from '../src/browser/open.ts';
import { defaultReaderPreset } from '../src/reader/preset.ts';
import type { BrowserOpenOptions } from '@podjs/framework/services';

function fixture(available = true, error?: Error) {
  const calls: { url: string; options?: BrowserOpenOptions }[] = [];
  const port: BrowserPort = {
    hasCapability: name => { expect(name).toBe('system.browser.inApp'); return available; },
    open: (url, options) => { calls.push({ url, options }); return { result: error ? Promise.reject(error) : Promise.resolve() }; },
  };
  return { calls, port };
}

test('native browser routing distinguishes article, players and external-only actions', async () => {
  const rows: [BrowserOrigin, string, boolean][] = [
    ['article', 'https://example.com/article', true], ['article', '/data/local/article.html', true],
    ['bili', 'https://www.bilibili.com/video/BV1', true], ['douyin', 'https://www.douyin.com/video/1', true],
    ['rss', 'HTTPS://example.com/video', true], ['rss', '/data/local/video.mp4', false],
    ['rss', 'file:///data/local/video.mp4', false], ['rss', 'content://media/1', false],
    ['information', 'https://qm.qq.com/q/example', false], ['phone-download', 'https://example.com/download', false],
  ];
  for (const [origin, url, inApp] of rows) {
    expect(usesInAppBrowser(origin, url)).toBe(inApp);
    const f = fixture();
    await openBrowserUrl(url, origin, defaultReaderPreset(), f.port);
    expect(f.calls).toEqual([{ url, options: inApp ? readerBrowserOptions(defaultReaderPreset()) : undefined }]);
  }
});

test('theme is current preset luminance and Android ARGB; native textZoom and font defaults are preserved', () => {
  const preset = defaultReaderPreset();
  preset.body.fontSizeSp = 64;
  preset.body.fontAssetId = 'custom-font';
  expect(readerBrowserOptions(preset)).toEqual({ mode: 'inApp', scaleMode: 'standard', theme: { dark: true, backgroundColor: '#ff000000' } });
  preset.background.type = 'VIDEO';
  preset.background.colorArgb = 0x80f8f3ec;
  expect(readerBrowserOptions(preset).theme).toEqual({ dark: false, backgroundColor: '#80f8f3ec' });
  preset.background.colorArgb = -16777216;
  expect(readerBrowserOptions(preset).theme?.backgroundColor).toBe('#ff000000');
  preset.background.colorArgb = 0xffbcbcbc;
  expect(readerBrowserOptions(preset).theme?.dark).toBe(false);
  preset.background.colorArgb = 0xffbbbbbb;
  expect(readerBrowserOptions(preset).theme?.dark).toBe(true);
});

test('missing capability falls back to the original one-argument browser API', async () => {
  for (const origin of ['article', 'bili', 'douyin', 'rss'] as const) {
    const f = fixture(false);
    await openBrowserUrl('https://example.com', origin, defaultReaderPreset(), f.port);
    expect(f.calls).toEqual([{ url: 'https://example.com', options: undefined }]);
  }
});

test('both embedded and fallback failures propagate unchanged without a second open', async () => {
  for (const available of [true, false]) for (const code of ['offline', 'webview_unavailable', 'busy', 'unsupported']) {
    const error = Object.assign(new Error('现有错误提示'), { code });
    const f = fixture(available, error);
    await expect(openBrowserUrl('https://example.com', 'article', defaultReaderPreset(), f.port)).rejects.toBe(error);
    expect(f.calls).toHaveLength(1);
  }
});

test('each open reads the supplied preset anew and resets scale to standard', async () => {
  const f = fixture(), preset = defaultReaderPreset();
  await openBrowserUrl('https://example.com', 'article', preset, f.port);
  preset.background.colorArgb = 0xffffffff;
  await openBrowserUrl('https://example.com', 'article', preset, f.port);
  expect(f.calls.map(call => call.options?.theme?.dark)).toEqual([true, false]);
  expect(f.calls.map(call => call.options?.scaleMode)).toEqual(['standard', 'standard']);
});


test('production framework host requests match the browser contract', async () => {
  const child = Bun.spawn([Bun.which('bun')!, 'test', `${import.meta.dir}/browser-open.isolated.ts`], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stdout + stderr).toBe(0);
});
