import { expect, test } from 'bun:test';
const emitted: Array<{ id: number; method: string; args: Record<string, unknown> }> = [];
const events: unknown[] = [];
(globalThis as { pod?: unknown }).pod = {
  capabilities: () => JSON.stringify(['system.browser', 'system.browser.inApp']),
  emit: (line: string) => emitted.push(JSON.parse(line)),
  takeEvents: () => events.length ? JSON.stringify(events.splice(0)) : undefined,
};
const { __pumpPodEvents } = await import('@podjs/framework/watch');
const { openBrowserUrl } = await import('../src/browser/open.ts');
const { defaultReaderPreset } = await import('../src/reader/preset.ts');

test('production opener delivers native embedded and external host methods', async () => {
  for (const origin of ['article', 'bili', 'douyin', 'rss', 'phone-download', 'information'] as const) {
    const task = openBrowserUrl('https://example.com', origin, defaultReaderPreset());
    const call = emitted.at(-1)!;
    const embedded = !['phone-download', 'information'].includes(origin);
    expect(call.method).toBe(embedded ? 'browser.openInApp' : 'browser.open');
    expect(call.args).toEqual(embedded ? {
      url: 'https://example.com', mode: 'inApp', scaleMode: 'standard', theme: { dark: true, backgroundColor: '#ff000000' },
    } : { url: 'https://example.com' });
    events.push({ t: 'service.result', id: call.id, ok: true, value: null });
    __pumpPodEvents();
    await task;
  }
});
