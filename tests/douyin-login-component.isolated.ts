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
let readerProps: any;
mock.module('../src/ui/ReaderBody.tsx', () => ({ReaderBody: (p: any) => {readerProps=p;return element('ReaderBody',p);}}));
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

const sample = (id: string) => ({ awemeId:id,description:`title ${id}`,authorName:'作者',authorId:'',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:0,variants:[] });
test('detail passes selected reader preset and offline metadata to the common reader without adding history on shared detail mounts', async () => {
  const {defaultReaderPreset}=await import('../src/reader/preset.ts');
  const preset=defaultReaderPreset('custom','自定义',false,23),item=sample('1'),playlist=[item,sample('2')];
  let request: any, destination: any;
  const client={resolvePlayback:async()=>({ok:true,data:item}),feedSnapshot:()=>({items:[sample('feed')],cursor:'feed-cursor',hasMore:true})};
  createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,preset,route:{name:'detail',awemeId:'1',item,playlist},client,onPlay:(value:any)=>request=value,onNavigate:(value:any)=>destination=value,settings:{}} as unknown as DouyinScreenProps);});
  await settle();expect(readerProps.preset).toBe(preset);expect(readerProps.fontSize).toBe(23);expect(readerProps.blocks[0].text).toBe('title 1');
  readerProps.onMedia({type:'video'});await settle();
  expect(request.playlist).toEqual(playlist);expect(request.hasMore).toBe(false);expect(request.cursor).toBeUndefined();expect(destination).toEqual({name:'player',awemeId:'1'});
});
test('history row marks before navigation and retains the pre-write ordered queue', async () => {
  const history=[sample('3'),sample('2'),sample('1')].map(item=>({item,watchedAtMillis:1}));let destination:any;const writes:any[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'history'},client:{listHistory:async()=>history,recordHistory:async(item:any)=>{writes.push(item);await gate;}},onNavigate:(value:any)=>destination=value,settings:{}} as unknown as DouyinScreenProps);});
  await settle();const row=nodes(root).find(n=>n.props.onPress&&nodes(n).some(child=>child.kind==='Text'&&String(child.props.children).includes('title 2')))!;
  row.props.onPress();row.props.onPress();expect(writes).toEqual([sample('2')]);expect(destination).toBeUndefined();release();await settle();expect(destination.item).toEqual(sample('2'));expect(destination.playlist).toEqual(history.map(e=>e.item));
});

test('feed row marks watched even without playback before opening offline detail', async () => {
  let destination:any;const writes:any[]=[];
  const client={restorePlaybackQueue:async()=>({items:[]}),fetchFeedPage:async()=>({ok:true,data:{items:[sample('list')],hasMore:false}}),recordHistory:async(item:any)=>{expect(destination).toBeUndefined();writes.push(item);}};
  const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'feed'},client,onNavigate:(value:any)=>destination=value,settings:{originalContentEnabled:false}} as unknown as DouyinScreenProps);});
  await settle();const row=nodes(root).find(n=>n.props.onPress&&nodes(n).some(child=>child.kind==='Text'&&String(child.props.children).includes('title list')))!;
  row.props.onPress();await settle();expect(writes).toEqual([sample('list')]);expect(destination.item).toEqual(sample('list'));
});
test('saved detail metadata lookup does not create Douyin watched history on reader entry', async () => {
  let writes=0;
  const client={listHistory:async()=>[],listSaved:async()=>[{item:sample('saved')}],recordHistory:async()=>{writes++;}};
  createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:'saved'},client,settings:{}} as unknown as DouyinScreenProps);});
  await settle();expect(readerProps.blocks[0].text).toBe('title saved');expect(writes).toBe(0);
});
