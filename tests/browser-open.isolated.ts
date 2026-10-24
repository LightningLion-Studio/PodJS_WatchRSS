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

test('default live-theme construction reads the real preset store, forwards changes and cancels its timer when dialog closes',async()=>{
 const pod=(globalThis as any).pod,store=new Map<string,string>();pod.kvGet=(key:string)=>store.get(key);pod.kvSet=(key:string,value:string)=>{store.set(key,value);return 0;};
 pod.capabilities=()=>JSON.stringify(['system.browser.inApp','system.browser.inApp.theme','runtime.timer']);
 const {ReaderPresetStore,activeReaderPreset}=await import('../src/reader/preset-store');const presets=new ReaderPresetStore();presets.ensureSeeded(true,18);
 const task=openBrowserUrl('https://example.com/live','article',activeReaderPreset(presets.load())),opened=emitted.at(-1)!;
 events.push({t:'service.result',id:opened.id,ok:true,value:null});__pumpPodEvents();await task;
 let theme=emitted.at(-1)!;expect(theme).toMatchObject({method:'browser.updateTheme',args:{theme:{dark:true}}});const timer=[...emitted].reverse().find(r=>r.method==='runtime.delay')!;expect(timer).toBeDefined();
 events.push({t:'service.result',id:theme.id,ok:true,value:{updated:true}});__pumpPodEvents();await Promise.resolve();
 presets.setThemeMode('LIGHT');await Promise.resolve();theme=emitted.at(-1)!;expect(theme).toMatchObject({method:'browser.updateTheme',args:{theme:{dark:false}}});
 events.push({t:'service.result',id:theme.id,ok:true,value:{updated:false}});__pumpPodEvents();await Promise.resolve();
 expect(emitted.at(-1)).toMatchObject({t:'service.cancel',id:timer.id});
});
