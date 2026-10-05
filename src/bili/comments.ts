import { BiliError, type BiliComment, type BiliCommentPage, type BiliReplyPage } from './types.ts';
import type { BiliClient } from './client.ts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : undefined;
const str = (v: unknown) => typeof v === 'string' ? v : undefined;
const number = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : undefined;
const bool = (v: unknown) => typeof v === 'boolean' ? v : number(v) === undefined ? undefined : Number(v) !== 0;
const list = (v: unknown) => Array.isArray(v) ? v.flatMap(x => object(x) ? [object(x)!] : []) : [];
function map<T>(v: unknown, parse: (item: ObjectValue) => T): Record<string, T> | undefined {
  const value = object(v); return value ? Object.fromEntries(Object.entries(value).flatMap(([key, item]) => object(item) ? [[key, parse(object(item)!)]] : [])) : undefined;
}
export function parseComment(v: ObjectValue): BiliComment {
  const member = object(v.member), vip = object(member?.vip), content = object(v.content), control = object(v.reply_control);
  return {
    rpid: number(v.rpid), oid: number(v.oid), mid: number(v.mid), root: number(v.root), parent: number(v.parent),
    count: number(v.count), replyCount: number(v.rcount), like: number(v.like), ctime: number(v.ctime),
    member: member ? { mid: str(member.mid), name: str(member.uname), avatar: str(member.avatar), vip: vip ? { nicknameColor: str(vip.nickname_color) } : undefined } : undefined,
    content: content ? {
      message: str(content.message),
      emote: map(content.emote, e => ({ id: number(e.id), text: str(e.text), url: str(e.url), type: number(e.type), size: number(e.size) })),
      members: list(content.members).map(m => ({ mid: str(m.mid), name: str(m.uname) })),
      jumpUrl: map(content.jump_url, j => ({ title: str(j.title), state: number(j.state), prefixIcon: str(j.prefix_icon), clickable: bool(j.clickable) })),
      pictures: list(content.pictures).map(p => ({ url: str(p.img_src), width: number(p.img_width), height: number(p.img_height) })),
    } : undefined,
    replies: list(v.replies).map(parseComment),
    replyControl: control ? { upReply: bool(control.up_reply), isUpTop: bool(control.is_up_top), isNote: bool(control.is_note) } : undefined,
  };
}
function data(value: unknown) { const result = object(value); if (!result) throw new BiliError('api', 'empty_data', -1); return result; }
function cursor(value: unknown): BiliCommentPage['cursor'] { const c = object(value); return c ? { next: number(c.next), isEnd: bool(c.is_end), mode: number(c.mode) } : undefined; }
export function parseCommentPage(value: unknown): BiliCommentPage {
  const d = data(value); return { replies: list(d.replies).map(parseComment), topReplies: list(d.top_replies).map(parseComment), cursor: cursor(d.cursor), upperMid: number(object(d.upper)?.mid) };
}
export function parseReplyPage(value: unknown): BiliReplyPage {
  const d = data(value), root = object(d.root); return { replies: list(d.replies).map(parseComment), root: root ? parseComment(root) : undefined, cursor: cursor(d.cursor) };
}
export type CommentTarget = { oid: number; root?: number };
export interface CommentState {
  items: BiliComment[]; root?: BiliComment; loading: boolean; refreshing: boolean;
  error?: string; canLoadMore: boolean;
}
/** Commit cursor/root/items together. Failed appends retry the same page; refresh supersedes pending work. */
export class BiliComments {
  state: CommentState = { items: [], loading: false, refreshing: false, canLoadMore: true };
  private next: number;
  private generation = 0;
  private disposed = false;
  private loaded = new Set<number>();
  constructor(private client: Pick<BiliClient, 'comments' | 'replies'>, readonly target: CommentTarget, private changed: (state: CommentState) => void = () => {}) { this.next = this.first; }
  private get first() { return this.target.root === undefined ? 0 : 1; }
  private publish(update: Partial<CommentState>) { this.state = { ...this.state, ...update }; this.changed(this.state); }
  dispose() { this.disposed = true; this.generation++; }
  refresh = () => this.request(true);
  loadMore = () => this.request(false);
  retry = () => this.request(this.state.refreshing);
  private async request(reset: boolean) {
    if (this.disposed || !reset && (this.state.loading || !this.state.canLoadMore)) return;
    const generation = ++this.generation, page = reset ? this.first : this.next;
    this.publish({ loading: true, refreshing: reset, error: undefined });
    try {
      const reply = this.target.root !== undefined;
      const result = reply ? await this.client.replies({ oid: this.target.oid, root: this.target.root!, page }) : await this.client.comments({ oid: this.target.oid, next: page });
      if (this.disposed || generation !== this.generation) return;
      const incoming = !reply && page === 0 ? [...(result as BiliCommentPage).topReplies, ...result.replies] : result.replies;
      // Preserve pinned metadata when the same rpid also occurs in regular replies.
      const items = reset ? [] : [...this.state.items], seen = new Set(items.flatMap(c => c.rpid === undefined ? [] : [c.rpid]));
      for (const item of incoming) { if (item.rpid !== undefined && seen.has(item.rpid)) continue; items.push(item); if (item.rpid !== undefined) seen.add(item.rpid); }
      if (reset) this.loaded.clear(); this.loaded.add(page);
      const next = reply ? (result.replies.length ? page + 1 : undefined) : result.cursor?.isEnd === false ? result.cursor.next : undefined;
      this.next = next ?? page;
      this.publish({ items, root: reset ? (result as BiliReplyPage).root : this.state.root, loading: false, refreshing: false, canLoadMore: next !== undefined && !this.loaded.has(next) });
    } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) }); }
  }
}

export function commentCount(count?: number) { return count === undefined || count < 0 ? '--' : count < 10000 ? String(count) : count < 100000000 ? `${(count / 10000).toFixed(1)}万` : `${(count / 100000000).toFixed(1)}亿`; }
export function commentTime(timestamp?: number, now = Date.now()) {
  if (timestamp === undefined) return '';
  const diff = Math.floor(now / 1000) - timestamp;
  if (diff < 60) return '刚刚'; if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`; if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
  const date = new Date(timestamp * 1000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
