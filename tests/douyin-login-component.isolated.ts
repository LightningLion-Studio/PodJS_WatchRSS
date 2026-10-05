import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from 'solid-js';
import type { BrowserAvailability } from '@podjs/framework/services';
import type { InternetStatus } from '../src/onboarding/state.ts';
import type { DouyinScreenProps } from '../src/ui/douyin/index.tsx';
const require = createRequire(import.meta.url), { transformSync } = require('@babel/core');
plugin({ name: 'douyin-login-solid', setup(builder) { builder.onLoad({ filter: /\/ui\/douyin\/index\.tsx$/ }, async args => ({ contents: transformSync(await Bun.file(args.path).text(), { filename: args.path, babelrc: false, configFile: false, presets: [[require('babel-preset-solid'), { generate: 'universal', moduleName: '@pocketjs/framework/renderer' }], [require('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]] }).code, loader: 'js' })); } });
type Node = { kind: string; props: Record<string, any> };
function element(kind: string, props: Node['props']): Node { const rendered = Object.create(props); Object.defineProperty(rendered, 'children', { value: props.children }); return { kind, props: rendered }; }
let probe: () => Promise<BrowserAvailability>, capability = true, calls: string[] = [], network: (status: InternetStatus) => void;
mock.module('@pocketjs/framework/renderer', () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
mock.module('@pocketjs/framework/components', () => ({ View: (p: Node['props']) => element('View', p), Text: (p: Node['props']) => element('Text', p), Image: (p: Node['props']) => element('Image', p) }));
mock.module('@podjs/framework/watch', () => ({ hasCapability: (name: string) => name === 'system.browser.auth' || capability }));
mock.module('@podjs/framework/services', () => ({ browser: { availability: () => { calls.push('probe'); return { result: probe() }; } } }));
mock.module('../src/media/browser-auth.ts', () => ({ authorizeInBrowser: () => { calls.push('authorize'); return { result: new Promise(() => {}), cancel: () => { calls.push('cancel'); } }; } }));
mock.module('../src/onboarding/network-host.ts', () => ({ observeHostInternet: (fn: typeof network) => { network = fn; fn('available'); return () => {}; } }));
mock.module('../src/ui/ScrollEntries.tsx', () => ({ ScrollEntries: (p: Node['props']) => element('ScrollEntries', { children: createMemo(() => p.entries.map((entry: any) => entry.render())) }) }));
for (const [path, name] of [['../src/ui/douyin/ImmersiveEntry.tsx', 'ImmersiveEntry'], ['../src/ui/RemoteImage.tsx', 'RemoteImage'], ['../src/ui/SafeQrScreen.tsx', 'SafeQrScreen'], ['../src/ui/ShareQrScreen.tsx', 'ShareQrScreen']] as const) mock.module(path, () => ({ [name]: () => null }));
const { DouyinScreen } = await import('../src/ui/douyin/index.tsx');
const stops: (() => void)[] = []; afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function nodes(value: any): Node[] { if (typeof value === 'function') return nodes(value()); if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || !('props' in value)) return []; return [value, ...nodes(value.props.children)]; }
function mount() {
  calls = []; capability = true;
  const root = createRoot(stop => { stops.push(stop); return DouyinScreen({ width: 233, height: 233, route: { name: 'login' }, client: {}, settings: {}, onBack() {}, onNavigate() {}, onPlay() {}, input: async () => null } as unknown as DouyinScreenProps); });
  return { root, press: () => nodes(root).find(n => n.kind === 'View' && n.props.focusable && n.props.onPress)!.props.onPress(), text: () => nodes(root).filter(n => n.kind === 'Text').map(n => n.props.children).join('\n') };
}
for (const status of ['no_provider', 'initialization_failed'] as const) test(`${status} renders B6 unavailable page without authorizing`, async () => {
  probe = async () => ({ status }); const f = mount(); await settle(); f.press(); await settle();
  expect(calls).toEqual(['probe']); expect(f.text()).toContain('无法打开登录页'); expect(f.text()).toContain('当前设备无法初始化 WebView');
});
test('authorization waits for probe and ignores repeat presses while busy', async () => {
  let finish!: (result: BrowserAvailability) => void; probe = () => new Promise(resolve => { finish = resolve; });
  const f = mount(); await settle(); const press = nodes(f.root).find(n => n.props.focusable && n.props.onPress)!.props.onPress;
  press(); press(); await settle(); expect(calls).toEqual(['probe']); finish({ status: 'available' }); await settle(); expect(calls).toEqual(['probe', 'authorize']);
});
for (const invalidation of ['dispose', 'network'] as const) test(`pending probe cannot authorize after ${invalidation}`, async () => {
  let finish!: (result: BrowserAvailability) => void; probe = () => new Promise(resolve => { finish = resolve; });
  const f = mount(); await settle(); f.press(); await settle();
  if (invalidation === 'dispose') stops.pop()!(); else { network('unavailable'); network('available'); }
  finish({ status: 'available' }); await settle(); expect(calls).toEqual(['probe']);
});
test('missing probe capability preserves B6 authorization', async () => {
  probe = async () => { throw Error('must not probe'); }; const f = mount(); capability = false; await settle(); f.press(); await settle(); expect(calls).toEqual(['authorize']);
});
test('probe errors reuse B6 unavailable handling', async () => {
  probe = async () => { throw { code: 'webview_unavailable' }; }; const f = mount(); await settle(); f.press(); await settle();
  expect(calls).toEqual(['probe']); expect(f.text()).toContain('无法打开登录页');
});
test('successful settings logout delegates clear-task navigation to the route owner',async()=>{
 let returned=0,navigated=0,logout=0;
 const client={isLoggedIn:async()=>true,logout:async()=>{logout++;}};
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'settings'},client,onBack(){},onNavigate(){navigated++;},onLogoutSuccess(){returned++;},onPlay(){},settings:{originalContentEnabled:false,onOriginalContentChange(){},continuePlaybackInBackgroundEnabled:false,onContinuePlaybackInBackgroundChange(){},onDeleteChannel(){}},input:async()=>null} as unknown as DouyinScreenProps);});
 await settle();
 const exit=nodes(root).find(node=>node.kind==='View'&&node.props.onPress&&nodes(node.props.children).some(child=>child.kind==='Text'&&child.props.children==='退出登录'))!;
 await exit.props.onPress();await settle();
 expect({logout,returned,navigated}).toEqual({logout:1,returned:1,navigated:0});
});
