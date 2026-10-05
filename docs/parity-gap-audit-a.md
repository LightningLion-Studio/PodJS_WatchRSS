# WatchRSS → PodJS 功能对齐差距审计（任务 1A）

> 审计日期：2026-10-04  
> 审计范围：启动引导与隐私同意、首页与 RSS、文章阅读、备忘录、阅读预设、设置与账号。  
> 证据规则：仅以当前 `Android_WatchRSS` 原生源码、`Android_WatchRSS_Phone` 中与手表交互的当前协议源码、以及当前 `PodJS_WatchRSS/src/` 为依据；未用旧迁移文档推断结论。  
> 状态含义：**已实现**＝PodJS 已有可达的对应产品路径；**部分实现**＝已有基础能力但关键交互、持久化或协议语义不完整；**缺失**＝当前 `src/` 未找到对应产品路径。工作量为补齐当前差距的粗估：S（小）、M（中）、L（大）。

## 1. 启动引导与隐私同意

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 启动时分别按 OOBE 版本、隐私政策版本做门禁，且先引导后隐私更新页，未通过前不挂载主内容 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/MainActivity.kt:55-81`、`data/settings/SettingsRepository.kt:54-66,131`；PodJS `src/ui/StartupGate.tsx`、`src/onboarding/state.ts`、`src/onboarding/store.ts` | 高 | S |
| 原生系统 Splash 退出缩放/淡出及应用内启动遮罩 | **部分实现（设备待验）**（`4c879b1`、`18cc10c`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/MainActivity.kt:31-45,105-117`；PodJS `src/ui/StartupGate.tsx`、`src/ui/startup-transition.ts` 已有品牌遮罩及淡出/缩放退出；PodJS 无法控制系统 Splash 本身，不能把应用自有覆盖层写成系统动画已对齐 | 低 | S |
| 从桌面冷启动时恢复上次打开的内部内容，并在首页下重建对应返回栈 | **已实现（源码级，设备待验）**（`4c879b1`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/MainActivity.kt:82-89,120-141`、`AppResumeStateStore.kt:10-49`；PodJS `src/ui/resume-state.ts`、`src/ui/screen.tsx` 持久化稳定内容页，并重建首页到频道/文章/平台详情的返回栈；瞬态播放器回落到稳定详情页 | 中 | M |
| 四步首次引导：欢迎、协议确认、自定义、互联网检测；支持系统返回逐页后退 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/OobeScreen.kt:112-127,142-283`、`ui/viewmodel/OobeViewModel.kt:19-64`；PodJS `src/ui/OnboardingScreen.tsx`、`src/onboarding/state.ts`、`src/ui/StartupGate.tsx` | 高 | S |
| 用户协议与隐私政策必须主动勾选；两段正文均可从引导内打开，未勾选显示错误 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/OobeScreen.kt:286-369`、`OobeActivity.kt:63-79`；PodJS `src/ui/OnboardingScreen.tsx`、`src/ui/StartupGate.tsx` | 高 | S |
| 引导自定义页：阅读明暗主题立即写入阅读预设；字号、滚轮音量、防误触、静音开播上限只作本页预览，不污染正式设置 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/OobeActivity.kt:57-89`、`ui/screen/OobeScreen.kt:373-548`；PodJS `src/ui/OnboardingCustomizationScreen.tsx`、`src/ui/StartupGate.tsx`、`src/onboarding/restoration.ts` | 中 | S |
| 区分可用互联网、无网、蓝牙网络、检测中；无网/蓝牙时经二次确认仍可继续 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/OobeScreen.kt:164-199,575-724`；PodJS `src/ui/OnboardingNetworkScreen.tsx`、`src/onboarding/network.ts`、`src/onboarding/network-host.ts` | 中 | S |
| 只有完成最后一步才同时持久化 OOBE 与隐私版本，页面重建可恢复页码、勾选、警告框、自定义草稿及协议阅读栈 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/OobeViewModel.kt:48-59`、`data/settings/SettingsRepository.kt:139-143,282-284`；PodJS `src/onboarding/controller.ts`、`src/onboarding/store.ts`、`src/onboarding/restoration.ts`、`src/onboarding/legal-restoration.ts`、`src/ui/StartupGate.tsx` | 高 | S |
| 隐私政策升级后的强制再次同意：查看正文、同意后记版本并退出门禁、不同意退出任务 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/PrivacyPolicyConsentActivity.kt:13-58`、`ui/screen/PrivacyPolicyConsentScreen.kt:35-135`；PodJS `src/ui/PrivacyPolicyConsentScreen.tsx`、`src/onboarding/controller.ts`、`src/ui/StartupGate.tsx` | 高 | S |
| 法律正文按后端路径实时获取，带应用版本头、禁缓存、加载/错误/重试，并可安全恢复阅读位置 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/InfoActivity.kt:60-100,117-143,168-216`；PodJS `src/onboarding/legal-document.ts`、`src/onboarding/legal-restoration.ts`、`src/onboarding/legal-snapshot-writer.ts`、`src/ui/InformationScreens.tsx` | 中 | S |

本区域结论：核心隐私门禁、明确同意语义、四步引导、稳定内容冷启动恢复和应用内启动遮罩均已有源码路径；系统 Splash 动画仍是平台差异，全部实体画面与返回栈行为仍待设备验收。

## 2. 首页与 RSS

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 首页入口：个人页、备忘录、订阅频道、RSS 推荐、添加 RSS、备案入口 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/home/HomeComposeScreen.kt:202-287`、`HomeFeedListActivity.kt:294-348`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/screen.tsx` | 高 | S |
| 首页启动时检查版本公告与未读推送；公告支持可选/强制更新、下载进度、失败提示及拉起系统安装器，推送以弹窗展示 | **部分实现（等待分发决策）**（`289aa4c`、`e0090ec`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/HomeFeedListActivity.kt:145-146,189-271,355-373`、`data/announcement/AnnouncementRepository.kt:34-52`；PodJS 已有公告/推送服务、首页弹窗及更新状态 UI，但 `VERSION_ANNOUNCEMENTS_ENABLED=false`。PodJS 包名与原生不同，宿主也无 `packageUpdate`，尚不能验证目标包或拉起安装器，启用前需用户决定分发策略 | 高 | L |
| 朗读进行中时在首页显示可返回的朗读卡片、当前文章状态和实时频谱 | **已实现（源码级，设备待验）**（`4c879b1`、`aceee5e`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/HomeFeedListActivity.kt:163-168,318-320`、`ui/screen/home/HomeComposeScreen.kt:135-137,249-253,405-473`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/SpeechPlaybackScreen.tsx`、`src/ui/screen.tsx` 已接进行中卡片、返回当前文章与宿主 TTS 频谱；旧宿主或无 PCM 的引擎保持空频谱槽 | 中 | S |
| 首页内置 B 站/抖音卡片根据实际登录状态显示“实时”更新语义 | **已实现（源码级，设备待验）**（`4c879b1`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/HomeViewModel.kt:22-59`、`ui/screen/home/HomeComposeScreen.kt:1130-1160`；PodJS `src/ui/HomeScreen.tsx`、`src/bili/client.ts`、`src/douyin/client.ts` 根据实际会话状态生成平台卡片语义 | 低 | S |
| 首次加载完成后，无订阅时显示“还没有 RSS 频道”的明确空状态 | **已实现（源码级，设备待验）**（`b857422`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/home/HomeComposeScreen.kt:214-221,318-324`；PodJS `src/ui/HomeScreen.tsx` 在首次加载完成且无 RSS 频道时显示对应空状态 | 低 | S |
| 首页下拉刷新全部非内置 RSS 频道，并显示刷新状态/首个错误 | **已实现（源码级，设备待验）**（`b857422`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/home/HomeComposeScreen.kt:172-180`、`ui/viewmodel/HomeViewModel.kt:79-104`；PodJS `src/ui/HomeScreen.tsx`、`src/ui/screen.tsx`、`src/services.ts` 已接下拉刷新全部非内置频道，并报告首个错误 | 高 | M |
| 订阅列表展示标题、简介、更新时间、未读数和置顶样式，并按“置顶优先、sortOrder 倒序”排列 | **已实现（源码级，设备待验）**（`b857422`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/db/RssChannelDao.kt:12-25`、`ui/screen/home/HomeComposeScreen.kt:328-349,720-755`；PodJS `src/services.ts`、`src/ui/HomeScreen.tsx` 已改为置顶优先、逻辑 `sortOrder` 倒序，备忘录入口也参与同一排序 | 中 | S |
| 首页长按频道操作：移动到顶部、置顶/取消置顶、标记已读、删除（含确认）；变更写入 RSS source 同步状态 | **已实现（源码级，设备待验）**（`b857422`） | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ChannelActionsActivity.kt:55-166`、`data/rss/DefaultRssRepository.kt:1315-1354,1465-1486`；PodJS `src/ui/HomeScreen.tsx`、`src/services.ts`、`src/sync/local-rss-actions.ts` 已接完整长按操作、危险动作确认及 source/change-log 同步状态写入 | 中 | M |
| 添加订阅：URL 输入与校验、解析预览、错误重试/取消、确认添加、识别已有订阅并直达频道；内置 B 站/抖音入口走对应页面 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/AddRssViewModel.kt:14-123`、`AddRssActivity.kt:25-88`；PodJS `src/ui/AddRssScreen.tsx`、`src/rss/add-channel.ts`、`src/services.ts` | 高 | S |
| 推荐订阅按媒体分组，保持当前六组及组内地址顺序，点击后预填添加流程 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/RssRecommendActivity.kt:10-27`、`RssRecommendGroupActivity.kt:15-34`、`data/rss/RssRecommendations.kt:15-87`；PodJS `src/ui/RecommendationScreen.tsx`、`src/rss/recommendations.ts`、`src/ui/screen.tsx` | 中 | S |
| 频道文章列表：未读标识、标题/摘要/封面、12 条首屏与每次 8 条增量（最多 200）、到底自动/手动加载、下拉刷新、点击标已读 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/FeedActivity.kt:41-105`、`ui/viewmodel/FeedViewModel.kt:26-85,125-129`；PodJS `src/ui/RssScreens.tsx`、`src/ui/feed-window.ts`、`src/ui/screen.tsx` | 高 | S |
| 频道列表条目左滑快捷收藏/稍后再看、长按打开条目操作；原文模式下仅对稳定可见范围预取并在滚动时暂停更新 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/FeedActivity.kt:83-104`、`ui/viewmodel/FeedViewModel.kt:88-119`；PodJS `src/ui/RssScreens.tsx`、`src/ui/screen.tsx`、`src/reader/original-cache.ts` | 高 | S |
| 频道详情：标题、简介、地址、更新时间、未读数，以及设置、频道内搜索、分享、标记已读 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ChannelDetailActivity.kt:42-95`；PodJS `src/ui/ChannelScreens.tsx`、`src/ui/screen.tsx`、`src/sharing/policy.ts` | 中 | S |
| 频道设置：原文阅读模式、仅有可播放媒体时显示后台续播、可清空本地导入频道、删除频道，危险操作二次确认 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ChannelSettingsActivity.kt:38-123`、`ui/viewmodel/ChannelDetailViewModel.kt:20-57`；PodJS `src/ui/ChannelScreens.tsx`、`src/services.ts`、`src/core/imported-content.ts` | 高 | S |
| 频道内搜索：180ms 防抖、最多 120 条、标题/摘要/正文/原文及分块边界匹配、命中片段与关键词高亮、点击进入文章 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/viewmodel/RssSearchViewModel.kt:20-48`、`RssSearchActivity.kt:20-39`；PodJS `src/ui/RssSearchScreen.tsx`、`src/rss/search-snippet.ts`、`src/services.ts` | 高 | S |
| 收藏与稍后再看：离线列表、RSS/平台内容打开、左滑移除、3 秒撤回、长按拖动排序；读完“稍后再看”条目自动移除 | **已实现** | 原生 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/SavedItemsActivity.kt:26-127`、`ui/viewmodel/SavedItemsViewModel.kt:17-43`；PodJS `src/ui/SavedItemsScreen.tsx`、`src/ui/screen.tsx`、`src/reader/watch-later-completion.ts` | 高 | S |
| 与手机的协议对齐：protocol v14 双向同步 RSS sources、文章正文/分块、收藏/稍后再看、排序、删除和阅读状态 | **已实现（源码级）**：已找到同版本 action、游标/manifest/article 阶段及 source/save 合并路径；本任务未做设备互通验证 | 原生手机 `Android_WatchRSS_Phone/app/src/main/java/com/lightningstudio/watchrss/phone/connection/bluetooth/BluetoothSyncProtocol.kt:11-30`、`PhoneBluetoothSyncManager.kt:458-566`、`LibrarySyncPayload.kt:63-83,138-180`；PodJS `src/sync/protocol.ts`、`src/sync/session.ts`、`src/sync/library-repository.ts`、`src/sync/source-store.ts`、`src/sync/saved-state.ts` | 高 | S |

本区域结论：首页刷新、频道排序/操作、无订阅空态、进行中朗读及平台登录语义已有源码路径。公告/推送服务与 UI 已写入，但版本公告开关保持关闭；PodJS 独立包名和宿主缺少 `packageUpdate` 使安装分发策略仍待用户决策。上述完成项均未取得本轮设备证据。
