# 当前源码功能对齐终审 D（A10）

审计日期：2026-10-10。结论：**不能宣布“功能和设备验收全部齐了”**。当前确认 **3 项源码差异（均 P3，M/M/S），未确认 P1/P2 源码缺口**。核心阅读、RSS、保存、平台媒体、连接/云同步主路径均有可达实现；当前 HEAD 尚无同一冻结版本的全量手表验收。

基线：应用 `master@5c17402c972369e3f205136744d9c8b813ec9cee`；framework `watchrss-migration@173894f0da4a4337e9f592ddcb1e02659615ad98`；原生 `main@6bb99ed4f5d197d44fbdc5be31e51143d19f62eb`，同时检查 main/debug 源集。原生最新提交的覆盖同步 / TXT novel 分类也在本次复核范围内。审计起始 app 为 `14dae0c`；收尾时并行主线提交 `5c17402`，本报告补审该提交后以最终 HEAD 为准。

引用前缀：`P/` 为本仓根目录；`N/` 为 `/home/wilf/data/OPPO_Develop/Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/`；`ND/` 为其 `app/src/debug/`；`F/` 为 `/home/wilf/data/PodJS/podjs-watch/`。提交前缀 A/F 分别为应用 / framework；旧审计的原始版本为 A `46ed4af`、A2 `238afc6`、B `6dfa798`。A/A2/B 编号按原版“部分/缺失”行出现顺序，本次分别复核 9 / 11 / 55 项，避免已更新表格把历史缺口隐去；原版 AI 内联总结行本来就是“已实现”，不误计为缺口。

“已关闭”只表示旧源码缺口已有真实实现/可达调用，或用户明确决定不追齐该差异；不表示设备全量 PASS。M=2–5 人日，S≤1 人日（含针对性验证，粗估）。本次没有改产品源码、没有运行安装/构建或连接设备，也没有运行 bun install。

## 1. 确认存在的源码缺口

| ID / 优先级 / 规模 | 当前差异 | 原生与当前实现证据 | 影响 / 待补齐边界 |
|---|---|---|---|
| C14 / P3 / M | 系统 Splash 退出动画仍部分对齐；guest 品牌层已实现 | `N/MainActivity.kt:33`；`N/MainActivity.kt:105`；`P/src/ui/StartupGate.tsx:120`；`F/platforms/android/app/src/main/java/dev/podjs/androidwatch/MainActivity.java:11` | native 系统 Splash 的缩放/淡出退出未在当前 host 接线；应用层遮罩动画不能证明系统层交接一致。不是由历史 cold-start 时延反推的功能缺口。 |
| D01（C15 声波附项） / P3 / M | debug 声波外部自动启动 / intent 配置 / Activity result 契约未迁移；声波主功能已实现 | `N/AcousticConnectionActivity.kt:104`；`N/AcousticConnectionActivity.kt:133`；`N/AcousticConnectionActivity.kt:140`；`N/AcousticConnectionActivity.kt:527`；`P/src/ui/AcousticConnectionScreen.tsx:28`；`P/src/ui/AcousticConnectionScreen.tsx:31`；`P/src/debug/external.ts:50`；`P/pod.config.json:20` | UI 手选模式/能力、手动 payload、回调入应用已可用；外部无法传 debug_auto_listen、debug_guided_payload_base64、preferred_ability 并自动执行，且无 return_remote_url 的 Android result。旧 C 附项曾提及，但不能随抖音 C15 关闭而一起消失。仅 debug 自动化兼容，非正式手机同步阻塞。 |
| D02（本轮设置补扫） / P3 / S | 阅读预设菜单的锚点漏计圆屏列表 start inset | `N/ReaderPresetActivity.kt:317`；`N/ReaderPresetActivity.kt:323`；`P/src/ui/ReaderPresetScreen.tsx:105`；`P/src/ui/ReaderPresetScreen.tsx:109`；`P/src/ui/ReaderPresetScreen.tsx:123`；`F/packages/framework/src/variable-list.tsx:39`；`F/packages/framework/src/variable-list.tsx:92` | 当前菜单虽然会翻转/夹紧位置（A:44fe2d7），按钮真实位置包含 roundInsets().start，而手工锚点仅 rawRowTop+65-scrollOffset；调用 ref 未消费 roundInsets。菜单可选择，仍不能宣称贴住所点行。纯源码几何夹具（233逻辑圆屏、首行 top26/height28/padding18）得到至少 32.121922 的漏计位移，非新设备测量。 |

D02 几何推导使用当前纯布局函数，不运行宿主：`.codex-tmp/a10/menu-anchor-check.ts` / `menu-anchor-check.json`。原 V4 “菜单居中”历史失败已有翻转定位补丁；这里确认的是补丁之后仍存在的圆屏 inset 漏计，不能把两个问题混写。

已定决策均不进入缺口表：C01 OSS / 低优先级，C11 保留手动 Cookie，C12 全局收藏；native 首页频道侧滑关闭、B站详情评论入口关闭。它们分别在下表注明决策或实现，不再以“原生有/PodJS不同”重开任务。

## 2. 已关闭项 / 历史部分项逐项复核

| 历史 ID | 功能点 | 当前状态 / 关闭范围 | 当前文件:行证据 | 修复 / 决策提交（均已在当前 HEAD 的祖先链核验） |
|---|---|---|---|---|
| C01 | 版本公告、更新安装 / OSS 决策 | 按已定决策退出缺口清单；推送已有，APK 自动更新保持关闭 | `P/src/announcement/home.ts:6`；`P/src/ui/screen.tsx:499` | A:289aa4c、e0090ec；决策 A:9ea2759 |
| C02 | 抖音 RSS 长按 / 侧滑 | 已关闭 | `P/src/ui/douyin/index.tsx:258`；`P/src/ui/RssScreens.tsx:67` | A:df4bca7 |
| C03 | 抖音 RSS 分页去重 / 不截为 40 条 | 已关闭；内存推荐窗口与 RSS 列表区分 | `P/src/douyin/rss-feed.ts:7`；`P/src/douyin/rss-feed.ts:30`；`P/src/ui/douyin/index.tsx:263` | A:ae1600d、df4bca7（合并 c59466c） |
| C04 | RSS 传入 item 的离线操作 | 已关闭；传入数据先显示，远端详情失败不阻断本地保存 | `P/src/douyin/actions.ts:12`；`P/src/ui/douyin/index.tsx:261`；`P/src/ui/routes/media-controller.ts:304` | A:ae1600d（合并 c59466c） |
| C05 | B站保存预览 MP4 / 离线播放回退 | 已关闭；真实文件下载、Range 校验与缓存回退，不只是 KV 标签 | `P/src/media-services.ts:21`；`P/src/bili/preview.ts:170`；`P/src/bili/preview-host.ts:8`；`P/src/ui/routes/media-controller.ts:179` | A:0016456（合并 02d3983） |
| C06 | 首页备忘录移动 / 置顶 | 已关闭 | `P/src/ui/HomeScreen.tsx:48`；`P/src/ui/HomeScreen.tsx:125`；`P/src/ui/HomeScreen.tsx:144` | A:2d6bed3 |
| C07 | B站分 P 的详情预热 | 已关闭；750ms 延后、5分钟 TTL、切 P 取消、播放消费暖源 | `P/src/bili/detail-preload.ts:19`；`P/src/bili/detail.ts:73`；`P/src/ui/bili/index.tsx:427` | A:ae1600d（合并 c59466c） |
| C08 | 首页导入频道清空 | 已关闭；含 TXT novel 分类 | `P/src/ui/HomeScreen.tsx:61`；`P/src/ui/HomeScreen.tsx:146`；`P/src/core/imported-content.ts:3` | A:2d6bed3；同步边界 A:325b89c |
| C09 | B站操作页默认收藏夹 / 成功退出 | 已关闭；取消收藏仍按已收藏夹执行 | `P/src/ui/bili/index.tsx:565`；`P/src/ui/bili/index.tsx:575`；`P/src/ui/bili/index.tsx:580` | A:bded520 |
| C10 | 抖音保存与分享后结束操作页 | 已关闭；分享结束由公共导航层执行 | `P/src/douyin/actions.ts:36`；`P/src/ui/douyin/index.tsx:328`；`P/src/ui/screen.tsx:434`；`P/src/ui/screen.tsx:452` | A:df4bca7；公共分享 A:5f58afe、ae1600d |
| C11 | 手动 Cookie 入口 | 决策关闭；保留入口，不按 native debug-only 限制删除 | `P/src/ui/douyin/index.tsx:197` | 决策 A:9ea2759 |
| C12 | 详情收藏写入全局收藏 | 决策已落实；真实持久化，不是仅内存星标 | `P/src/douyin/favorite.ts:19`；`P/src/douyin/favorite.ts:26`；`P/src/douyin/client.ts:106`；`P/src/media-services.ts:26` | A:ae1600d（合并 c59466c）；决策 A:9ea2759 |
| C13 | 抖音设置 / 下载 / 删除确认 | 已关闭；两平台复用正式设置页 | `P/src/ui/douyin/index.tsx:351`；`P/src/ui/PlatformSettingsScreen.tsx:49`；`P/src/ui/PlatformSettingsScreen.tsx:59` | A:df4bca7 |
| C15 | 抖音 external alias / receiver / provider 契约 | 抖音范围已关闭；声波外部启动扩展仍见 D01 | `P/src/debug/external.ts:19`；`P/src/debug/external.ts:37`；`P/pod.config.json:20`；`F/packages/cli/src/debug-external.ts:27`；`F/packages/cli/templates/debug-external/PodDebugExternal.java:47` | A:7f32820、60123df、f4b59e5；F:22f0cc0（debug bridge）、b2e359f（T26） |
| C16 | 隐藏 LlmSummaryActivity 路由 | 已关闭；debug-only，正式阅读仍以内联总结提供功能 | `P/src/debug/external.ts:38`；`P/src/debug/summary.ts:5`；`P/src/ui/DebugSummaryPlaceholder.tsx:1` | A:7f32820、17a8a21 |
| C17 | 详细 TTS 模型 / 音色 / Base URL / API Key | 已关闭；debug 编辑字段、引擎选择、测试；密钥不回显 | `P/src/debug/tts.ts:12`；`P/src/ui/SettingsScreen.tsx:81`；`P/src/ui/SettingsScreen.tsx:91`；`P/src/ui/DebugToolsScreen.tsx:56` | A:7f32820、d1f185f |
| A-01 | 原生系统 Splash 退出缩放/淡出及应用内启动遮罩 | 应用遮罩已关闭；系统部分仍 C14 | `P/src/ui/StartupGate.tsx:120`；`P/src/ui/startup-transition.ts:1` | A:4c879b1、18cc10c |
| A-02 | 从桌面冷启动时恢复上次打开的内部内容，并在首页下重建对应返回栈 | 已关闭；fresh launcher 与 Activity recreation 区分 | `P/src/navigation/resume-state.ts:115`；`P/src/ui/screen.tsx:6` | A:4c879b1、717caaa、16662c4 |
| A-03 | 首页启动时检查版本公告与未读推送；公告支持可选/强制更新、下载进度、失败提示及拉起系统安装器，推送以弹窗展示 | 推送已关闭；版本更新依 C01 决策不列缺口 | `P/src/announcement/home.ts:1`；`P/src/ui/screen.tsx:499` | A:289aa4c、e0090ec；决策 9ea2759 |
| A-04 | 朗读进行中时在首页显示可返回的朗读卡片、当前文章状态和实时频谱 | 已关闭；只有实际 PCM 才画频谱 | `P/src/ui/HomeScreen.tsx:102`；`P/src/ui/screen.tsx:380` | A:4c879b1、aceee5e |
| A-05 | 首页内置 B 站/抖音卡片根据实际登录状态显示“实时”更新语义 | 已关闭；使用实际会话 | `P/src/ui/home-extras.ts:28`；`P/src/ui/routes/home.tsx:1` | A:4c879b1 |
| A-06 | 首次加载完成后，无订阅时显示“还没有 RSS 频道”的明确空状态 | 已关闭 | `P/src/ui/HomeScreen.tsx:128` | A:b857422 |
| A-07 | 首页下拉刷新全部非内置 RSS 频道，并显示刷新状态/首个错误 | 已关闭；刷新指示期间不禁用频道 | `P/src/ui/HomeScreen.tsx:136`；`P/src/ui/screen.tsx:1164` | A:b857422、b05ba66 |
| A-08 | 订阅列表展示标题、简介、更新时间、未读数和置顶样式，并按“置顶优先、sortOrder 倒序”排列 | 已关闭；备忘录参与同一排序 | `P/src/services.ts:198`；`P/src/ui/HomeScreen.tsx:125` | A:b857422、2d6bed3 |
| A-09 | 首页长按频道操作：移动到顶部、置顶/取消置顶、标记已读、删除（含确认）；变更写入 RSS source 同步状态 | 已关闭；见 C06/C08 细化 | `P/src/ui/HomeScreen.tsx:49`；`P/src/sync/local-rss-actions.ts:1` | A:b857422、2d6bed3 |
| A2-01 | 返回或进入后台时确保最后阅读进度写入完成 | 已关闭；返回有界等待，生命周期 checkpoint 持久化；无回调直接杀进程不承诺最后瞬间 | `P/src/navigation/reader-exit.ts:1`；`P/src/reader/progress-write-queue.ts:1`；`P/src/ui/ReaderBody.tsx:32` | A:82cb7ea、3eacf97 |
| A2-02 | 本地导入内容的单篇删除及确认，并从后续同步中移除 | 已关闭；墓碑/change log/清理重试 | `P/src/ui/screen.tsx:918`；`P/src/services.ts:181`；`P/src/core/imported-content.ts:1` | A:b857422、325b89c |
| A2-03 | RSS 内抖音媒体播放失败后重新解析有效播放地址 | 已关闭；重试强制重新解析，失败不复用旧地址 | `P/src/ui/routes/media-controller.ts:572`；`P/src/ui/routes/media.tsx:63` | A:7ef2bf3 |
| A2-04 | 朗读播控的“返回文章”与“查看当前文章”两种入口语义 | 已关闭；首页入口可查看当前文章 | `P/src/ui/SpeechPlaybackScreen.tsx:14`；`P/src/ui/routes/home.tsx:1` | A:4c879b1 |
| A2-05 | 预设选择菜单中以该预设的真实正文样式和背景展示单行预览 | 正文样式/背景预览已关闭；菜单锚点另见 D02 | `P/src/ui/ReaderPresetScreen.tsx:130`；`P/src/ui/ReaderPresetSingleLinePreview.tsx:39` | A:82cb7ea |
| A2-06 | debug 版手表端详细 TTS 配置：选择引擎、本地/后端默认、状态信息与连通性测试 | 已关闭（debug）；见 C17 | `P/src/ui/SettingsScreen.tsx:81`；`P/src/debug/tts.ts:8` | A:8112b63、7f32820、d1f185f |
| A2-07 | debug 设置内重新进入新手引导及大列表/大文章性能工具入口 | 已关闭（debug） | `P/src/ui/DebugToolsScreen.tsx:53`；`P/src/debug/perf.ts:3` | A:8112b63 |
| A2-08 | 总结结果按“显示 Token 用量”设置展示本次输入/输出/总 Token；完整错误原因可回看 | 已关闭；按设置显示计数，完整错误保留在卡片 | `P/src/ui/ReaderScreen.tsx:65`；`P/src/ui/ReaderScreen.tsx:73`；`P/src/ui/ReaderScreen.tsx:120` | A:454b542 |
| A2-09 | Token 统计页面打开期间随新增消耗自动更新 | 已关闭；有变更订阅 | `P/src/ui/LlmUsageScreen.tsx:13`；`P/src/llm/usage.ts:1` | A:18cc10c |
| A2-10 | 账号页展示会员云中继状态、已用/总空间、首次手机批准说明，以及非会员云存储说明 | 已关闭（与 native 一样 debug cloud service 才出现） | `P/src/account/status.ts:35`；`P/src/ui/AccountStatusScreen.tsx:73`；`P/src/cloud/application.ts:26` | A:9991d72 |
| A2-11 | 已有笔记的草稿保存，在原记录被同步删除/不存在时保持记录身份和基线语义 | 已关闭；save 查墓碑记录沿用 ID，真正不存在仍报错 | `P/src/notes/repository.ts:65` | A:0637b1d |
| B-01 | 独立 BluetoothConnection 页面：权限请求、等待/结果、重试、返回 URL | 已关闭；独立权限/状态/重试页 | `P/src/ui/BluetoothConnectionScreen.tsx:21`；`P/src/ui/bluetooth-connection.ts:1` | A:bee3e71、e0090ec |
| B-02 | 纯声波：接收 RSS、发送收藏/稍后再看、时长预估和录音权限 | 主功能已关闭（debug）；外部启动契约另见 D01 | `P/src/phoneconnection/session.ts:30`；`P/src/phoneconnection/session.ts:47`；`P/src/phoneconnection/codec.ts:1` | A:2c88006；F:66198b0 |
| B-03 | 声波引导 Wi-Fi：热点连接、拉 RSS、推收藏/稍后再看 | 主功能已关闭（debug）；外部启动契约另见 D01 | `P/src/phoneconnection/session.ts:58`；`P/src/phoneconnection/protocol.ts:1` | A:2c88006；F:66198b0 |
| B-04 | 不可用原因独立页面 | 已关闭 | `P/src/ui/PhoneConnectionUnavailableScreen.tsx:7` | A:bee3e71、e0090ec |
| B-05 | 分享二维码可配置宽度比例 | 已关闭；参数传到共享布局 | `P/src/ui/ShareQrScreen.tsx:10`；`P/src/ui/ShareQrScreen.tsx:25` | A:18cc10c |
| B-06 | Server：收藏、稍后再看、B站观看记录 HTTP 导出 | 已关闭；HTTP 服务的可达导出模式，非只蓝牙 action | `P/src/ui/RemoteInputScreen.tsx:20`；`P/src/remote-input/exports.ts:6`；`P/src/remote-input/http.ts:1` | A:9e13e05、e0090ec |
| B-07 | 16 KiB 传输分块、包含 prefix 的字节进度 | 已关闭；框架 frame-stream 承接 16 KiB / prefix 进度 | `P/src/sync/stream.ts:1`；`P/src/sync/session.ts:9`；`F/packages/framework/src/frame-stream.ts:1` | A:0954193；框架上提 25beb14 |
| B-08 | probe 中阅读器能力及媒体能力发布 | 已关闭；实际 reader/media capabilities 接入 | `P/src/sync/application-host.ts:37`；`P/src/sync/protocol.ts:82`；`P/src/sync/media-capabilities.ts:1` | A:0954193 |
| B-09 | previewReader stream=true 持续预览流及 ACK 节流 | 已关闭；持续流单独分支，不消费下一帧为普通 ACK | `P/src/sync/session.ts:90`；`P/src/sync/session.ts:138` | A:0954193 |
| B-10 | syncAccount 安全存储账号、返回身份 | 已关闭；secure 写入 / 身份 / 实际 backlog | `P/src/sync/account-actions.ts:76`；`P/src/sync/account-telemetry.ts:1` | A:7e85fb0、a0c2a1a |
| B-11 | pullDebugLog 截断、maxChars、totalChars | 已关闭；全应用日志源，保留生产 pullDebugLog | `P/src/logs/logger-host.ts:11`；`P/src/sync/diagnostic-log.ts:1` | A:7e85fb0、d293e2d、a3679ad |
| B-12 | guided Wi-Fi /pullRemoteInput、token action URL | 已关闭（debug）；真实手机热点 HTTP 客户端 | `P/src/phoneconnection/protocol.ts:1`；`P/src/phoneconnection/session.ts:58` | A:2c88006；F:66198b0 |
| B-13 | DebugBluetoothSyncActivity：超时参数、payload 摘要、生命周期独占 | 已关闭（debug）；超时、摘要、独占、退出释放 | `P/src/debug/bluetooth.ts:19`；`P/src/debug/bluetooth.ts:24`；`P/src/ui/DebugToolsScreen.tsx:27` | A:8112b63 |
| B-14 | bootstrap、设备注册、会员/空间和 heads API | 已关闭（debug）；platform=watch，运行时构造 | `P/src/cloud/client.ts:37`；`P/src/cloud/runtime.ts:11` | A:b79d045、9991d72 |
| B-15 | 设备 P-256 密钥、手机批准、信封解封、多版本账号密钥 | 已关闭（debug）；批准在手机发生，手表 waiting-approval / 解封 / 多版本 key | `P/src/cloud/keys.ts:20`；`P/src/cloud/keys.ts:32`；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudCrypto.java:1` | A:b79d045；F:a16b307 |
| B-16 | 快照 manifest/chunk 加密、gzip、哈希及缓存复用 | 已关闭（debug） | `P/src/cloud/codec.ts:38`；`P/src/cloud/codec.ts:64`；`P/src/cloud/cache.ts:6` | A:b79d045；F:a16b307 |
| B-17 | 拉远端快照及分块、验 hash/长度、解密并恢复本地库 | 已关闭（debug）；校验后恢复库 | `P/src/cloud/service.ts:79`；`P/src/cloud/service.ts:88`；`P/src/cloud/codec.ts:77` | A:b79d045、9991d72 |
| B-18 | 本地 RSS/保存状态导出、序列/heads 因果合并、ACK、防重复上传 | 已关闭（debug）；heads/sequence/state/ACK 已有调用 | `P/src/cloud/library.ts:1`；`P/src/cloud/service.ts:92`；`P/src/cloud/service.ts:101`；`P/src/cloud/state.ts:1` | A:b79d045、9991d72 |
| B-19 | TUS 大对象上传：6 MiB 分块、offset、重试 | 已关闭（debug）；uploader 有 service caller | `P/src/cloud/tus.ts:1`；`P/src/cloud/service.ts:127` | A:9991d72 |
| B-20 | 公共 RSS 库 resolve/recent128/all 与本地合并 | 已关闭（debug）；resolve recent128/all 真正合并 | `P/src/cloud/client.ts:53`；`P/src/cloud/service.ts:96` | A:9991d72 |
| B-21 | 计费网络仅小状态、Wi-Fi/手动正文、状态及会员空间展示 | 已关闭（debug）；计费网络小状态、手动/Wi-Fi 完整内容、实配额 | `P/src/cloud/service.ts:53`；`P/src/account/status.ts:35`；`P/src/ui/AccountStatusScreen.tsx:73` | A:9991d72 |
| B-22 | 前台 5 分钟节流、账号/网络/数据变化触发、6 小时 worker | 已关闭（debug）；5分钟节流 / 变化订阅 / 6小时系统 worker | `P/src/cloud/application.ts:25`；`P/src/cloud/application.ts:29`；`P/src/cloud/scheduler.ts:2`；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWork.java:27` | A:9991d72；F:fb99c5c |
| B-23 | Entry：原文卡片模式与 RSS 文本模式切换 | 已关闭 | `P/src/ui/bili/index.tsx:1`；`P/src/ui/routes/media.tsx:40` | A:1744667、3ddd0c5 |
| B-24 | Entry：推荐追加、缓存先显、去重、长按/滑动快捷收藏 | 已关闭；追加/缓存/去重及卡片手势全部存在 | `P/src/bili/browse.ts:77`；`P/src/bili/browse.ts:89`；`P/src/ui/bili/index.tsx:154` | A:1744667、b0176ec |
| B-25 | Search：历史存储/清空、AV/BV 直达、连续结果分页 | 已关闭 | `P/src/bili/browse.ts:53`；`P/src/ui/bili/index.tsx:6` | A:1744667、15be9f0 |
| B-26 | List：历史 cursor 与收藏内容 loadMore | 已关闭 | `P/src/bili/browse.ts:56`；`P/src/bili/browse.ts:59` | A:1744667、15be9f0 |
| B-27 | Detail：选分 P、恢复上次 cid、点赞/投币/取消收藏及互动状态 | 已关闭 | `P/src/bili/detail.ts:11`；`P/src/bili/detail.ts:25`；`P/src/ui/bili/index.tsx:409` | A:ba0ea98、67d93da |
| B-28 | Detail：离线本地已保存信息兜底、预览视频热身 | 已关闭；离线 SQL 详情、分 P 暖源、MP4 预览分别见 C05/C07 | `P/src/media-services.ts:34`；`P/src/bili/detail.ts:17`；`P/src/bili/detail-preload.ts:19` | A:ba0ea98、ae1600d、0016456 |
| B-29 | CommentActivity：置顶/正文/头像、回复入口 | 已关闭；实现保留，native detail 入口关闭按决策不列缺口 | `P/src/bili/comments.ts:1`；`P/src/ui/bili/CommentScreen.tsx:1`；`N/BiliDetailActivity.kt:121` | A:bb8c0d7 |
| B-30 | ReplyDetailActivity：根评论、楼中楼及分页 | 已关闭；原生同样无正式 detail 评论入口 | `P/src/bili/comments.ts:1`；`P/src/ui/bili/CommentScreen.tsx:1` | A:bb8c0d7 |
| B-31 | VideoActions/Detail：远端成功后写本地收藏/稍后再看并缓存预览 | 已关闭；远端成功后 SQL saved + 真实预览任务 | `P/src/bili/client.ts:71`；`P/src/media-services.ts:21` | A:b857422、0016456 |
| B-32 | Settings：退出登录、删除频道确认、后台播放开关 | 已关闭 | `P/src/ui/bili/index.tsx:613`；`P/src/ui/PlatformSettingsScreen.tsx:60` | A:911a56d、3ef11c0 |
| B-33 | Player：播放错误刷新源/切候选、缓存播放源/预览回退 | 已关闭；重新 resolve / 候选重试 / 本地预览回退 | `P/src/ui/routes/media-controller.ts:179`；`P/src/ui/routes/media-controller.ts:199`；`P/src/bili/client.ts:57` | A:ba0ea98、0016456 |
| B-34 | Entry：原文沉浸竖向流 / RSS 列表模式开关 | 已关闭 | `P/src/douyin/original-mode.ts:1`；`P/src/ui/routes/media.tsx:41` | A:c4cbe8d、7ef2bf3 |
| B-35 | Entry：沉浸预加载播放器池、缓存引导、最近窗口/当前视频恢复、失效源刷新/跳过 | 已关闭；真实多 session / 单 decoder 降级与缓存恢复 | `P/src/ui/douyin/video-sessions.ts:1`；`P/src/douyin/feed-store.ts:1`；`P/src/ui/VideoPlayerScreen.tsx:250` | A:c4cbe8d、c0a40cb、ee08f96 |
| B-36 | Entry：长按/侧滑视频操作、标题点击频道信息 | 已关闭；RSS 与沉浸两种路径 | `P/src/ui/douyin/index.tsx:258`；`P/src/ui/VideoPlayerScreen.tsx:249`；`P/src/ui/VideoPlayerScreen.tsx:254` | A:c4cbe8d、df4bca7 |
| B-37 | ChannelInfo：专门说明/URL/更新状态页，登录、设置、历史入口 | 已关闭 | `P/src/ui/douyin/index.tsx:118` | A:c4cbe8d |
| B-38 | Login：官方 WebView 登录、提取二维码、cookie 持久化 | 已关闭；官方 WebView QR/cookie，保留 C11 | `P/src/ui/douyin/index.tsx:159`；`P/src/ui/douyin/index.tsx:170` | A:69e253f、911a56d；F:7956455 |
| B-39 | Login：Checking / 无网络 / 蓝牙网络禁用、WebView 不可用专页 | 已关闭；互联网状态与 WebView 可用性判断 | `P/src/ui/douyin/index.tsx:138`；`P/src/ui/douyin/login-state.ts:1` | A:911a56d、db75a8d |
| B-40 | Login：二步验证识别及回落网页登录 | 已关闭；扫码二步状态与回落网页登录 | `P/src/ui/douyin/login-state.ts:1`；`P/src/ui/douyin/index.tsx:159` | A:69e253f、2ac82a0；F:7956455 |
| B-41 | Detail：继承阅读器预设、字号、传入数据直接离线展示 | 已关闭；使用 ReaderArticlePage、传入 item 与预设 | `P/src/ui/douyin/index.tsx:289`；`P/src/ui/douyin/index.tsx:309` | A:74447e2、3ddd0c5、ae1600d |
| B-42 | History：从历史构造播放队列、连续换视频记录历史 | 已关闭 | `P/src/douyin/playback-queue.ts:8`；`P/src/ui/routes/media-controller.ts:9` | A:74447e2、2ac82a0 |
| B-43 | VideoActions：本地保存进入统一 RSS 库与手机同步 | 已关闭；外部内容入统一 SQL 库 | `P/src/douyin/client.ts:106`；`P/src/media-services.ts:26` | A:b857422、ae1600d |
| B-44 | Settings：原文/后台开关、退出登录、频道删除确认 | 已关闭；见 C13 | `P/src/ui/douyin/index.tsx:351`；`P/src/ui/PlatformSettingsScreen.tsx:60` | A:df4bca7 |
| B-45 | Settings：退出清 WebView cookie、媒体缓存和最近窗口、回首页 | 已关闭；cookie、站点数据、媒体/窗口按 native 范围清理并回 Home | `P/src/media-services.ts:27`；`P/src/media/logout.ts:1`；`P/src/ui/douyin/index.tsx:355`；`P/src/ui/routes/media.tsx:165` | A:911a56d、db75a8d、e0090ec |
| B-46 | Player：网络遮罩、队列位置跨重启恢复、沉浸流长按操作 | 已关闭；遮罩、队列恢复与手势可达 | `P/src/ui/VideoPlayerScreen.tsx:249`；`P/src/douyin/playback-queue.ts:8`；`P/src/ui/routes/media-controller.ts:330` | A:74447e2、2ac82a0 |
| B-47 | Info：Activity 重建时保留正文/加载状态/滚动 | 已关闭；正文/加载/滚动按 Activity 状态恢复 | `P/src/ui/InformationScreens.tsx:29`；`P/src/onboarding/legal-restoration.ts:170` | A:18cc10c、edd33e6 |
| B-48 | 加群：相同 URL/群号、二维码与无障碍说明 | 已关闭；安全二维码和无障碍描述 | `P/src/ui/InformationScreens.tsx:158` | A:18cc10c |
| B-49 | 日志上传隐私说明及显式开始操作 | 已关闭；privacy 页显式开始后才进入上传 | `P/src/ui/InformationScreens.tsx:135`；`P/src/ui/routes/info.tsx:64` | A:03b1619、e0090ec |
| B-50 | 日志读取、暂无/加载失败状态、WebView 自动提交加密日志、取件码 | 已关闭；直接实现 native 加密/InstantDB/取件码契约，不要求相同 WebView 容器 | `P/src/logs/encryption.ts:10`；`P/src/logs/upload.ts:34`；`P/src/ui/LogUploadScreen.tsx:1` | A:03b1619、d293e2d、e0090ec |
| B-51 | WebView：应用内浏览、历史返回、缩放档位、主题、加载进度、销毁 | 已关闭；实际宿主 inApp 路径 | `P/src/browser/open.ts:1`；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodInAppBrowser.java:1` | A:d716e07；F:144848a |
| B-52 | WebView：联网前置检查、不可用提示、本地绝对路径转换 | 已关闭；validated network / 不可用 / 本地路径 URI | `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodInAppBrowser.java:80`；`P/src/browser/open.ts:1` | A:d716e07；F:144848a |
| B-53 | 原生超大列表/超大文章固定场景与指标 | 已关闭（debug）；固定场景 + native frame 指标 | `P/src/debug/perf.ts:3`；`P/src/ui/DebugToolsScreen.tsx:70`；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodDebugPerformance.java:1` | A:8112b63 |
| B-54 | 抖音 debug alias/广播故障注入、cookie 导入、自动换片 | 抖音范围已关闭（debug）；声波 ABI 仍 D01 | `P/src/debug/external.ts:37`；`P/src/debug/external.ts:44`；`P/pod.config.json:20` | A:8112b63、7f32820、60123df |
| B-55 | DebugLogProvider / dump 与性能开关 | 已关闭（debug）；provider 移到工作线程，production 日志另保留 | `P/src/debug/external.ts:21`；`F/packages/cli/templates/debug-external/PodDebugExternal.java:47`；`P/src/debug/perf.ts:3` | A:8112b63、7f32820、f4b59e5；F:22f0cc0 |


### 组件重扫与未编号动作核对

清单由当前 main/debug manifest 与 Kotlin/Java 声明重扫得出：[原始清单](../.codex-tmp/a10/native-components.json)、[逐组件映射](../.codex-tmp/a10/component-mapping.json)。主 manifest 为 **70 个 Activity、2 个 Provider、0 个自定义 Service / 静态 Receiver**；debug manifest 覆盖同一个 DouyinEntryActivity，另有 **1 个 alias、1 个 Receiver**，不重复计算 Activity。源码另有 **1 个 CoroutineWorker、1 个动态 screen Receiver**。SDK bili/douyin manifest 无额外应用组件。

以下分组逐一列出全部 70 个 Activity 的对应入口；不要求 PodJS 注册 70 个 Android Activity 才算功能存在。

- **启动 / 首页 / RSS（14）**：`MainActivity、HomeFeedListActivity、AddRssActivity、RssRecommendActivity、RssRecommendGroupActivity、OobeActivity、PrivacyPolicyConsentActivity、FeedActivity、ChannelActionsActivity、ItemActionsActivity、DetailActivity、ChannelDetailActivity、RssSearchActivity、ChannelSettingsActivity`。对应 `P/src/ui/StartupGate.tsx:44`；`P/src/ui/HomeScreen.tsx:49`；`P/src/ui/AddRssScreen.tsx:1`；`P/src/ui/RecommendationScreen.tsx:1`；`P/src/ui/RssScreens.tsx:33`；`P/src/ui/ChannelScreens.tsx:1`；`P/src/ui/RssSearchScreen.tsx:1`；`P/src/ui/ReaderScreen.tsx:37`。可达主路径；Main 的系统 Splash 仍 C14。
- **设置 / 阅读 / AI（10）**：`SettingsActivity、ReaderPresetActivity、ReaderPresetPreviewActivity、AdvancedSettingsActivity、TtsSettingsActivity、LlmPromptPresetActivity、LlmSummaryActivity、LlmTokenUsageActivity、ReadAloudPlaybackActivity、AutoScrollControlActivity`。对应 `P/src/ui/SettingsScreen.tsx:56`；`P/src/ui/ReaderPresetScreen.tsx:28`；`P/src/ui/ReaderPresetSingleLinePreview.tsx:18`；`P/src/ui/ReaderPreviewScreen.tsx:1`；`P/src/ui/LlmPromptPresetScreen.tsx:1`；`P/src/ui/LlmUsageScreen.tsx:13`；`P/src/ui/SpeechPlaybackScreen.tsx:14`；`P/src/ui/AutoScrollSettingsScreen.tsx:1`；`P/src/debug/summary.ts:5`。正式/隐藏 debug 分支分别检查；菜单锚点仍 D02。
- **个人 / 备忘录 / 保存（6）**：`ProfileActivity、NotesActivity、NoteDetailActivity、NoteActionsActivity、SavedItemsActivity、AccountStatusActivity`。对应 `P/src/ui/ProfileScreen.tsx:1`；`P/src/ui/NotesScreen.tsx:44`；`P/src/ui/SavedItemsScreen.tsx:58`；`P/src/ui/AccountStatusScreen.tsx:73`；`P/src/notes/repository.ts:65`。统一持久化、笔记墓碑冲突、长按动作与草稿逻辑。
- **手机连接 / 旧 HTTP 服务（7）**：`PhoneConnectionActivity、BluetoothConnectionActivity、AcousticConnectionActivity、DebugAcousticConnectionActivity、DebugBluetoothSyncActivity、PhoneConnectionUnavailableActivity、ServerActivity`。对应 `P/src/ui/PhoneConnectionScreen.tsx:1`；`P/src/ui/routes/phone.tsx:20`；`P/src/ui/AcousticConnectionScreen.tsx:28`；`P/src/ui/DebugToolsScreen.tsx:53`；`P/src/ui/RemoteInputScreen.tsx:20`。声波/debug蓝牙仅 debug；声波 external/result 仍 D01。
- **B站（11）**：`BiliDetailActivity、BiliChannelInfoActivity、BiliSettingsActivity、BiliListActivity、BiliLoginActivity、BiliPlayerActivity、BiliVideoActionsActivity、BiliEntryActivity、BiliCommentActivity、BiliReplyDetailActivity、BiliSearchActivity`。对应 `P/src/ui/bili/index.tsx:1`；`P/src/ui/bili/CommentScreen.tsx:1`；`P/src/ui/routes/media.tsx:1`；`P/src/ui/VideoPlayerScreen.tsx:41`。feed、登录、search/list/detail/actions、播放均有路由；评论实现保留，native detail 入口关闭。
- **抖音（8）**：`DouyinEntryActivity、DouyinChannelInfoActivity、DouyinHistoryActivity、DouyinSettingsActivity、DouyinLoginActivity、DouyinPlayerActivity、DouyinVideoActionsActivity、DouyinDetailActivity`。对应 `P/src/ui/douyin/index.tsx:1`；`P/src/ui/douyin/video-sessions.ts:1`；`P/src/ui/VideoPlayerScreen.tsx:41`；`P/src/ui/routes/media-controller.ts:304`。原文/RSS 两种入口、历史、QR状态、离线详情、动作、设置、队列。
- **信息 / 日志 / 通用媒体（12）**：`AboutActivity、CollaboratorsActivity、InfoActivity、ContactDeveloperActivity、JoinGroupActivity、LogUploadPrivacyActivity、LogUploadActivity、BeianActivity、ShareQrActivity、WebViewActivity、ImagePreviewActivity、RssPlayerActivity`。对应 `P/src/ui/InformationScreens.tsx:36`；`P/src/ui/routes/info.tsx:64`；`P/src/ui/LogUploadScreen.tsx:1`；`P/src/ui/ShareQrScreen.tsx:10`；`P/src/browser/open.ts:1`；`P/src/ui/ImagePreviewScreen.tsx:1`；`P/src/ui/routes/media-controller.ts:1`。文档、显式上传、加群/备案、分享、应用内浏览与媒体路径。
- **性能工具（2）**：`debug.PerfLargeListActivity、debug.PerfLargeArticleActivity`。对应 `P/src/debug/perf.ts:3`；`P/src/ui/DebugToolsScreen.tsx:70`。debug-only 固定场景；PerfEntryActivity 是 object/helper，不是 manifest Activity。

- **Provider**：native `N/debug/DebugLogProvider.kt:9` 与 main manifest:58 对应 `P/src/debug/external.ts:21`、`F/packages/cli/templates/debug-external/PodDebugExternal.java:47`。native `FileProvider` 除 APK 更新，也被 `N/RssPlayerActivity.kt:135`、`N/ui/screen/rss/DetailBehaviorSupport.kt:276` 用于本地媒体/浏览；当前媒体和浏览由同 UID 宿主读取文件，浏览转换见 `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodInAppBrowser.java:80`，不因没有同名 provider 判断用户功能缺失；更新安装按 C01 决策。
- **静态 Receiver / alias**：`ND/AndroidManifest.xml:9,19` 及 `ND/java/com/lightningstudio/watchrss/debug/DouyinPlaybackDebugReceiver.kt:10` 对应 `P/pod.config.json:20` / `P/src/debug/external.ts:37`；生成器在 debug source set 写组件并使用 shell 权限（`F/packages/cli/src/debug-external.ts:27`），release 不暴露外部动作。
- **动态 Receiver**：`N/phoneconnection/bluetooth/WatchBluetoothForegroundSyncManager.kt:38,75` 的 screen-on/off 与前台 ownership 对应 `P/src/sync/application-foreground.ts:47,48,102` / `P/src/sync/application-host.ts:51`，已同时消费 display.interactive 与 lifecycle，不只页面挂载监听。
- **Worker**：`N/data/cloud/WatchCloudSyncWorker.kt:15,20` 对应 `P/src/cloud/application.ts:25` / `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWorker.java:25,30` / `PodCloudWork.java:27`，debug-only、6小时系统计划、独占后台 guest；并非 JS 前台 timer 冒充 Worker。
- **Service 名称与支撑类**：`RssFetchService / RssParseService / RssReadableService / ManagedCacheService / WatchCloudSyncService` 是普通业务类，不继承 Android Service，不能额外报“少了 5 个后台 Service”。对应 `P/src/services.ts:341`、原文服务/缓存、`P/src/cloud/service.ts`；`AcousticAudioReceiver` 是 PCM 解码类，也不是 BroadcastReceiver。`BaseWatchActivity` 是公共基类；`PerfEntryActivity` 是 debug helper，分别由 host 导航/生命周期与 DebugTools 承接。

设置与手势重扫保留检索证据 [native-ui-actions.txt](../.codex-tmp/a10/native-ui-actions.txt)，并核对组件调用点而非仅搜关键词：

- **正式设置**：阅读器/预设、朗读语速及手机配置、自动滚动、从手机输入、字号、滚轮音量、防误触/静音上限、高级缓存上限/已用/清除/预取数量、同步无声音频保活、系统/QR分享能力、备案入口；`N/ui/screen/rss/SettingsScreen.kt:310,344,359,524,690,749,787,825,848` 对应 `P/src/ui/SettingsScreen.tsx:56,60,67,81` / `P/src/ui/media-volume-settings.tsx` / `P/src/ui/advanced-cache-settings.tsx` / `P/src/ui/AutoScrollSettingsScreen.tsx`。AI 可见条件、自动总结/预设/Token显示/累计统计同样逐项检查（native :579–649 ↔ Pod :50–54）。
- **阅读预设与 debug**：主题深/浅/自动、深色跟随、固定时间/日出日落/定位失败、字体/背景和菜单预览（`P/src/ui/ReaderPresetScreen.tsx:46,58,84,94,130`）；TTS 引擎/模型/音色/地址/Key/状态/测试，重进 OOBE、大列表/文章、蓝牙、声波、抖音故障/自动换片/Cookie（`P/src/ui/SettingsScreen.tsx:81`、`P/src/ui/DebugToolsScreen.tsx:53,55,56,57`）。菜单锚点漏计见 D02；其余没有确认新增源码缺口。
- **平台/频道设置**：原文模式、后台播放、手机下载、登录/退出、删除确认；通用频道原文/媒体续播/导入清空/删除，`P/src/ui/PlatformSettingsScreen.tsx:49,50,52,60` / `P/src/ui/ChannelScreens.tsx`。C11 保留手动 Cookie 是既定决策。
- **首页 / RSS / 备忘录**：首页普通频道长按 move/pin/read/delete，备忘录 move/pin，导入频道清空；RSS 左滑收藏/稍后与长按操作、本地单篇删除；笔记长按 pin/移动文件夹/删除，编辑 undo/redo/光标和自动保存。对应 `P/src/ui/HomeScreen.tsx:49,136`、`RssScreens.tsx:67`、`NotesScreen.tsx:77`、`P/src/notes/repository.ts:65`。native 首页 `HomeFeedListActivity.kt:278` 的 enableChannelSwipeActions=false、笔记卡片 `NotesActivity.kt:394` 的 swipe 空回调均按实际关闭状态核验，不列缺口。
- **保存 / 阅读 / 图片**：收藏/稍后长按拖排序、左滑删除/撤回；正文长按指定位置朗读、逐段高亮/播控、自动滚动暂停/返回；图片点击退出、双击/捏合缩放和平移。native `N/ui/screen/rss/SavedItemsScreen.kt:171,230` / `N/ui/screen/rss/DetailContentBlocks.kt:120` 对应 `P/src/ui/SavedItemsScreen.tsx:58,70` / `P/src/ui/ReaderBody.tsx:304` / `P/src/ui/ImagePreviewScreen.tsx`，不是仅有操作标签。
- **B站 / 抖音 / 播放器**：B站 feed 原文/RSS 手势、侧边快速入口、操作收藏/稍后/分享/取消、详情分 P/互动/缓存；抖音 RSS 操作、沉浸纵向切片/长按/横向操作、历史队列；播放器触摸/音量/旋转缩放/快进按住/网络遮罩、浏览返回/缩放。对应 `P/src/ui/bili/index.tsx:154,158,565`、`P/src/ui/douyin/index.tsx:258,335`、`P/src/ui/VideoPlayerScreen.tsx:31,249,250,254` / `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodInAppBrowser.java:80`。native `N/BiliDetailActivity.kt:121` showCommentEntry=false，评论入口不重开。

补审并行提交 `5c17402`：两平台 entry/login/actions/player 不再固定显示页头说明；首次使用确认仍在 `P/src/ui/routes/media.tsx:83,148,168`，频道范围、账号说明卡与分享/收藏等操作保留（`P/src/ui/PlatformNotice.tsx:70` / `P/src/ui/bili/index.tsx:620` / `P/src/ui/douyin/index.tsx:366`）。当前 native `N/BiliEntryActivity.kt:16,22` / `N/DouyinEntryActivity.kt:103` 直接构造内容，本轮未找到同类固定说明页头；不能沿用 PodJS 旧注释把附加页头当成 native 必需契约。移除页头未使本应用的说明信息/确认门禁不可达，不另判产品功能缺口，也不据此宣布视觉全量对齐。新布局设备验收仍 PENDING。

A–C 外新增确认项为 D02；D01 是旧 C 声波附项的独立保留，避免误合并到已关闭的抖音 C15。历史设备失败（例如平台说明重现、推荐页回收语义）若没有当前源码的明确因果证据，保留为设备 PENDING，不凭旧截图直接增加源码缺口。

## 3. 设备验收覆盖（只复用已有报告）

这里的 PASS 都限定为所列历史版本与步骤；**当前 A/F HEAD 全部需要冻结重测**。最新 V16 是 v1009，报告的 app `faa839e` / framework `d66ed136`，不含当前 T31。最终 app `5c17402` 还移除了平台固定说明页头，播放器恢复全屏高度，历史圆屏几何 PASS 不能直接覆盖这个布局。早期 `.podjs` 共存包（v28/v34）也不等同后来正式同包接管版本。未在报告找到正向证据的路径保留 PENDING，未实际执行的破坏/账号操作不凭页面按钮存在判 PASS。

| 功能 / 对应项 | 已有手表证据（历史版本与范围） | 仍是 PENDING / 原因 |
|---|---|---|
| 首页 / K8、缺字与冷启动 | [V16](../.codex-tmp/t30/device/v16-report.md)：v1009 五冷启动、最终 Home 全图 MAE=0；①书名与気作者 ROI MAE=0；Home 可见中位3.120s。 | 当前 T31 未安装；V16 ACTIVE 247.087ms 仍未过当时150ms门限；T31 <100ms没有设备值。禁止用 JVM/单测代替。 |
| 准入 / 首帧后深检 / Worker ownership | [V14](../.codex-tmp/t25/device/v14-report.md)：v1007 深检首纹理后10.044s PASS、限频观察；[V16](../.codex-tmp/t30/device/v16-report.md)：实际系统 job、首纹理后 deferred 摘要观察。 | 当前 <100ms、长周期/异常重启待验；系统 job 观察不是云数据同步往返，也不证明全部 native 历史作业取消。 |
| 正式同包接管 / 备份连续性 | [V8b](../.codex-tmp/t18/device/v8b-report-final.md)、[V9/V9b](../.codex-tmp/t20/device/v9-final-report.md)、[V13](../.codex-tmp/t23/device/v13-report.md)、V16：正式 UID10132、同代际/六项 sealed 摘要连续性与真实页面。V5 首启 PAUSED 的历史失败没有抹掉。 | V8 legacy PARTIAL / equal=false / 私有 files 完整性限制仍保留；sealed 备份摘要连续不等于所有 live DB/KV/secure/离线文件逐项等值。未完成同一版本全量迁移验收。 |
| 桌面恢复 / Reader 最终进度（A-02、A2-01） | [V4](../.codex-tmp/device/report-V4.md)：v34 实际锁屏回收后411正文重开 MAE0；[V13](../.codex-tmp/t23/device/v13-report.md)：v1006 后台 am kill、PID改变后412全文 MAE0，返回频道标题ROI0、再回Home。 | 最新 HEAD 的 screen-off 最后瞬间/存储失败/超长导入文章、所有稳定页类型未全面覆盖。V13 B站父推荐页重新说明、内容变化 MAE39.923494，native等价性待复核。 |
| 首页普通 / 备忘录 / 导入频道动作（C06/C08） | [V1b](../.codex-tmp/device/report-V1b.md)：备忘录 move/pin/cancel、普通RSS move/pin/read/delete菜单与TXT清空可见，点取消返回；[V8b](../.codex-tmp/t18/device/v8b-report-final.md)：真实5条备忘录列表。 | 未执行置顶/排序落盘、删除/清空及后续手机同步；笔记新增/编辑/自动保存/墓碑冲突/撤销重做需可写隔离数据。 |
| 普通 RSS 阅读 / 标为未读 / 刷新 | [V3](../.codex-tmp/device/report-V3.md)：真实标为未读、圆点与计数变化、36kr 内容刷新；[K22](../.codex-tmp/device/report-K22.md)：失败刷新保持卡片 MAE0、错误toast、Home K8=0；V13/V16有真实文章阅读。 | 全库刷新首个错误、添加/删订阅、搜索/加载上限、墓碑清理重试、稍后读完自动移除没有同一HEAD完整功能步骤证据。普通HTTP抓取成功不等于WebView challenge/cookie成功。 |
| 抖音 RSS 操作 / 分页（C02/C03） | [V2](../.codex-tmp/device/report-V2.md)：v28 ON→OFF→ON恢复、真实下拉刷新、左滑按钮、长按4项、自动更多出现新内容；[V4](../.codex-tmp/device/report-V4.md)：五行圆屏可达。 | V2未点击保存/分享；无 >40 条穷尽、重复aweme/网络异常状态的真机保证。V12现有频道无抖音RSS记 N/A，不抹掉旧V2；当前账号/频道准备仍需要授权环境。 |
| 抖音 item 离线保存 / 全局收藏（C04/C10/C12） | V1b/V4有操作页与分享QR的可见证据。源码 ae1600d / df4bca7 不能代替设备持久化证据。 | 真实离线保存、成功toast退出、重启全局收藏、与手机同步、QR返回不残留操作页均未执行；需要可写隔离资料库，且账号/源可用。 |
| B站默认收藏夹 / 远端互动 / 保存预览（C05/C07/C09） | [V1b](../.codex-tmp/device/report-V1b.md) / V4 操作页按钮可见、取消返回；[01](../.codex-tmp/device/report-01.md) / [02](../.codex-tmp/device/report-02.md) 有真实推荐详情与播放。 | 没有 remote 收藏/稍后/点赞/投币成功→SQL→MP4下载→断网回放完整记录，也无切P预热/失效源恢复设备全链路。需可操作B站账号与受控断网/缓存夹具。 |
| 平台设置（C13 / B32/B44） | V1b两平台设置及下载弹窗截图；V4有限设置行/正常可见位置；[V12](../.codex-tmp/t22/device/v12-report.md) B站本地退出、凭据立即导入读回与冷启恢复登录/推荐/历史 PASS。 | 退出测试只覆盖B站且登录恢复不等于缓存恢复；删除/后台开关实际持久化、抖音logout站点/媒体/窗口清理、下载弹窗返回差异未全面验收。 |
| B站 / 抖音登录二维码、二步验证（C11 / B38–40） | V1b/V4两平台初始已登录；V12 B站恢复凭据后实际账号历史加载。 | 官方新登录、QR提取/等待蓝环、二步扫码/回落、无网/蓝牙网/WebView缺失需受控账号与网络；不能擅自退出当前抖音账号制造测试，也未证明抖音凭据恢复。 |
| 沉浸 / 队列 / 网络遮罩 / 物理播放器 | V3两平台出现真实视频帧，但控件裁切历史失败；V4正常模式采样图标/进度文字在圆内。 | 实际流拖动/多session预热/codec降级/故障跳过/离线回退/旋转各档/队列进度重启未全覆盖。有限采样不能保证每个状态或触摸框完整。 |
| 后台媒体 / 通知 / 锁屏 / 同步保活 | V4/V13有真实屏幕关闭/进程恢复；V14/V16有框架后台检查/系统job证据。 | 实际媒体续播、AudioFocus/通知权限/点击通知返回、锁屏长传输、蓝牙连接期间无声音频需后台与通知场景；页面/源码开关存在不能判 PASS。 |
| 阅读预设 / 自动滚动 / 菜单锚点 | V4设置/预设/固定时间控件及预览可达；V8b实际自定义手写预览；V16滚轮正反与自动滚动OFF后恢复ON/1.5截图 MAE0。 | 菜单锚点旧V4 FAIL，新代码仍有D02，需修补后实测；实际定时/日出日落定位切换、持续自动滚动、手机字体/背景资源实时预览待验。开关恢复不是自动滚动执行通过。 |
| 图片预览 / 大图 / 内存 | V13真实阮一峰双击放大/平移 PASS；[V15](../.codex-tmp/t28/device/v15-report.md)：四张NASA 3840×2160至8256×5504大原图加载，1x/2x/4x缩放 PASS、30秒PSS下降。 | 捏合/惯性/横向边界全套物理手势、受控同图峰值内存/Graphics释放、压力/低内存场景待验；V15 Reader对V13 MAE6.346838，V16对V15的MAE0不反证此前差异消失。 |
| 朗读 / 首页卡片频谱 / TTS（A-04/A2-04/C17） | V4/ V8b只是语速等设置可见；没有实际合成/频谱/逐段高亮的完整报告。 | 本地引擎/后端与第三方需要实际可用TTS服务/账号配置，逐段跟随、连播、首页返回/PCM频谱、debug字段编辑与连接测试 PENDING。不得用合成波形替代实际数据。 |
| AI / Token / 账号云状态（A2-08/09/10、C16） | V4账号说明卡可见；Token用量明确因未绑定记 PENDING；V13也没有绑定账号制造状态。 | 真实WatchRSS授权、总结/刷新失败重试/Token新增订阅/统计清空、debug隐藏页、会员空间与首次批准需要可用绑定/会员测试账号。 |
| 蓝牙 / IP / 实时阅读预览 / 旧 HTTP 导出（B01/06–13） | V13“连接手机”引导页可见；报告明确未配对、未运行会开启监听的debug蓝牙；主机协议测试不是设备往返。 | 需要手机配对和双端受控数据：v14帧/16KiB进度/stream ACK、长正文/资源/笔记/账号/日志、authoritative replace/clear/revision reset、IP路由切换/重连、HTTP三种导出均 PENDING。 |
| 声波 / 引导 Wi-Fi / 外部启动（B02/03/12、D01） | 仅源码/主机夹具与debug菜单，不存在实际手表PCM或手机热点成功报告。 | 麦克风/位置/附近Wi-Fi权限、收发时长、压缩payload/手机热点token HTTP、取消/后台释放需手机及真实音频环境；D01 ABI 本身未实现。 |
| 云端快照 / 加密 / TUS / 6小时后台（B14–22） | V16系统job admission观察不等于云业务成功；当前源码crypto/service/worker可达。 | 需要绑定测试账号、手机批准P-256信封、服务端空间/对象、计费网/Wi-Fi切换、冲突/ACK/断点重试及系统计划实际后台运行；无端到端手机→云→手表报告。 |
| AppLogger / provider / 日志上传（C15/B11/49/50/55） | V13本地日志UTF-8/大小观察及隐私页→“开始上传”停止；provider超时经[D1](../.codex-tmp/d1/device/d1-report.md)诊断、T26修补后V15 dump0.104s/--clear0.083s PASS。 | 生产log-file.read 65536字节分片、5MiB截断未真机触发；未点上传、未确认测试端点，故InstantDB加密传输/取件码全流程仍 PENDING。 |
| WebView / 法律与首次引导 / 外部debug / 系统Splash | V3有WebView renderer warning/crash诊断；V4法律/设置有限页面与V13平台说明、日志隐私可达。历史冷启没有系统Splash等价判定。 | OOBE/隐私升级全部回退与同意持久化、文档失败重试/加载中重建、WebView历史/三档缩放/cookie挑战、release-debug隔离/广播故障注入/perf场景实测待验；C14系统退出未接线。 |

优先验收应以实际功能链路安排：手机配对/实时预览与覆盖同步、受控账号的平台登录/离线保存/缓存播放、后台媒体通知与云同步；本审计没有启动这些设备任务。性能 <100ms、UI 像素和业务数据一致性使用各自证据，不互相替代。

## 交付与保护

本报告只新增审计文档与 `.codex-tmp/a10/` 的只读证据/索引。旧 minor 报告先逐字节归档到 [t31-report.md](../.codex-tmp/t31/t31-report.md)，然后写10行以内的 [摘要](../.codex-tmp/wrss-minor-report.md)。原有 app 的 LEAD_BRIEF 与两个 pycache 改动完整保留；原生/framework 基线未变。应用在审计期间由外部工作提交 `5c17402`，6个变化文件均逐字节匹配该提交，未由本审计修改；其余原有 tracked 文件保持不变。基线变化证据见 [concurrent-head-change.json](../.codex-tmp/a10/concurrent-head-change.json)。引用行号与修复提交存在性/当前祖先关系的检查结果见 [references.json](../.codex-tmp/a10/references.json) / [commit-verification.json](../.codex-tmp/a10/commit-verification.json)，保护校验见 [protection-result.json](../.codex-tmp/a10/protection-result.json)。本任务结束，停止。
