import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, createSignal, mergeProps } from 'solid-js';
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
let readerProps: any, rssProps: any;
let detailStatus: () => { message?: string; retry?: () => void };
const realHost = await import('@pocketjs/framework/host');
mock.module('@pocketjs/framework/host', () => ({ ...realHost, getOps: () => ({ measureText: (text: string) => text.length * 12 }) }));
mock.module('../src/ui/RssScreens.tsx', () => ({
  RssFeedScreen: (p: any) => {rssProps=p;return element('RssFeedScreen', { children: createMemo(() => p.items.map((a: any) => element('View', { onPress: () => p.onOpen(a), children: element('Text', { children: a.title }) }))) });},
  feedEmptyStateEntry: (title: string) => ({ height: 48, render: () => element('Text', { children: title }) }),
  feedPillEntry: (label: string, _width: number, onPress?: () => void) => ({ height: 52, render: () => element('View', { onPress, children: element('Text', { children: label }) }) }),
}));
mock.module('../src/ui/ReaderBody.tsx', () => ({ReaderBody: (p: any) => {readerProps=p;return element('ReaderBody',p);}}));
// Douyin detail renders through the shared reader-styled MediaReaderDetail (title row + blocks).
mock.module('../src/ui/MediaReaderDetail.tsx', () => ({MediaReaderDetail: (p: any) => {detailStatus=()=>({message:p.message,retry:p.onRetry});readerProps={...p,fontSize:p.preset.body.fontSizeSp,onMedia:()=>p.onPlay()};return element('MediaReaderDetail',p);}}));
const { NetworkRecovery } = await import('../src/network/recovery.ts');
const { NetworkRecoveryContext } = await import('../src/network/context.ts');
const { DouyinScreen } = await import('../src/ui/douyin/index.tsx');
const stops: (() => void)[] = []; afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function nodes(value: any): Node[] { if (typeof value === 'function') return nodes(value()); if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || !('props' in value)) return []; return [value, ...nodes(value.props.children)]; }
function mount(scope?: InstanceType<typeof NetworkRecovery>) {
  calls = []; capability = true; statusCapability = true; network = () => {};
  const root = createRoot(stop => { stops.push(stop); const screen = () => DouyinScreen({ width: 233, height: 233, route: { name: 'login' }, client: {onAuthExpired:()=>()=>{},buildPlaybackHeaders:async()=>({"User-Agent":"SYNTHETIC-UA"})}, settings: {}, onBack() {}, onNavigate() {}, onPlay() {}, input: async () => null } as unknown as DouyinScreenProps); return scope ? createComponent(NetworkRecoveryContext.Provider, {value: scope, get children(){return screen();}}) : screen(); });
  return { root, press: () => nodes(root).find(n => n.kind === 'View' && n.props.focusable && n.props.onPress)!.props.onPress(), text: () => nodes(root).filter(n => n.kind === 'Text').map(n => n.props.children).join('\n') };
}
for (const status of ['no_provider', 'initialization_failed'] as const) test(`${status} renders B6 unavailable page without authorizing`, async () => {
  probe = async () => ({ status }); const f = mount(); await settle(); f.press(); await settle();
  expect(calls).toEqual(['probe']); expect(f.text()).toContain('输入 Cookie');expect(f.text()).toContain('无法打开登录页'); expect(f.text()).toContain('当前设备无法初始化 WebView');
});
test('authorization waits for probe and ignores repeat presses while busy', async () => {
  let finish!: (result: BrowserAvailability) => void; probe = () => new Promise(resolve => { finish = resolve; });
  const f = mount(); await settle(); const press = nodes(f.root).find(n => n.props.focusable && n.props.onPress)!.props.onPress;
  press(); press(); await settle(); expect(calls).toEqual(['probe']); finish({ status: 'available' }); await settle(); expect(calls).toEqual(['probe', 'authorize']);
});
for (const invalidation of ['dispose'] as const) test(`pending probe cannot authorize after ${invalidation}`, async () => {
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
  expect(calls).toEqual(['probe']); expect(f.text()).toContain('输入 Cookie');expect(f.text()).toContain('无法打开登录页');
});
test('successful settings logout delegates clear-task navigation to the route owner',async()=>{
 let returned=0,navigated=0,logout=0;
 const client={authState:()=> 'logged-in',subscribeAuth:()=>()=>{},onAuthExpired:()=>()=>{},isLoggedIn:async()=>true,logout:async()=>{logout++;}};
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
  const history=[sample('3'),sample('2'),sample('1')].map(item=>({item,watchedAtMillis:1}));let reads=0,destination:any;const writes:any[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'history'},client:{onAuthExpired:()=>()=>{},listHistory:async()=>{reads++;return history;},recordHistory:async(item:any)=>{writes.push(item);await gate;}},onNavigate:(value:any)=>destination=value,settings:{}} as unknown as DouyinScreenProps);});
  await settle();const row=nodes(root).find(n=>n.props.onPress&&nodes(n).some(child=>child.kind==='Text'&&String(child.props.children).includes('title 2')))!;
  row.props.onPress();row.props.onPress();expect(writes).toEqual([sample('2')]);expect(destination).toBeUndefined();release();await settle();expect(destination.item).toEqual(sample('2'));expect(destination.playlist).toBeUndefined();expect(reads).toBe(1);
});

test('feed row marks watched even without playback before opening offline detail', async () => {
  let destination:any;const writes:any[]=[];
  const client={authState:()=> 'logged-in',subscribeAuth:()=>()=>{},onAuthExpired:()=>()=>{},restorePlaybackQueue:async()=>({items:[]}),fetchFeedPage:async()=>({ok:true,data:{items:[sample('list')],hasMore:false}}),recordHistory:async(item:any)=>{expect(destination).toBeUndefined();writes.push(item);}};
  const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'feed'},client,onNavigate:(value:any)=>destination=value,settings:{originalContentEnabled:false}} as unknown as DouyinScreenProps);});
  await settle();const row=nodes(root).find(n=>n.props.onPress&&nodes(n).some(child=>child.kind==='Text'&&String(child.props.children).includes('title list')))!;
  row.props.onPress();await settle();expect(writes).toEqual([sample('list')]);expect(destination.item).toEqual(sample('list'));
});
test('saved detail metadata lookup does not create Douyin watched history on reader entry', async () => {
  let writes=0;
  const client={onAuthExpired:()=>()=>{},findLocalItem:async(id:string)=>id==='saved'?sample('saved'):undefined,recordHistory:async()=>{writes++;}};
  createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:'saved'},client,settings:{}} as unknown as DouyinScreenProps);});
  await settle();expect(readerProps.title).toBe('title saved');expect(writes).toBe(0);
});


test('M4 renders PNG login and JPEG verification, clears QR and reports webpage state', async () => {
  probe = async () => ({status:'available'}); const f=mount(); await settle(); f.press(); await settle();
  expect(authOptions.qrExtractionScript).toBe('framework-status-script');
  expect(authOptions.completeOnLoginPanelHidden).toBe(true);
  expect(authOptions.qrWait).toEqual({message:'正在加载抖音登录二维码，需要 30~60 秒，请您耐心等待'});
  expect(authOptions.userAgent).toBe((await import('../src/douyin/request-config.ts')).DOUYIN_USER_AGENT);
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
for (const cause of ['dispose'] as const) test(`M4 ignores status after ${cause}`, async()=>{
  probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();const emit=authOptions.onStatus;
  stops.pop()!();
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
test('D2 failed offline authorization retries once and rejects settled native status callbacks',async()=>{
  let status: InternetStatus = 'available';
  const scope = new NetworkRecovery({observe:fn=>{network=value=>{status=value;fn(value);};fn(status);return()=>{};},check:async()=>status});
  stops.push(()=>scope.dispose());
  probe=async()=>({status:'available'});const f=mount(scope);scope.setActive(true);await settle();f.press();await settle();
  const oldEmit=authOptions.onStatus;
  network('unavailable');expect(scope.blocking).toBe(false);
  rejectAuth({code:'network_error'});await settle();expect(scope.blocking).toBe(true);
  oldEmit({type:'qr',kind:'login',mime:'image/png',imageBase64:'OLD'});
  expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  network('bluetooth');await settle();expect(scope.blocking).toBe(false);
  expect(calls.filter(c=>c==='authorize')).toHaveLength(2);expect(calls).not.toContain('cancel');
  oldEmit({type:'qr',kind:'login',mime:'image/png',imageBase64:'OLD'});
  expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
  authOptions.onStatus({type:'qr',kind:'login',mime:'image/png',imageBase64:'NEW'});
  expect(nodes(f.root).find(n=>n.kind==='Image')?.props.src).toContain('NEW');
  rejectAuth({code:'network_error'});await settle();
  expect(calls.filter(c=>c==='authorize')).toHaveLength(2);expect(scope.blocking).toBe(false);
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
 const item={...sample('stored'),playUrl:'https://v3-dy-o.zjcdn.com/media.mp4'};let request:any;
 const client={onAuthExpired:()=>()=>{},resolvePlayback:async()=>({ok:false,code:'REQUEST_FAILED',message:'网络请求失败'})};
 createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:item.awemeId,item},client,onPlay:(value:any)=>request=value,onNavigate(){},settings:{}} as unknown as DouyinScreenProps);});
 await settle();readerProps.onMedia({type:'video'});await settle();
 expect(request).toMatchObject({playback:item,playlist:[item],hasMore:false,detailPlayback:true});
});

for (const code of ['browser_qr_timeout','browser_auth_timeout','browser_script_error','webview_renderer_gone','webview_http_403']) test(`DYLOGIN ${code} shows a closed reason and permits fresh retry`,async()=>{
 probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();
 expect(f.text().replaceAll('\n','')).toContain('正在加载抖音登录页');
 const oldEmit=authOptions.onStatus;
 rejectAuth({code,message:'SECRET sessionid=PRIVATE'});await settle();
 expect(f.text().replaceAll('\n','')).toContain('重试登录');expect(f.text()).not.toContain('SECRET');
 f.press();await settle();expect(calls.filter(c=>c==='authorize')).toHaveLength(2);
 oldEmit({type:'qr',kind:'login',mime:'image/png',imageBase64:'OLD'});
 expect(nodes(f.root).some(n=>n.kind==='Image')).toBe(false);
 rejectAuth({code:'cancelled'});await settle();
});
test('DYLOGIN opens official page without reading cookie or playback configuration',async()=>{
 probe=async()=>({status:'available'});let cookieReads=0;
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'login'},client:{onAuthExpired:()=>()=>{},buildPlaybackHeaders:()=>{cookieReads++;return new Promise(()=>{});}},settings:{},onBack(){},onNavigate(){},onPlay(){},input:async()=>null} as unknown as DouyinScreenProps);});
 calls=[];await settle();nodes(root).find(n=>n.props.focusable&&n.props.onPress)!.props.onPress();await settle();
 expect(calls).toEqual(['probe','authorize']);expect(cookieReads).toBe(0);
 rejectAuth({code:'cancelled'});await settle();
});

test('DYUI logout feedback precedes slow cleanup and its completion cannot dismiss a later login',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');
 let release!:()=>void;const blocked=new Promise<void>(r=>release=r),data=new Map([['douyin.cookie','fixture']]);
 const client=new DouyinClient({secureStorage:{get:async k=>data.get(k)??null,set:async(k,v)=>{data.set(k,v);},remove:async k=>{await blocked;data.delete(k);}},transport:{request:async()=>{throw Error('unused');}}});
 let returned=0,page='settings';const routes:any[]=[];
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'settings'},client,settings:{},onLogoutSuccess:()=>{returned++;page='home';},onNavigate:(r:unknown)=>routes.push(r)} as unknown as DouyinScreenProps);});
 await settle();const exit=nodes(root).find(n=>n.props.onPress&&nodes(n.props.children).some(c=>c.props.children==='退出登录'))!;
 exit.props.onPress();await settle();
 // Record before unblocking even on the broken baseline.
 const immediateReturns=returned;
 page='login';routes.push({name:'login'});release();await settle();await settle();
 console.log('DYUI_logout_navigation',JSON.stringify({immediateReturns,returned,page}));
 expect(immediateReturns).toBe(1);expect(returned).toBe(1);expect(page).toBe('login');expect(routes).toEqual([{name:'login'}]);
});

test('DYUI unknown settings state is non-actionable; logged-out login never calls logout',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');
 let finish!:(value:string|null)=>void;let logout=0;const routes:any[]=[];
 const client=new DouyinClient({secureStorage:{get:k=>k==='douyin.cookie'?new Promise(r=>finish=r):Promise.resolve(null),set:async()=>{},remove:async()=>{}},transport:{request:async()=>{throw Error('unused');}}});
 const original=client.logout.bind(client);client.logout=()=>{logout++;return original();};
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'settings'},client,settings:{},onNavigate:(r:unknown)=>routes.push(r)} as unknown as DouyinScreenProps);});
 await settle();const placeholder=nodes(root).find(n=>n.props.accessibilityLabel==='读取登录状态…')!;expect(placeholder.props.onPress).toBeUndefined();
 finish(null);await settle();const login=nodes(root).find(n=>n.props.accessibilityLabel==='登录')!;login.props.onPress();
 expect(routes).toEqual([{name:'login'}]);expect(logout).toBe(0);
});
test('DYUI retained logout handler cannot log out a state that changed to logged-out',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');let logout=0;
 const client=new DouyinClient({secureStorage:{get:async k=>k==='douyin.cookie'?'fixture':null,set:async()=>{},remove:async()=>{}},transport:{request:async()=>{throw Error('unused');}}});
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'settings'},client,settings:{}} as unknown as DouyinScreenProps);});
 await settle();const retained=nodes(root).find(n=>n.props.accessibilityLabel==='退出登录')!.props.onPress;
 await client.logout();client.logout=async()=>{logout++;};retained();await settle();expect(logout).toBe(0);
});
test('DYUI login requests native cookie completion and compact rendering',async()=>{
 probe=async()=>({status:'available'});const f=mount();await settle();f.press();await settle();
 expect(authOptions.completeOnRequiredCookies).toBe(true);expect(authOptions.lowMemory).toBe(true);
});

test('DYUI RSS unknown state renders a non-actionable placeholder and cannot refresh before authentication',async()=>{
 const {DouyinClient}=await import('../src/douyin/client.ts');let finish!:(value:string|null)=>void,requests=0;
 const client=new DouyinClient({secureStorage:{get:k=>k==='douyin.cookie'?new Promise(r=>finish=r):Promise.resolve(null),set:async()=>{},remove:async()=>{}},transport:{request:async()=>{requests++;throw Error('unexpected request');}}});
 createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'feed'},client,settings:{originalContentEnabled:false}} as unknown as DouyinScreenProps);});
 await settle();expect(rssProps.refreshing).toBe(false);expect(rssProps.canNext).toBe(false);expect(rssProps.items).toEqual([]);
 // 1eaaef44 prepends the persistent third-party platform notice to the feed leading row; the
 // auth placeholder moved to index 1 but keeps its meaning: right after the notice, non-actionable.
 expect(rssProps.leading).toHaveLength(2);
 const notice=rssProps.leading[0].render();expect(notice.kind).toBe('View');expect(String(notice.props.accessibilityLabel)).toContain('腕上RSS提供的第三方平台功能');
 const placeholder=rssProps.leading[1].render();expect(placeholder.props.children).toBe('读取登录状态…');expect(placeholder.props.onPress).toBeUndefined();
 rssProps.onRefresh();rssProps.onNext();expect(requests).toBe(0);finish(null);await settle();expect(client.authState()).toBe('logged-out');
 // Logged-out leading is exactly: notice, inert 未登录 text, actionable login pill.
 expect(rssProps.leading).toHaveLength(3);
 const [loggedOutNotice,loggedOutText,loginPill]=rssProps.leading.map((entry:any)=>entry.render());
 expect(loggedOutNotice.props.accessibilityLabel).toBe(notice.props.accessibilityLabel);
 expect(String(loggedOutText.props.children)).toContain('未登录');expect(loggedOutText.props.onPress).toBeUndefined();
 expect(loginPill.kind).toBe('View');expect(loginPill.props.children.props.children).toBe('登录');expect(typeof loginPill.props.onPress).toBe('function');
 rssProps.onRefresh();rssProps.onNext();expect(requests).toBe(0);
});

test('DYBENCH an older failed probe keeps its own attempt after a disposed page retry',async()=>{
 const before=(globalThis as any).pod,events:any[]=[];let seq=500,fail!:(e:unknown)=>void,ready!:(v:BrowserAvailability)=>void;
 (globalThis as any).pod={benchmark:(raw:string)=>{const value=JSON.parse(raw);if(!value.seq)value.seq=++seq;events.push(value);return value.seq;}};
 try{
  probe=()=>new Promise((_resolve,reject)=>fail=reject);const f=mount();await settle();f.press();await settle();const first=events.find(x=>x.code==='login_entry')!;
  stops.pop()!();probe=()=>new Promise(resolve=>ready=resolve);const fresh=mount();fresh.press();await settle();const entries=events.filter(x=>x.code==='login_entry');expect(entries).toHaveLength(2);
  fail(Error('synthetic old probe'));await settle();expect(events.filter(x=>x.code==='error').map(x=>x.seq)).toEqual([first.seq]);
  ready({status:'available'});await settle();expect(authOptions.benchmark).toEqual({seq:entries[1].seq,attempt:entries[1].attempt});
 }finally{(globalThis as any).pod=before;}
});

test('NETOVERLAY RSS-mode feed failure uses route recovery while optional share title does not',async()=>{
 let changed!:(status:InternetStatus)=>void,requests=0,checks=0;
 const scope=new NetworkRecovery({observe:fn=>{changed=fn;fn('unavailable');return()=>{};},check:async()=>{checks++;return 'unavailable';}});scope.setActive(true);
 const client={authState:()=> 'logged-in',subscribeAuth:()=>()=>{},onAuthExpired:()=>()=>{},restorePlaybackQueue:async()=>undefined,fetchFeedPage:async()=>++requests===1?{ok:false,code:'REQUEST_FAILED',message:'fixture',networkFailure:true}:{ok:true,data:{items:[sample('restored')],hasMore:false}},fetchDetail:async()=>({ok:false,code:'REQUEST_FAILED',message:'fixture',networkFailure:true})};
 const render=(route:any)=>createRoot(stop=>{stops.push(stop);return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){return DouyinScreen({width:233,height:233,route,client,settings:{},onNavigate(){},onBack(){},onPlay(){}} as unknown as DouyinScreenProps);}});});
 render({name:'feed'});await settle();expect(requests).toBe(1);expect(scope.blocking).toBe(true);
 changed('available');await settle();expect(requests).toBe(2);expect(scope.blocking).toBe(false);expect(rssProps.items[0].title).toContain('restored');
 stops.pop()!();changed('unavailable');const checked=checks;
 render({name:'share',awemeId:'fixture'});await settle();expect(scope.blocking).toBe(false);expect(checks).toBe(checked);scope.dispose();
});


test('Douyin detail offers a new read after the recovery layer returns a transport failure',async()=>{
 let reads=0;
 const client={
  onAuthExpired:()=>()=>{},findLocalItem:async()=>undefined,
  fetchDetail:async()=>{reads++;return {ok:false,code:'REQUEST_FAILED',message:'fixture detail failure',networkFailure:true};},
 };
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({
  width:233,height:233,route:{name:'detail',awemeId:'fixture'},client,settings:{},
  onNavigate(){},onBack(){},onPlay(){},
 } as unknown as DouyinScreenProps);});
 await settle();
 const text=()=>nodes(root).filter(node=>node.kind==='Text').map(node=>node.props.children).join('');
 expect(text()).toContain('fixture detail failure');
 expect(text()).not.toContain('加载中');
 const retry=nodes(root).find(node=>node.props.accessibilityLabel==='重试');
 expect(retry?.props.onPress).toBeFunction();
 retry!.props.onPress();await settle();
 expect(reads).toBe(2);
 expect(text()).toContain('fixture detail failure');
});

test('a slow detail play coalesces repeat taps and cannot navigate after leaving and returning',async()=>{
 const [active,setActive]=createSignal(true),item=sample('slow');let requests=0,opens=0,finish!:(value:any)=>void;
 const result=new Promise(resolve=>finish=resolve);
 const client={onAuthExpired:()=>()=>{},resolvePlayback:async()=>{requests++;return result;}};
 createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:item.awemeId,item},client,get active(){return active();},onPlay(){opens++;},onNavigate(){opens++;},settings:{}} as unknown as DouyinScreenProps);});
 await settle();readerProps.onMedia({type:'video'});readerProps.onMedia({type:'video'});
 setActive(false);setActive(true);finish({ok:true,data:item});await settle();
 expect([requests,opens]).toEqual([1,0]);
});
test('photo detail opens its image and shares its own title',async()=>{
 const note={kind:'note',awemeId:'photo',description:'相册标题',authorName:'作者',likeCount:5,imageUrls:['https://cdn.test/image.jpg']};
 const client={onAuthExpired:()=>()=>{},findLocalItem:async()=>undefined,fetchDetail:async()=>({ok:true,data:note}),getSavedState:async()=>({favorite:false,watchLater:false})};
 let image='',shared:any;
 createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'detail',awemeId:'photo'},client,onOpenImage:(url:string)=>image=url,onShare:(input:any)=>shared=input,settings:{}} as unknown as DouyinScreenProps);});
 await settle();expect(readerProps.title).toBe('相册标题');readerProps.onShare();readerProps.onImage?.(note.imageUrls[0]);
 expect([image,shared.title]).toEqual([note.imageUrls[0],'相册标题']);
});

test('RSS account changes during paging clear old visible and in-flight rows before the new page',async()=>{
 let version=1,status='logged-in',changed!:(value:string)=>void;
 const pages:Array<(value:any)=>void>=[];
 const client={authState:()=>status,playbackAuthorizationVersion:()=>version,subscribeAuth:(listener:typeof changed)=>{changed=listener;return ()=>{};},
  onAuthExpired:()=>()=>{},restorePlaybackQueue:async()=>({items:[]}),fetchFeedPage:()=>new Promise(resolve=>pages.push(resolve))};
 createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'feed'},client,settings:{originalContentEnabled:false}} as unknown as DouyinScreenProps);});
 const page=(id:string)=>({ok:true,data:{items:[sample(id)],nextCursor:id,hasMore:true}});
 await settle();pages[0]!(page('old'));await settle();rssProps.onNext();await settle();
 status='logged-out';version++;changed(status);status='logged-in';version++;changed(status);await settle();
 pages[1]!(page('late'));await settle();
 expect(rssProps.items.map((row:any)=>row.id)).toEqual([]);expect(pages).toHaveLength(3);
 pages[2]!(page('new'));await settle();expect(rssProps.items.map((row:any)=>row.id)).toEqual(['new']);
});
test('manual login persists only a verified cookie and keeps validation errors visible without a browser',async()=>{
 let verdict:'unknown'|'unauthenticated'|'authenticated'='unknown',saves=0,navigations=0;
 const client={onAuthExpired:()=>()=>{},verifyLoginCookie:async()=>verdict,applyCookie:async()=>{saves++;return {ok:true};}};
 probe=async()=>({status:'no_provider'});
 const root=createRoot(stop=>{stops.push(stop);return DouyinScreen({width:233,height:233,route:{name:'login'},client,settings:{},onNavigate(){navigations++;},input:async()=>'fixture credential'} as unknown as DouyinScreenProps);});
 await settle();nodes(root).find(n=>n.kind==='View'&&n.props.focusable&&n.props.onPress)!.props.onPress();await settle();
 const manual=()=>nodes(root).find(n=>n.kind==='View'&&n.props.onPress&&nodes(n.props.children).some(child=>child.kind==='Text'&&child.props.children==='输入 Cookie'))!.props.onPress();
 const content=()=>nodes(root).filter(n=>n.kind==='Text').map(n=>n.props.children).join('');
 manual();await settle();expect(saves).toBe(0);expect(content()).toContain('暂时无法验证 Cookie');
 verdict='unauthenticated';manual();await settle();expect(saves).toBe(0);expect(content()).toContain('Cookie 无效');
 verdict='authenticated';manual();await settle();expect([saves,navigations]).toEqual([1,1]);
});

for (const reason of ['expired', 'oversized', 'missing-source'] as const) test(`DYFAV ${reason} saved stream resolves the same awemeId through detail`, async () => {
  const item = { ...sample('123'), playUrl: reason === 'missing-source' ? '' : 'https://mock.invalid/stale?x-expires=1700000000' };
  if (reason === 'oversized') Object.assign(item, {
    playUrl: 'https://mock.invalid/1080p',
    variants: [{ playUrl: 'https://mock.invalid/1080p', width: 1080, height: 1920, codec: 'h264', bitrate: 500000 }],
  });
  const fresh = { ...sample('123'), playUrl: 'https://mock.invalid/fresh' };
  const calls: unknown[] = [], plays: any[] = [];
  const client = {
    onAuthExpired: () => () => {},
    findLocalItem: async () => item,
    resolvePlayback: async (id: string, options?: { forceRefresh?: boolean; allowDetail?: boolean }) => {
      calls.push([id, options]);
      return options?.forceRefresh && options.allowDetail
        ? { ok: true, data: fresh }
        : { ok: false, code: 'TEMPORARILY_UNAVAILABLE', message: '抖音暂时不可用，请稍后重试' };
    },
  };
  const root = createRoot(stop => {
    stops.push(stop);
    return DouyinScreen({
      width: 233, height: 233, route: { name: 'detail', awemeId: '123', savedPlayback: true },
      client, onPlay: (value: any) => plays.push(value), onNavigate() {}, settings: {},
    } as unknown as DouyinScreenProps);
  });
  await settle();
  nodes(root);
  readerProps.onMedia({ type: 'video' });
  await settle();
  expect(calls).toEqual([['123', { forceRefresh: true, allowDetail: true }]]);
  expect(plays).toMatchObject([{ playback: fresh, savedPlayback: true }]);
});

test('DYFAV detail failure exposes a reason and the retry button can open the same saved item', async () => {
  const item = { ...sample('321'), playUrl: '' };
  const fresh = { ...item, playUrl: 'https://mock.invalid/fresh' };
  const ids: string[] = [], plays: any[] = [];
  const client = {
    onAuthExpired: () => () => {},
    findLocalItem: async () => item,
    resolvePlayback: async (id: string) => {
      ids.push(id);
      return ids.length === 1 ? { ok: false, code: 'PARSE_FAILED', message: 'private fixture details' } : { ok: true, data: fresh };
    },
  };
  const root = createRoot(stop => {
    stops.push(stop);
    return DouyinScreen({
      width: 233, height: 233, route: { name: 'detail', awemeId: '321', savedPlayback: true },
      client, onPlay: (value: any) => plays.push(value), onNavigate() {}, settings: {},
    } as unknown as DouyinScreenProps);
  });
  await settle();
  nodes(root);
  readerProps.onMedia({ type: 'video' });
  await settle();
  expect(detailStatus().message).toBe('视频详情解析失败，请重试');
  expect(plays).toHaveLength(0);
  expect(detailStatus().retry).toBeFunction();
  detailStatus().retry?.();
  await settle();
  expect(ids).toEqual(['321', '321']);
  expect(plays).toMatchObject([{ playback: fresh, savedPlayback: true }]);
  nodes(root);
  readerProps.onMedia({ type: 'video' });
  await settle();
  expect(ids).toEqual(['321', '321']);
  expect(plays).toMatchObject([{ playback: fresh }, { playback: fresh }]);
});
