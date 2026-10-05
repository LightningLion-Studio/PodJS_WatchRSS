# M1：原生 Activity 状态恢复审计（2026-10-05）

基线：应用 `master@23de712` → `minor/state-retention`。原生只读来源为 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss`，扫描所有 `*Activity.kt` 内 Activity 类；另外 `debug/PerfEntryActivity.kt` 是 intent 工厂 object，不是 Activity。下表是**源码审计/接线**，不是设备验收表。

原生语义分三类：`rememberSaveable`、LazyListState/ScrollState、Intent/SavedStateHandle 属于 task saved；ViewModel 中普通 StateFlow/草稿只跨配置重建；普通 `remember`、网络/解码/输入/同步 handle 重建。业务数据库/KV/播放记录仍由原有仓库负责，不能把配置 retained 字段冒充进程 saved。

M1前：StartupGate有startup saved/retained及大正文文件恢复，主要内容仅有有限KV resume，普通页面路由、列表和展开状态未进入Activity bag，信息页状态只在同一guest的route对象中保存。M1后：增加独立content namespace、bounded route descriptors、验证后hydrate、generic item anchors、native saveable/retained字段接线。保存上限为24项/24KiB metadata和640KiB retained；宿主仍要求saved≤64KiB、retained≤896KiB。未知版本/坏参数/缺失实体/无live preview安全降级至合法栈前缀。

| 原生 Activity | PodJS对应 | 原生持有/恢复 | M1后的逻辑/边界 | 只读来源（Activity及Screen） |
| --- | --- | --- | --- | --- |
| AboutActivity | `information/about` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `AboutActivity.kt` / AboutScreen |
| AccountStatusActivity | `account-status` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `AccountStatusActivity.kt` / AccountStatusScreen |
| AcousticConnectionActivity | `phone-connection（声学引导）` | ScrollState saved；连接/声学IO实际来源，destroy时释放 | 普通app列表anchor接线；host独立声学引导页控件不属于guest snapshot，IO不伪造恢复 | `AcousticConnectionActivity.kt` / AcousticConnectionScreen |
| AddRssActivity | `add-rss` | ViewModel 保留 URL/step/preview/error（配置）；ScrollState saved | retained URL/error/preview 意图 + saved item anchor；已识别预览重新验证，不保存确认 token；process 回到 intent URL | `AddRssActivity.kt` / AddRssScreen |
| AdvancedSettingsActivity | `settings-advanced` | 无直接识别到saveable滚动（从该Activity/同名screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `AdvancedSettingsActivity.kt` / AdvancedSettingsScreen |
| AutoScrollControlActivity | `settings-auto-scroll / reader-scroll-controls` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `AutoScrollControlActivity.kt` / AutoScrollControlScreen |
| BaseWatchActivity | `宿主基类，非页面` | Intent/KV 上次内容、生命周期；基类不保存自己的页面控件 | 已有 KV resume；新 Bundle 导航优先，未知版本降级；无 native 改动 | `BaseWatchActivity.kt` |
| BeianActivity | `information/beian` | 原生动画重新创建；没有saveable播放阶段 | 恢复information/beian route；按既有动画重建，不存动画/渲染句柄 | `BeianActivity.kt` / BeianScreen |
| BiliChannelInfoActivity | `bili/channel-info` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BiliChannelInfoActivity.kt` / BiliChannelInfoScreen |
| BiliCommentActivity | `bili/comments` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BiliCommentActivity.kt` / BiliCommentScreen |
| BiliDetailActivity | `bili/detail（含 RSS mode）` | LazyListState saved；expanded(text) saveable；selectedPageIndex 在 VM 中 retained，播放记录在仓库 | saved 描述展开/list anchor；retained 手选 cid；process 按原路由参数和真实播放仓库重读 | `BiliDetailActivity.kt` / BiliRssDetailScreen, BiliDetailScreen |
| BiliEntryActivity | `bili/* 导航栈` | rememberNavController 保存内部 route/args；子页 VM retained | Bundle 保存 bili route 链/安全参数；具体叶状态独立 namespace，handles/headers/stream URLs不入 Bundle | `BiliEntryActivity.kt` |
| BiliListActivity | `bili/history / watch-later / favorites / favorite-folder` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BiliListActivity.kt` / BiliListScreen |
| BiliLoginActivity | `bili/login` | ScrollState saved；登录请求/二维码VM生命周期，账号凭据持久 | 保存login route/list anchor；重新向真实host/client查登录，不保存二维码/cookie/登录op句柄 | `BiliLoginActivity.kt` / BiliLoginScreen |
| BiliPlayerActivity | `video/bili` | 目标 Intent/SavedStateHandle；播放记录仓库；控制显隐/缩放普通 remember | 保存 aid/bvid/cid，当前凭据重新解析 playback；不持久化普通 remember 控件，已有播放 checkpoint不改 | `BiliPlayerActivity.kt` / BiliPlayerScreen |
| BiliReplyDetailActivity | `bili/replies` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BiliReplyDetailActivity.kt` / BiliReplyDetailScreen |
| BiliSearchActivity | `bili/search / results` | NavController saved；draftQuery/activeQuery/分页为 ViewModel retained；LazyListState saved | 完成的查询是 route 身份；已交回 guest 的搜索词 retained；模态输入仍在编辑的草稿见宿主缺口 | `BiliSearchActivity.kt` / BiliSearchScreen, BiliSearchResultScreen |
| BiliSettingsActivity | `bili/settings` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BiliSettingsActivity.kt` / BiliSettingsScreen |
| BiliVideoActionsActivity | `bili/actions / share` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BiliVideoActionsActivity.kt` / ActionDialogScreen |
| BluetoothConnectionActivity | `bluetooth-connection` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `BluetoothConnectionActivity.kt` / BluetoothConnectionScreen |
| ChannelActionsActivity | `channel-detail / channel-share` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ChannelActionsActivity.kt` / ActionDialogScreen |
| ChannelDetailActivity | `channel-detail` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ChannelDetailActivity.kt` / ChannelDetailScreen |
| ChannelSettingsActivity | `channel-settings` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ChannelSettingsActivity.kt` / ChannelSettingsScreen |
| CollaboratorsActivity | `information/collaborators` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `CollaboratorsActivity.kt` / CollaboratorsScreen |
| ContactDeveloperActivity | `information/contact-developer` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ContactDeveloperActivity.kt` / ContactDeveloperScreen |
| DebugAcousticConnectionActivity | `debug-tools/acoustic` | debug gate、实验/IO state由actual host/session；无保存运行IO句柄 | 只恢复debug-tools route，host debug flag关时trim；运行IO重新请求，不伪造延续 | `DebugAcousticConnectionActivity.kt` |
| DebugBluetoothSyncActivity | `debug-tools/bluetooth` | debug gate、实际transport/session；无运行socket保存 | 同上；不复活socket/未经授权的sync operation | `DebugBluetoothSyncActivity.kt` |
| DetailActivity | `reader` | LazyListState/数据库阅读 anchor；aiSummaryExpanded(item.id) saveable；VM数据重新载入 | 原有阅读持久 anchor 保留；新增 saved AI展开及 article 路由，不把正文放Bundle；不因恢复再markRead | `DetailActivity.kt` / DetailScreen |
| DouyinChannelInfoActivity | `douyin/channel-info（现有 entry/card）` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `DouyinChannelInfoActivity.kt` / DouyinChannelInfoScreen |
| DouyinDetailActivity | `douyin/detail` | 无直接识别到saveable滚动（从该Activity/同名screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `DouyinDetailActivity.kt` / DetailContent |
| DouyinEntryActivity | `douyin/entry / feed；video immersive` | immersive pager/entry index/controls/scale/Bluetooth/start-volume flag saveable；recent IDs saveable仅供debug trace；decoder slot内部身份 | saved 当前 aweme与控件、缩放、Bluetooth、音量限制已消耗；读取真实持久queue并重新resolve；decoder句柄重建，debug recent-trace列表未补 | `DouyinEntryActivity.kt` / DouyinLoginScreen, DouyinImmersiveScreen, DouyinRssFeedScreen |
| DouyinHistoryActivity | `douyin/history` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `DouyinHistoryActivity.kt` / DouyinHistoryScreen |
| DouyinLoginActivity | `douyin/login` | 登录checking/banned/2-step来自实际client；刷新token/QR非Bundle状态 | 保存login route/list anchor；重建读取实际授权状态，host模态WebView恢复未补 | `DouyinLoginActivity.kt` / DouyinLoginCheckingScreen, DouyinLoginBannedScreen, DouyinLoginScreen |
| DouyinPlayerActivity | `video/douyin（非 immersive）` | 目标 Intent，非 immersive BiliPlayerScreen 控件普通 remember | 保存 aweme 身份并重解析，普通控件仍重置；不伪造播放器实例恢复 | `DouyinPlayerActivity.kt` / PlatformEntryScreen, BiliPlayerScreen |
| DouyinSettingsActivity | `douyin/settings` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `DouyinSettingsActivity.kt` / BiliSettingsScreen |
| DouyinVideoActionsActivity | `douyin/actions / share` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `DouyinVideoActionsActivity.kt` / ActionDialogScreen |
| FeedActivity | `articles` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `FeedActivity.kt` / FeedScreen |
| HomeFeedListActivity | `home（旧首页/原生 home 列表）` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `HomeFeedListActivity.kt` / renderHomeContent, HomeComposeScreen |
| ImagePreviewActivity | `reader-image` | URL Intent；缩放/平移等普通remember，重建重置 | 保存原URL/私有文件引用，重建图片；不把解码bitmap/gesture状态当saveable | `ImagePreviewActivity.kt` / ImagePreviewScreen |
| InfoActivity | `information/privacy / useragreement / info / licenses` | reloadKey/content/isLoading saveable；LazyListState saved；每次重建按原语义fresh load | main legal route先写/验正文文件再发引用；恢复时hydrate再mount；builtin从真实bundle源重读、保留anchor/reload | `InfoActivity.kt` |
| ItemActionsActivity | `rss-actions / rss-share` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ItemActionsActivity.kt` / ActionDialogScreen |
| JoinGroupActivity | `information/join-group` | ScrollState（原生布局）；群链接静态实际来源 | 保存information route；PodJS现有固定QR布局没有native可滚动内容，此处不能宣称scroll parity | `JoinGroupActivity.kt` / JoinGroupScreen |
| LlmPromptPresetActivity | `settings-llm-preset` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `LlmPromptPresetActivity.kt` / LlmPromptPresetScreen |
| LlmSummaryActivity | `reader 内的 AI 摘要（没有独立 app route）` | ScrollState saved；summary/request/status VM retained，业务摘要入库 | reader AI区域复用已持久摘要 + saved展开；独立summary Activity/滚动并不存在于当前app，未虚构映射验收 | `LlmSummaryActivity.kt` / LlmSummaryScreen |
| LlmTokenUsageActivity | `settings-llm-usage` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `LlmTokenUsageActivity.kt` / LlmTokenUsageScreen |
| LogUploadActivity | `log-upload` | 日志文本/加载/错误普通remember；每次创建重新读日志/创建WebView | 恢复log-upload route；重新读真实日志；不自动恢复或重复一次未完成上传 | `LogUploadActivity.kt` / LogUploadScreen |
| LogUploadPrivacyActivity | `information/log-upload-privacy` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `LogUploadPrivacyActivity.kt` / LogUploadPrivacyScreen |
| MainActivity | `StartupGate + home + KV resume` | launch routing、AppResumeStateStore；首页 LazyListState | 原来 KV 仅恢复少数内容；新增 bounded Activity task stack 和 home 列表 anchor | `MainActivity.kt` / renderLaunchContent |
| NoteActionsActivity | `note-actions` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `NoteActionsActivity.kt` / ActionDialogScreen |
| NotesActivity | `notes` | LazyListState saved；列表业务内容由数据库 | saved list anchor；重新读真实 MemoRepository，不能保存正文/图片句柄在Bundle | `NotesActivity.kt` / titleContent, NoteDocumentContent, drawContent |
| NoteDetailActivity | `note-detail` | readerListState saved；editing/caret/undo等普通remember；正文autosave数据库 | saved reader item anchor；编辑状态按原生重建，autosave后回写真实noteId防new模式重复；普通editor状态不改 | `NotesActivity.kt` / titleContent, NoteDocumentContent, drawContent |
| OobeActivity | `StartupGate/OOBE` | 协议勾选/错误/离线提示与自定义值rememberSaveable，VM其他字段retained | 已有OOBE saved/retained逻辑保持；Hub只合并startup namespace，避免覆盖content状态 | `OobeActivity.kt` / OobeScreen |
| PhoneConnectionActivity | `phone-connection` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `PhoneConnectionActivity.kt` / PhoneConnectionScreen |
| PhoneConnectionUnavailableActivity | `phone-connection-unavailable` | 无直接识别到saveable滚动（从该Activity/同名screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `PhoneConnectionUnavailableActivity.kt` |
| PrivacyPolicyConsentActivity | `StartupGate/privacy consent` | 协议状态/列表滚动；consent业务记录持久 | 已有StartupGate/legal恢复；Hub保存startup键，不覆盖content键 | `PrivacyPolicyConsentActivity.kt` / PrivacyPolicyConsentScreen |
| ProfileActivity | `profile` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ProfileActivity.kt` / ProfileScreen |
| ReadAloudPlaybackActivity | `speech-playback` | 全局TTS engine为实际来源；控件普通remember；进程死后engine会重置 | 恢复speech-playback route；只展示真实SpeechPlayback状态，未持久化或虚构运行句柄 | `ReadAloudPlaybackActivity.kt` / ReadAloudPlaybackScreen |
| ReaderPresetActivity | `settings-reader-presets` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ReaderPresetActivity.kt` |
| ReaderPresetPreviewActivity | `reader-preview` | 实际phone preview session；普通remember resource state；fallback ScrollState saved | 有live preview才保留route，无source恢复合法prefix；不序列化同步session/image/font handles；临时fallback滚动另见边界 | `ReaderPresetPreviewActivity.kt` |
| RssPlayerActivity | `video/rss` | 原文/media intent、仓库播放设置；控件普通 remember | 保存 article 身份和原文链接，再解析/读取当前仓库；不保存 resolved stream URL/headers | `RssPlayerActivity.kt` / BiliPlayerScreen |
| RssRecommendActivity | `recommendations` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `RssRecommendActivity.kt` / RssRecommendScreen |
| RssRecommendGroupActivity | `recommendations/group` | 无直接识别到saveable滚动（从该Activity/同名screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `RssRecommendGroupActivity.kt` / RssRecommendGroupScreen |
| RssSearchActivity | `search` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `RssSearchActivity.kt` / RssSearchScreen |
| SavedItemsActivity | `saved / watch-later` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `SavedItemsActivity.kt` / SavedItemsScreen |
| ServerActivity | `remote-input` | 无直接识别到saveable滚动（从该Activity/同名screen）；目标Intent；普通remember临时控件重建 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `ServerActivity.kt` / ServerScreen |
| SettingsActivity | `settings（各子页作为 route）` | currentPage rememberSaveable；各 ScrollState saved；设置实时持久化 | 恢复settings/subpage route和列表anchor；设置值仍从现有真实SettingsStore读取 | `SettingsActivity.kt` |
| ShareQrActivity | `rss-share / channel-share / bili/share / douyin/share` | 目标Intent；QR bitmap/动画普通remember | 仅保存逻辑目标参数；QR重新生成，现有固定QR布局无scroll状态 | `ShareQrActivity.kt` / ShareQrScreen |
| TtsSettingsActivity | `settings-speech / tts-config` | ScrollState/LazyListState保存滚动（对应screen）；目标Intent；ViewModel业务数据配置保留、进程重读 | 恢复逻辑route/args + ScrollEntries的saved item anchor（实际使用该adapter的页面）；业务数据仍从原有源重读，不保存IO/确认弹窗句柄 | `TtsSettingsActivity.kt` / TtsSettingsScreen |
| WebViewActivity | `host browser Dialog（不是 guest route）` | EXTRA_URL Intent；KEY_SCALE_MODE + rememberSaveable saved；不调用WebView.saveState | 未补：host Dialog没有缩放/路由snapshot API，Activity销毁后无法从guest读回；需框架followup | `WebViewActivity.kt` / WebViewScreen |
| PerfLargeArticleActivity | `debug-tools/perf + 实际 fixture reader` | debug性能fixture +阅读state | 只恢复debug gate后的工具/实际fixture；未新增独立Perf Activity task descriptor | `debug/PerfLargeArticleActivity.kt` / DetailContent |
| PerfLargeListActivity | `debug-tools/perf + 实际 fixture list` | debug fixture +LazyListState saved | 同上，生产列表ScrollEntries逻辑接线不等于原生独立Perf Activity恢复 | `debug/PerfLargeListActivity.kt` / FeedScreen |

## 本轮源码与单测证明

- RouteActivityProvider/restoredSignal使用真实Solid owner/effect测试，配置读取两个bag，process只读取saved；字段各自校验。
- ScrollEntries在真实scroller state machine下测试晚到rows、条件remount、滚动槽复用、touch取消pending以及前方行高变化后保留同一item anchor；现有ReaderBody/InformationDocument各自anchor不被generic list覆盖。
- InformationActivity测试commit正文早于publish、正文不进入Bundle、两类重建hydrate、原引用复用、tamper/错身份回真实加载、published文件不被早删。复用已有legal recovery文件完整性协议，不修改native数据。
- 视频Bundle只放logical identity。已有仓库checkpoint与真实queue负责内容数据；新resolve获取当前播放URL/headers。保存源变化时的current aweme；不恢复decoder/session handle。
- StartupGate只发布startup键，内容只发布content键，晚ACK不能把较早本地namespace缓存覆盖较新状态。原生host同步按dispatch顺序应用write；代码证据不等于Android onSave时序的设备证明。

## 明确未补齐的边界

1. **WebView独立Dialog**：原生saved缩放/URL路由与当前guest页面栈不同。host `PodInAppBrowser`没有读取/订阅缩放/重建Dialog的API；应用侧不能可靠保存用户在host中切换的模式。
2. **模态文字输入仍未提交的草稿**：`input.text`只在确认后向guest返回。M1保存已交回guest的Bili搜索词、真实inline AddRSS草稿；不能读到Bili/其他模态框中未确认的字符。需host draft/state接口；不能假称已覆盖此窗口。
3. **临时预览/独立debug Activity与UI结构差异**：无live preview安全退出到prefix，不伪造preview数据。独立LlmSummary/Perf活动和固定QR布局的滚动状态不能用普通adapter单测声称native parity；不是本轮布局改造。
4. **运行资源**：视频解码、TTS、输入session、网络/声学/蓝牙operation和native内部slot不入Bundle；正常重建从真实服务状态或仓库重新获取。Douyin recentVisited saveable字段在原生仅用于debug trace，本轮没有新增对应debug列表。
5. **设备验证 PENDING**：本轮未执行ADB或修改安装包。必须由设备所有者验证真实Bundle时序、配置重建、后台进程回收、滚动锚点/IME/视频/host Dialog差异。

应用页面状态接线与离线测试完成后，不得把本审计表整体标为“所有Activity恢复一致”。上述host/UI边界需独立任务和设备验收。
