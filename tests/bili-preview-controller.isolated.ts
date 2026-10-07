import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, mergeProps } from 'solid-js';
import type { RouteEntry } from '../src/ui/routes/types.ts';
const require = createRequire(import.meta.url), { transformSync } = require('@babel/core');
plugin({ name: 'bili-preview-routes', setup(builder) {
  builder.onLoad({ filter: /\/ui\/routes\/media\.tsx$/ }, async args => ({ contents: transformSync(await Bun.file(args.path).text(), {
    filename: args.path, babelrc: false, configFile: false, presets: [
      [require('babel-preset-solid'), { generate: 'universal', moduleName: '@pocketjs/framework/renderer' }],
      [require('@babel/preset-typescript'), { isTSX: true, allExtensions: true }],
    ],
  }).code, loader: 'js' }));
} });
mock.module('@pocketjs/framework/renderer', () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
let player: any;
mock.module('../src/ui/VideoPlayerScreen.tsx', () => ({ VideoPlayerScreen: (props: any) => { player = props; return null; } }));
mock.module('../src/ui/bili/index.tsx', () => ({ BiliScreen: () => null }));
mock.module('../src/ui/douyin/index.tsx', () => ({ DouyinScreen: () => null }));
mock.module('../src/ui/PlatformNotice.tsx', () => ({ PendingDisclosure: () => null, PlayerPlatformNotice: () => null, playerNoticeHeight: () => 30 }));
const values = new Map<string, any>();
mock.module('@podjs/framework/watch', () => ({ kv: { get: (key: string) => values.get(key), set: (key: string, value: any) => values.set(key, value), delete: (key: string) => values.delete(key) }, lifecycle: () => 'active' }));
mock.module('@podjs/framework/services', () => ({ video: { captureBackdrop: async () => {}, stop: async () => {} }, videoSessions: {}, browserAuth: {}, hostOperation() {}, secureStorage: {} }));
mock.module('@pocketjs/framework/lifecycle', () => ({ onFrame() {} }));
mock.module('../src/cache/host.ts', () => ({ managedCache: {} }));
mock.module('../src/debug/douyin-host.ts', () => ({ douyinDebug: {} }));
let resolveRemote: () => Promise<any>, lookup: () => Promise<any>, reports = 0;
mock.module('../src/media-services.ts', () => ({
  biliClient: { detail:async()=>{throw Error('offline_detail');}, getSession: async () => ({ cookies: { SESSDATA: 'fixture' } }), resolvePlayback: () => resolveRemote(), reportHistory: async () => { reports++; } },
  biliPreviewCache: { lookup: () => lookup() }, douyinClient: {}, loadLocalBiliDetail: async () => undefined,
}));
const { createMediaRouteController } = await import('../src/ui/routes/media-controller.ts');
const { MediaRoutes } = await import('../src/ui/routes/media.tsx');
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); values.clear(); });
function fixture() {
  let entry: RouteEntry = { page: 'home' }, source: any;
  const errors: string[] = [];
  const controller = createRoot(stop => { stops.push(stop); return createMediaRouteController({
    services: {} as never, current: () => entry, motion: { phase: 'idle' }, busy: () => false,
    setBusy: () => false, setError: (value: string) => { errors.push(value); return value; }, settings: () => ({}),
    playingSource: () => source, setPlayingSource: (value: any) => source = value, channels: () => [], setChannels: (v: any) => v,
    setOriginalModes: (v: any) => v, setStack: (v: any) => v, popPage: () => false,
    setPage: (page: RouteEntry['page'], data?: Partial<RouteEntry>) => { entry = { page, ...data }; },
  } as never); });
  return { controller, errors, get entry() { return entry; }, navigate() { entry = { page: 'settings' }; }, render() {
    createRoot(stop => { stops.push(stop); return MediaRoutes({ entry, page: () => 'video', active: () => true,
      playingSource: () => source, setError: (value: string) => errors.push(value), douyinReady() {},
    } as never); });
    return player;
  } };
}
const route = { name: 'player' as const, aid: 7, bvid: 'BVfixture', cid: 19, title: 'fixture' };
const local = { path: 'managed-cache/bili-preview/' + 'a'.repeat(64) + '.mp4', cid: 19 };
const remote = { acceptQuality: [], acceptDescription: [], durl: [{ url: 'https://fixture.invalid/primary', backupUrl: ['https://fixture.invalid/backup'] }] };
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test('offline production controller opens checked local path without Cookie and leaves full-video resume intact', async () => {
  reports = 0; resolveRemote = async () => { throw Error('offline'); }; lookup = async () => local;
  const previous = JSON.stringify([{ aid: 7, bvid: route.bvid, cid: 19, positionMs: 3000000, durationMs: 3600000, updatedAt: 1 }]);
  values.set('watchrss.bili.playback-progress.v1', previous);
  const f = fixture(); await f.controller.biliNavigate(route);
  expect(f.entry.page).toBe('video'); expect(f.entry.playback).toMatchObject({ url: local.path, type: 'video/mp4', headers: {}, resumePositionMs: 0 });
  const props = f.render(); props.onProgress(1000, 1800000); props.onCheckpoint('ready', 1000, 1800000); props.onCheckpoint('ended', 1800000, 1800000); await flush();
  expect(values.get('watchrss.bili.playback-progress.v1')).toBe(previous); expect(reports).toBe(0); expect(f.errors.filter(Boolean)).toEqual([]);
});

test('production player failure callback advances backup, then local once, and clears all remote source fields', async () => {
  let resolutions = 0;
  resolveRemote = async () => { if (++resolutions > 1) throw Error('offline'); return remote; }; lookup = async () => local;
  const f = fixture(); await f.controller.biliNavigate(route);
  expect(f.entry.playback?.url).toBe(remote.durl[0].url);
  const props = f.render(); props.onPlaybackFailure(321); await flush();
  expect(f.entry.playback).toMatchObject({ url: remote.durl[0].backupUrl[0], resumePositionMs: 321 });
  props.onPlaybackFailure(321); await flush();
  expect(f.entry.playback).toMatchObject({ url: local.path, headers: {}, type: 'video/mp4', resumePositionMs: 0 });
  expect(f.entry.playback?.audioUrl).toBeUndefined(); expect(f.entry.playback?.videoUrl).toBeUndefined();
  props.onPlaybackFailure(0); await flush();
  expect(f.errors.filter(Boolean)).toHaveLength(1); expect(resolutions).toBe(2);
});

test('late offline preview lookup cannot navigate after the owning route changed', async () => {
  resolveRemote = async () => { throw Error('offline'); };
  let started!: () => void, release!: (value: any) => void;
  const waiting = new Promise<void>(yes => started = yes);
  lookup = () => { started(); return new Promise(yes => release = yes); };
  const f = fixture(), pending = f.controller.biliNavigate(route);
  await waiting; f.navigate(); release(local); await pending;
  expect(f.entry.page).toBe('settings'); expect(f.errors.filter(Boolean)).toEqual([]);
});


test('saved RSS video link without CID recovers the cached page when detail lookup is offline', async () => {
  resolveRemote = async () => { throw Error('offline'); }; lookup = async () => local;
  const f = fixture();
  await f.controller.openRssVideo({title:'saved',link:'https://www.bilibili.com/video/BVfixture'} as never,'https://www.bilibili.com/video/BVfixture');
  expect(f.entry.page).toBe('video'); expect(f.entry.playback?.url).toBe(local.path);
  expect(f.entry.videoTarget).toMatchObject({kind:'bili',cid:local.cid});
});
