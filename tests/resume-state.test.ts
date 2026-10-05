import { expect, test } from "bun:test";
import { AppResumeStore, resolveResumeTarget, resumeTargetForStack, validateResumeTarget } from "../src/navigation/resume-state.ts";

class MemoryStorage {
  values = new Map<string, unknown>();
  get<T>(key: string) { return this.values.get(key) as T | undefined; }
  set<T>(key: string, value: T) { this.values.set(key, value); }
  delete(key: string) { this.values.delete(key); }
}

test("resume target scans through transient overlays and keeps only stable internal identifiers", () => {
  expect(resumeTargetForStack([
    { page: "home" }, { page: "bili", biliRoute: { name: "detail", bvid: "BV1", source: { expires: true } } }, { page: "video" },
  ])).toEqual({ version: 1, kind: "bili", route: { name: "detail", bvid: "BV1" } });
  expect(resumeTargetForStack([
    { page: "home" }, { page: "reader", readerArticle: { id: "article-7" } }, { page: "speech-playback" },
  ])).toEqual({ version: 1, kind: "reader", articleId: "article-7" });
  expect(resumeTargetForStack([{ page: "home" }, { page: "settings" }])).toEqual({ version: 1, kind: "home" });
});

test("resume target validation rejects external or incomplete routes and downgrades players to detail", () => {
  expect(validateResumeTarget({ version: 1, kind: "reader", articleId: " " })).toBeNull();
  expect(validateResumeTarget({ version: 1, kind: "bili", route: { name: "player", bvid: "BV2", cid: 3, source: { url: "expired" } } }))
    .toEqual({ version: 1, kind: "bili", route: { name: "detail", bvid: "BV2", cid: 3 } });
  expect(validateResumeTarget({ version: 1, kind: "douyin", route: { name: "player", awemeId: "7123" } }))
    .toEqual({ version: 1, kind: "douyin", route: { name: "detail", awemeId: "7123" } });
  expect(validateResumeTarget({ version: 1, kind: "bili", route: { name: "https://outside" } })).toBeNull();
});

test("resume store clears corrupt state and round trips a validated target", () => {
  const storage = new MemoryStorage(), store = new AppResumeStore(storage);
  storage.values.set("watchrss.resume-state.v1", { version: 99, kind: "reader", articleId: "a" });
  expect(store.read()).toBeNull();
  expect(storage.values.size).toBe(0);
  const target = { version: 1, kind: "articles", channelId: "channel-1" } as const;
  store.save(target);
  expect(store.read()).toEqual(target);
});

test("cold-start resolution keeps home as the safe fallback for deleted content", async () => {
  const article = { id: "a", title: "restored" };
  const resolver = { hasChannel: async (id: string) => id === "channel-1", getArticle: async (id: string) => id === "a" ? article : null };
  await expect(resolveResumeTarget({ version: 1, kind: "articles", channelId: "channel-1" }, resolver))
    .resolves.toEqual({ version: 1, kind: "articles", channelId: "channel-1" });
  await expect(resolveResumeTarget({ version: 1, kind: "articles", channelId: "deleted" }, resolver))
    .resolves.toEqual({ version: 1, kind: "home" });
  await expect(resolveResumeTarget({ version: 1, kind: "reader", articleId: "a" }, resolver))
    .resolves.toEqual({ version: 1, kind: "reader", articleId: "a", article });
  await expect(resolveResumeTarget({ version: 1, kind: "reader", articleId: "deleted" }, resolver))
    .resolves.toEqual({ version: 1, kind: "home" });
});

test("only native resumable activities are recorded (no channel list or Bili feed)", () => {
  expect(resumeTargetForStack([{ page: "home" }, { page: "articles", channelId: "7" }] as never)).toEqual({ version: 1, kind: "home" });
  expect(resumeTargetForStack([{ page: "home" }, { page: "bili", biliRoute: { name: "entry" } }] as never)).toEqual({ version: 1, kind: "home" });
  expect(resumeTargetForStack([{ page: "home" }, { page: "bili", biliRoute: { name: "detail", bvid: "BV1xx" } }] as never).kind).toBe("bili");
  expect(resumeTargetForStack([{ page: "home" }, { page: "articles", channelId: "7" }, { page: "reader", readerArticle: { id: "42" } }] as never)).toEqual({ version: 1, kind: "reader", articleId: "42" });
  expect(resumeTargetForStack([{ page: "home" }, { page: "douyin", douyinRoute: { name: "settings" } }] as never)).toEqual({ version: 1, kind: "home" });
});
