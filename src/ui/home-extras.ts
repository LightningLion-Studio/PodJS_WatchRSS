import type { SpeechPlaybackState } from "../reader/speech-playback.ts";
import { speechPlaybackStatus } from "../reader/speech-playback.ts";
import type { Channel } from "./service.ts";

export interface HomePlatformLoginState {
  bili: boolean;
  douyin: boolean;
}

export interface HomeSpeechCardModel {
  title: string;
  summary: string;
  playing: boolean;
}

export function homeSpeechCard(state?: SpeechPlaybackState): HomeSpeechCardModel | null {
  if (!state?.article || state.phase === "idle") return null;
  const articleTitle = state.article.title.trim() || "本地朗读";
  const source = state.article.channelTitle?.trim();
  const status = speechPlaybackStatus(state);
  return {
    title: state.playing ? "正在朗读" : "朗读已暂停",
    summary: `${articleTitle}\n${source ? `${source} · ` : ""}${status}`,
    playing: state.playing,
  };
}

export function homeChannelSummary(
  channel: Channel,
  login: HomePlatformLoginState,
  formatTime: (timestamp: number) => string,
): string {
  const platform = channel.url === "builtin:bili" ? "bili" : channel.url === "builtin:douyin" ? "douyin" : null;
  const realtime = platform ? login[platform] : false;
  const summary = realtime ? "进入以获取推荐内容" : channel.description?.trim() || channel.url;
  const pin = channel.isPinned ? "置顶 · " : "";
  const unread = !platform && (channel.unreadCount ?? 0) > 0 ? `未读 ${channel.unreadCount} · ` : "";
  const update = realtime ? "更新：实时" : `更新: ${channel.lastFetchedAt ? formatTime(channel.lastFetchedAt) : "未更新"}`;
  return `${pin}${summary}\n${unread}${update}`;
}

/** HomeReadAloudSpectrumView.onDraw, in the native 38 x 34 dp slot.
 * Input levels have already passed through the native gain/attack/release model. */
export function homeSpeechSpectrumBars(levels: readonly number[] | undefined, playing: boolean) {
  const width = 38, height = 34, count = 5;
  const gap = width / (count * 1.9), barWidth = (width - gap * (count - 1)) / count;
  return Array.from({length: count}, (_, index) => {
    const raw = levels?.[index] ?? 0;
    const level = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const barHeight = Math.max(height * level, height * .16);
    return {
      insetL: index * (barWidth + gap), insetT: (height - barHeight) / 2,
      width: barWidth, height: barHeight,
      opacity: level <= .005 ? 0 : Math.floor((.32 + level * .58) * (playing ? 1 : .52) * 255) / 255,
    };
  });
}
