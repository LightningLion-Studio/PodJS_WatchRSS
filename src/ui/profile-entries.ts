import type { ProfileIconName } from "./ProfileIcon.tsx";

export type ProfileEntryKey = "account" | "cloud-sync" | "saved" | "watch-later" | "phone-connection" | "settings" | "about" | "contact-developer";

/** Native ProfileScreen order. Selection is by key so inserting an entry cannot shift another's target. */
export const PROFILE_ENTRIES: readonly { key: ProfileEntryKey; title: string; icon: ProfileIconName }[] = [
  { key: "account", title: "账号", icon: "person" },
  { key: "cloud-sync", title: "云同步", icon: "cloud" },
  { key: "saved", title: "我的收藏", icon: "star" },
  { key: "watch-later", title: "稍后再看", icon: "play-circle" },
  { key: "phone-connection", title: "连接手机", icon: "phone-android" },
  { key: "settings", title: "设置", icon: "settings" },
  { key: "about", title: "关于", icon: "info" },
  { key: "contact-developer", title: "联系开发者", icon: "person" },
];
