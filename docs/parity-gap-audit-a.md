# WatchRSS → PodJS 功能对齐差距审计（任务 1A）

> 审计日期：2026-10-04  
> 审计范围：启动引导与隐私同意、首页与 RSS、文章阅读、备忘录、阅读预设、设置与账号。  
> 证据规则：仅以当前 `Android_WatchRSS` 原生源码、`Android_WatchRSS_Phone` 中与手表交互的当前协议源码、以及当前 `PodJS_WatchRSS/src/` 为依据；未用旧迁移文档推断结论。  
> 状态含义：**已实现**＝PodJS 已有可达的对应产品路径；**部分实现**＝已有基础能力但关键交互、持久化或协议语义不完整；**缺失**＝当前 `src/` 未找到对应产品路径。工作量为补齐当前差距的粗估：S（小）、M（中）、L（大）。

## 1. 启动引导与隐私同意

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 启动时分别按 OOBE 版本、隐私政策版本做门禁，且先引导后隐私更新页，未通过前不挂载主内容 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/MainActivity.kt:55-81`、`data/settings/SettingsRepository.kt:54-66,131`；PodJS `src/ui/StartupGate.tsx`、`src/onboarding/state.ts`、`src/onboarding/store.ts` | 高 | S |
| 原生系统 Splash 退出缩放/淡出及应用内启动遮罩 | **部分实现**：PodJS 门禁读取期间只有纯黑 `StartupLoading`，未见原生的品牌启动遮罩和退出动画 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/MainActivity.kt:31-45,105-117`；PodJS `src/ui/StartupGate.tsx` | 低 | S |
| 从桌面冷启动时恢复上次打开的内部内容，并在首页下重建对应返回栈 | **缺失**：PodJS 内容导航栈每次挂载都固定从 `home` 初始化，未持久化或恢复上次频道/文章等页面 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/MainActivity.kt:82-89,120-141`、`AppResumeStateStore.kt:10-49`；PodJS `src/ui/screen.tsx` | 中 | M |
| 四步首次引导：欢迎、协议确认、自定义、互联网检测；支持系统返回逐页后退 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/OobeScreen.kt:112-127,142-283`、`ui/viewmodel/OobeViewModel.kt:19-64`；PodJS `src/ui/OnboardingScreen.tsx`、`src/onboarding/state.ts`、`src/ui/StartupGate.tsx` | 高 | S |
| 用户协议与隐私政策必须主动勾选；两段正文均可从引导内打开，未勾选显示错误 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/OobeScreen.kt:286-369`、`OobeActivity.kt:63-79`；PodJS `src/ui/OnboardingScreen.tsx`、`src/ui/StartupGate.tsx` | 高 | S |
| 引导自定义页：阅读明暗主题立即写入阅读预设；字号、滚轮音量、防误触、静音开播上限只作本页预览，不污染正式设置 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/OobeActivity.kt:57-89`、`ui/screen/OobeScreen.kt:373-548`；PodJS `src/ui/OnboardingCustomizationScreen.tsx`、`src/ui/StartupGate.tsx`、`src/onboarding/restoration.ts` | 中 | S |
| 区分可用互联网、无网、蓝牙网络、检测中；无网/蓝牙时经二次确认仍可继续 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/OobeScreen.kt:164-199,575-724`；PodJS `src/ui/OnboardingNetworkScreen.tsx`、`src/onboarding/network.ts`、`src/onboarding/network-host.ts` | 中 | S |
| 只有完成最后一步才同时持久化 OOBE 与隐私版本，页面重建可恢复页码、勾选、警告框、自定义草稿及协议阅读栈 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/OobeViewModel.kt:48-59`、`data/settings/SettingsRepository.kt:139-143,282-284`；PodJS `src/onboarding/controller.ts`、`src/onboarding/store.ts`、`src/onboarding/restoration.ts`、`src/onboarding/legal-restoration.ts`、`src/ui/StartupGate.tsx` | 高 | S |
| 隐私政策升级后的强制再次同意：查看正文、同意后记版本并退出门禁、不同意退出任务 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/PrivacyPolicyConsentActivity.kt:13-58`、`ui/screen/PrivacyPolicyConsentScreen.kt:35-135`；PodJS `src/ui/PrivacyPolicyConsentScreen.tsx`、`src/onboarding/controller.ts`、`src/ui/StartupGate.tsx` | 高 | S |
| 法律正文按后端路径实时获取，带应用版本头、禁缓存、加载/错误/重试，并可安全恢复阅读位置 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/InfoActivity.kt:60-100,117-143,168-216`；PodJS `src/onboarding/legal-document.ts`、`src/onboarding/legal-restoration.ts`、`src/onboarding/legal-snapshot-writer.ts`、`src/ui/InformationScreens.tsx` | 中 | S |

本区域结论：核心隐私门禁、明确同意语义和四步引导已对齐；差距是冷启动不能恢复上次内容，以及原生启动过渡视觉未完整迁移。

## 2. 首页与 RSS

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 首页入口：个人页、备忘录、订阅频道、RSS 推荐、添加 RSS、备案入口 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/home/HomeComposeScreen.kt:202-287`、`HomeFeedListActivity.kt:294-348`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/screen.tsx` | 高 | S |
| 首页启动时检查版本公告与未读推送；公告支持可选/强制更新、下载进度、失败提示及拉起系统安装器，推送以弹窗展示 | **缺失**：PodJS `src/` 未找到公告、应用内 APK 更新或首页推送消息路径 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/HomeFeedListActivity.kt:145-146,189-271,355-373`、`data/announcement/AnnouncementRepository.kt:34-52`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/screen.tsx` | 高 | L |
| 朗读进行中时在首页显示可返回的朗读卡片、当前文章状态和实时频谱 | **部分实现**：PodJS 已有持续的朗读控制器和独立播控页，但首页不显示进行中入口或频谱，离开阅读/播控路径后只能间接返回 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/HomeFeedListActivity.kt:163-168,318-320`、`ui/screen/home/HomeComposeScreen.kt:135-137,249-253,405-473`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/SpeechPlaybackScreen.tsx`、`src/ui/screen.tsx` | 中 | S |
| 首页内置 B 站/抖音卡片根据实际登录状态显示“实时”更新语义 | **部分实现**：PodJS 平台客户端能读取会话，但首页卡片不订阅登录状态，固定使用频道简介和 `lastFetchedAt`（通常显示“未更新”） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/HomeViewModel.kt:22-59`、`ui/screen/home/HomeComposeScreen.kt:1130-1160`；PodJS `src/ui/HomeScreen.tsx`、`src/bili/client.ts`、`src/douyin/client.ts` | 低 | S |
| 首次加载完成后，无订阅时显示“还没有 RSS 频道”的明确空状态 | **缺失**：PodJS 始终显示备忘录/推荐/添加入口，但没有原生的订阅空状态提示 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/home/HomeComposeScreen.kt:214-221,318-324`；PodJS `src/ui/HomeScreen.tsx` | 低 | S |
| 首页下拉刷新全部非内置 RSS 频道，并显示刷新状态/首个错误 | **缺失**：PodJS 首页没有刷新手势或“刷新全部”动作，只能进入单个频道刷新 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/home/HomeComposeScreen.kt:172-180`、`ui/viewmodel/HomeViewModel.kt:79-104`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/screen.tsx` | 高 | M |
| 订阅列表展示标题、简介、更新时间、未读数和置顶样式，并按“置顶优先、sortOrder 倒序”排列 | **部分实现**：字段与置顶样式已展示，但 PodJS 查询是 `ORDER BY sort_order,title`，没有置顶优先且方向与原生不同；备忘录也固定在频道前 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/db/RssChannelDao.kt:12-25`、`ui/screen/home/HomeComposeScreen.kt:328-349,720-755`；PodJS `src/services.ts`、`src/ui/HomeScreen.tsx` | 中 | S |
| 首页长按频道操作：移动到顶部、置顶/取消置顶、标记已读、删除（含确认）；变更写入 RSS source 同步状态 | **部分实现**：标记已读和删除可从频道详情/设置绕行；移动到顶部与置顶没有 PodJS UI/service 写入口 | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ChannelActionsActivity.kt:55-166`、`data/rss/DefaultRssRepository.kt:1315-1354,1465-1486`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/ChannelScreens.tsx`、`src/services.ts` | 中 | M |
| 添加订阅：URL 输入与校验、解析预览、错误重试/取消、确认添加、识别已有订阅并直达频道；内置 B 站/抖音入口走对应页面 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/AddRssViewModel.kt:14-123`、`AddRssActivity.kt:25-88`；PodJS `src/ui/AddRssScreen.tsx`、`src/rss/add-channel.ts`、`src/services.ts` | 高 | S |
| 推荐订阅按媒体分组，保持当前六组及组内地址顺序，点击后预填添加流程 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/RssRecommendActivity.kt:10-27`、`RssRecommendGroupActivity.kt:15-34`、`data/rss/RssRecommendations.kt:15-87`；PodJS `src/ui/RecommendationScreen.tsx`、`src/rss/recommendations.ts`、`src/ui/screen.tsx` | 中 | S |
| 频道文章列表：未读标识、标题/摘要/封面、12 条首屏与每次 8 条增量（最多 200）、到底自动/手动加载、下拉刷新、点击标已读 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/FeedActivity.kt:41-105`、`ui/viewmodel/FeedViewModel.kt:26-85,125-129`；PodJS `src/ui/RssScreens.tsx`、`src/ui/feed-window.ts`、`src/ui/screen.tsx` | 高 | S |
| 频道列表条目左滑快捷收藏/稍后再看、长按打开条目操作；原文模式下仅对稳定可见范围预取并在滚动时暂停更新 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/FeedActivity.kt:83-104`、`ui/viewmodel/FeedViewModel.kt:88-119`；PodJS `src/ui/RssScreens.tsx`、`src/ui/screen.tsx`、`src/reader/original-cache.ts` | 高 | S |
| 频道详情：标题、简介、地址、更新时间、未读数，以及设置、频道内搜索、分享、标记已读 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ChannelDetailActivity.kt:42-95`；PodJS `src/ui/ChannelScreens.tsx`、`src/ui/screen.tsx`、`src/sharing/policy.ts` | 中 | S |
| 频道设置：原文阅读模式、仅有可播放媒体时显示后台续播、可清空本地导入频道、删除频道，危险操作二次确认 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ChannelSettingsActivity.kt:38-123`、`ui/viewmodel/ChannelDetailViewModel.kt:20-57`；PodJS `src/ui/ChannelScreens.tsx`、`src/services.ts`、`src/core/imported-content.ts` | 高 | S |
| 频道内搜索：180ms 防抖、最多 120 条、标题/摘要/正文/原文及分块边界匹配、命中片段与关键词高亮、点击进入文章 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/RssSearchViewModel.kt:20-48`、`RssSearchActivity.kt:20-39`；PodJS `src/ui/RssSearchScreen.tsx`、`src/rss/search-snippet.ts`、`src/services.ts` | 高 | S |
| 收藏与稍后再看：离线列表、RSS/平台内容打开、左滑移除、3 秒撤回、长按拖动排序；读完“稍后再看”条目自动移除 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/SavedItemsActivity.kt:26-127`、`ui/viewmodel/SavedItemsViewModel.kt:17-43`；PodJS `src/ui/SavedItemsScreen.tsx`、`src/ui/screen.tsx`、`src/reader/watch-later-completion.ts` | 高 | S |
| 与手机的协议对齐：protocol v14 双向同步 RSS sources、文章正文/分块、收藏/稍后再看、排序、删除和阅读状态 | **已实现（源码级）**：已找到同版本 action、游标/manifest/article 阶段及 source/save 合并路径；本任务未做设备互通验证 | 原生手机 `Android_WatchRSS_Phone/app/src/main/java/com/lightningstudio/watchrss/phone/connection/bluetooth/BluetoothSyncProtocol.kt:11-30`、`PhoneBluetoothSyncManager.kt:458-566`、`LibrarySyncPayload.kt:63-83,138-180`；PodJS `src/sync/protocol.ts`、`src/sync/session.ts`、`src/sync/library-repository.ts`、`src/sync/source-store.ts`、`src/sync/saved-state.ts` | 高 | S |

本区域结论：首页到添加、推荐、频道、搜索、收藏的核心阅读路径已存在；主要产品差距集中在首页版本公告/强制更新与推送、刷新全部、频道排序/置顶/移顶管理，以及进行中朗读入口，而非 RSS 解析或文章列表本身。
