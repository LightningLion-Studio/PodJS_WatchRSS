import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from 'solid-js';
import { NetworkRecovery } from '../src/network/recovery.ts';
import { NetworkRecoveryContext } from '../src/network/context.ts';
const require = createRequire(import.meta.url), { transformSync } = require('@babel/core');
plugin({ name: 'bili-preview-detail', setup(builder) {
  builder.onLoad({ filter: /\/ui\/(?:bili\/index|MediaReaderDetail)\.tsx$/ }, async args => ({ contents: transformSync(await Bun.file(args.path).text(), {
    filename: args.path, babelrc: false, configFile: false, presets: [[require('babel-preset-solid'), { generate: 'universal', moduleName: '@pocketjs/framework/renderer' }], [require('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]],
  }).code, loader: 'js' }));
} });
type Node = { props: any };
const element = (props: any): Node => ({ props });
mock.module('@pocketjs/framework/renderer', () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
mock.module('@pocketjs/framework/components', () => ({ FocusScope: element, View: element, Text: element, Image: element }));
mock.module('@pocketjs/framework/host', () => ({ getOps: () => ({ measureText: (text: string) => text.length * 7 }) }));
mock.module('@podjs/framework/watch', () => ({ kv: { get: () => undefined, set() {} } }));
mock.module('@podjs/framework/services', () => ({ delay: () => ({ result: Promise.resolve(), cancel() {} }), hostOperation: () => ({ result: Promise.resolve(), cancel() {} }) }));
mock.module('../src/ui/ScrollEntries.tsx', () => ({ ScrollEntries: (props: any) => element({ get children() { return props.entries.map((entry: any) => entry.render()); } }) }));
let rss: any;
mock.module('../src/ui/ReaderBody.tsx', () => ({ReaderBody:(props:any)=>element({
  get children(){return props.footer?.map((row:any)=>row.render());},
})}));
mock.module('../src/ui/reader-fonts.ts', () => ({useReaderFonts:()=>()=>undefined}));
mock.module('../src/ui/ReaderTitleEntry.tsx', () => ({useReaderTitleEntry:()=>()=>({height:28,render:()=>null})}));
const {MediaReaderDetail}=await import('../src/ui/MediaReaderDetail.tsx');
mock.module('../src/ui/MediaReaderDetail.tsx', () => ({ MediaReaderDetail: (props: any) => {
  rss = props;
  return createComponent(MediaReaderDetail,props);
} }));
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


test('RSS-style Bili detail presents a retry after the first read fails', async () => {
  let reads=0;
  const root=createRoot(stop=>{
    stops.push(stop);
    return BiliScreen({
      width:233,height:233,route:{name:'detail',aid:7,cid:19},settings:{originalContentEnabled:false},
      client:{detail:async()=>{
        if(++reads===1)throw Object.assign(Error('fixture offline'),{code:'network_error'});
        return {item:{aid:7,cid:19,title:'recovered fixture'},pages:[]};
      },getSession:async()=>null} as never,
      onNavigate(){},onBack(){},
    });
  });
  await flush();
  expect(nodes(root).some(node=>String(node.props.children).includes('fixture offline'))).toBe(true);
  const retry=nodes(root).find(node=>node.props.accessibilityLabel==='重试');
  expect(retry?.props.onPress).toBeFunction();
  retry!.props.onPress();
  await flush();
  expect(reads).toBe(2);
  expect(rss.title).toBe('recovered fixture');
});

test('cached Bili RSS-style detail offers a page retry without blocking cached content',async()=>{
  let reads=0,checks=0,finishRead!:()=>void;
  const scope=new NetworkRecovery({
    observe:report=>{report('unavailable');return()=>{};},
    check:async()=>{checks++;return 'unavailable';},
  });
  scope.setActive(true);
  const cached={item:{aid:7,cid:19,title:'saved fixture'},pages:[]};
  const root=createRoot(stop=>{
    stops.push(()=>{stop();scope.dispose();});
    return createComponent(NetworkRecoveryContext.Provider,{value:scope,get children(){
      return createComponent(BiliScreen,{
        width:233,height:233,route:{name:'detail',aid:7,cid:19},settings:{originalContentEnabled:false},
        client:{getSession:async()=>null,detail:async()=>{
          if(++reads===1)throw Object.assign(Error('fixture offline'),{code:'network_error'});
          await new Promise<void>(resolve=>{finishRead=resolve;});
          return {...cached,item:{...cached.item,title:'updated fixture'}};
        }} as never,
        loadLocalDetail:async()=>cached,onNavigate(){},onBack(){},
      });
    }});
  });
  const label=(text:string)=>nodes(root).find(node=>node.props.accessibilityLabel===text);
  await flush();
  expect({title:rss.title,message:rss.message,blocking:scope.blocking,checks,reads}).toEqual({
    title:'saved fixture',message:'Error: fixture offline',blocking:false,checks:0,reads:1,
  });
  expect(label('收藏')).toBeDefined();
  expect(label('分享')).toBeDefined();
  const retry=label('重试');
  expect(retry?.props.onPress).toBeFunction();
  retry!.props.onPress();
  retry!.props.onPress();
  await flush();
  expect(reads).toBe(2);
  expect(rss.title).toBe('saved fixture');
  expect(label('重试')).toBeUndefined();
  finishRead();await flush();
  expect({title:rss.title,message:rss.message,blocking:scope.blocking,checks}).toEqual({
    title:'updated fixture',message:'',blocking:false,checks:0,
  });
});
