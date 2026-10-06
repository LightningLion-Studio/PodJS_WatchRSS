# A9：迁移剩余差距审计 C

审计日期：2026-10-06；执行者：wrss-impl；范围：只读源码审计，文档交付 DONE，产品总体迁移未宣告完成。

## 基线与判定边界

- 应用 master：`050a75a0178d8a09b35d19717e525acf2054971f`；框架：`904a4fc2907370d3b1c3919aa46603e804b630fd`，均已用 `git rev-parse HEAD` 核对。
- 原生参考 HEAD：`734121c3c11304f4ef014b75aa3c5a21f4caf55f`。原生工作区并非干净：RSS Repository/DAO、导入标识、蓝牙/IP 同步等已有未提交改动；本文使用当前工作区代码，不把它称为纯 HEAD 快照。应用已有 takeover 文档/脚本等他人改动；本任务不修改这些文件。
- `N/` = `/home/wilf/data/OPPO_Develop/Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/`；`ND/` = 该应用 `app/src/debug/`；`F/` = `/home/wilf/data/PodJS/podjs-watch/`；`src/` 为本应用。下表 `文件:行` 均对应本次读取代码。
- **已实现**：当前主要页面/数据/宿主调用链存在；不表示每个异常分支、真实服务、设备或视觉验收通过。**部分**：存在已确认的行为或入口差异。**缺失**：未找到对应路径。**debug-only**：单列构建门控及完成度。**有意不迁移（需用户决策）**：仅提出范围决策，未经用户确认不能关闭。
- 以 release 用户入口为优先；manifest 声明不等于 release 可达。所有原生 debug 功能仍在用户要求的迁移范围；只能由 host `application.buildInfo().debugBuild` 开启。圆屏非阅读页纯黑、阅读页预设背景、不复刻 debug vignette 是 LEAD_BRIEF 已明确的选择，不列作缺口。
- S：约 1 人日以内；M：约 2–5 人日；L：超过 5 人日。只估补齐及针对性验证；不是承诺。UI 归 lead，逻辑归 agent，宿主能力归 framework。
- 已参考 A/A2/B、implementation-status、activity-restoration-audit；以下结论重新核对代码。没有构建、运行测试、ADB、安装、截图或真实账号操作；本次设备证据统一 **PENDING**。只读文档任务不执行 LEAD_BRIEF 的通用构建流程。

## 优先处理的 Top 15

| ID / 优先级 | 判定、缺口 | 原生位置 | PodJS 当前位置 | 用户可见影响 | 规模 / 建议归属 |
|---|---|---|---|---|---|
| C01 / P1 | 部分：版本公告关闭，APK 检查、安装及实时下载进度缺失 | `N/HomeFeedListActivity.kt:189`、`N/data/announcement/AnnouncementRepository.kt:34` | `src/announcement/home.ts:6` 固定 false；`src/announcement/host.ts:39` 的 inspectApk/installApk/progress 为 false | 无应用内升级闭环；推送弹窗不是版本更新替代。最终接管原生包名已决定，但发布渠道、签名/版本校验及安装实现仍需落实 | L；framework + agent；lead 落实分发方案 |
| C02 / P1 | 部分：抖音 RSS 列表缺长按操作和收藏/稍后看侧滑入口 | `N/DouyinEntryActivity.kt:258`、`N/ui/screen/douyin/DouyinRssFeedScreen.kt:170` | `src/ui/douyin/index.tsx:222` 普通 onPress 卡片，`:224` 无长按/侧滑处理 | 关闭原文模式后无法像原生在列表直接收藏/稍后看，操作页虽存在却未从此列表接入 | M；lead（UI）+ agent（携带 item） |
| C03 / P1 | 部分：抖音 RSS 分页裁掉旧项目且未按 awemeId 去重；刷新/加载更多改为按钮 | `N/ui/viewmodel/DouyinFeedViewModel.kt:754` 的 incoming 去重、sourceItems + incoming；`N/ui/screen/douyin/DouyinRssFeedScreen.kt:56` | `src/ui/douyin/index.tsx:75`、`:220` 直接拼接后 slice(-40)，`:223` 按钮分页 | 超过 40 条后早期内容消失，服务端重叠页可重复；浏览与触底加载行为不同 | M；agent；lead 接刷新/触底 |
| C04 / P1 | 部分：抖音操作页丢失现有 item，强制重新请求详情 | `N/DouyinVideoActionsActivity.kt:37`、`:59` 用 Intent 中现成视频构造保存项 | `src/ui/douyin/index.tsx:36` actions 只带 ID，`:289` fetchDetail 成功前 item=null | 已有视频元数据时，断网/解析失败仍无法执行本地收藏与稍后看；分享标题也可能降级 | M；agent；lead 做最小参数接线 |
| C05 / P1 | 部分：B 站收藏后的离线预览视频缓存及缓存源回退缺失 | `N/BiliVideoActionsActivity.kt:194`、`N/ui/viewmodel/BiliDetailViewModel.kt:267`、`N/data/bili/BiliRepository.kt:606`、`:634` | `src/media-services.ts:19` onSaved 只写统一 SQL；`src/bili/client.ts` 无预览片段下载；`src/cache/managed.ts:66` 是图片 acquire | 收藏元数据和封面已有，不能等同原生 MP4 片段离线回退；现有 URL 候选重试不能替代本地片段 | L；agent；必要流式/Range 能力由 framework 支持 |
| C06 / P1 | 部分：首页备忘录移动到顶部/置顶没有 UI 调用 | `N/HomeFeedListActivity.kt:304`、`N/ChannelActionsActivity.kt:78`、`:92` | `src/ui/HomeScreen.tsx:104` notes row 不带 channel；`:115` 长按只命中 channel；`src/ui/home-placement.ts:20`/`:25` 方法无 UI caller | 可读已同步/已有排序，却无法在手表修改备忘录入口位置 | S；lead + agent |
| C07 / P2 | 部分：B 站详情选中分 P 后没有延迟预热 | `N/ui/viewmodel/BiliDetailViewModel.kt:331`、`N/data/bili/BiliRepository.kt:426` | `src/bili/detail.ts:34`、`:55` 加载/选择不预热；`src/ui/bili/index.tsx:417` 点击播放时才解析 | 首次播放缺少原生提前准备路径；影响启动等待，但本次未测量延迟 | M；agent；需要播放器预热时交 framework |
| C08 / P2 | 部分：首页频道长按菜单缺本地导入频道“清空” | `N/ChannelActionsActivity.kt:67`、`:113` | `src/ui/HomeScreen.tsx:43` 仅移动/置顶/已读/删除；`src/ui/routes/rss.tsx:208` 设置页已有清空 | 仍可进频道设置清空，但原生快捷入口缺失；不要误写成清空逻辑全缺 | S；lead |
| C09 / P2 | 部分：B 站视频操作页改为选收藏夹，成功后不返回 | `N/BiliVideoActionsActivity.kt:80`、`:138`、`:168` | `src/ui/bili/index.tsx:553`–`:557` 展开文件夹、setMessage，无成功 onBack | 原生一次默认收藏/稍后看后关闭；当前需要选夹且留在操作页，返回栈与操作次数不同 | S；lead；agent 核对默认收藏夹策略 |
| C10 / P2 | 部分：抖音操作成功/分享后不关闭操作页 | `N/DouyinVideoActionsActivity.kt:134`、`:163`–`:166` | `src/ui/douyin/index.tsx:290`–`:292` 只更新文案或 push share | 返回会再次看到操作页，可再次切换保存状态；与原生 finish 不一致 | S；lead |
| C11 / P2 | 部分：release 抖音登录页额外开放手工 Cookie 输入 | `N/ui/screen/douyin/DouyinLoginScreen.kt:155` 为 WebView 提取；`ND/java/com/lightningstudio/watchrss/debug/DouyinPlaybackDebugReceiver.kt` 为 debug 导入 | `src/ui/douyin/index.tsx:162`、`:179` 无 debugGate；另有 `src/debug/douyin.ts:19` 门控导入 | 正式页显示原生没有的调试式登录入口；应按已明确的 host-debug 规则收口，或由用户明确批准产品例外 | S；lead + agent |
| C12 / P2 | 部分：抖音详情收藏从临时 UI 状态变为持久化 | `N/DouyinDetailActivity.kt:82` 仅切 remember 状态/Toast | `src/ui/douyin/index.tsx:253`–`:257` 读取并写统一保存库 | 同一详情按钮会实际改变收藏及后续同步。可能是合理改进，但不是原生零差异；需用户决定保留增强或回归原行为 | S；agent + lead；用户决策 |
| C13 / P2 | 部分：抖音设置缺原生共用设置页的手机下载控件，删除确认结构不同 | `N/DouyinSettingsActivity.kt:98` 使用 BiliSettingsScreen；`N/ui/screen/bili/BiliSettingsScreen.kt:118` 下载按钮 | `src/ui/douyin/index.tsx:306` 无下载按钮，确认替换整页；B 站 `src/ui/bili/index.tsx:603` 已有下载控件 | 页面/控件结构与原生不一致；共用原生按钮文案含 B 站记录，是否照搬文案由 lead 决定 | S；lead |
| C14 / P3 | 部分：启动页只有 guest 覆盖层退出，未见对应系统 Splash 退出控制 | `N/MainActivity.kt:33`、`:105` | `src/ui/StartupGate.tsx:108`、`src/ui/startup-transition.ts:1`；当前 Android app/runtime 未找到 installSplashScreen 等原生对应接线 | 系统启动面与 guest 品牌层交接不能声明原生一致；仅源码差异，实际闪屏/时延未验证 | M；framework；lead 验收 |
| C15 / P3 debug | debug-only／部分：调试操作已有 UI，但原生外部 alias/广播和 provider dump 契约缺失 | `ND/AndroidManifest.xml:9`、`:19`；`N/debug/DebugLogProvider.kt:33` | `src/debug/douyin.ts:4`、`src/ui/DebugToolsScreen.tsx:44`；F Android manifests 无对应 alias/receiver/provider | 手工调试能做多项操作，原生外部自动化的 OPEN_DOUYIN、故障注入广播、--douyin-playback/--clear dump 无法原样使用；AppLogger/pullDebugLog 不是 provider API | M；framework + agent；不得开放到 release |

## 额外范围决策与非缺口

- C16：**有意不迁移（需用户决策）候选**：独立 `LlmSummaryActivity` 页面。`N/LlmSummaryActivity.kt:15` 确有完整页，但全原生 main 源码搜索未找到外部 createIntent 调用；正式文章 `N/DetailActivity.kt:151` 直接 prepareAndStart，PodJS `src/ui/ReaderScreen.tsx:69`/`:119` 已有内联总结、重试和 token。独立 route 无；影响是旧显式 Activity/调试入口不等价，非正式总结功能缺失。S，lead；用户决定是否迁移隐藏独立页。不能把未批准的候选记成已豁免。
- 首页横向快捷侧滑：`N/HomeFeedListActivity.kt:278` 明确 `enableChannelSwipeActions=false`，不列正式缺口；首页频道长按仍需 C08、备忘录长按仍需 C06。
- B 站评论入口：`src/ui/bili/index.tsx:383` 与原生详情 showCommentEntry=false 一致；评论/楼中楼路由仍有实现。不要为补“缺口”擅自开放入口。
- TTS/LLM 配置、B 站记录不支持声波：`src/phoneconnection/session.ts:28` 与原生对应未支持分支一致，不列新增缺失。
- 不将模块内备用 PlayerScreen 的“由宿主显示”文案判成播放器未迁移：正式播放由 `src/ui/routes/media.tsx` → `VideoPlayerScreen` 接管。

## Manifest 全量 Activity / 页面核对（70 项）

每行同时核对声明、原生页面回调及当前 PodJS 路由/组件。已实现仅指上述源码审计口径；差异影响/规模/归属由 C 编号表统一给出。

| 原生 Activity 源码入口 | 状态 | PodJS 入口 | 核对结果 |
|---|---|---|---|
| `N/MainActivity.kt:25` | 部分 | `src/ui/StartupGate.tsx:44` | OOBE/隐私版本门禁、恢复；系统启动面见 C14 |
| `N/HomeFeedListActivity.kt:62` | 部分 | `src/ui/HomeScreen.tsx:58` | 频道、推荐、刷新、朗读卡片；C01/C06/C08 |
| `N/AddRssActivity.kt:20` | 已实现 | `src/ui/AddRssScreen.tsx:13` | 输入→预览→确认/已有频道；内联输入和远程输入 |
| `N/RssRecommendActivity.kt:10` | 已实现 | `src/ui/RecommendationScreen.tsx:9` | 分组→推荐项→添加预填；routes/info 接组 ID |
| `N/RssRecommendGroupActivity.kt:10` | 已实现 | `src/ui/RecommendationScreen.tsx:9` | 分组→推荐项→添加预填；routes/info 接组 ID |
| `N/OobeActivity.kt:22` | 已实现 | `src/ui/OnboardingScreen.tsx:40` | 四步引导、法律正文、配置预览、联网检测 |
| `N/PrivacyPolicyConsentActivity.kt:19` | 已实现 | `src/ui/PrivacyPolicyConsentScreen.tsx:9` | 政策升级同意/退出门禁 |
| `N/FeedActivity.kt:20` | 已实现 | `src/ui/RssScreens.tsx:16` | RSS 分页、刷新、已读、侧滑保存、原文请求 |
| `N/ChannelActionsActivity.kt:29` | 部分 | `src/ui/HomeScreen.tsx:39` | 频道操作存在；备忘录动作/导入频道清空入口见 C06/C08 |
| `N/ItemActionsActivity.kt:26` | 已实现 | `src/ui/RssScreens.tsx:75` | 收藏/稍后看/分享、导入条目删除确认 |
| `N/NoteActionsActivity.kt:25` | 已实现 | `src/ui/NotesScreen.tsx:176` | 置顶、移动文件夹、删除确认 |
| `N/DetailActivity.kt:28` | 已实现 | `src/ui/ReaderScreen.tsx:37` | 正文/原文、媒体、AI、朗读、滚动控制、进度/退出结果 |
| `N/ShareQrActivity.kt:11` | 已实现 | `src/ui/ShareQrScreen.tsx:23` | 分享 QR、比例、标题、错误态 |
| `N/WebViewActivity.kt:57` | 已实现 | `src/browser/open.ts:32` | system.browser.inApp；宿主历史/缩放/主题/恢复；旧 host fallback 不代表当前缺失 |
| `N/ChannelDetailActivity.kt:28` | 已实现 | `src/ui/ChannelScreens.tsx:21` | 说明/搜索/分享/已读；原文、后台播放、清空/删除确认 |
| `N/RssSearchActivity.kt:15` | 已实现 | `src/ui/RssSearchScreen.tsx:19` | 频道搜索、摘要高亮、点击阅读 |
| `N/ChannelSettingsActivity.kt:25` | 已实现 | `src/ui/ChannelScreens.tsx:21` | 说明/搜索/分享/已读；原文、后台播放、清空/删除确认 |
| `N/SettingsActivity.kt:17` | 已实现 | `src/ui/SettingsScreen.tsx:52` | 阅读/AI/音量/缓存/分享/同步保活；调试配置另列 |
| `N/ReaderPresetActivity.kt:68` | 已实现 | `src/ui/ReaderPresetScreen.tsx:26` | 明暗、日程、日出日落定位、预设选择 |
| `N/ReaderPresetPreviewActivity.kt:71` | 已实现 | `src/ui/ReaderPreviewScreen.tsx:26` | 手机实时预览会话、字号/字体/背景，非本地新编辑器 |
| `N/AdvancedSettingsActivity.kt:11` | 已实现 | `src/ui/SettingsScreen.tsx:52` | 阅读/AI/音量/缓存/分享/同步保活；调试配置另列 |
| `N/TtsSettingsActivity.kt:15` | 已实现 | `src/ui/SettingsScreen.tsx:73` | release 语速/播放设置与手机配置；详细引擎/API 配置在 debug-tools，非全页 debug-only |
| `N/LlmPromptPresetActivity.kt:15` | 已实现 | `src/ui/LlmPromptPresetScreen.tsx:9` | 四种提示词选择 |
| `N/LlmSummaryActivity.kt:15` | 有意不迁移（需用户决策）候选 | `src/ui/ReaderScreen.tsx:37` | 内联总结主路径已实现；独立页面未迁，C16 |
| `N/LlmTokenUsageActivity.kt:13` | 已实现 | `src/ui/LlmUsageScreen.tsx:10` | 汇总/图表/记录/清空及订阅刷新 |
| `N/ReadAloudPlaybackActivity.kt:14` | 已实现 | `src/ui/SpeechPlaybackScreen.tsx:14` | 上/下段、暂停、停止、自动续读、语速、返回文章 |
| `N/AutoScrollControlActivity.kt:18` | 已实现 | `src/ui/AutoScrollSettingsScreen.tsx:24` | 独立设置与阅读会话控制两种路由 |
| `N/ProfileActivity.kt:10` | 已实现 | `src/ui/ProfileScreen.tsx:5` | 账号/保存/手机/设置/关于/联系/备案 |
| `N/NotesActivity.kt:131` | 已实现 | `src/ui/NotesScreen.tsx:44` | 列表、新建、Markdown 阅读、内联标题正文、自动保存、撤销重做、光标锚点 |
| `N/NotesActivity.kt:167` | 已实现 | `src/ui/NotesScreen.tsx:44` | 列表、新建、Markdown 阅读、内联标题正文、自动保存、撤销重做、光标锚点 |
| `N/AccountStatusActivity.kt:30` | 已实现 | `src/ui/AccountStatusScreen.tsx:10` | 账号有效期/权益；debug 云状态由实际 service 提供 |
| `N/PhoneConnectionActivity.kt:11` | 已实现 | `src/ui/PhoneConnectionScreen.tsx:9` | 原生正式页面本就是说明/手机下载；不误要求选择传输方式 |
| `N/BluetoothConnectionActivity.kt:44` | 已实现 | `src/ui/BluetoothConnectionScreen.tsx:20` | 状态/重试/remote input；常规同步由全局管理器运行 |
| `N/AcousticConnectionActivity.kt:59` | debug-only | `src/ui/AcousticConnectionScreen.tsx:28` | debug-only／已实现纯声波、引导 Wi-Fi、选择能力及调试 payload；真机待验 |
| `N/DebugAcousticConnectionActivity.kt:8` | debug-only | `src/ui/AcousticConnectionScreen.tsx:28` | debug-only／已实现纯声波、引导 Wi-Fi、选择能力及调试 payload；真机待验 |
| `N/DebugBluetoothSyncActivity.kt:19` | debug-only | `src/debug/bluetooth.ts:14` | debug-only／一次同步工具与实际 transport；外部 Activity extras 不是同一 ABI |
| `N/PhoneConnectionUnavailableActivity.kt:17` | 已实现 | `src/ui/PhoneConnectionUnavailableScreen.tsx:7` | 不可用原因页面 |
| `N/SavedItemsActivity.kt:26` | 已实现 | `src/ui/SavedItemsScreen.tsx:30` | 收藏/稍后看、移除/撤销、排序、阅读退出处理、手机导出 |
| `N/AboutActivity.kt:9` | 已实现 | `src/ui/InformationScreens.tsx:45` | 各 information route 可达；正文/远端法律/作者/联系/二维码/日志说明；Info 带恢复快照 |
| `N/CollaboratorsActivity.kt:8` | 已实现 | `src/ui/InformationScreens.tsx:45` | 各 information route 可达；正文/远端法律/作者/联系/二维码/日志说明；Info 带恢复快照 |
| `N/InfoActivity.kt:45` | 已实现 | `src/ui/InformationScreens.tsx:45` | 各 information route 可达；正文/远端法律/作者/联系/二维码/日志说明；Info 带恢复快照 |
| `N/BiliDetailActivity.kt:25` | 部分 | `src/ui/bili/index.tsx:401` | 原文/RSS 双模式、分 P、互动、本地详情兜底；C05/C07 |
| `N/BiliChannelInfoActivity.kt:26` | 已实现 | `src/ui/bili/index.tsx:185` | 登录/设置/搜索/历史/收藏/稍后看入口 |
| `N/BiliSettingsActivity.kt:31` | 已实现 | `src/ui/bili/index.tsx:582` | 原文/后台开关、退出清理、删除确认、手机下载 |
| `N/BiliListActivity.kt:21` | 已实现 | `src/ui/bili/index.tsx:247` | 历史、稍后看、首收藏夹及分页 |
| `N/BiliLoginActivity.kt:20` | 已实现 | `src/ui/bili/index.tsx:291` | QR 申请/轮询/状态/刷新/账号保存 |
| `N/BiliPlayerActivity.kt:25` | 部分 | `src/ui/VideoPlayerScreen.tsx:40` | MP4/DASH/headers/候选回退/进度/历史；本地预览片段缺 C05 |
| `N/BiliVideoActionsActivity.kt:27` | 部分 | `src/ui/bili/index.tsx:552` | 远端+本地保存已有；C05/C09 |
| `N/ImagePreviewActivity.kt:10` | 已实现 | `src/ui/ImagePreviewScreen.tsx:10` | 原尺寸瓦片、EXIF、缺图提示、旋转/缩放/平移/返回 |
| `N/RssPlayerActivity.kt:25` | 已实现 | `src/ui/VideoPlayerScreen.tsx:40` | RSS 音视频和抖音详情单片播放、失效 URL 重解、网络提示 |
| `N/BiliEntryActivity.kt:11` | 已实现 | `src/ui/bili/index.tsx:104` | 缓存推荐、分页去重、长按/侧滑、边缘菜单；旧 B 的手势缺口已关闭 |
| `N/BiliCommentActivity.kt:14` | 已实现 | `src/ui/bili/CommentScreen.tsx:64` | 置顶/正文/头像/表情/图片/回复及分页；独立路由，详情入口同原生隐藏 |
| `N/BiliReplyDetailActivity.kt:14` | 已实现 | `src/ui/bili/CommentScreen.tsx:64` | 置顶/正文/头像/表情/图片/回复及分页；独立路由，详情入口同原生隐藏 |
| `N/BiliSearchActivity.kt:22` | 已实现 | `src/ui/bili/index.tsx:327` | 热搜/历史/清空、BV/av 直达、结果分页 |
| `N/DouyinEntryActivity.kt:46` | 部分 | `src/ui/douyin/ImmersiveEntry.tsx:10` | 原文沉浸/预热/恢复/故障跳过已有；RSS 模式 C02/C03 |
| `N/DouyinChannelInfoActivity.kt:28` | 已实现 | `src/ui/douyin/index.tsx:102` | 频道说明、URL、登录/设置/历史 |
| `N/DouyinHistoryActivity.kt:25` | 已实现 | `src/ui/douyin/index.tsx:278` | 本地历史/清空→详情单片播放；旧 B 历史整队列结论已过时 |
| `N/DouyinSettingsActivity.kt:35` | 部分 | `src/ui/douyin/index.tsx:302` | 原文/后台/退出清理/删除存在；C13 |
| `N/DouyinLoginActivity.kt:24` | 部分 | `src/ui/douyin/index.tsx:114` | 官方 WebView、网络门禁、QR/二验；C11 |
| `N/DouyinPlayerActivity.kt:36` | 已实现 | `src/ui/VideoPlayerScreen.tsx:40` | 队列切换/播控/旋转缩放/音量/后台/恢复；宿主 session 路径 |
| `N/DouyinVideoActionsActivity.kt:28` | 部分 | `src/ui/douyin/index.tsx:287` | 统一 SQL 保存已有；离线操作/关闭差异 C04/C10 |
| `N/DouyinDetailActivity.kt:25` | 部分 | `src/ui/douyin/index.tsx:227` | 阅读预设、传入/history/saved 元数据、播放；收藏语义 C12 |
| `N/ContactDeveloperActivity.kt:17` | 已实现 | `src/ui/InformationScreens.tsx:45` | 各 information route 可达；正文/远端法律/作者/联系/二维码/日志说明；Info 带恢复快照 |
| `N/JoinGroupActivity.kt:8` | 已实现 | `src/ui/InformationScreens.tsx:45` | 各 information route 可达；正文/远端法律/作者/联系/二维码/日志说明；Info 带恢复快照 |
| `N/LogUploadPrivacyActivity.kt:8` | 已实现 | `src/ui/InformationScreens.tsx:45` | 各 information route 可达；正文/远端法律/作者/联系/二维码/日志说明；Info 带恢复快照 |
| `N/LogUploadActivity.kt:24` | 已实现 | `src/ui/LogUploadScreen.tsx:8` | 全应用日志源、加密上传及取件码；真实服务器未验 |
| `N/ServerActivity.kt:19` | 已实现 | `src/ui/RemoteInputScreen.tsx:17` | HTTP 输入/保存导出/记录；TTS 配置由 TtsConfigScreen 接线 |
| `N/BeianActivity.kt:10` | 已实现 | `src/ui/BeianScreen.tsx:38` | 标题、网址、QR 及真实测量/blur 能力 |
| `N/debug/PerfLargeListActivity.kt:18` | debug-only | `src/debug/perf.ts:3` | debug-only／正式组件 10000 项/大文章、真实宿主帧指标；不是 JS 假帧率 |
| `N/debug/PerfLargeArticleActivity.kt:20` | debug-only | `src/debug/perf.ts:3` | debug-only／正式组件 10000 项/大文章、真实宿主帧指标；不是 JS 假帧率 |

原生 main manifest 没有声明 Android `<service>`；后台能力由应用管理器与 WorkManager 承担。debug manifest 仅覆盖 DouyinEntry 启动模式并新增 DouyinDebugEntry alias、DouyinPlaybackDebugReceiver，均纳入 C15；profileableRelease manifest 只加 profileable 标志，不新增页面。FileProvider 是文件共享基础设施，框架已有自身 provider；不要求原样复制 authority。DebugLogProvider 单列 C15。

## ViewModel 骨架核对

以下逐个覆盖原生 `*ViewModel.kt`（Factory 为构造设施，不另作产品页）。同名类不是迁移要求：PodJS controller/service 及组件回调共同承担功能。

| 原生 | 状态 | PodJS 主实现 | 结果 |
|---|---|---|---|
| `N/ui/viewmodel/AddRssViewModel.kt:33` | 已实现 | `src/services.ts:266` | URL 规范化、预览/确认、已有源 |
| `N/ui/viewmodel/BiliCommentViewModel.kt:16` | 已实现 | `src/bili/comments.ts:13` | 主评论分页/置顶去重/正文/富文本 |
| `N/ui/viewmodel/BiliDetailViewModel.kt:41` | 部分 | `src/bili/detail.ts:24` | 分 P/互动/离线详情已有；预热/片段 C05/C07 |
| `N/ui/viewmodel/BiliFeedViewModel.kt:29` | 已实现 | `src/bili/browse.ts:66` | 缓存先显、去重分页及 feed 快捷互动 |
| `N/ui/viewmodel/BiliListViewModel.kt:54` | 已实现 | `src/bili/browse.ts:59` | 历史游标、首收藏夹分页、稍后看 |
| `N/ui/viewmodel/BiliLoginViewModel.kt:26` | 已实现 | `src/ui/bili/index.tsx:291` | QR 请求/轮询/更新/取消 |
| `N/ui/viewmodel/BiliPlayerViewModel.kt:49` | 部分 | `src/bili/playback.ts:12` | 进度/checkpoint/远端历史及源恢复已有；本地片段 C05 |
| `N/ui/viewmodel/BiliReplyViewModel.kt:18` | 已实现 | `src/ui/bili/CommentScreen.tsx:30` | root + 楼中楼分页；原生 root 接线也有历史限制，不作为 PodJS 额外缺口 |
| `N/ui/viewmodel/BiliSearchResultViewModel.kt:18` | 已实现 | `src/bili/browse.ts:53` | 查询、分页/失效响应处理 |
| `N/ui/viewmodel/BiliSearchViewModel.kt:33` | 已实现 | `src/bili/browse.ts:14` | 热搜/历史/清空及 BV/av 直达 |
| `N/ui/viewmodel/BiliSettingsViewModel.kt:25` | 已实现 | `src/media/logout.ts:6` | 账号/互动/进度/预览清理，保留 feed/search/saved |
| `N/ui/viewmodel/ChannelActionsViewModel.kt:11` | 部分 | `src/services.ts:164` | 逻辑已有；首页清空入口 C08 |
| `N/ui/viewmodel/ChannelDetailViewModel.kt:11` | 已实现 | `src/ui/ChannelScreens.tsx:21` | 信息、搜索、已读与频道设置 |
| `N/ui/viewmodel/DetailViewModel.kt:36` | 已实现 | `src/ui/ReaderScreen.tsx:37` | 正文/原文、离线重试、阅读进度与自动滚动 |
| `N/ui/viewmodel/DouyinFeedViewModel.kt:70` | 部分 | `src/douyin/feed-store.ts:5` | 沉浸 feed/recent/预热/故障跳过已有；RSS C02/C03/C04 |
| `N/ui/viewmodel/DouyinSettingsViewModel.kt:26` | 部分 | `src/media/logout.ts:13` | 退出清 cookie/WebView/cache/recent；设置 UI C13 |
| `N/ui/viewmodel/FeedViewModel.kt:22` | 已实现 | `src/ui/routes/rss.tsx:80` | 刷新/分页/侧滑/原文更新暂停 |
| `N/ui/viewmodel/HomeViewModel.kt:27` | 部分 | `src/ui/screen.tsx:985` | 刷新/排序/置顶/删除已接；notes 入口 C06 |
| `N/ui/viewmodel/ItemActionsViewModel.kt:14` | 已实现 | `src/ui/RssScreens.tsx:75` | 保存/删除/分享 |
| `N/ui/viewmodel/LlmSummaryViewModel.kt:75` | 已实现 | `src/llm/summary.ts:54` | 等待正文/清理截取/默认模型/授权重试/消耗记录；独立页 C16 |
| `N/ui/viewmodel/LlmTokenUsageViewModel.kt:16` | 已实现 | `src/ui/LlmUsageScreen.tsx:10` | 统计/清空/变化订阅 |
| `N/ui/viewmodel/OobeViewModel.kt:28` | 已实现 | `src/onboarding/controller.ts:7` | 页码/同意/门禁与恢复 |
| `N/ui/viewmodel/RssPlayerViewModel.kt:28` | 已实现 | `src/ui/routes/media-controller.ts:48` | 原始 URL、抖音重解、故障回退与单片播放 |
| `N/ui/viewmodel/RssSearchViewModel.kt:21` | 已实现 | `src/services.ts:207` | 查询 SQL、摘要/关键词 |
| `N/ui/viewmodel/SavedItemsViewModel.kt:17` | 已实现 | `src/ui/routes/saved-controller.ts:16` | 双保存类型、撤销、排序、退出移除策略 |
| `N/ui/viewmodel/SettingsViewModel.kt:22` | 已实现 | `src/settings/store.ts:42` | 设置持久化；services/screen 接缓存、音量、AI、分享与同步保活 |
| `N/ui/viewmodel/TtsSettingsViewModel.kt:53` | 部分 / debug-only 子集 | `src/debug/tts.ts:8` | release 语速/手机配置已有；详细字段编辑 C17 |

### C17：详细 TTS 调试页仍是子集

**debug-only／部分，P3，M，lead + agent**。原生 `N/ui/viewmodel/TtsSettingsViewModel.kt:174`、`:187`、`:218`、`:231` 支持修改 model、voiceId、baseUrl、API key；PodJS `src/ui/DebugToolsScreen.tsx:47` 只有选择引擎、语速、状态和测试，`src/debug/tts.ts:10` 选择时应用默认字段。`TtsConfigScreen` 是手机配置 HTTP/QR 页面，不能代替手表详细编辑控件。手机同步及语音播放能力并非缺失；影响是无法在手表调试任意音色/端点/密钥。旧 A2 的“详细 TTS 未迁移”和旧 B 的“完整已补齐”都应改为此子集结论。所有补齐继续遵循 host debug 门控。

## Repository、Worker 与服务骨架

| 原生位置 | 状态 | PodJS 当前主路径 | 核对结果 / 剩余项 |
|---|---|---|---|
| `N/data/rss/RssRepository.kt:12`、`N/data/rss/DefaultRssRepository.kt:72` | 已实现（主要产品/同步路径） | `src/core/repository.ts:10`、`src/services.ts:149`、`src/sync/library-repository.ts:29` | 频道/文章/已读/双保存、排序、导入内容删除、正文/元数据与同步状态均有接线；首页操作入口问题见 C06/C08。不是全库协议形式化等价证明 |
| `N/data/rss/RssFetchService.kt:11`、`RssParseService.kt:9`、`RssReadableService.kt:11`（同目录） | 已实现（主路径） | `src/services.ts:95`、`src/core/parser.ts:27`、`src/reader/original-cache.ts:11` | RSS/Atom 获取、解析、原文抓取及请求取消/身份复查；离线媒体重试接 `src/reader/offline-media.ts`；不声称所有第三方 feed/HTML 边界已验 |
| `N/data/note/WatchNoteRepository.kt:8` | 已实现 | `src/notes/repository.ts:46`、`src/ui/routes/notes.tsx:34` | Markdown 保存、文件夹/置顶/删除、手机合并；光标锚点 `src/notes/editor-anchor.ts:50`、内联输入 `src/ui/NoteInlineEditor.tsx:69` 已存在，不沿用旧文档的“光标未实现” |
| `N/data/reader/ReaderPresetRepository.kt:30` | 已实现（当前手表产品面） | `src/reader/preset-store.ts:18`、`src/reader/preview-session.ts:7`、`src/sync/reader-actions.ts:4` | 选择/时间规则/定位、手机预设与资源同步/实时预览；原生 Repository 有 CRUD 不代表手表必须出现手机端编辑器 |
| `N/data/settings/SettingsRepository.kt:61` | 已实现（主路径） | `src/settings/store.ts:42`、`src/ui/routes/settings.tsx:59` | 设置读写→实际 UI/缓存/播控接线；详细 TTS 字段编辑见 C17 |
| `N/data/announcement/AnnouncementRepository.kt:18` | 部分 | `src/announcement/repository.ts:7`、`src/announcement/host.ts:35` | 版本解析/状态机存在，但产品版本公告关闭且缺安装能力，C01 |
| `N/data/push/PushNotificationRepository.kt:17` | 已实现 | `src/announcement/home.ts:13`、`src/ui/HomeNoticeDialog.tsx:6` | 版本开关 false 时仍 fetchNewMessages，不能将推送一起记成禁用 |
| `N/data/llm/LlmTokenUsageRepository.kt:13` | 已实现 | `src/llm/usage.ts:10`、`src/services.ts:155`、`src/sync/token-usage.ts:7` | 保存/汇总/清空/通知/同步；清空和变化由页面订阅 |
| `N/data/bili/BiliRepository.kt:66` | 部分 | `src/bili/client.ts:17`、`src/bili/browse.ts:7`、`src/bili/detail.ts:23`、`src/bili/playback.ts:15` | QR/session、浏览搜索评论互动、历史/进度和候选 URL 恢复存在；C05 本地预览片段、C07 详情预热仍缺。统一 SQL 保存已有，勿重复派工 |
| `N/data/douyin/DouyinRepository.kt:21` | 部分（UI 调用差异） | `src/douyin/client.ts:11`、`src/douyin/feed-store.ts:7`、`src/douyin/playback-queue.ts:8`、`src/media/logout.ts:6` | 登录、feed/detail、watch history、recent/feed cache、预热、退出清理存在；C02/C03/C04 属 RSS/UI 参数链差异，不等于整个沉浸引擎缺失 |
| `N/data/cache/ManagedCacheService.kt:49` | 部分 | `src/cache/managed.ts:12`、`src/cache/policy.ts:18` | 容量统计、淘汰顺序、抖音保留窗口、offline 不淘汰、bucket 清理已有；有 bili-preview bucket 不代表有 C05 MP4 生产者 |
| `N/data/cloud/WatchCloudSyncService.kt:33` | debug-only／已实现主路径 | `src/cloud/service.ts:31`、`src/cloud/runtime.ts:11`、`src/cloud/application.ts:14` | 已实例化；watch 注册、bootstrap/批准、heads、下载校验/解密/合并/ACK、导出/TUS、公共库、计费网络小状态/手动正文均有调用路径。端到端/异常组合未验 |
| `N/data/cloud/WatchCloudSyncWorker.kt:15` | debug-only／已实现主路径 | `src/cloud/background.ts:1`、`src/cloud/scheduler.ts:6`；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWork.java:14`、`PodCloudWorker.java:11` | 前台 5 分钟、账号/库/网络触发、6 小时 WorkManager、后台 handler；`pod.config.json:90` 已登记；release cancel。旧 B “无 worker/无运行时”结论作废 |

### 跨页面服务（不遗漏没有 Activity 的能力）

| 原生 | 当前路径与判定 | 说明 |
|---|---|---|
| `N/WatchRssApplication.kt:93` 全局蓝牙/IP；`N/phoneconnection/bluetooth/WatchBluetoothForegroundSyncManager.kt`、`WatchBluetoothSyncServer.kt`；`N/phoneconnection/ip/WatchIpSyncManager.kt` | 已实现主路径：`src/main.tsx:22`、`src/sync/application-host.ts:29`、`src/sync/application-foreground.ts`、`src/sync/ip-controller.ts` | 前台生命周期、BLE/mDNS/WebSocket、RFCOMM、账号/笔记/阅读预设/资源/正文/clear/ACK 均有实际 controller；正式双端、断连和大正文性能本次 PENDING |
| 原生同步实时预览、资源/资产和远程输入 | 已实现主路径：`src/sync/application-host.ts:34`、`src/sync/reader-preview.ts`、`src/sync/reader-resources.ts`、`src/sync/note-assets.ts`、`src/remote-input/http.ts` | pullDebugLog 仍是生产协议能力；不能因名称 Debug 整体禁用 |
| `N/phoneconnection/guided/WatchGuidedWifiClient.kt:98`、`N/AcousticConnectionActivity.kt:304`/`:364` | debug-only／已实现主路径：`src/phoneconnection/session.ts:47`、`:70`、`src/phoneconnection/codec.ts`；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodAcousticServices.java` | 真实 PCM、权限、Wi-Fi 会话、token HTTP、gzip/声波编解码均有代码；UI 手选模式/能力替代原生 extras，外部自动启动/返回结果 ABI 仍未原样迁移。若需要自动化兼容，归 C15 范围，M，framework + agent |
| `N/data/cloud/WatchCloudKeyManager.kt:30`、`WatchCloudCrypto.kt:139`（同目录） | debug-only／已实现：`src/cloud/keys.ts:11`、`src/cloud/codec.ts:38`、`src/cloud/cache.ts`、`src/cloud/tus.ts` | 私钥留在宿主、信封解封、多版本账号 key、分块加密/gzip/hash、缓存复用及 TUS；不是只有类型声明。`src/cloud/client.ts:37` 已是 platform=watch |
| 原生朗读 controller/音频、LLM 后端、统计上报 | 已实现主路径：`src/reader/speech-playback.ts:38`、`src/tts/speech-port.ts`、`src/llm/runtime.ts`、`src/telemetry/host.ts` | 云/本地语音、段落与阅读锚点、后台播控/音量、摘要调用与消耗记录；真实引擎声音/音量/后台存活本次 PENDING |
| `N/LogUploadActivity.kt:42`、`N/debug/DebugLogProvider.kt:33` | 上传主路径已实现：`src/logs/logger-host.ts:31`、`src/logs/host.ts`、`src/ui/LogUploadScreen.tsx`；provider 契约仍 C15 | AppLogger → 隐私同意 → gzip/AES/RSA framing → 上传/取件码；不能用源代码存在宣告后端取件成功 |
| `N/AppResumeStateStore.kt:10`、各 Activity saveable/VM | 已实现基础设施：`src/navigation/activity-navigation.ts:79`/`:100`、`src/navigation/activity-host.ts`、`src/ui/route-activity.tsx:10` | saved 与 retained 分离、route/args/滚动恢复、失效实体回退；Info/OOBE 法律正文另外有快照存储；网络请求、socket 和解码器不伪造恢复。物理 process-death / recreate 本次未验 |

## 对旧审计的修正

1. B 站 feed 长按/侧滑已接 `SwipeCard`（`src/ui/bili/index.tsx:149`）；收藏列表已直接进入首文件夹（`:277`）；这些旧缺口不再成立。视频操作页选夹差异仍存在，不能混淆两个入口。
2. 云同步不再是空壳：`src/main.tsx:22` 启动、`src/cloud/application.ts:24` 构造运行时，后台 handler/WorkManager 均存在；仍严格 debug-only，不应列为 release 缺失。
3. 声波/引导 Wi-Fi 已迁到 phoneconnection 与 PodAcousticServices；设备权限、音频、热点与手机互通未验证，不能继续写“源码无”。
4. 备忘录光标映射、宿主文档编辑会话以及阅读/Info/OOBE 恢复已存在；旧 implementation-status 的历史未完成段落不是当前缺口证据。
5. 抖音 history/detail 当前明确单片 RssPlayer（`src/ui/douyin/index.tsx:245`）；旧 B 声称历史全队列的结论不适用于此基线。沉浸流自己的 queue/prewarm 属另一条链。
6. 登录 QR/二验、应用内 WebView、统一媒体保存、清理 cookie/cache、日志上传、首页推送及大列表调试均已接；验收缺口与实现缺口分开。

## 验证范围与 lead 后续安排

本次执行的是源码交叉阅读、`rg` 调用点搜索、Git 基线/差异读取、manifest XML 枚举、70 项 Activity 与 27 项 ViewModel 映射完整性检查、文档引用路径/行号检查。没有运行测试或构建；没有声称历史测试/设备结果覆盖当前基线。没有改动应用/框架/原生源码，也未提交。

建议先派 **C02–C04 抖音 RSS 列表与离线操作链** 给 lead + agent，随后 C05/C07 B 站预览链；C06/C08 是小型首页入口任务。C01 由 framework 与 lead 独立收敛发布实现。C11 按既定 debug 门控规则修正；C12/C16 为具体产品范围决策，不能默认为获准。

需要 lead 调度的设备验收（本任务未执行）：同一基线安装后检查 round-screen RSS/notes 操作、在线/离线 B 站预览、抖音原文/RSS 切换及离线保存、release/debug Cookie 与 TTS/声波/云入口隔离；对真实已授权的同步隔离夹具做断连/ACK/长正文/后台唤醒，检查 recreate 与 process-death 恢复。真实账号更改和正式资料库写入按设备代理既有规则处理。截图仅用于控件是否存在/明显不同，不做像素级验收。


## 用户决策（2026-10-06）

- **C01 版本更新分发**：自建阿里云对象存储（OSS）托管 APK 与版本清单；优先级低，暂不排期。
- **C11 抖音手工 Cookie 输入**：保留。手表版无论 debug/release 均提供；手机版仅 debug 提供（手机端不在本仓范围）。PodJS 当前行为即为目标，无需改动。
- **C12 抖音详情收藏**：需要持久化，写入全局收藏（与 RSS/B站共用的 saved items），不是临时 UI 状态。
