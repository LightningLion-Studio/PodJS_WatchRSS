import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from 'solid-js';
import type { BrowserAvailability } from '@podjs/framework/services';
import type { InternetStatus } from '../src/onboarding/state.ts';
import type { DouyinScreenProps } from '../src/ui/douyin/index.tsx';
const require = createRequire(import.meta.url), { transformSync } = require('@babel/core');
plugin({ name: 'douyin-login-solid', setup(builder) { builder.onLoad({ filter: /\/ui\/(douyin\/index|PlatformSettingsScreen|PlatformNotice|round-rows|AutoScrollSettingsScreen|DeleteConfirmDialog|DownloadPhoneAppDialog)\.tsx$/ }, async args => ({ contents: transformSync(await Bun.file(args.path).text(), { filename: args.path, babelrc: false, configFile: false, presets: [[require('babel-preset-solid'), { generate: 'universal', moduleName: '@pocketjs/framework/renderer' }], [require('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]] }).code, loader: 'js' })); } });
type Node = { kind: string; props: Record<string, any> };
function element(kind: string, props: Node['props']): Node { const rendered = Object.create(props); Object.defineProperty(rendered, 'children', { get: () => props.children }); return { kind, props: rendered }; }
let authOptions: any, finishAuth: (value: any) => void, rejectAuth: (error: any) => void;
let statusCapability = true;
let probe: () => Promise<BrowserAvailability>, capability = true, calls: string[] = [], network: (status: InternetStatus) => void;
mock.module('@pocketjs/framework/renderer', () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
mock.module('@pocketjs/framework/components', () => ({ FocusScope: (p: Node['props']) => element('FocusScope', p), View: (p: Node['props']) => element('View', p), Text: (p: Node['props']) => element('Text', p), Image: (p: Node['props']) => element('Image', p) }));
const realWatch = await import('@podjs/framework/watch');
mock.module('@podjs/framework/watch', () => ({ ...realWatch, hasCapability: (name: string) => name === 'system.browser.auth' || (name === 'system.browser.auth.status' ? statusCapability : capability) }));
const realServices = await import('@podjs/framework/services');
mock.module('@podjs/framework/services', () => ({ ...realServices, DOUYIN_AUTH_STATUS_SCRIPT: 'framework-status-script', browser: { availability: () => { calls.push('probe'); return { result: probe() }; } } }));
mock.module('../src/media/browser-auth.ts', () => ({ authorizeInBrowser: (options: any) => { authOptions = options; calls.push('authorize'); return { result: new Promise((resolve, reject) => { finishAuth = resolve; rejectAuth = reject; }), cancel: () => { calls.push('cancel'); } }; } }));
mock.module('../src/onboarding/network-host.ts', () => ({ observeHostInternet: (fn: typeof network) => { network = fn; fn('available'); return () => {}; } }));
mock.module('../src/ui/ScrollEntries.tsx', () => ({ ScrollEntries: (p: Node['props']) => element('ScrollEntries', { children: createMemo(() => p.entries.map((entry: any) => entry.render())) }) }));
for (const [path, name] of [['../src/ui/douyin/ImmersiveEntry.tsx', 'ImmersiveEntry'], ['../src/ui/RemoteImage.tsx', 'RemoteImage'], ['../src/ui/SafeQrScreen.tsx', 'SafeQrScreen'], ['../src/ui/ShareQrScreen.tsx', 'ShareQrScreen']] as const) mock.module(path, () => ({ [name]: () => null }));
let readerProps: any;
const realHost = await import('@pocketjs/framework/host');
mock.module('@pocketjs/framework/host', () => ({ ...realHost, getOps: () => ({ measureText: (text: string) => text.length * 12 }) }));
mock.module('../src/ui/RssScreens.tsx', () => ({
  RssFeedScreen: (p: any) => element('RssFeedScreen', { children: createMemo(() => p.items.map((a: any) => element('View', { onPress: () => p.onOpen(a), children: element('Text', { children: a.title }) }))) }),
  feedEmptyStateEntry: (title: string) => ({ height: 48, render: () => element('Text', { children: title }) }),
  feedPillEntry: (label: string, _width: number, onPress?: () => void) => ({ height: 52, render: () => element('View', { onPress, children: element('Text', { children: label }) }) }),
}));
mock.module('../src/ui/ReaderBody.tsx', () => ({ReaderBody: (p: any) => {readerProps=p;return element('ReaderBody',p);}}));
// Douyin detail renders through the shared reader-styled MediaReaderDetail (title row + blocks).
mock.module('../src/ui/MediaReaderDetail.tsx', () => ({MediaReaderDetail: (p: any) => {readerProps={...p,fontSize:p.preset.body.fontSizeSp,onMedia:()=>p.onPlay()};return element('MediaReaderDetail',p);}}));
const { DouyinScreen } = await import('../src/ui/douyin/index.tsx');
const stops: (() => void)[] = []; afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function nodes(value: any): Node[] { if (typeof value === 'function') return nodes(value()); if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || !('props' in value)) return []; return [value, ...nodes(value.props.children)]; }
function mount() {
  calls = []; capability = true; statusCapability = true;
  const root = createRoot(stop => { stops.push(stop); return DouyinScreen({ width: 233, height: 233, route: { name: 'login' }, client: {onAuthExpired:()=>()=>{},buildPlaybackHeaders:async()=>({"User-Agent":"SYNTHETIC-UA"})}, settings: {}, onBack() {}, onNavigate() {}, onPlay() {}, input: async () => null } as unknown as DouyinScreenProps); });
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
 const client={onAuthExpired:()=>()=>{},isLoggedIn:async()=>true,logout:async()=>{logout++;}};
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'settings'},client,onBack(){},onNavigate(){navigated++;},onLogoutSuccess(){returned++;},onPlay(){},settings:{originalContentEnabled:false,onOriginalContentChange(){},continuePlaybackInBackgroundEnabled:false,onContinuePlaybackInBackgroundChange(){},onDeleteChannel(){}},input:async()=>null} as unknown as DouyinScreenProps);});
 await settle();
 const exit=nodes(root).find(node=>node.kind==='View'&&node.props.onPress&&nodes(node.props.children).some(child=>child.kind==='Text'&&child.props.children==='退出登录'))!;
 await exit.props.onPress();await settle();
 expect({logout,returned,navigated}).toEqual({logout:1,returned:1,navigated:0});
});

const sample = (id: string) => ({ awemeId:id,description:`title ${id}`,authorName:'作者',authorId:'',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:0,variants:[] });
test('detail passes selected reader preset and offline metadata to the common reader without adding history on shared detail mounts', async () => {
  const {defaultReaderPreset}=await import('../src/reader/preset.ts');
  const preset=defaultReaderPreset('custom','自定义',false,23),item=sample('1'),playlist=[item,sample('2')];
  let request: any, destination: any;
  const client={onAuthExpired:()=>()=>{},resolvePlayback:async()=>({ok:true,data:item}),feedSnapshot:()=>({items:[sample('feed')],cursor:'feed-cursor',hasMore:true})};
  createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,preset,route:{name:'detail',awemeId:'1',item,playlist},client,onPlay:(value:any)=>request=value,onNavigate:(value:any)=>destination=value,settings:{}} as unknown as DouyinScreenProps);});
  await settle();expect(readerProps.preset).toBe(preset);expect(readerProps.fontSize).toBe(23);expect(readerProps.title).toBe('title 1');
  readerProps.onMedia({type:'video'});await settle();
  expect(request.playlist).toEqual([item]);expect(request.hasMore).toBe(false);expect(request.cursor).toBeUndefined();expect(destination).toEqual({name:'player',awemeId:'1'});
});
test('history row marks before navigation without passing a history playback queue', async () => {
  const history=[sample('3'),sample('2'),sample('1')].map(item=>({item,watchedAtMillis:1}));let destination:any;const writes:any[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'history'},client:{onAuthExpired:()=>()=>{},listHistory:async()=>history,recordHistory:async(item:any)=>{writes.push(item);await gate;}},onNavigate:(value:any)=>destination=value,settings:{}} as unknown as DouyinScreenProps);});
  await settle();const row=nodes(root).find(n=>n.props.onPress&&nodes(n).some(child=>child.kind==='Text'&&String(child.props.children).includes('title 2')))!;
  row.props.onPress();row.props.onPress();expect(writes).toEqual([sample('2')]);expect(destination).toBeUndefined();release();await settle();expect(destination.item).toEqual(sample('2'));expect(destination.playlist).toBeUndefined();
});

test('feed row marks watched even without playback before opening offline detail', async () => {
  let destination:any;const writes:any[]=[];
  const client={onAuthExpired:()=>()=>{},restorePlaybackQueue:async()=>({items:[]}),fetchFeedPage:async()=>({ok:true,data:{items:[sample('list')],hasMore:false}}),recordHistory:async(item:any)=>{expect(destination).toBeUndefined();writes.push(item);}};
  const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'feed'},client,onNavigate:(value:any)=>destination=value,settings:{originalContentEnabled:false}} as unknown as DouyinScreenProps);});
  await settle();const row=nodes(root).find(n=>n.props.onPress&&nodes(n).some(child=>child.kind==='Text'&&String(child.props.children).includes('title list')))!;
  row.props.onPress();await settle();expect(writes).toEqual([sample('list')]);expect(destination.item).toEqual(sample('list'));
});
test('saved detail metadata lookup does not create Douyin watched history on reader entry', async () => {
  let writes=0;
  const client={onAuthExpired:()=>()=>{},listHistory:async()=>[],listSaved:async()=>[{item:sample('saved')}],recordHistory:async()=>{writes++;}};
  createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:'saved'},client,settings:{}} as unknown as DouyinScreenProps);});
  await settle();expect(readerProps.title).toBe('title saved');expect(writes).toBe(0);
});


test('M4 renders PNG login and JPEG verification, clears QR and reports webpage state', async () => {
  probe = async () => ({status:'available'}); const f=mount(); await settle(); f.press(); await settle();
  expect(authOptions.qrExtractionScript).toBe('framework-status-script');
  expect(authOptions.completeOnLoginPanelHidden).toBe(true);
  expect(authOptions.qrWait).toEqual({message:'正在加载抖音登录二维码，需要 30~60 秒，请您耐心等待'});
  expect(authOptions.userAgent).toBe('SYNTHETIC-UA');
  const emit=authOptions.onStatus;
  emit({type:'qr',kind:'login',mime:'image/png',imageBase64:'AAAA'});
  expect(nodes(f.root).find(n=>n.kind==='Image')?.props.src).toBe('data:image/png;base64,AAAA');
  expect(f.text()).toContain('请使用抖音App扫码登录');
  emit({type:'qr',kind:'secondVerify',mime:'image/jpeg',imageBase64:'BBBB'});
  expect(nodes(f.root).find(n=>n.kind==='Image')?.props.src).toBe('data:image/jpeg;base64,BBBB');
  expect(f.text()).toContain('二步验证');
  emit({type:'qrCleared'}); expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  emit({type:'verifying',active:true}); expect(f.text().replaceAll('\n','')).toContain('请在网页中完成二步验证');
  emit({type:'verifying',active:false}); emit({type:'pageState',loading:true}); expect(f.text().replaceAll('\n','')).toContain('正在加载抖音登录页');
  emit({type:'pageState',loading:false,loginPanelVisible:true}); expect(f.text().replaceAll('\n','')).toContain('请在网页中选择登录或验证方式');
  emit({type:'pageState',loading:false,loginPanelVisible:false}); expect(f.text().replaceAll('\n','')).toContain('登录后点');
  emit({type:'cancelled'}); expect(f.text()).toContain('已取消登录');
  rejectAuth({code:'cancelled'}); await settle();
  emit({type:'qr',kind:'login',mime:'image/png',imageBase64:'AAAA'}); expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  expect(f.text()).toContain('输入 Cookie');
});
test('M4 old host retains legacy extraction with no onStatus', async () => {
  const {DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT}=await import('../src/media/douyin-login.ts');
  probe=async()=>({status:'available'}); const f=mount(); statusCapability=false; await settle(); f.press(); await settle();
  expect(authOptions.onStatus).toBeUndefined(); expect(authOptions.qrExtractionScript).toBe(DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT);
  expect(authOptions.requiredCookieNames).toEqual(['sessionid']);
});
for (const cause of ['network','dispose'] as const) test(`M4 ignores status after ${cause}`, async()=>{
  probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();const emit=authOptions.onStatus;
  if(cause==='network') network('bluetooth'); else stops.pop()!();
  const before=f.text();emit({type:'qr',kind:'secondVerify',mime:'image/jpeg',imageBase64:'AAAA'});
  expect(f.text()).toBe(before);expect(calls).toContain('cancel');
});


test('D2 verifying suppresses late login and second-step QR until verification ends', async()=>{
  probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();
  const emit=authOptions.onStatus;
  emit({type:'verifying',active:true});
  for(const kind of ['login','secondVerify'])emit({type:'qr',kind,mime:'image/png',imageBase64:'AAAA'});
  expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  expect(f.text().replaceAll('\n','')).toContain('请在网页中完成二步验证');
  emit({type:'verifying',active:false});
  emit({type:'qr',kind:'secondVerify',mime:'image/jpeg',imageBase64:'BBBB'});
  expect(nodes(f.root).find(n=>n.kind==='Image')?.props.src).toBe('data:image/jpeg;base64,BBBB');
});
test('D2 network ban cancels login, WiFi return allows fresh attempt and rejects old success',async()=>{
  probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();
  const oldFinish=finishAuth,oldEmit=authOptions.onStatus;
  network('bluetooth');expect(f.text().replaceAll('\n','')).toContain('当前为蓝牙网络');
  network('unavailable');expect(f.text().replaceAll('\n','')).toContain('未检测到可用互联网');
  network('checking');expect(f.text().replaceAll('\n','')).toContain('正在检测互联网');
  network('available');await settle();f.press();await settle();
  oldEmit({type:'qr',kind:'login',mime:'image/png',imageBase64:'OLD'});oldFinish({cookie:'sessionid=old'});await settle();
  expect(calls.filter(c=>c==='authorize')).toHaveLength(2);
  expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  rejectAuth({code:'cancelled'});await settle();
});
test('D2 failed authorization clears QR and can retry without exposing raw exception',async()=>{
  probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();
  const oldEmit=authOptions.onStatus;
  oldEmit({type:'qr',kind:'login',mime:'image/png',imageBase64:'AAAA'});
  rejectAuth(new Error('SECRET-cookie-input'));await settle();
  expect(f.text().replaceAll('\n','')).toContain('加载失败，请重试');expect(f.text()).not.toContain('SECRET');
  expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  f.press();await settle();oldEmit({type:'qr',kind:'login',mime:'image/png',imageBase64:'OLD'});
  expect(calls.filter(c=>c==='authorize')).toHaveLength(2);expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
});

test('D2 history detail initial refresh failure retains the native direct-URL fallback as a single item',async()=>{
 const item=sample('stored');let request:any;
 const client={onAuthExpired:()=>()=>{},resolvePlayback:async()=>({ok:false,code:'REQUEST_FAILED',message:'网络请求失败'})};
 createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:item.awemeId,item},client,onPlay:(value:any)=>request=value,onNavigate(){},settings:{}} as unknown as DouyinScreenProps);});
 await settle();readerProps.onMedia({type:'video'});await settle();
 expect(request).toMatchObject({playback:item,playlist:[item],hasMore:false,detailPlayback:true});
});
