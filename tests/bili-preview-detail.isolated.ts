import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from 'solid-js';
const require = createRequire(import.meta.url), { transformSync } = require('@babel/core');
plugin({ name: 'bili-preview-detail', setup(builder) {
  builder.onLoad({ filter: /\/ui\/bili\/index\.tsx$/ }, async args => ({ contents: transformSync(await Bun.file(args.path).text(), {
    filename: args.path, babelrc: false, configFile: false, presets: [[require('babel-preset-solid'), { generate: 'universal', moduleName: '@pocketjs/framework/renderer' }], [require('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]],
  }).code, loader: 'js' }));
} });
type Node = { props: any };
const element = (props: any): Node => ({ props });
mock.module('@pocketjs/framework/renderer', () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
mock.module('@pocketjs/framework/components', () => ({ View: element, Text: element, Image: element }));
mock.module('@pocketjs/framework/host', () => ({ getOps: () => ({ measureText: (text: string) => text.length * 7 }) }));
mock.module('@podjs/framework/watch', () => ({ kv: { get: () => undefined, set() {} } }));
mock.module('@podjs/framework/services', () => ({ delay: () => ({ result: Promise.resolve(), cancel() {} }), hostOperation: () => ({ result: Promise.resolve(), cancel() {} }) }));
mock.module('../src/ui/ScrollEntries.tsx', () => ({ ScrollEntries: (props: any) => element({ get children() { return props.entries.map((entry: any) => entry.render()); } }) }));
let rss: any;
mock.module('../src/ui/MediaReaderDetail.tsx', () => ({ MediaReaderDetail: (props: any) => { rss = props; return null; } }));
mock.module('../src/ui/ReaderBackground.tsx', () => ({ ReaderBackground: () => null, useReaderBackgrounds: () => () => undefined }));
for (const [path, name] of [
  ['bili/CommentScreen', 'CommentScreen'], ['bili/BiliSideMenu', 'BiliSideMenu'], ['RemoteImage', 'RemoteImage'], ['SwipeCard', 'SwipeCard'],
  ['SafeQrScreen', 'SafeQrScreen'], ['AutoScrollSettingsScreen', 'WatchSwitch'], ['DeleteConfirmDialog', 'DeleteConfirmDialog'],
  ['DownloadPhoneAppDialog', 'DownloadPhoneAppDialog'], ['WatchProgressIndicator', 'WatchProgressIndicator'], ['ShareQrScreen', 'ShareQrScreen'],
]) mock.module(`../src/ui/${path}.tsx`, () => ({ [name!]: () => null }));
const { BiliScreen } = await import('../src/ui/bili/index.tsx');
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function nodes(root: any): Node[] {
  if (typeof root === 'function') return nodes(root()); if (Array.isArray(root)) return root.flatMap(nodes);
  if (!root || typeof root !== 'object' || !root.props) return [];
  return [root, ...nodes(root.props.children)];
}
test('both native-mode and RSS-mode offline detail play buttons delegate resolution to the playback controller', async () => {
  for (const originalContentEnabled of [true, false]) {
    const navigated: any[] = [], errors: string[] = []; let resolutions = 0;
    const root = createRoot(stop => { stops.push(stop); return BiliScreen({
      width: 233, height: 233, route: { name: 'detail', aid: 7, bvid: 'BVfixture', cid: 19 },
      settings: { originalContentEnabled },
      client: { detail: async () => { throw Error('offline'); }, resolvePlayback: async () => { resolutions++; throw Error('should_resolve_in_controller'); } } as never,
      loadLocalDetail: async () => ({ item: { aid: 7, bvid: 'BVfixture', cid: 19, title: 'saved fixture' }, pages: [] }),
      onNavigate: route => navigated.push(route), onBack() {}, onError: value => errors.push(value),
    }); });
    await flush();
    if (originalContentEnabled) nodes(root).find(node => node.props.accessibilityLabel === '播放')!.props.onPress();
    else rss.onPlay();
    await flush();
    expect(navigated).toEqual([{ name: 'player', cid: 19, aid: 7, bvid: 'BVfixture', title: 'saved fixture' }]);
    expect(resolutions).toBe(0); expect(errors).toEqual([]);
    stops.pop()!();
  }
});
