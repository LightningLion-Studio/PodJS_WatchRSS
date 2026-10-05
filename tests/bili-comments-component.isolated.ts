import { afterEach, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import { createRequire } from 'node:module';
import { createComponent, createMemo, createRenderEffect, createRoot, createSignal, mergeProps } from 'solid-js';
import type { BiliScreenProps, BiliRoute } from '../src/ui/bili/index.tsx';
const require = createRequire(import.meta.url), { transformSync } = require('@babel/core');
plugin({ name: 'bili-comments-solid', setup(builder) { builder.onLoad({ filter: /\/ui\/bili\/CommentScreen\.tsx$/ }, async args => ({ contents: transformSync(await Bun.file(args.path).text(), { filename: args.path, babelrc: false, configFile: false, presets: [[require('babel-preset-solid'), { generate: 'universal', moduleName: '@pocketjs/framework/renderer' }], [require('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]] }).code, loader: 'js' })); } });
type Node = { kind: string; props: Record<string, any> };
function element(kind: string, props: Node['props']): Node { const rendered = Object.create(props); Object.defineProperty(rendered, 'children', { get: createMemo(() => props.children) }); return { kind, props: rendered }; }
mock.module('@pocketjs/framework/renderer', () => ({ createComponent, mergeProps, memo: createMemo, effect: createRenderEffect }));
mock.module('@pocketjs/framework/components', () => ({ View: (p: Node['props']) => element('View', p), Text: (p: Node['props']) => element('Text', p), Image: (p: Node['props']) => element('Image', p) }));
mock.module('@pocketjs/framework/host', () => ({ getOps: () => ({ measureText: (s: string, slot: number) => Array.from(s).length * (slot === 22 ? 17 : slot === 8 ? 14 : 12) }) }));
mock.module('@pocketjs/framework/gesture', () => ({ createGesture: () => {} }));
mock.module('@pocketjs/framework/kinetics', () => ({ createScroller: () => ({ offset: () => 0, step() {}, stop() {} }) }));
mock.module('@pocketjs/framework/lifecycle', () => ({ onFrame: () => {} }));
mock.module('../src/ui/RemoteImage.tsx', () => ({ RemoteImage: (p: Node['props']) => element('RemoteImage', p) }));
mock.module('../src/ui/WatchProgressIndicator.tsx', () => ({ WatchProgressIndicator: (p: Node['props']) => element('Progress', p) }));
let scroll: any;
mock.module('../src/ui/ScrollEntries.tsx', () => ({ ScrollEntries: (p: Node['props']) => { scroll = p; return element('ScrollEntries', { children: createMemo(() => p.entries.map((entry: any) => entry.render())) }); } }));
const { CommentScreen } = await import('../src/ui/bili/CommentScreen.tsx');
const stops: (() => void)[] = []; afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function nodes(value: any): Node[] { if (typeof value === 'function') return nodes(value()); if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || !('props' in value)) return []; return [value, ...nodes(value.props.children)]; }
const text = (root: any) => nodes(root).filter(n => n.kind === 'Text').map(n => n.props.children).join('\n');
function mount(client: any, initial: BiliRoute = { name: 'comments', oid: 7, uploaderMid: 2 }) {
  const [route, setRoute] = createSignal(initial); let destination: BiliRoute | undefined, back = 0;
  const root = createRoot(stop => { stops.push(stop); return CommentScreen({ width: 233, height: 233, get route() { return route(); }, client, onNavigate: r => destination = r, onBack: () => back++ } as Parameters<typeof CommentScreen>[0]); });
  return { root, setRoute, destination: () => destination, back: () => back };
}
const sample = { rpid: 11, root: 999, mid: 2, replyCount: 5, like: 10000, ctime: Math.floor(Date.now() / 1000), replyControl: { isUpTop: true }, member: { name: '作者', avatar: '//image/avatar', vip: { nicknameColor: '#fb7299' } }, content: { message: '完整正文'.repeat(40) + ' @人[笑] https://example.test', emote: { '[笑]': { url: '//image/emote' } }, pictures: [{ url: '//image/pic1' }, { url: '//image/pic2' }] }, replies: [1, 2, 3, 4].map(rpid => ({ rpid, member: { name: `子${rpid}` }, content: { message: '预览' } })) };
test('full card shows native metadata, images and three previews; rpid is the reply target', async () => {
  const f = mount({ comments: async () => ({ topReplies: [sample], replies: [], cursor: { isEnd: true } }) }); await settle();
  const copy = text(f.root); for (const label of ['UP', '置顶', '刚刚', '1.0万', '5条回复', '子1:', '子3:']) expect(copy).toContain(label); expect(copy).not.toContain('子4:');
  expect(copy.replace(/\n/g, '')).toContain('完整正文'.repeat(40));
  const images = nodes(f.root).filter(n => n.kind === 'RemoteImage'); expect(images.map(n => n.props.url)).toEqual(['https://image/avatar', 'https://image/emote', 'https://image/pic1', 'https://image/pic2']);
  expect(images[0]?.props.width).toBe(36); expect(images[0]?.props.fit).toBe('cover'); expect(images[1]?.props.width).toBe(20);
  expect(nodes(f.root).find(n => n.kind === 'Text' && n.props.children === '作者')?.props.style.textColor).toBe('#fb7299');
  const card = nodes(f.root).find(n => n.props.accessibilityRole === 'button')!; card.props.onPress(); expect(f.destination()).toEqual({ name: 'replies', oid: 7, root: 11, uploaderMid: 2 });
  nodes(f.root).find(n => n.props.accessibilityLabel === '返回')!.props.onPress(); expect(f.back()).toBe(1);
});
test('reply detail renders root and all-replies header, page two, then stops on empty', async () => {
  const pages: number[] = [];
  const f = mount({ replies: async ({ page }: any) => { pages.push(page); return { root: sample, replies: page < 3 ? [{ rpid: page, content: { message: `回复${page}` } }] : [] }; } }, { name: 'replies', oid: 7, root: 11, uploaderMid: 2 }); await settle();
  expect(text(f.root)).toContain('所有回复'); expect(text(f.root)).toContain('回复1'); expect(nodes(f.root).filter(n => n.props.accessibilityRole === 'button')).toHaveLength(0);
  scroll.onSettledRange(0, scroll.entries.length - 1); await settle(); expect(text(f.root)).toContain('回复2');
  scroll.onSettledRange(0, scroll.entries.length - 1); await settle(); expect(pages).toEqual([1, 2, 3]); expect(text(f.root)).not.toContain('加载更多');
});
test('empty comments show both native labels; empty replies stay blank', async () => {
  const f = mount({ comments: async () => ({ replies: [], topReplies: [] }), replies: async () => ({ replies: [] }) }); await settle();
  expect(text(f.root)).toContain('暂无评论'); expect(text(f.root)).toContain('快来发表第一条评论吧');
  f.setRoute({ name: 'replies', oid: 7, root: 11 }); await settle(); expect(text(f.root)).toBe('回复详情');
});
test('loading spinner and first-load auth error allow retry without a login gate', async () => {
  let finish!: () => void, calls = 0;
  const f = mount({ comments: async () => { calls++; if (calls === 1) { await new Promise<void>(done => finish = done); throw Error('账号未登录'); } return { replies: [], topReplies: [] }; } }); await settle();
  expect(nodes(f.root).find(n => n.kind === 'Progress')?.props.size).toBe(32); finish(); await settle(); expect(text(f.root)).toContain('加载失败:'); expect(text(f.root).replace(/\n/g, '')).toContain('账号未登录');
  const retry = nodes(f.root).find(n => n.props.onPress && text(n).replace(/\n/g, '').includes('加载失败:'))!; retry.props.onPress(); await settle(); expect(calls).toBe(2); expect(text(f.root)).toContain('暂无评论');
});
test('append errors keep existing comments and retry the failed cursor', async () => {
  const calls: number[] = []; let fail = true;
  const f = mount({ comments: async ({ next }: any) => { calls.push(next); if (next && fail) { fail = false; throw Error('断网'); } return { topReplies: [], replies: [{ rpid: next + 1, content: { message: next ? '第二页' : '第一页' } }], cursor: { next: 7, isEnd: !!next } }; } }); await settle();
  scroll.onSettledRange(0, scroll.entries.length - 1); await settle(); expect(text(f.root)).toContain('第一页'); expect(text(f.root)).toContain('加载失败:');
  nodes(f.root).find(n => n.props.onPress && text(n).includes('加载失败:'))!.props.onPress(); await settle(); expect(calls).toEqual([0, 7, 7]); expect(text(f.root)).toContain('第二页');
});
test('pull refresh starts first page again and removes old items', async () => {
  let calls = 0;
  const f = mount({ comments: async ({ next }: any) => { expect(next).toBe(0); calls++; return { replies: [{ rpid: calls, content: { message: calls === 1 ? '旧评论' : '新评论' } }], topReplies: [] }; } }); await settle(); scroll.onRefresh(); await settle();
  expect(text(f.root)).toContain('新评论'); expect(text(f.root)).not.toContain('旧评论');
});
test('route changes invalidate a pending comment response', async () => {
  let finish!: (value: any) => void;
  const f = mount({ comments: () => new Promise(done => finish = done), replies: async () => ({ root: { rpid: 4, content: { message: '新根评论' } }, replies: [] }) }); await settle();
  f.setRoute({ name: 'replies', oid: 8, root: 4 }); await settle(); finish({ replies: [{ content: { message: '旧响应' } }], topReplies: [] }); await settle();
  expect(text(f.root)).toContain('新根评论'); expect(text(f.root)).not.toContain('旧响应');
});
