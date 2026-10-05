import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseClassLiteral } from "/home/wilf/data/PodJS/podjs-watch/vendor/pocketjs/framework/compiler/tailwind.ts";
import { homeChannelSummary, homeSpeechCard } from "../src/ui/home-extras.ts";
import type { SpeechPlaybackState } from "../src/reader/speech-playback.ts";
import type { Channel } from "../src/ui/service.ts";

const channel = (url: string, patch: Partial<Channel> = {}): Channel => ({ id: url, title: url, url, ...patch });
const speech = (patch: Partial<SpeechPlaybackState> = {}): SpeechPlaybackState => ({
  phase: "ready", playing: true, queueIndex: 1, queueSize: 3, segmentIndex: 2, segmentCount: 5,
  autoAdvance: true, rate: 1, article: { id: "article", title: "article", content: "" }, ...patch,
});

test("home speech card follows the native current article and playback status semantics", () => {
  const playing = homeSpeechCard(speech({ article: { id: "a", channelId: "c", title: "文章", channelTitle: "频道", content: "正文" } }));
  expect(playing).toEqual({ title: "正在朗读", summary: "文章\n频道 · 播放中 · 第 1/3 篇 · 第 2/5 段", playing: true });
  expect(homeSpeechCard(speech({ playing: false }))?.title).toBe("朗读已暂停");
  expect(homeSpeechCard(speech({ phase: "idle", article: undefined }))).toBeNull();
});

test("built-in platform cards say realtime only for a stored authenticated session", () => {
  const format = () => "10-04 12:30";
  const bili = channel("builtin:bili", { description: "未登录说明", lastFetchedAt: 1, isPinned: true });
  const douyin = channel("builtin:douyin", { description: "抖音说明" });
  expect(homeChannelSummary(bili, { bili: true, douyin: false }, format)).toBe("置顶 · 进入以获取推荐内容\n更新：实时");
  expect(homeChannelSummary(douyin, { bili: true, douyin: false }, format)).toBe("抖音说明\n更新: 未更新");
  expect(homeChannelSummary(channel("https://feed", { unreadCount: 4, lastFetchedAt: 1 }), { bili: true, douyin: true }, format)).toBe("https://feed\n未读 4 · 更新: 10-04 12:30");
});

test("home speech card and playback action classes compile in the actual PodJS style parser", () => {
  for (const file of ["HomeScreen", "SpeechPlaybackScreen"]) {
    const source = readFileSync(new URL(`../src/ui/${file}.tsx`, import.meta.url), "utf8");
    for (const match of source.matchAll(/class="([^"]+)"/g)) {
      expect(parseClassLiteral(match[1]!), `${file}: ${match[1]}`).not.toBeNull();
    }
  }
});
