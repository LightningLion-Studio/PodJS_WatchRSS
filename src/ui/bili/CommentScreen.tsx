import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Image, Text, View, type NodeMirror } from '@pocketjs/framework/components';
import { getOps } from '@pocketjs/framework/host';
import { createGesture } from '@pocketjs/framework/gesture';
import { createScroller, type Scroller } from '@pocketjs/framework/kinetics';
import { onFrame } from '@pocketjs/framework/lifecycle';
import { BiliComments, commentCount, commentTime, type CommentState } from '../../bili/comments.ts';
import type { BiliComment } from '../../bili/types.ts';
import { layoutText } from '../../reader/index.ts';
import { ScrollEntries, type ScrollEntry } from '../ScrollEntries.tsx';
import { RemoteImage } from '../RemoteImage.tsx';
import { WatchProgressIndicator } from '../WatchProgressIndicator.tsx';
import { commentRuns, layoutCommentRuns, vipColor } from './comment-layout.ts';
import type { BiliRoute, BiliScreenProps } from './index.tsx';

const measure = (text: string, slot: number) => getOps().measureText(text, slot);
const wrap = (text: string, width: number, slot: number) => layoutText(text, { width: Math.max(1, width), measure: s => measure(s, slot) });
const remoteUrl = (url: string) => url.replace(/^\/\//, 'https://');
function PictureStrip(props: { pictures: NonNullable<NonNullable<BiliComment['content']>['pictures']>; width: number }) {
  let node: NodeMirror | undefined;
  const scroll = createScroller({ max: () => Math.max(0, props.pictures.length * 100 - props.width) });
  createGesture({ region: { node: () => node }, axis: 'x', onDown: () => scroll.stop(), onPanStart: () => scroll.beginDrag(), onPanMove: c => scroll.drag(-c.fdx), onPanEnd: c => scroll.endDrag(-c.vx), onCancel: () => { if (scroll.state() === 'tracking') scroll.endDrag(0); } });
  onFrame(() => scroll.step()); onCleanup(() => scroll.stop());
  return <View ref={value => node = value} class="relative overflow-hidden" style={{ width: props.width, height: 100 }}>
    <View class="absolute top-[0] left-[0]" style={{ width: props.pictures.length * 100, height: 100, translateX: -scroll.offset() }}>
      {props.pictures.map((picture, index) => <View class="absolute top-[0] rounded-[8] overflow-hidden" style={{ insetL: index * 100, width: 92, height: 100 }}>{picture.url ? <RemoteImage url={remoteUrl(picture.url)} cacheBucket="bili-preview" width={92} height={100} fit="cover" /> : null}</View>)}
    </View>
  </View>;
}
export function commentEntry(comment: BiliComment, width: number, uploaderMid?: number, onPress?: () => void): ScrollEntry {
  const contentWidth = Math.max(1, width - 24), nameWidth = Math.max(1, contentWidth - 44);
  const up = comment.mid !== undefined && comment.mid === uploaderMid, top = comment.replyControl?.isUpTop === true;
  const badgesWidth = (up ? 25 : 0) + (top ? 30 : 0);
  const names = wrap(comment.member?.name ?? '', nameWidth - badgesWidth, 8);
  const nameHeight = Math.max(17, names.length * 17), headerHeight = Math.max(36, nameHeight + 14);
  const rich = comment.content ? layoutCommentRuns(commentRuns(comment.content), contentWidth, s => measure(s, 22)) : { fragments: [], height: 0 };
  const bodyTop = 12 + headerHeight + 8;
  const pictures = comment.content?.pictures ?? [], picturesTop = bodyTop + rich.height + 8;
  const actionTop = bodyTop + rich.height + (pictures.length ? 108 : 0) + 8;
  const preview = (comment.replies ?? []).slice(0, 3).map(reply => {
    const author = `${reply.member?.name ?? ''}:`, authorWidth = Math.min(measure(author, 7), Math.max(1, contentWidth - 32));
    const body = wrap(reply.content?.message ?? '', contentWidth - 16 - authorWidth - 4, 0);
    const clipped = body.slice(0, 2);
    if (body.length > 2) { let text = clipped[1] ?? ''; while (text && measure(text + '…', 0) > contentWidth - 20 - authorWidth) text = Array.from(text).slice(0, -1).join(''); clipped[1] = text + '…'; }
    return { author, authorWidth, body: clipped.join('\n'), height: Math.max(14, clipped.length * 14) + 4 };
  });
  const previewHeight = preview.length ? 16 + preview.reduce((sum, item) => sum + item.height, 0) : 0;
  const height = actionTop + 16 + (preview.length ? 8 + previewHeight : 0) + 12;
  const likes = commentCount(comment.like), nameColor = vipColor(comment.member?.vip?.nicknameColor);
  return { height, render: () => <View onPress={onPress} focusable={!!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={onPress ? `${comment.member?.name ?? ''}，${comment.replyCount ?? 0}条回复` : undefined} class="absolute inset-0 rounded-[16] bg-[#1c1f21] overflow-hidden">
    <View class="absolute left-[12] w-[36] h-[36] rounded-full overflow-hidden" style={{ insetT: 12 + (headerHeight - 36) / 2 }}>{comment.member?.avatar ? <RemoteImage url={remoteUrl(comment.member.avatar)} cacheBucket="bili-preview" width={36} height={36} fit="cover" /> : null}</View>
    <Text class="absolute text-sm font-bold text-[#f5f5f5]" style={{ insetL: 56, insetT: 12, width: nameWidth - badgesWidth, height: nameHeight, lineHeight: 17, textColor: nameColor }}>{names.join('\n')}</Text>
    {up ? <View class="absolute rounded-[4] bg-[#ff6026]" style={{ insetL: width - 12 - badgesWidth + 4, insetT: 12 + (nameHeight - 15) / 2, width: 21, height: 15 }}><Text class="absolute left-[4] top-[2] text-[9px] leading-[11] text-black">UP</Text></View> : null}
    {top ? <View class="absolute right-[12] rounded-[4] bg-[#333333]" style={{ insetT: 12 + (nameHeight - 15) / 2, width: 26, height: 15 }}><Text class="absolute left-[4] top-[2] text-[9px] leading-[11] text-[#f5f5f5]">置顶</Text></View> : null}
    <Text class="absolute left-[56] right-[12] text-xs leading-[14] text-[#b6b6b6]" style={{ insetT: 12 + nameHeight }}>{commentTime(comment.ctime)}</Text>
    {rich.fragments.map(run => run.emote ? <View class="absolute" style={{ insetL: 12 + run.x, insetT: bodyTop + run.y + .5, width: 20, height: 20 }} accessibilityLabel={run.text}>{run.image ? <RemoteImage url={remoteUrl(run.image)} cacheBucket="bili-preview" width={20} height={20} fit="contain" /> : null}</View> : <Text class="absolute text-[17px] leading-[21]" style={{ insetL: 12 + run.x, insetT: bodyTop + run.y, width: run.width + 1, height: 21, textColor: run.color ?? '#f5f5f5' }}>{run.text}</Text>)}
    {pictures.length ? <View class="absolute left-[12]" style={{ insetT: picturesTop }}><PictureStrip pictures={pictures} width={contentWidth} /></View> : null}
    <Image src="../assets/icons/bili-comment-like.svg" class="absolute left-[12] w-[16] h-[16]" style={{ insetT: actionTop }} />
    <Text class="absolute left-[32] text-xs leading-[14] text-[#b6b6b6]" style={{ insetT: actionTop + 1 }}>{likes}</Text>
    {(comment.replyCount ?? 0) > 0 ? <Text class="absolute text-xs leading-[14] text-[#ff6026]" style={{ insetL: 48 + measure(likes, 0), insetT: actionTop + 1 }}>{`${comment.replyCount}条回复`}</Text> : null}
    {preview.length ? <View class="absolute left-[12] right-[12] rounded-[8] bg-[#23272a]" style={{ insetT: actionTop + 24, height: previewHeight }}>{preview.map((reply, index) => <View class="absolute left-[8] right-[8]" style={{ insetT: 8 + preview.slice(0, index).reduce((sum, r) => sum + r.height, 0), height: reply.height }}><Text class="absolute left-[0] top-[0] text-xs font-bold leading-[14] text-[#ff6026]" style={{ width: reply.authorWidth, height: reply.height }}>{reply.author}</Text><Text class="absolute top-[0] right-[0] text-xs leading-[14] text-[#f5f5f5]" style={{ insetL: reply.authorWidth + 4, height: reply.height }}>{reply.body}</Text></View>)}</View> : null}
  </View> };
}
export function CommentScreen(props: BiliScreenProps & { route: Extract<BiliRoute, { name: 'comments' | 'replies' }> }) {
  const [state, setState] = createSignal<CommentState>({ items: [], loading: true, refreshing: true, canLoadMore: true });
  let controller: BiliComments;
  let listScroller: Scroller | undefined;
  createEffect(() => {
    const route = props.route;
    const own = new BiliComments(props.client, { oid: Number(route.oid), root: route.name === 'replies' ? Number(route.root) : undefined }, setState);
    controller = own; listScroller?.scrollTo(0, { immediate: true }); setState(own.state); void own.refresh(); onCleanup(() => own.dispose());
  });
  const width = () => (props.width ?? 233) - 36;
  const status = (message: string, color = '#b6b6b6', action?: () => void): ScrollEntry => {
    const text = wrap(message, width() - 32, 1);
    return { height: Math.max(49, text.length * 17 + 32), render: () => <View class="absolute inset-0" onPress={action} focusable={!!action}><Text class="absolute left-[16] right-[16] top-[16] text-sm leading-[17] text-center" style={{ textColor: color }}>{text.join('\n')}</Text></View> };
  };
  const entries = createMemo<ScrollEntry[]>(() => {
    const s = state(), reply = props.route.name === 'replies', showItems = !s.refreshing;
    const result: ScrollEntry[] = [];
    if (reply && s.root) { result.push(commentEntry(s.root, width(), Number(props.route.uploaderMid))); result.push({ height: 43, render: () => <View class="absolute inset-0"><View class="absolute left-[0] right-[0] top-[0] h-[1] bg-[#2c3135]" /><Text class="absolute left-[18] top-[17] text-[21px] leading-[26] text-[#f5f5f5]">所有回复</Text></View> }); }
    if (showItems) result.push(...s.items.map(comment => commentEntry(comment, width(), Number(props.route.uploaderMid), !reply && comment.rpid !== undefined ? () => props.onNavigate({ name: 'replies', oid: props.route.oid, root: comment.rpid!, uploaderMid: props.route.uploaderMid }) : undefined)));
    if (s.loading) result.push({ height: 64, render: () => <View class="absolute inset-0 items-center justify-center"><WatchProgressIndicator size={32} /></View> });
    else if (s.error) result.push(status(`加载失败: ${s.error}`, '#e54d4d', () => void controller.retry()));
    else if (!reply && !s.items.length) result.push({ height: Math.max(70, props.height - 64), render: () => <View class="absolute inset-0 items-center justify-center"><Text class="text-[21px] leading-[26] text-[#b6b6b6]">暂无评论</Text><View class="h-[8]" /><Text class="text-sm leading-[17] text-[#b6b6b6]">快来发表第一条评论吧</Text></View> });
    else if (s.canLoadMore) result.push(status('加载更多', '#ff6026', () => void controller.loadMore()));
    return result;
  });
  return <View class="relative w-full bg-[#0b1211]" style={{ height: props.height }}>
    <View class="absolute left-[0] right-[0] top-[0] h-[64]">
      <View onPress={props.onBack} focusable accessibilityLabel="返回" class="absolute left-[4] top-[8] w-[48] h-[48] items-center justify-center active:scale-96"><Image src="../assets/icons/bili-comment-back.svg" style={{ width: 24, height: 24 }} /></View>
      <Text class="absolute left-[56] right-[4] top-[19] text-[21px] leading-[26] text-[#f5f5f5]">{props.route.name === 'replies' ? '回复详情' : '评论'}</Text>
    </View>
    <View class="absolute left-[0] right-[0] top-[64] bottom-[0]">
      <ScrollEntries height={Math.max(1, props.height - 64)} entries={entries()} padding={18} verticalPadding={0} gap={8} ref={value => { listScroller = value.scroller; props.ref?.(value); }} onRefresh={() => void controller.refresh()} onSettledRange={(_, last) => { const s = state(); if (!s.loading && !s.error && s.canLoadMore && last >= entries().length - 2) void controller.loadMore(); }} />
    </View>
  </View>;
}
