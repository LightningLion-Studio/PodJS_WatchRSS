import type { Page } from "./types.ts";
import type { ProfileEntryKey } from "../profile-entries.ts";

const routeTitles: Record<Page, string> = {
  "debug-summary": "AI 总结",
  "debug-tools": "调试工具",
  "add-rss": "添加 RSS",
  "remote-input": "从手机输入",
  "log-upload": "日志上传",
  "bluetooth-connection": "蓝牙同步",
  "phone-connection-unavailable": "暂不可用",
  "tts-config": "配置朗读语音",
  "reader-preview": "预设实时预览",
  "phone-connection": "连接手机",
  "account-status": "账号",
  "cloud-sync": "云同步",
  "sync-v2": "云同步",
  "speech-playback": "朗读播控",
  "settings-reader-presets": "阅读器预设",
  "settings-llm-usage": "Token 消耗",
  "settings-llm-preset": "提示词预设",
  "channel-detail": "频道详情",
  "channel-settings": "频道设置",
  "channel-share": "分享频道",
  "reader-image": "图片",
  "settings-auto-scroll": "滚动控制",
  "reader-scroll-controls": "滚动控制",
  "settings-speech": "朗读语速",
  "rss-actions": "操作",
  "rss-share": "分享",
  bili: "哔哩哔哩",
  douyin: "抖音",
  video: "播放",
  "watch-later": "稍后再看",
  home: "",
  profile: "我的",
  articles: "文章",
  saved: "收藏",
  search: "搜索",
  settings: "设置",
  "settings-advanced": "高级",
  notes: "备忘录",
  "note-detail": "备忘录",
  "note-actions": "笔记操作",
  recommendations: "RSS推荐",
  information: "信息",
  reader: "阅读",
};

const titledByScreen = new Set<Page>([
  "add-rss",
  "remote-input",
  "log-upload",
  "bluetooth-connection",
  "phone-connection-unavailable",
  "tts-config",
  "reader-preview",
  "phone-connection",
  "account-status",
  "cloud-sync",
  "sync-v2",
  "speech-playback",
  "settings-reader-presets",
  "settings-llm-usage",
  "settings-llm-preset",
  "reader",
  "channel-detail",
  "channel-settings",
  "channel-share",
  "reader-image",
  "settings-auto-scroll",
  "reader-scroll-controls",
  "rss-actions",
  "rss-share",
  "articles",
  "saved",
  "watch-later",
  "search",
  "bili",
  "douyin",
  "video",
  "home",
  "profile",
  "settings",
  "settings-speech",
  "settings-advanced",
  "notes",
  "note-detail",
  "note-actions",
  "recommendations",
  "information",
]);

export function routeTitle(page: Page): string {
  return routeTitles[page];
}

export function routeIsSelfTitled(page: Page): boolean {
  return titledByScreen.has(page);
}

export function routeIsKnown(value:unknown):value is Page { return typeof value==="string"&&Object.hasOwn(routeTitles,value); }

/** 我的 entries open a route page, or an information document for about/contact. */
export function profileDestination(key: ProfileEntryKey): { page: Page } | { information: "about" | "contact-developer" } {
  if (key === "about" || key === "contact-developer") return { information: key };
  return { page: key === "account" ? "account-status" : key };
}
