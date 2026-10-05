import { expect, test } from 'bun:test';
import { BiliClient } from '../../src/bili/client.ts';
import { BiliComments, commentCount, commentTime, parseCommentPage, parseReplyPage } from '../../src/bili/comments.ts';
import type { BiliCommentPage, BiliHttpRequest, BiliReplyPage } from '../../src/bili/types.ts';
import { commentRuns, layoutCommentRuns, vipColor } from '../../src/ui/bili/comment-layout.ts';
const page = (ids: number[], next?: number): BiliCommentPage => ({ replies: ids.map(rpid => ({ rpid })), topReplies: [], cursor: { next, isEnd: next === undefined } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => resolve = done); return { promise, resolve }; };
const unusedReplies = async (): Promise<BiliReplyPage> => { throw Error('unexpected replies'); };

test('native comment requests are anonymous, unsigned and server ordered; replies use pn/ps', async () => {
  const requests: BiliHttpRequest[] = [];
  const client = new BiliClient({ transport: { async request(r) { requests.push(r); return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ code: 0, data: {} })) }; } } });
  await client.comments({ oid: 17 }); await client.comments({ oid: 17, next: 31 }); await client.replies({ oid: 17, root: 123, page: 2 });
  expect(requests.map(r => new URL(r.url).pathname)).toEqual(['/x/v2/reply/main', '/x/v2/reply/main', '/x/v2/reply/reply']);
  expect(requests.map(r => Object.fromEntries(new URL(r.url).searchParams))).toEqual([{ type: '1', oid: '17', next: '0' }, { type: '1', oid: '17', next: '31' }, { type: '1', oid: '17', root: '123', pn: '2', ps: '20' }]);
  for (const request of requests) expect(request.headers.Cookie).toBeUndefined();
});
test('authenticated comments carry stored cookies without mutation or WBI lookup; -101 stays an error', async () => {
  let request!: BiliHttpRequest;
  const client = new BiliClient({ secureStore: { get: async () => JSON.stringify({ cookies: { SESSDATA: 'fixture' }, updatedAt: 0 }), set: async () => { throw Error('no write'); }, delete: async () => {} }, transport: { async request(r) { request = r; return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ code: -101, message: '账号未登录' })) }; } } });
  await expect(client.comments({ oid: 2 })).rejects.toMatchObject({ kind: 'auth', code: -101, message: '账号未登录' });
  expect(request.headers.Cookie).toBe('SESSDATA=fixture'); expect(request.url).toContain('/reply/main?');
});
test('parsing preserves pinned, VIP, mentions, emotes, links, images and nested metadata', () => {
  const raw = { rpid: '42', mid: '3', rcount: 8, reply_control: { is_up_top: true, up_reply: 1 }, member: { uname: 'UP', avatar: '//image/avatar', vip: { nickname_color: '#fb7299' } }, content: { message: '正文[笑] @某人 https://example.test', emote: { '[笑]': { id: 1, text: '笑', url: '//image/emote' }, broken: null }, members: [{ mid: '4', uname: '某人' }], jump_url: { 'https://example.test': { title: '链接', clickable: true } }, pictures: [{ img_src: 'https://image/pic', img_width: 900 }] }, replies: [null, { rpid: 43, content: { message: '子回复' } }] };
  const result = parseCommentPage({ top_replies: [raw], replies: [null, false], upper: { mid: '3' }, cursor: { next: '8', is_end: false, mode: 3 } });
  expect(result.topReplies[0]).toMatchObject({ rpid: 42, mid: 3, replyCount: 8, replyControl: { isUpTop: true, upReply: true }, member: { vip: { nicknameColor: '#fb7299' } }, content: { emote: { '[笑]': { id: 1 } }, members: [{ mid: '4', name: '某人' }], jumpUrl: { 'https://example.test': { title: '链接', clickable: true } }, pictures: [{ width: 900 }] }, replies: [{ rpid: 43 }] });
  expect(result.replies).toEqual([]); expect(result.cursor).toEqual({ next: 8, isEnd: false, mode: 3 }); expect(result.upperMid).toBe(3);
  expect(parseReplyPage({ root: raw }).root?.rpid).toBe(42);
});
test('missing API data is an error; nullable lists are empty', () => {
  for (const value of [null, undefined, [], 0]) { expect(() => parseCommentPage(value)).toThrow('empty_data'); expect(() => parseReplyPage(value)).toThrow('empty_data'); }
  expect(parseCommentPage({ replies: null, top_replies: null }).replies).toEqual([]);
});
test('pinned first page is retained once and append failure retries exact cursor', async () => {
  const calls: number[] = []; let fail = true;
  const pager = new BiliComments({ replies: unusedReplies, comments: async ({ next }) => { calls.push(next!); if (next === 0) return { ...page([1, 2], 9), topReplies: [{ rpid: 1, replyControl: { isUpTop: true } }] }; if (fail) { fail = false; throw Error('offline'); } return page([2, 3]); } }, { oid: 2 });
  await pager.refresh(); expect(pager.state.items.map(c => c.rpid)).toEqual([1, 2]); expect(pager.state.items[0]?.replyControl?.isUpTop).toBe(true);
  await pager.loadMore(); expect(pager.state.error).toBe('offline'); expect(pager.state.items).toHaveLength(2);
  await pager.retry(); expect(calls).toEqual([0, 9, 9]); expect(pager.state.items.map(c => c.rpid)).toEqual([1, 2, 3]); expect(pager.state.canLoadMore).toBe(false);
});
test('missing cursor stops and a repeated cursor cannot cause auto-page loops', async () => {
  for (const cursor of [undefined, { next: 0, isEnd: false }, { next: 2 }, { isEnd: false }]) {
    let calls = 0; const pager = new BiliComments({ replies: unusedReplies, comments: async () => { calls++; return { ...page([1]), cursor }; } }, { oid: 2 });
    await pager.refresh(); await pager.loadMore(); expect(calls).toBe(1); expect(pager.state.canLoadMore).toBe(false);
  }
});
test('replies preserve root, use page numbers and stop only on an empty page like native', async () => {
  const calls: number[] = [];
  const pager = new BiliComments({ comments: async () => page([]), replies: async ({ page: pn }) => { calls.push(pn!); return { root: { rpid: pn === 1 ? 99 : 88 }, replies: pn! < 3 ? [{ rpid: pn }] : [], cursor: { isEnd: true } }; } }, { oid: 2, root: 99 });
  await pager.refresh(); await pager.loadMore(); await pager.loadMore(); await pager.loadMore();
  expect(calls).toEqual([1, 2, 3]); expect(pager.state.root?.rpid).toBe(99); expect(pager.state.items.map(c => c.rpid)).toEqual([1, 2]); expect(pager.state.canLoadMore).toBe(false);
});
test('refresh replaces old items/root and supersedes pending append; duplicate loadMore ignored', async () => {
  const pending = deferred<BiliReplyPage>(); let calls = 0;
  const pager = new BiliComments({ comments: async () => page([]), replies: async ({ page: pn }) => { calls++; return pn === 2 ? pending.promise : { root: { rpid: calls }, replies: [{ rpid: calls }] }; } }, { oid: 2, root: 99 });
  await pager.refresh(); const append = pager.loadMore(); await pager.loadMore(); await pager.refresh();
  pending.resolve({ root: { rpid: 100 }, replies: [{ rpid: 100 }] }); await append;
  expect(calls).toBe(3); expect(pager.state.root?.rpid).toBe(3); expect(pager.state.items.map(c => c.rpid)).toEqual([3]);
});
test('failed refresh retries first page and disposal ignores late responses', async () => {
  let fail = false; const calls: number[] = [];
  const pager = new BiliComments({ replies: unusedReplies, comments: async ({ next }) => { calls.push(next!); if (fail) { fail = false; throw Error('network'); } return page([1], 10); } }, { oid: 2 });
  await pager.refresh(); fail = true; await pager.refresh(); await pager.retry(); expect(calls).toEqual([0, 0, 0]);
  const pending = deferred<BiliCommentPage>(); let published = 0;
  const dead = new BiliComments({ replies: unusedReplies, comments: () => pending.promise }, { oid: 2 }, () => published++);
  const loading = dead.refresh(); dead.dispose(); pending.resolve(page([8])); await loading; await dead.refresh(); expect(published).toBe(1); expect(dead.state.items).toEqual([]);
});
test('rich content consumes adjacent mentions/emotes without duplication and leaves links literal', () => {
  const runs = commentRuns({ message: '@人[笑][笑] https://example.test 尾😀', emote: { '[笑]': { url: 'image', text: '[笑]' } }, jumpUrl: { 'https://example.test': { title: '不替换' } } });
  expect(runs.map(r => r.text).join('')).toBe('@人[笑][笑] https://example.test 尾😀'); expect(runs.filter(r => r.emote)).toHaveLength(2); expect(runs[0]?.color).toBe('#00a1d6'); expect(runs.at(-1)?.color).toBeUndefined();
});
test('layout preserves entire long body/newlines, wraps inline image at full 20px width', () => {
  const text = '这是长正文'.repeat(40) + '\n尾😀'; const layout = layoutCommentRuns(commentRuns({ message: text }), 80, s => Array.from(s).length * 10);
  expect(layout.height).toBeGreaterThan(6 * 21); expect(layout.fragments.map(r => r.text).join('')).toBe(text.replace('\n', ''));
  const mixed = layoutCommentRuns(commentRuns({ message: 'abc[笑]尾', emote: { '[笑]': { url: 'img' } } }), 40, s => s.length * 10);
  expect(mixed.fragments.find(r => r.emote)).toMatchObject({ x: 0, y: 21, width: 20 });
});
test('native counts/time and Android VIP colors', () => {
  expect([commentCount(), commentCount(-1), commentCount(9999), commentCount(10000), commentCount(100000000)]).toEqual(['--', '--', '9999', '1.0万', '1.0亿']);
  const now = 2000000000 * 1000;
  expect([0, 61, 3601, 86401].map(diff => commentTime(now / 1000 - diff, now))).toEqual(['刚刚', '1分钟前', '1小时前', '1天前']);
  expect(commentTime()).toBe(''); expect(commentTime(0, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(vipColor('#fffb7299')).toBe('#fb7299ff'); expect(vipColor('invalid')).toBe('#f5f5f5');
});
