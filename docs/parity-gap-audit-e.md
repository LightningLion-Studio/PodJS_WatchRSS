# 原生 → PodJS 当前功能差距审计 E

日期：2026-10-24。范围：只读源码、配置、Git 分支与现有测试源码。**没有运行 ADB、连接设备、构建、测试、安装、账号操作或提交。只写本文。** 本文的“已补齐”指当前生产调用链存在，不是当前 APK、真实服务或视觉验收 PASS。共确认 **10项正式功能/迁移行为差异、2项debug差异**；其中原生云store/v19迁入是条件性风险，与已启用PodJS代际的普通覆盖升级分开。

## 1. 基线、范围与排除项

| 前缀 | 本次实际读取的树 |
| --- | --- |
| `P/` | `/home/wilf/data/OPPO_Develop/PodJS_WatchRSS`，`master@8760ce38fd22841dfd648dab05885ebf33a55570` **加工作区**；包括尚未提交的同步域快速路径、传输期间暂停云同步等改动 |
| `F/` | `/home/wilf/data/PodJS/podjs-watch`，`watchrss-migration@f4c3be342188a4bbee2d06882000a93ecc01bf56` **加工作区**；不是旧 D 报告的 framework 修订 |
| `N/` | `/home/wilf/data/OPPO_Develop/Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/`，`main@d7794237e0e138a899c99a9d59bc09ccc49d96c9`；另读取当前云缓存/重试工作区改动 |
| `V2/` | 同一原生仓库 `fix/cloud-v2@efb972c6bdae3598ebbdac89ab015f182e506195` 的 `app/src/main/java/com/lightningstudio/watchrss/`。行号来自 **git show 该分支文件**，不是 main 行号 |
| `ND/` | 原生 `app/src/debug/`；Android manifest 引用另外写明完整相对路径 |

先完整阅读指定的 A、A2、B、C、D、native-parity-a2、settings-parity-audit、ui-parity、debug-parity、douyin-d2-parity，再追踪当前路由、handler、仓储与 Android 宿主。后面的历史编号 A/A2/B 沿用 D 对原始缺口的编号；C01–C17、D01/D02、G1–G5 沿用各报告。同一问题不因出现于多个旧报告重复计数。

**不重新派工的产品决策：**

- 声波连接、引导 Wi-Fi 及其 debug/external ABI 全部废弃：`P/docs/t36-acoustic-retirement.md:3`、`:9`。旧 B02/B03/B12、C15 的声波附项、D01 均排除，不因原生 manifest 仍保留组件重开。
- C01 应用内 APK 升级：OSS 分发，低优先级暂不排期，见 `P/docs/parity-gap-audit-c.md:210`。当前 `P/src/announcement/home.ts:6` 的版本公告关闭和 `P/src/announcement/host.ts:50` 的安装能力缺失仍是真实边界，但按既定安排退出本轮 Top/缺口计数；推送消息不能一并算成关闭。
- C11 手表 release/debug 都保留手工 Cookie；C12 抖音详情收藏必须进入全局保存库：`P/docs/parity-gap-audit-c.md:211`、`:212`。两者是目标行为，不要求退回原生临时星标或隐藏 Cookie。
- 非阅读页纯黑、不复刻原生 debug vignette，是旧 C 明确记录的选择（`P/docs/parity-gap-audit-c.md:11`）。首页频道侧滑和 B 站详情评论按钮在原生正式路径本来关闭，也不凭底层组件存在要求额外开放。
- **debug-only 不整体豁免。** 下文单列尚不等价的诊断和性能场景；现有门控应继续保留。

没有把同名 Activity/Android Service、相同存储格式或相同缓存介质作为功能完成条件；反过来，也没有把 helper/类型声明/表结构的存在当成完整实现。

## 2. 当前确认的用户可见缺口与行为差异

影响按实际触发后的后果评定；“条件性”不代表本次证明设备已处于该状态。建议仅供后续实现，本轮未改代码。

### RSS、收藏与离线阅读

| ID | 原生实现位置 | PodJS 现状与当前证据 | 用户影响 | 建议 |
| --- | --- | --- | --- | --- |
| **E01** | `N/data/rss/DefaultRssRepository.kt:1856`、`:1877` 新增收藏/稍后看即调用 `downloadMediaForItem`；`:1880` 最后一种保存取消后删除离线媒体；普通非权威同步同样安排下载（`:2641`）。`N/data/rss/RssOfflineStore.kt:35` 提取媒体、下载并创建成功/失败记录，`:74` 写 DAO | **部分：能读迁入的离线媒体、能重试已有记录；缺少新保存时的媒体生产与配套取消清理。** `P/src/services.ts:336`、`:337` 只调用仓储保存；`P/src/core/repository.ts:60`–`:69` 只写保存状态/同步状态。`P/src/reader/offline-media.ts:35` 仅 SELECT 已有 `offline_media` 后重试，不提取/新增记录；全 `src` 的该表 INSERT 只见去重迁移复制（`P/src/core/dedup-migration.ts:154`）。同步保存投影 `P/src/sync/saved-state.ts:83`、`:110` 也无下载阶段。普通阅读图片缓存/B站预览各有路径，不能替代此项 | **高**。新收藏文章即使文字可离线读，尚未浏览的图片/视频不因收藏而保留；新条目甚至没有失败记录供“重试”。取消所有保存也缺原生对应的逐篇离线清理 | 补保存后的媒体提取、失败记录、持久下载队列与重试；取消最后一种保存时取消下载并清理。普通 merge 应安排副作用，权威覆盖继续遵守原生“不自动下载”的边界。加“未打开正文→收藏→离线”和“最后一种保存取消”回归 |
| **E02** | `N/data/rss/DefaultRssRepository.kt:222`、`:252` 添加预览直接 fetch；`:384`、`:402` 刷新直接 fetch，不依赖 WatchRSS 账号 | **不一致：公共 RSS 的手动添加/刷新新增强制账号依赖。** `P/src/services.ts:116`–`:121` 将普通公共 HTTP(S) 源送公共池；`P/src/cloud/rss-pool.ts:6`–`:11` 没有账号立即抛“请先连接手机并绑定账号以添加公共 RSS”。同一个 fetch helper 也用于刷新，故旧订阅刷新会收到“添加”文案。内网/带认证的本地专用源与内置平台不在这个分支 | **高**。未绑定、令牌失效后仍有本机订阅的用户，无法像原生一样添加或刷新普通公共 RSS；已有缓存仍可阅读，不能写成整个 RSS 不可用 | 按 S8 保持“先 resolve 公共池”，明确公共池的未登录访问方案或产品登录门槛，并分别给添加/刷新提供准确提示。S8 改来源是明确决策，**没有在所读决策中找到放弃未登录本地 RSS 的决定**；不可用偷偷回退私人云文章索引来补齐 |

E01 修正旧 A/A2/D 的宽泛“离线已实现”：旧离线文件读取和失败重试是真实现，但未覆盖 **新条目的首次离线媒体生产**。E02 是快照瘦身后的新增行为差异；公共池本身已接通，不应再引用旧 B 的“只有 resolve 类型/没有运行时”。

### 抖音播放、预加载与恢复

| ID | 原生实现位置 | PodJS 现状与当前证据 | 用户影响 | 建议 |
| --- | --- | --- | --- | --- |
| **E03** | `N/data/douyin/DouyinPlaybackPreviewCache.kt:350`、`:357` 保存/读取实际播放器 poster；`:562` 恢复 pinned 预览窗口；`:602`、`:650` 持久退出快照。`N/ui/screen/douyin/DouyinImmersiveScreen.kt:814`、`:887`、`:2328` 实际消费/捕获/退出保存 | **部分：元数据、队列、磁盘前缀及两播放器预热已有，实际首帧 poster 快照/离线重进消费不等价。** `P/src/douyin/feed-store.ts:81` 保存元数据与 secure 播放信息；`P/src/ui/VideoPlayerScreen.tsx:348` 重进/拖动使用远端 `posterUrl` 的 RemoteImage，未见实际视频帧捕获及恢复路径。`P/src/douyin/preload-host.ts:58`–`:60` 明确 lookup 恒为 undefined、播放先 resolve，不能把持久 prefix 文件当完整离线源；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodMediaPrefixCache.java:49` 也要求重启后重新登记源 | **中**。原生能复用的“上次实际视频画面/预览起始字节”在弱网、断网重进时不等价，可能回到封面、解析失败或等待；不声称原生可完整离线播所有视频，也不声称 PodJS 完全没有缓存 | 补宿主通用视频帧快照与受控恢复入口，应用绑定条目/源代际，分别验证封面缓存、实际帧快照、前缀字节三种能力。保留 URL/凭据校验，不能用陈旧 URL 绕过权限 |
| **E04** | `N/ui/screen/douyin/DouyinImmersiveScreen.kt:1585` 收预取 HTTP 失败事件；`:1606` 对当前源 403 请求刷新；`:1631` 对符合条件的非前台坏条目隔离；`:1332` 保存失败原因/次数/时间 | **部分：前台播放报错有恢复，但后台预取失败未接业务刷新/隔离。** `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodMediaPrefixCache.java:96` 只计 failures 和打印脱敏 HTTP 分类，随后移除 job；`F/packages/framework/src/media-prefix-cache.ts:2` 暴露聚合统计，未有逐条失败事件。`P/src/douyin/preload-host.ts:29`–`:48` 只处理 resolve/登记/window，不消费预取 HTTP 结果；`P/src/douyin/playback-queue.ts:86` 的 recover 是另一条后置恢复链 | **中**。预热阶段已经识别的坏地址仍可能留到用户切片才失败，少了原生提前换源/跳过坏邻项的路径；具体卡顿时间本轮未测量 | 框架提供带 opaque 条目令牌、HTTP 分类及代际的通用预取结果事件；应用实现一次 403 刷新、重复失败隔离，保留“旧源失败忽略/前台不被旁路自动隔离”等原生规则 |

旧 B/D 的“沉浸流、预热、窗口恢复已实现”继续成立于主路径；它不覆盖上述两个更细的异常/恢复分支。新框架 `PodMediaPrefixCache` 已经是实际字节生产者，不能沿用 debug 文档说整个下载能力不存在。

### 首次接管与原生存量迁移

| ID | 原生实现位置 | PodJS 现状与当前证据 | 用户影响 | 建议 |
| --- | --- | --- | --- | --- |
| **E05** | `N/data/cloud/WatchCloudKeyManager.kt:24` 使用 `watchrss_cloud_keys`；`:92`–`:95` 写/读软件 ECDH 身份；`:128`、`:137` 存多版本账号 key。保留 v2 分支也继续有加密云身份/已验证状态 | **部分，条件性：原生云身份 store 没有通用接管转换闭环。** `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodStoreMappings.java:52` 只校验旧 account_* 键，不将其从 unused 集合移除或写入 PodJS 云 vault，软件设备私钥键也未转换；`:158` 的 joint 只补预设/TTS。`PodStoreAndroidCrypto.java:81` 的旧绑定检查还只查硬件Keystore alias，不含API30软件私钥；`PodStoreConverter.java:114` 将未知键记 retained-unsupported，`:119`–`:122` 另检查云绑定；`PodStorePolicy.java:9`–`:18` 的 known-retention 白名单不含云 key，`PodTakeoverConverters.java:34`–`:42` 因而可阻止激活。这与 PodJS 自己的云 v1→v2 升级是两件事 | **高（仅首次从已用原生云功能的源迁入）**。可能停在迁移恢复页，或需要专门身份恢复，而不是自动继承批准。**不是当前已启用 PodJS 代际升级必然丢账号的结论**，也未读取任何设备私有 store 证明触发 | 对固定原生 main/v2 源夹具做密钥、注册公钥与账号绑定联合迁移设计；无法安全继承时给可理解的恢复/重新批准路径并保留源。不可直接把 blocked 改 ready 或只复制明文 key |
| **E06** | `V2/data/db/WatchRssDatabase.kt:35` 已为 Room **19**；`:316` 增加 readingStateSourceDeviceId | **缺失，条件性：保留分支的 v19 数据库不在当前接管器支持范围。** `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodRoomV18Converter.java:181` 固定要求源 user_version=18 和固定 Room identity；`PodTakeoverSource.java:32` 初始 schema 固定 18。`P/pod.config.json:48` 仍为 native40 接管配置。原生 main 当前仍是18，不能把该问题扩大到所有正式原生用户 | **中（若从保留 fix/cloud-v2 包直接覆盖迁入，则为阻断）**。该分支用户不能仅凭“原生迁移已完成”保证无损升级 | 发布支持范围明确写18；若要承接19，新增独立 schema/identity 契约与列级迁移、完整性夹具，而非放宽 v18 校验。未确认该分支曾正式分发，不把假设用户规模当事实 |
| **E07** | `N/AppResumeStateStore.kt:10`、`N/MainActivity.kt:120` 以及各稳定内容 Activity 的 buildResumeIntent 保留上次内容入口 | **不一致，已知迁移差异：首次接管不会把原生非首页 intent 转为相应 PodJS 内容栈。** `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodStoreMappings.java:22`–`:24` 统一先写 home；只有 Main/Home intent 被消费，其他 retained。`PodStorePolicy.java:15` 明确 native_route_unsupported_home_fallback 可按 known-difference 激活。PodJS 自身以后启动的恢复 `P/src/navigation/resume-state.ts:115`、`:144` 已实现，两者不能混为一谈 | **低**。首次升级后回首页，需自己重新找原来的文章/平台详情；不等于文章阅读进度被清零 | 对可验证的稳定内容 Intent 建立显式白名单映射；保留不安全/瞬态 Intent 的首页回退。若产品接受首次迁移回首页，补明确决策和升级说明，不再把 native intent 连续性算全等 |

### 云同步后台、协议兼容与应用内网页

| ID | 原生实现位置 | PodJS 现状与当前证据 | 用户影响 | 建议 |
| --- | --- | --- | --- | --- |
| **E08** | `N/WatchRssApplication.kt:84`–`:89` 手动云同步运行于 appScope；`:35` 为 IO scope；`V2/CloudSyncActivity.kt:129` 明确离开页面只取消等待，不取消同步 | **不一致，带性能取舍：手动云任务切到应用后台会暂停当前前台 run。** `P/src/cloud/application.ts:19`–`:23`、`:36` 以 lifecycle 和本地传输控制 execution；`P/src/cloud/execution.ts:11`–`:18` 将旧 run 永久 fence。`P/src/cloud/scheduler.ts:13`、`:21`–`:25` 负责回前台重试/保留手动意图；系统后台另走独立 worker（`P/src/cloud/background.ts:8`、`:22`）。**仅离开云同步页、应用仍前台，不等于此触发条件** | **中**。按手动同步后回桌面/熄屏，不能按原生 appScope 行为预期当前任务持续完成；首次大库尤其明显。当前限制是防后台占核的明确实现，不建议直接撤销 | 页面说明前台条件与暂停状态；若要同等后台手动完成，移交受预算、独占约束的 OS worker 并保留可恢复进度。用离页、后台、锁屏、本地 BLE 活动分别验收，不能把6小时计划当即时移交 |
| **E09** | `N/phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:580` 按 supportsChunkedBodies 分支，`:667`–`:673` 仍接非分块 merge；最低版本限制与 body 能力分别判断 | **不一致：缺少原生仍保留的非分块兼容分支。** `P/src/sync/session.ts:213`–`:217` 即便版本满足最低门槛，只要 supportsChunkedBodies=false 就抛错。已有现代分块/批次/ACK/域快速路径不受该结论影响 | **低**。自定义/降级 peer 宣告不支持分块时不能像原生继续同步；不意味着当前官方手机主路径不能同步 | 明确对外能力和最低 peer 契约；需要兼容时补独立受限非分块路径，否则返回明确升级错误并测试。不要将这个旧 native-parity-a2 边界遗漏成“全部 fallback 等价” |
| **E10** | `N/WebViewActivity.kt:93` 订阅 activePreset；`:111` 在网页打开期间重新 applyWebThemePreference | **部分：打开时主题正确，网页持续打开期间的阅读主题切换未接同等更新。** `P/src/browser/open.ts:19`–`:36` 把 preset 转一次性 options；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodInAppBrowser.java:40` 为 final options，`:135` 初始化 dialog，未有订阅阅读预设/更新主题的桥接。历史返回、三档缩放、进度、销毁和 Activity 恢复仍有实现 | **低**。网页跨固定时间/日出日落主题边界时保持打开时的明暗，原生可更新；本轮未做夜间设备观察 | 框架提供通用更新在用浏览器主题的能力，由应用阅读主题变化驱动；或明确接受关闭后重开才应用的取舍 |

## 3. debug-only 尚不等价项（仍需迁移）

| ID | 原生实现位置 | PodJS 现状与当前证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| **DBG-E01** | `N/debug/DebugLogProvider.kt:39` 导出真实播放快照；`N/ui/screen/douyin/DouyinPlaybackDebugOverlay.kt:27`–`:57` 含页码/settled/scroll、下载逐项进度、缓存字节、slot codec/状态、隔离原因/次数；`N/ui/screen/douyin/DouyinImmersiveScreen.kt:1707` 实际更新 | **部分且含过时诊断结论。** `P/src/debug/external-host.ts:11` 只注入 ManagedCache/BiliPreview；`P/src/debug/playback-diagnostics.ts:18` 仍固定输出没有 Douyin preview-download producer，实际生产者已是 `P/src/douyin/preload-host.ts:23`、`:25` 和 framework prefix cache；`:23` 的隔离 reason/failureCount/lastFailedAt 仍 unavailable，queue 只保存删除 ID 集（`P/src/douyin/playback-queue.ts:75`、`:92`）。槽位、上下文、外部广播/provider 本身已接通 | **中（调试）**。排查“预取是否在工作/哪个条目失败”会收到缺信息甚至错误的“没有生产者”解释；不是因为没有复刻 native byte-array 内存结构就必须制造 RAM 数字 | on-demand 读取真实 mediaPrefixCache stats，补逐条任务/隔离元数据与当前页状态。native RAM 没有同构实测时继续写 unavailable 并说明介质；不得把 decoder budget 或 Bili M3 当 Douyin 实占 RAM |
| **DBG-E02** | `N/debug/PerfLargeListActivity.kt:71` 给 FeedScreen 指定 densityScale=3；`N/debug/PerfLargeArticleActivity.kt:45` 同样 Density(3f) | **不一致：测试数据规模和真实帧指标已迁，基准的排版密度未同等声明。** `P/src/ui/DebugToolsScreen.tsx:69`–`:78` 直接用正常 props.width/height 调正式 Feed/Reader，未设置对应3f测试视口/密度；`P/src/debug/perf.ts:3`–`:7` 保留10000项与10万字。旧文档“原生固定场景全等”过宽 | **低（调试）**。测试页可用，但同一物理屏幕的可见行数、换行和布局负载不一定与原生场景相同，不能直接用两端帧耗时判断迁移性能优劣 | 保留正常密度场景，再增加注明3f的原生对拍模式，固定字体缩放/视口/数据/图片加载状态并标记指标来源 |

已补齐且不应重开：严格 host debugBuild 门控、详细 TTS 字段/密钥配置、重新 OOBE、固定大列表/大文章、原生帧统计、蓝牙独占同步、抖音故障注入/自动换片/Cookie 导入、外部 alias/广播、provider dump/clear、隐藏独立 AI 总结。当前证据见第4节。`debug-parity.md` 中历史“没有预览下载生产者”的说明需要随 DBG-E01 更新，不能当当前能力盘点结论。

## 4. 旧审计逐项复核

### 4.1 C/D 与 native-parity-a2 的明确编号项

| 旧编号 | 当前结论 | 当前代码证据 / 范围 |
| --- | --- | --- |
| C01 | 按既定排期排除 | `P/src/announcement/home.ts:6`、`P/src/announcement/host.ts:50`；版本安装未补，推送仍启用 |
| C02/C03 | 已补齐 | `P/src/ui/douyin/index.tsx:239`、`:247` 接共享 RSS feed；`P/src/douyin/rss-feed.ts:33` 去重追加、不截40条；刷新/更多由正式 RssFeedScreen 承担 |
| C04 | 已补齐 | `P/src/douyin/actions.ts:12` 接传入 item，远端失败保留本地可操作内容；`P/src/ui/routes/media-controller.ts:313` 携带平台 item |
| C05 | 已补齐（B站范围） | `P/src/media-services.ts:23`–`:26` 远端保存后写SQL并 enqueue/remove；`P/src/bili/preview.ts:193` 真正 Range 下载；不能推导 E01 普通 RSS 媒体也补齐 |
| C06/C08 | 已补齐 | `P/src/ui/HomeScreen.tsx:48`、`:61` 备忘录移动/置顶、导入频道清空；`P/src/ui/routes/home.tsx:111`–`:115` 接生产动作 |
| C07 | 已补齐 | `P/src/bili/detail-preload.ts:12`、`:30` 750ms/TTL/cancel；`P/src/bili/detail.ts` 控制器与详情组件有真实消费 |
| C09 | 已补齐 | `P/src/ui/bili/index.tsx:565`、`:575`、`:580` 默认收藏夹，成功后返回；不是仍让用户先选夹 |
| C10 | 已补齐 | `P/src/douyin/actions.ts:36` 完成回调；`P/src/ui/screen.tsx:453` 公共分享结束源页面；保存成功退出操作页 |
| C11/C12 | 用户决策已落实 | `P/src/ui/douyin/index.tsx:182` 手工 Cookie；`P/src/douyin/favorite.ts:19`、`P/src/media-services.ts:29` 所在统一保存接线；不回退临时收藏 |
| C13 | 已补齐 | `P/src/ui/PlatformSettingsScreen.tsx:49`、`:50`、`:60` 两平台共用下载、退出、删除确认 |
| C14 / D 的系统Splash | **已补齐** | `P/pod.config.json:61`–`:69`；`F/platforms/android/app/src/main/java/dev/podjs/androidwatch/MainActivity.java:12` install；`F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodSplash.java:37` 系统Splash、`:71` fade/scale退出。不能再说只有 guest 遮罩 |
| C15（抖音外部ABI） | 主契约已补；诊断内容部分见 DBG-E01 | `P/pod.config.json:20`、`P/src/debug/external.ts:22`–`:49`、`F/packages/cli/templates/debug-external/PodDebugExternal.java`；声波附项排除 |
| C16 | 已补齐（隐藏debug） | `P/src/debug/external.ts:39`、`P/src/debug/summary.ts:8`、`P/src/ui/DebugSummaryPlaceholder.tsx:19`；正式阅读内联总结仍保留 |
| C17 | 已补齐（debug） | `P/src/ui/SettingsScreen.tsx:107`–`:110`、`P/src/ui/DebugToolsScreen.tsx:55`，model/voice/baseUrl/key 真正可编辑，不回显存储密钥 |
| D01 | 废弃，排除 | `P/docs/t36-acoustic-retirement.md:3` |
| D02 | **已补齐** | `P/src/ui/ReaderPresetScreen.tsx:109` 使用 roundStart，`:127` 从 ref.roundInsets().start 取值；`F/packages/framework/src/variable-list.tsx:39`–`:44` 当前实际行位置就是统一 start shift，原先漏项已计入 |
| G1 前台动作边界 | 已补齐且有新协议扩展 | `P/src/sync/action-policy.ts:5`、`:15` 区分前台/主动页；`P/src/sync/application-host.ts:52`、`:57` 分别接IP和蓝牙策略。syncBooks/syncDomains/openPairing 是当前扩展，不因比原生旧集合多就判漏洞 |
| G2 QR等待提示 | 已补齐 | `P/src/ui/douyin/login-state.ts:61`–`:63`；宿主 `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodBrowserAuthServices.java:220` 等待环，已不是只改被Dialog遮住的guest文案 |
| G3 日志读失败 | 已补齐 | `P/src/logs/app-logger.ts:17`–`:20` catch后交null构造成功空日志；生产 host `P/src/sync/application-host.ts:42` 接 hostAppLogger.pull |
| G4 ImportedContent trim | 已补齐 | `P/src/core/imported-content.ts:1`–`:15` 共用 kotlinTrim，不再用 JS trim 识别本地导入URL |
| G5 QR时长诊断 | 已补齐 | `P/src/logs/douyin-login.ts:24` 写真实duration；与 usage telemetry 分开 |
| native-parity-a2 非分块边界 | 仍不等价 | E09，不能因G1–G5关闭而遗漏原文最后的兼容边界 |

### 4.2 A / A2 / B 历史缺口索引

以下逐项覆盖 D 使用的9个A、11个A2、55个B历史缺口。新增 E/DBG 编号收窄先前“已实现”的范围；不是把旧结论原样搬来。其他原本已实现的功能，按第5节页面/设置/后台盘点复核。

宿主证据中的 `F/…/类名` 均指 `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/` 下的同名文件。无行号的补充路径用于标明同一调用链，主要定位以带行号者为准。

| 历史 ID | 功能 | 当前判定 | 当前证据 |
| --- | --- | --- | --- |
| A-01 | 原生系统 Splash 退出缩放/淡出及应用内启动遮罩 | 已补齐 | `F/…/PodSplash.java:37、:71`；`P/pod.config.json:61` |
| A-02 | 从桌面冷启动时恢复上次打开的内部内容，并在首页下重建对应返回栈 | 已补齐（PodJS自身恢复）；迁入边界E07 | `P/src/navigation/resume-state.ts:115、:144` |
| A-03 | 首页启动时检查版本公告与未读推送；公告支持可选/强制更新、下载进度、失败提示及拉起系统安装器，推送以弹窗展示 | 推送已补；版本升级按决策排除 | `P/src/announcement/home.ts:6`；`P/src/ui/HomeNoticeDialog.tsx:6` |
| A-04 | 朗读进行中时在首页显示可返回的朗读卡片、当前文章状态和实时频谱 | 已补齐 | `P/src/ui/HomeScreen.tsx:102`；`P/src/reader/speech-playback.ts:38` |
| A-05 | 首页内置 B 站/抖音卡片根据实际登录状态显示“实时”更新语义 | 已补齐 | `P/src/ui/home-extras.ts:28`；`P/src/ui/routes/home.tsx:89` |
| A-06 | 首次加载完成后，无订阅时显示“还没有 RSS 频道”的明确空状态 | 已补齐 | `P/src/ui/HomeScreen.tsx:128` |
| A-07 | 首页下拉刷新全部非内置 RSS 频道，并显示刷新状态/首个错误 | 已补齐；未绑定公共RSS刷新见E02 | `P/src/ui/HomeScreen.tsx:136`；`P/src/services.ts:329` |
| A-08 | 订阅列表展示标题、简介、更新时间、未读数和置顶样式，并按“置顶优先、sortOrder 倒序”排列 | 已补齐 | `P/src/ui/HomeScreen.tsx:124`；`P/src/services.ts:215` |
| A-09 | 首页长按频道操作：移动到顶部、置顶/取消置顶、标记已读、删除（含确认）；变更写入 RSS source 同步状态 | 已补齐 | `P/src/ui/HomeScreen.tsx:48`；`P/src/ui/routes/home.tsx:99` |
| A2-01 | 返回或进入后台时确保最后阅读进度写入完成 | 已补齐（有界等待） | `P/src/ui/ReaderBody.tsx:181`；`P/src/navigation/reader-exit.ts:1` |
| A2-02 | 本地导入内容的单篇删除及确认，并从后续同步中移除 | 已补齐 | `P/src/core/imported-article-deletion.ts:24`；`P/src/services.ts:87` |
| A2-03 | RSS 内抖音媒体播放失败后重新解析有效播放地址 | 已补齐 | `P/src/ui/routes/media-controller.ts（DouyinRssRecovery消费）`；`P/src/ui/routes/media.tsx:63` |
| A2-04 | 朗读播控的“返回文章”与“查看当前文章”两种入口语义 | 已补齐 | `P/src/ui/SpeechPlaybackScreen.tsx:14`；`P/src/ui/routes/home.tsx:92` |
| A2-05 | 预设选择菜单中以该预设的真实正文样式和背景展示单行预览 | 已补齐；原D02也已修 | `P/src/ui/ReaderPresetScreen.tsx:109、:127、:134` |
| A2-06 | debug 版手表端详细 TTS 配置：选择引擎、本地/后端默认、状态信息与连通性测试 | 已补齐（debug） | `P/src/ui/SettingsScreen.tsx:107`；`P/src/debug/tts.ts:12` |
| A2-07 | debug 设置内重新进入新手引导及大列表/大文章性能工具入口 | 已补齐（debug）；密度见DBG-E02 | `P/src/ui/DebugToolsScreen.tsx:52、:63、:69` |
| A2-08 | 总结结果按“显示 Token 用量”设置展示本次输入/输出/总 Token；完整错误原因可回看 | 已补齐 | `P/src/ui/ReaderScreen.tsx:120`；`P/src/llm/summary.ts` |
| A2-09 | Token 统计页面打开期间随新增消耗自动更新 | 已补齐 | `P/src/ui/LlmUsageScreen.tsx:13`；`P/src/llm/usage.ts` |
| A2-10 | 账号页展示会员云中继状态、已用/总空间、首次手机批准说明，以及非会员云存储说明 | 已补齐，现已不是仅debug云 | `P/src/account/status.ts:57`；`P/src/ui/AccountStatusScreen.tsx:72`；`P/src/cloud/gate.ts:2` |
| A2-11 | 已有笔记的草稿保存，在原记录被同步删除/不存在时保持记录身份和基线语义 | 已补齐 | `P/src/notes/repository.ts:65（含墓碑查找，保留身份/基线）` |
| B-01 | 独立 BluetoothConnection 页面：权限请求、等待/结果、重试、返回 URL | 已补齐 | `P/src/ui/BluetoothConnectionScreen.tsx:21`；`P/src/ui/routes/phone.tsx:20` |
| B-02 | 纯声波：接收 RSS、发送收藏/稍后再看、时长预估和录音权限 | 废弃，排除 | `P/docs/t36-acoustic-retirement.md:3` |
| B-03 | 声波引导 Wi-Fi：热点连接、拉 RSS、推收藏/稍后再看 | 废弃，排除 | `P/docs/t36-acoustic-retirement.md:3` |
| B-04 | 不可用原因独立页面 | 已补齐 | `P/src/ui/PhoneConnectionUnavailableScreen.tsx:7` |
| B-05 | 分享二维码可配置宽度比例 | 已补齐 | `P/src/ui/ShareQrScreen.tsx:25`；`P/src/ui/share-qr-layout.ts` |
| B-06 | Server：收藏、稍后再看、B站观看记录 HTTP 导出 | 已补齐 | `P/src/remote-input/exports.ts:6`；`P/src/remote-input/http.ts:35`；`P/src/ui/RemoteInputScreen.tsx:25` |
| B-07 | 16 KiB 传输分块、包含 prefix 的字节进度 | 已补齐 | `P/src/sync/stream.ts`；`F/packages/framework/src/frame-stream.ts` |
| B-08 | probe 中阅读器能力及媒体能力发布 | 已补齐 | `P/src/sync/application-host.ts:43`；`P/src/sync/media-capabilities.ts` |
| B-09 | previewReader stream=true 持续预览流及 ACK 节流 | 已补齐 | `P/src/sync/session.ts:209`；`P/src/reader/preview-session.ts:21` |
| B-10 | syncAccount 安全存储账号、返回身份 | 已补齐 | `P/src/sync/account-actions.ts`；`P/src/account/store.ts:20`；`P/src/sync/application-host.ts:42` |
| B-11 | pullDebugLog 截断、maxChars、totalChars | 已补齐（含失败best-effort） | `P/src/logs/app-logger.ts:17`；`P/src/sync/diagnostic-log.ts` |
| B-12 | guided Wi-Fi /pullRemoteInput、token action URL | 随声波废弃，排除 | `P/docs/t36-acoustic-retirement.md:3` |
| B-13 | DebugBluetoothSyncActivity：超时参数、payload 摘要、生命周期独占 | 已补齐（debug） | `P/src/debug/bluetooth.ts:19`；`P/src/ui/DebugToolsScreen.tsx:54`；`P/src/sync/application-host.ts:60` |
| B-14 | bootstrap、设备注册、会员/空间和 heads API | 已补齐、生产可达 | `P/src/cloud/runtime.ts:11`；`P/src/cloud/service.ts:74`；`P/src/cloud/gate.ts:2` |
| B-15 | 设备 P-256 密钥、手机批准、信封解封、多版本账号密钥 | 已补齐（PodJS密钥链）；原生迁入E05 | `P/src/cloud/keys.ts`；`P/src/cloud/v2.ts`；`P/src/cloud/service.ts:86` |
| B-16 | 快照 manifest/chunk 加密、gzip、哈希及缓存复用 | 已补齐 | `P/src/cloud/codec.ts`；`P/src/cloud/cache.ts`；`P/src/cloud/records.ts:45` |
| B-17 | 拉远端快照及分块、验 hash/长度、解密并恢复本地库 | 已补齐 | `P/src/cloud/service.ts`；`P/src/cloud/codec.ts`；`P/src/cloud/records.ts` |
| B-18 | 本地 RSS/保存状态导出、序列/heads 因果合并、ACK、防重复上传 | 已补齐并升级S8/R45 | `P/src/cloud/library.ts`；`P/src/cloud/records.ts`；`P/src/cloud/service.ts:90` |
| B-19 | TUS 大对象上传：6 MiB 分块、offset、重试 | 已补齐 | `P/src/cloud/tus.ts`；`P/src/cloud/service.ts（reserve/upload/complete调用）` |
| B-20 | 公共 RSS 库 resolve/recent128/all 与本地合并 | 已补齐；未绑定限制E02 | `P/src/cloud/client.ts:83`；`P/src/cloud/service.ts:123`；`P/src/cloud/rss-pool.ts:6` |
| B-21 | 计费网络仅小状态、Wi-Fi/手动正文、状态及会员空间展示 | 已补齐（records与正文网络策略分开） | `P/src/cloud/service.ts:89`；`P/src/ui/CloudSyncScreen.tsx:177`；`P/src/account/status.ts:57` |
| B-22 | 前台 5 分钟节流、账号/网络/数据变化触发、6 小时 worker | 已补齐；前台暂停取舍E08 | `P/src/cloud/application.ts:31、:36`；`P/src/cloud/scheduler.ts:2`；`F/…/PodCloudWorker.java:32` |
| B-23 | Entry：原文卡片模式与 RSS 文本模式切换 | 已补齐 | `P/src/bili/browse.ts:7`；`P/src/ui/routes/media.tsx:40` |
| B-24 | Entry：推荐追加、缓存先显、去重、长按/滑动快捷收藏 | 已补齐 | `P/src/bili/browse.ts:9`；`P/src/ui/bili/index.tsx:152、:163` |
| B-25 | Search：历史存储/清空、AV/BV 直达、连续结果分页 | 已补齐 | `P/src/bili/browse.ts`；`P/src/ui/bili/index.tsx（SearchScreen/结果页）` |
| B-26 | List：历史 cursor 与收藏内容 loadMore | 已补齐 | `P/src/bili/browse.ts`；`P/src/ui/bili/index.tsx:266、:285` |
| B-27 | Detail：选分 P、恢复上次 cid、点赞/投币/取消收藏及互动状态 | 已补齐 | `P/src/bili/detail.ts:11`；`P/src/ui/bili/index.tsx（详情分P与互动回调）` |
| B-28 | Detail：离线本地已保存信息兜底、预览视频热身 | 已补齐（B站） | `P/src/media-services.ts`；`P/src/bili/detail-preload.ts:12`；`P/src/bili/preview.ts:95` |
| B-29 | CommentActivity：置顶/正文/头像、回复入口 | 已补齐；正式详情入口同原生关闭 | `P/src/bili/comments.ts:13`；`P/src/ui/bili/CommentScreen.tsx:64` |
| B-30 | ReplyDetailActivity：根评论、楼中楼及分页 | 已补齐；原生root接线限制不额外要求 | `P/src/bili/comments.ts`；`P/src/ui/bili/CommentScreen.tsx:64` |
| B-31 | VideoActions/Detail：远端成功后写本地收藏/稍后再看并缓存预览 | 已补齐（B站） | `P/src/media-services.ts:23、:25`；`P/src/bili/client.ts` |
| B-32 | Settings：退出登录、删除频道确认、后台播放开关 | 已补齐 | `P/src/ui/PlatformSettingsScreen.tsx:48、:50、:60`；`P/src/media/logout.ts` |
| B-33 | Player：播放错误刷新源/切候选、缓存播放源/预览回退 | 已补齐 | `P/src/bili/playback.ts`；`P/src/ui/routes/media-controller.ts（候选与本地预览回退）` |
| B-34 | Entry：原文沉浸竖向流 / RSS 列表模式开关 | 已补齐 | `P/src/douyin/original-mode.ts`；`P/src/ui/routes/media.tsx:41` |
| B-35 | Entry：沉浸预加载播放器池、缓存引导、最近窗口/当前视频恢复、失效源刷新/跳过 | 主路径已补；细分差异E03/E04 | `P/src/ui/douyin/video-sessions.ts:89`；`P/src/douyin/preload-host.ts:29`；`P/src/douyin/feed-store.ts:81` |
| B-36 | Entry：长按/侧滑视频操作、标题点击频道信息 | 已补齐 | `P/src/ui/douyin/index.tsx:247`；`P/src/ui/VideoPlayerScreen.tsx（纵向/横向手势）` |
| B-37 | ChannelInfo：专门说明/URL/更新状态页，登录、设置、历史入口 | 已补齐 | `P/src/ui/douyin/index.tsx（ChannelInfoScreen与路由）` |
| B-38 | Login：官方 WebView 登录、提取二维码、cookie 持久化 | 已补齐 | `P/src/media/browser-auth.ts`；`P/src/ui/douyin/index.tsx:167、:172` |
| B-39 | Login：Checking / 无网络 / 蓝牙网络禁用、WebView 不可用专页 | 已补齐 | `P/src/ui/douyin/login-state.ts`；`P/src/douyin/browser.ts`；`P/src/ui/douyin/index.tsx:199` |
| B-40 | Login：二步验证识别及回落网页登录 | 已补齐 | `P/src/ui/douyin/login-state.ts:48、:62`；`P/src/media/browser-auth.ts` |
| B-41 | Detail：继承阅读器预设、字号、传入数据直接离线展示 | 已补齐 | `P/src/douyin/detail.ts`；`P/src/ui/douyin/index.tsx（ReaderArticlePage）` |
| B-42 | History：从历史构造播放队列、连续换视频记录历史 | 按D2修为原生单片详情；显式队列另有恢复 | `P/src/ui/routes/media-controller.ts:355`；`P/src/douyin/resume.ts`；`P/docs/douyin-d2-parity.md:24` |
| B-43 | VideoActions：本地保存进入统一 RSS 库与手机同步 | 已补齐 | `P/src/douyin/client.ts`；`P/src/media-services.ts（onSaved统一SQL）` |
| B-44 | Settings：原文/后台开关、退出登录、频道删除确认 | 已补齐 | `P/src/ui/PlatformSettingsScreen.tsx:48、:50、:60` |
| B-45 | Settings：退出清 WebView cookie、媒体缓存和最近窗口、回首页 | 已补齐 | `P/src/media/logout.ts`；`P/src/media-services.ts:29`；`P/src/ui/routes/media.tsx` |
| B-46 | Player：网络遮罩、队列位置跨重启恢复、沉浸流长按操作 | 已补齐主路径；首帧缓存恢复另E03 | `P/src/ui/VideoPlayerScreen.tsx:312`；`P/src/douyin/resume.ts`；`P/src/douyin/playback-queue.ts:28` |
| B-47 | Info：Activity 重建时保留正文/加载状态/滚动 | 已补齐 | `P/src/ui/InformationScreens.tsx:112、:149`；`P/src/ui/routes/info.tsx` |
| B-48 | 加群：相同 URL/群号、二维码与无障碍说明 | 已补齐 | `P/src/ui/InformationScreens.tsx:156（QR/群号/读屏说明）` |
| B-49 | 日志上传隐私说明及显式开始操作 | 已补齐 | `P/src/ui/InformationScreens.tsx:134`；`P/src/ui/routes/info.tsx:64` |
| B-50 | 日志读取、暂无/加载失败状态、WebView 自动提交加密日志、取件码 | 已补齐 | `P/src/logs/encryption.ts:10`；`P/src/logs/upload.ts`；`P/src/ui/LogUploadScreen.tsx` |
| B-51 | WebView：应用内浏览、历史返回、缩放档位、主题、加载进度、销毁 | 主路径已补；实时主题E10 | `P/src/browser/open.ts:32`；`F/…/PodInAppBrowser.java:135、:149、:193` |
| B-52 | WebView：联网前置检查、不可用提示、本地绝对路径转换 | 已补齐 | `F/…/PodInAppBrowser.java:80、:101` |
| B-53 | 原生超大列表/超大文章固定场景与指标 | 已补齐；基准密度DBG-E02 | `P/src/debug/perf.ts:3`；`P/src/ui/DebugToolsScreen.tsx:69` |
| B-54 | 抖音 debug alias/广播故障注入、cookie 导入、自动换片 | 已补齐（debug）；声波排除 | `P/src/debug/external.ts:38、:43、:45`；`P/pod.config.json:20` |
| B-55 | DebugLogProvider / dump 与性能开关 | 外部契约已补；内容仍DBG-E01 | `P/src/debug/external.ts:22`；`P/src/debug/playback-diagnostics.ts:18`；`P/src/debug/gate.ts` |

### 4.3 其余指定文档的项目复核

| 文档/项目 | 当前判定与证据 |
| --- | --- |
| A：OOBE版本/隐私门禁、四步引导、法律正文、同意/拒绝、草稿/法律栈恢复 | 主路径仍实现：`P/src/ui/StartupGate.tsx:47`、`:74`；`P/src/onboarding/controller.ts:17`、`:21`；`P/src/onboarding/legal-restoration.ts`。没有因为云/蓝牙启动改动绕过准入；本轮未做设备同意操作 |
| A：首页、添加/推荐、频道详情/设置、搜索、保存列表 | 页面均可达（第5节）；添加/刷新公共源账号依赖E02；保存列表/文字可离线，不足以关闭E01首次媒体下载。12+8/200分页仍见 `P/src/ui/feed-window.ts:10`、`P/src/ui/RssScreens.tsx:88`；频道搜索与推荐均有实际服务接线 |
| A/A2：文章正文/原文、阅读位置、图片预览、媒体、朗读、自动滚动 | `P/src/ui/ReaderScreen.tsx:119`、`:131`，`P/src/ui/ReaderBody.tsx:181`，`P/src/ui/ImagePreviewScreen.tsx:37`，`P/src/ui/AutoScrollSettingsScreen.tsx:24`。主功能存在；离线媒体生产E01、WebView持续主题E10另列。没有据此保证所有HTML/物理手势/字体像素等价 |
| A2：预设与字体/背景资源、日程/定位、单行真实预览、手机实时预览 | `P/src/ui/ReaderPresetScreen.tsx:46`、`:84`、`:134`；`P/src/reader/preview-session.ts:21`（20秒/120秒/33ms）；`P/src/sync/reader-actions.ts:4`。菜单旧D02已关闭，仍不把源码几何修补当本轮实机视觉PASS |
| A2：AI开关、自动总结、四提示词、Token显示/统计/订阅、账号状态 | `P/src/ui/SettingsScreen.tsx:46`、`P/src/ui/ReaderScreen.tsx:120`、`P/src/ui/LlmUsageScreen.tsx:13`、`P/src/account/status.ts:42`、`P/src/ui/AccountStatusScreen.tsx:64`。独立隐藏摘要也已实现（C16）。账号云状态现在由真实产品云runtime提供，旧debug-only描述作废 |
| B：连接主页/蓝牙/IP、协议帧/增量/覆盖/清库、笔记/附件、预设/实时预览/资源、账号/统计/日志、HTTP导出 | `P/src/sync/application-host.ts:42`、`:52`、`:57`，`P/src/sync/session.ts:213`，`P/src/remote-input/http.ts:17`、`:35`。生产handler齐全；旧非分块fallback E09仍不同，G1前台策略已补。扫码配对不是只有旧“下载手机”说明页 |
| B：B站11页的推荐/登录/搜索/列表/分P互动/保存/离线预览/评论/播放器 | `P/src/ui/bili/index.tsx:152`、`:266`、`:285`、`:565`；`P/src/bili/detail.ts`、`P/src/bili/preview.ts:193`；评论组件 `P/src/ui/bili/CommentScreen.tsx:64`。原先追加/手势、详情预热、默认夹/成功返回等缺口均已补；没有凭备用播放器占位误判整个播放缺失 |
| B：抖音8页主功能 | 正式原文/RSS、QR/二验/手工Cookie、详情/历史、保存/设置/播放器均有接线。E03/E04收窄恢复和预热错误分支，DBG-E01收窄诊断完整性，不退回“抖音全缺/没有播放器池”结论 |
| settings-parity-audit：高级入口/备案、分享描述和Kotlin空白/空标题规则 | 当前 `P/src/ui/SettingsScreen.tsx:56`、`:62`；`P/src/sharing/policy.ts:5`–`:22` 仍分别处理详情/操作页和system/QR。原生主设置页没有的“清理缓存/隐私与日志”占位不重建；高级用量/预取/保活依然存在 |
| ui-parity：首页结构、原字体/图标、虚拟列表/手势 | 旧底部四导航已无；`P/src/ui/HomeScreen.tsx:124`–`:136` 按个人入口/备忘录与频道/推荐添加备案组织，`P/pod.config.json:121` 字体，`P/src/ui/ScrollEntries.tsx:16` 使用framework VariableList。旧文档“所有页面尚未迁移”一类历史描述不可直接沿用；也没有本次逐像素对拍，视觉验收仍未建立新证据 |
| debug-parity：C15/C16/C17、详细诊断 | 外部ABI/独立摘要/TTS编辑已接；详细诊断仍DBG-E01。原生真实帧指标在宿主，不把JS帧间隔当Android帧耗时；场景密度DBG-E02。debug关闭时不以缺控件判功能丢失 |
| douyin-d2-parity：历史/详情单片、显式播放器队列恢复、遮罩/本地源、二验优先、登录错误/自动完成 | 当前 `P/src/ui/routes/media-controller.ts:286`–`:355` 分开detailPlayback/immersive；`P/src/douyin/resume.ts:4` 恢复真实secure快照；`P/src/ui/VideoPlayerScreen.tsx:312` 区分网络遮罩/恢复，`P/src/ui/douyin/login-state.ts:48` 取消/二验状态，`P/src/ui/douyin/index.tsx:167` browser auth实际参数。主路径已实现，不沿用旧B“点击历史必传完整队列”；实际poster缓存E03不是D2单片导航问题 |

## 5. 从原生入口重新盘点

### 5.1 Activity 与页面入口

本轮重新解析 **当前** 原生 main manifest：**72 Activity、2 Provider、0自定义Android Service、0静态Receiver**；debug manifest另有1个alias、1个Receiver（覆写DouyinEntry不是新增Activity）。与D的70项差别为CloudSync/MiniProgramPairing两个新入口。下面逐个映射，不以是否同名/同数量来宣称行为全等。文件行号为当前类声明附近；细分动作差异以第2/3节为准。

| 原生Activity（当前源码） | PodJS当前入口 | 判定/剩余范围 |
| --- | --- | --- |
| `N/MainActivity.kt:25`（MainActivity） | `P/src/ui/StartupGate.tsx:47` | 版本门禁/系统Splash/恢复；首次迁入E05–E07 |
| `N/HomeFeedListActivity.kt:62`（HomeFeedListActivity） | `P/src/ui/HomeScreen.tsx:124` | 频道/备忘录/朗读/刷新；公共RSS限制E02 |
| `N/AddRssActivity.kt:20`（AddRssActivity） | `P/src/ui/AddRssScreen.tsx:13` | 预览/确认/已有源；E02 |
| `N/RssRecommendActivity.kt:10`（RssRecommendActivity） | `P/src/ui/RecommendationScreen.tsx:9` | 入口/主路径已映射 |
| `N/RssRecommendGroupActivity.kt:10`（RssRecommendGroupActivity） | `P/src/ui/RecommendationScreen.tsx:9` | 入口/主路径已映射 |
| `N/OobeActivity.kt:22`（OobeActivity） | `P/src/ui/OnboardingScreen.tsx:40` | 入口/主路径已映射 |
| `N/PrivacyPolicyConsentActivity.kt:19`（PrivacyPolicyConsentActivity） | `P/src/ui/PrivacyPolicyConsentScreen.tsx:9` | 入口/主路径已映射 |
| `N/FeedActivity.kt:20`（FeedActivity） | `P/src/ui/RssScreens.tsx:33` | 入口/主路径已映射 |
| `N/ChannelActionsActivity.kt:29`（ChannelActionsActivity） | `P/src/ui/HomeScreen.tsx:48` | 入口/主路径已映射 |
| `N/ItemActionsActivity.kt:26`（ItemActionsActivity） | `P/src/ui/RssScreens.tsx:93` | 保存/分享/删除入口；离线副作用E01 |
| `N/NoteActionsActivity.kt:25`（NoteActionsActivity） | `P/src/ui/NotesScreen.tsx:221` | 入口/主路径已映射 |
| `N/DetailActivity.kt:28`（DetailActivity） | `P/src/ui/ReaderScreen.tsx:119` | 正文/原文/AI/朗读/进度/媒体；E01/E10 |
| `N/ShareQrActivity.kt:11`（ShareQrActivity） | `P/src/ui/ShareQrScreen.tsx:25` | 入口/主路径已映射 |
| `N/WebViewActivity.kt:57`（WebViewActivity） | `P/src/browser/open.ts:32` | 应用→原生host完整浏览器；E10 |
| `N/ChannelDetailActivity.kt:28`（ChannelDetailActivity） | `P/src/ui/ChannelScreens.tsx:21` | 入口/主路径已映射 |
| `N/RssSearchActivity.kt:15`（RssSearchActivity） | `P/src/ui/RssSearchScreen.tsx:19` | 入口/主路径已映射 |
| `N/ChannelSettingsActivity.kt:25`（ChannelSettingsActivity） | `P/src/ui/ChannelScreens.tsx:21` | 入口/主路径已映射 |
| `N/SettingsActivity.kt:17`（SettingsActivity） | `P/src/ui/SettingsScreen.tsx:56` | 入口/主路径已映射 |
| `N/ReaderPresetActivity.kt:68`（ReaderPresetActivity） | `P/src/ui/ReaderPresetScreen.tsx:28` | 选择/日程/定位；旧D02关闭 |
| `N/ReaderPresetPreviewActivity.kt:71`（ReaderPresetPreviewActivity） | `P/src/ui/ReaderPreviewScreen.tsx:26` | 入口/主路径已映射 |
| `N/AdvancedSettingsActivity.kt:11`（AdvancedSettingsActivity） | `P/src/ui/SettingsScreen.tsx:56` | 入口/主路径已映射 |
| `N/TtsSettingsActivity.kt:15`（TtsSettingsActivity） | `P/src/ui/SettingsScreen.tsx:56` | 入口/主路径已映射 |
| `N/LlmPromptPresetActivity.kt:15`（LlmPromptPresetActivity） | `P/src/ui/LlmPromptPresetScreen.tsx:9` | 入口/主路径已映射 |
| `N/LlmSummaryActivity.kt:15`（LlmSummaryActivity） | `P/src/ui/DebugSummaryPlaceholder.tsx:19` | 隐藏debug独立页；正常阅读内联总结 |
| `N/LlmTokenUsageActivity.kt:13`（LlmTokenUsageActivity） | `P/src/ui/LlmUsageScreen.tsx:11` | 入口/主路径已映射 |
| `N/ReadAloudPlaybackActivity.kt:14`（ReadAloudPlaybackActivity） | `P/src/ui/SpeechPlaybackScreen.tsx:14` | 入口/主路径已映射 |
| `N/AutoScrollControlActivity.kt:18`（AutoScrollControlActivity） | `P/src/ui/AutoScrollSettingsScreen.tsx:24` | 入口/主路径已映射 |
| `N/ProfileActivity.kt:10`（ProfileActivity） | `P/src/ui/ProfileScreen.tsx:7` | 入口/主路径已映射 |
| `N/NotesActivity.kt:131`（NotesActivity） | `P/src/ui/NotesScreen.tsx:49` | 入口/主路径已映射 |
| `N/NotesActivity.kt:167`（NoteDetailActivity） | `P/src/ui/NotesScreen.tsx:102` | Markdown/编辑/草稿/撤销重做/锚点 |
| `N/AccountStatusActivity.kt:30`（AccountStatusActivity） | `P/src/ui/AccountStatusScreen.tsx:12` | 入口/主路径已映射 |
| `N/CloudSyncActivity.kt:26`（CloudSyncActivity） | `P/src/ui/CloudSyncScreen.tsx:132` | records/快照/批准/归属/重登记/退出；后台取舍E08 |
| `N/MiniProgramPairingActivity.kt:44`（MiniProgramPairingActivity） | `P/src/ui/MiniProgramPairingPanel.tsx:1` | 扫码/SAS/取消/完成；R43按新契约实现 |
| `N/PhoneConnectionActivity.kt:11`（PhoneConnectionActivity） | `P/src/ui/PhoneConnectionScreen.tsx:17` | 扫码绑定/手机App下载/同步进度 |
| `N/BluetoothConnectionActivity.kt:44`（BluetoothConnectionActivity） | `P/src/ui/BluetoothConnectionScreen.tsx:21` | 入口/主路径已映射 |
| `N/AcousticConnectionActivity.kt:59`（AcousticConnectionActivity） | `P/docs/t36-acoustic-retirement.md:3` | 已废弃，排除 |
| `N/DebugAcousticConnectionActivity.kt:8`（DebugAcousticConnectionActivity） | `P/docs/t36-acoustic-retirement.md:3` | 已废弃，排除 |
| `N/DebugBluetoothSyncActivity.kt:19`（DebugBluetoothSyncActivity） | `P/src/debug/bluetooth.ts:19` | debug独占/超时/结果/释放 |
| `N/PhoneConnectionUnavailableActivity.kt:17`（PhoneConnectionUnavailableActivity） | `P/src/ui/PhoneConnectionUnavailableScreen.tsx:7` | 入口/主路径已映射 |
| `N/SavedItemsActivity.kt:26`（SavedItemsActivity） | `P/src/ui/SavedItemsScreen.tsx:58` | 收藏/稍后看/排序/移除撤回/导出；E01 |
| `N/AboutActivity.kt:9`（AboutActivity） | `P/src/ui/InformationScreens.tsx:128` | 入口/主路径已映射 |
| `N/CollaboratorsActivity.kt:8`（CollaboratorsActivity） | `P/src/ui/InformationScreens.tsx:128` | 入口/主路径已映射 |
| `N/InfoActivity.kt:45`（InfoActivity） | `P/src/ui/InformationScreens.tsx:128` | 入口/主路径已映射 |
| `N/BiliDetailActivity.kt:25`（BiliDetailActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/BiliChannelInfoActivity.kt:26`（BiliChannelInfoActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/BiliSettingsActivity.kt:31`（BiliSettingsActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/BiliListActivity.kt:21`（BiliListActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/BiliLoginActivity.kt:20`（BiliLoginActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/BiliPlayerActivity.kt:25`（BiliPlayerActivity） | `P/src/ui/VideoPlayerScreen.tsx:44` | 播放/DASH/进度/历史/候选/预览回退 |
| `N/BiliVideoActionsActivity.kt:27`（BiliVideoActionsActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/ImagePreviewActivity.kt:10`（ImagePreviewActivity） | `P/src/ui/ImagePreviewScreen.tsx:10` | 入口/主路径已映射 |
| `N/RssPlayerActivity.kt:25`（RssPlayerActivity） | `P/src/ui/VideoPlayerScreen.tsx:44` | 入口/主路径已映射 |
| `N/BiliEntryActivity.kt:11`（BiliEntryActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/BiliCommentActivity.kt:14`（BiliCommentActivity） | `P/src/ui/bili/CommentScreen.tsx:64` | 实现保留；原生详情入口同样隐藏 |
| `N/BiliReplyDetailActivity.kt:14`（BiliReplyDetailActivity） | `P/src/ui/bili/CommentScreen.tsx:64` | 实现保留；原生详情入口同样隐藏 |
| `N/BiliSearchActivity.kt:22`（BiliSearchActivity） | `P/src/ui/bili/index.tsx:618` | 正式入口/服务齐备；C05/C07/C09均已关闭 |
| `N/DouyinEntryActivity.kt:46`（DouyinEntryActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/DouyinChannelInfoActivity.kt:28`（DouyinChannelInfoActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/DouyinHistoryActivity.kt:25`（DouyinHistoryActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/DouyinSettingsActivity.kt:35`（DouyinSettingsActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/DouyinLoginActivity.kt:24`（DouyinLoginActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/DouyinPlayerActivity.kt:36`（DouyinPlayerActivity） | `P/src/ui/VideoPlayerScreen.tsx:44` | 单片/沉浸队列分别接；E03/E04 |
| `N/DouyinVideoActionsActivity.kt:28`（DouyinVideoActionsActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/DouyinDetailActivity.kt:25`（DouyinDetailActivity） | `P/src/ui/douyin/index.tsx:390` | 正式入口/服务齐备；细分E03/E04、DBG-E01 |
| `N/ContactDeveloperActivity.kt:17`（ContactDeveloperActivity） | `P/src/ui/InformationScreens.tsx:128` | 入口/主路径已映射 |
| `N/JoinGroupActivity.kt:8`（JoinGroupActivity） | `P/src/ui/InformationScreens.tsx:128` | 入口/主路径已映射 |
| `N/LogUploadPrivacyActivity.kt:8`（LogUploadPrivacyActivity） | `P/src/ui/InformationScreens.tsx:128` | 入口/主路径已映射 |
| `N/LogUploadActivity.kt:24`（LogUploadActivity） | `P/src/ui/LogUploadScreen.tsx:1` | 入口/主路径已映射 |
| `N/ServerActivity.kt:19`（ServerActivity） | `P/src/ui/RemoteInputScreen.tsx:17` | 入口/主路径已映射 |
| `N/BeianActivity.kt:10`（BeianActivity） | `P/src/ui/BeianScreen.tsx:38` | 入口/主路径已映射 |
| `N/debug/PerfLargeListActivity.kt:18`（PerfLargeListActivity） | `P/src/ui/DebugToolsScreen.tsx:69` | debug场景/真实帧指标；DBG-E02 |
| `N/debug/PerfLargeArticleActivity.kt:20`（PerfLargeArticleActivity） | `P/src/ui/DebugToolsScreen.tsx:69` | debug场景/真实帧指标；DBG-E02 |

### 5.2 Screen及无独立Activity的支撑文件

共74个`ui/screen/*.kt`文件，含布局、状态模型和组件，不等于74个独立页面。下表列出全部文件，辅助类归入其实际页面调用链；没有把旧Compose包装页或注释文件虚增为新产品入口。第2/3节指出已确认的细分差异，其他行仅确认对应实现路径，非逐像素认证。

| 原生Screen/支撑文件（首个定义附近） | 当前PodJS对应路径/细分结论 |
| --- | --- |
| `N/ui/screen/AboutScreen.kt:31` | src/ui/InformationScreens.tsx:128 |
| `N/ui/screen/ActionDialogScreen.kt:36` | src/ui/RssScreens.tsx:93 / src/ui/bili/index.tsx:567 |
| `N/ui/screen/BeianScreen.kt:22` | src/ui/BeianScreen.tsx:38 |
| `N/ui/screen/CollaboratorsScreen.kt:36` | src/ui/InformationScreens.tsx:131 |
| `N/ui/screen/ContactDeveloperScreen.kt:40` | src/ui/InformationScreens.tsx:132 |
| `N/ui/screen/DeleteConfirmDialog.kt:42` | src/ui/DeleteConfirmDialog.tsx |
| `N/ui/screen/InfoScreen.kt:33` | src/ui/InformationScreens.tsx:149 |
| `N/ui/screen/JoinGroupScreen.kt:32` | src/ui/InformationScreens.tsx:156 |
| `N/ui/screen/LogUploadPrivacyScreen.kt:32` | src/ui/InformationScreens.tsx:134 |
| `N/ui/screen/LogUploadScreen.kt:28` | src/ui/LogUploadScreen.tsx |
| `N/ui/screen/OobeScreen.kt:95` | src/ui/OnboardingScreen.tsx:40 |
| `N/ui/screen/PlatformEntryScreen.kt:24` | src/ui/PlatformNotice.tsx / src/ui/entry-disclosure.ts |
| `N/ui/screen/PrivacyPolicyConsentScreen.kt:35` | src/ui/PrivacyPolicyConsentScreen.tsx:9 |
| `N/ui/screen/ProfileScreen.kt:45` | src/ui/ProfileScreen.tsx:7 |
| `N/ui/screen/ServerScreen.kt:58` | src/ui/RemoteInputScreen.tsx:17 |
| `N/ui/screen/ShareQrScreen.kt:26` | src/ui/ShareQrScreen.tsx:25 |
| `N/ui/screen/WebViewScreen.kt:39` | src/browser/open.ts:32（宿主浏览器；E10） |
| `N/ui/screen/bili/BiliChannelInfoScreen.kt:46` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliCommentScreen.kt:41` | src/ui/bili/CommentScreen.tsx:64 |
| `N/ui/screen/bili/BiliComponents.kt:50` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliDetailScreen.kt:67` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliEntryNavGraph.kt:32` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliFeedScreen.kt:76` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliListScreen.kt:37` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliLoginScreen.kt:38` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliPlayerScreen.kt:123` | src/ui/VideoPlayerScreen.tsx / src/ui/video-player.ts（通用播放器链） |
| `N/ui/screen/bili/BiliReplyDetailScreen.kt:45` | src/ui/bili/CommentScreen.tsx:64 |
| `N/ui/screen/bili/BiliRssDetailScreen.kt:68` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliRssFeedScreen.kt:72` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliSearchResultScreen.kt:33` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliSearchScreen.kt:38` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/bili/BiliSettingsScreen.kt:39` | src/ui/bili/index.tsx:618 / src/ui/routes/media.tsx |
| `N/ui/screen/cloud/CloudApprovalDialog.kt:26` | src/ui/CloudSyncScreen.tsx:132 / src/ui/cloud-sync-view.ts（批准/归属/错误分支；E08） |
| `N/ui/screen/cloud/CloudSyncScreen.kt:47` | src/ui/CloudSyncScreen.tsx:132 / src/ui/cloud-sync-view.ts（批准/归属/错误分支；E08） |
| `N/ui/screen/cloud/CloudSyncUiState.kt:10` | src/ui/CloudSyncScreen.tsx:132 / src/ui/cloud-sync-view.ts（批准/归属/错误分支；E08） |
| `N/ui/screen/douyin/DouyinChannelInfoScreen.kt:46` | src/ui/douyin/index.tsx:390 / src/ui/routes/media.tsx |
| `N/ui/screen/douyin/DouyinCookieInputDialog.kt:33` | src/ui/douyin/index.tsx:182（C11决策保留） |
| `N/ui/screen/douyin/DouyinFeedScreen.kt:39` | src/ui/douyin/index.tsx:390 / src/ui/routes/media.tsx |
| `N/ui/screen/douyin/DouyinHistoryScreen.kt:41` | src/ui/douyin/index.tsx:390 / src/ui/routes/media.tsx |
| `N/ui/screen/douyin/DouyinImmersiveScreen.kt:149` | src/ui/VideoPlayerScreen.tsx / src/ui/douyin/video-sessions.ts:88（E03/E04） |
| `N/ui/screen/douyin/DouyinLoginBannedScreen.kt:14` | src/ui/douyin/index.tsx:390 / src/ui/routes/media.tsx |
| `N/ui/screen/douyin/DouyinLoginScreen.kt:67` | src/ui/douyin/index.tsx:390 / src/ui/routes/media.tsx |
| `N/ui/screen/douyin/DouyinLoginScreenComment.kt:1` | 原生保留的注释文件；非额外运行入口 |
| `N/ui/screen/douyin/DouyinPlaybackDebugOverlay.kt:7` | src/debug/playback-diagnostics.ts:11（DBG-E01） |
| `N/ui/screen/douyin/DouyinPlaybackStateResolver.kt:5` | src/ui/douyin/player-network.ts / src/ui/VideoPlayerScreen.tsx（网络/首帧状态） |
| `N/ui/screen/douyin/DouyinRssFeedScreen.kt:50` | src/ui/douyin/index.tsx:390 / src/ui/routes/media.tsx |
| `N/ui/screen/home/HomeComposeScreen.kt:102` | src/ui/HomeScreen.tsx:124 |
| `N/ui/screen/launch/LaunchScreenOverlay.kt:61` | src/ui/StartupGate.tsx:47 / F/…/PodSplash.java:37 |
| `N/ui/screen/phoneconnection/MiniProgramPairingScreen.kt:47` | src/ui/PhoneConnectionScreen.tsx:17 / src/ui/MiniProgramPairingPanel.tsx（R28/R43） |
| `N/ui/screen/phoneconnection/PairingUiState.kt:6` | src/ui/PhoneConnectionScreen.tsx:17 / src/ui/MiniProgramPairingPanel.tsx（R28/R43） |
| `N/ui/screen/phoneconnection/PhoneConnectionComponents.kt:62` | src/ui/PhoneConnectionScreen.tsx:17 / src/ui/MiniProgramPairingPanel.tsx（R28/R43） |
| `N/ui/screen/phoneconnection/PhoneConnectionScreen.kt:49` | src/ui/PhoneConnectionScreen.tsx:17 / src/ui/MiniProgramPairingPanel.tsx（R28/R43） |
| `N/ui/screen/rss/AddRssScreen.kt:59` | src/ui/AddRssScreen.tsx:13（E02） |
| `N/ui/screen/rss/AutoScrollControlScreen.kt:54` | src/ui/AutoScrollSettingsScreen.tsx:24 |
| `N/ui/screen/rss/ChannelDetailScreen.kt:53` | src/ui/ChannelScreens.tsx:21 |
| `N/ui/screen/rss/ChannelSettingsScreen.kt:37` | src/ui/ChannelScreens.tsx:41 |
| `N/ui/screen/rss/DetailBehaviorSupport.kt:35` | src/ui/ReaderBody.tsx / src/reader/progress.ts / src/sharing/policy.ts |
| `N/ui/screen/rss/DetailContentBlocks.kt:60` | src/reader/content.ts:57 / src/ui/ReaderBody.tsx |
| `N/ui/screen/rss/DetailHeaderActions.kt:78` | src/ui/ReaderScreen.tsx:119 |
| `N/ui/screen/rss/DetailMediaSupport.kt:37` | src/ui/ReaderScreen.tsx:131 / src/ui/routes/media-controller.ts（E01） |
| `N/ui/screen/rss/DetailScreen.kt:144` | src/ui/ReaderScreen.tsx:119 |
| `N/ui/screen/rss/FeedScreen.kt:120` | src/ui/RssScreens.tsx:33 |
| `N/ui/screen/rss/HomeScreen.kt:43` | src/ui/HomeScreen.tsx:124（兼容包装，不新增入口） |
| `N/ui/screen/rss/ImagePreviewScreen.kt:59` | src/ui/ImagePreviewScreen.tsx:10 |
| `N/ui/screen/rss/LlmPromptPresetScreen.kt:35` | src/ui/LlmPromptPresetScreen.tsx:9 |
| `N/ui/screen/rss/LlmSummaryScreen.kt:51` | src/ui/DebugSummaryPlaceholder.tsx:19 / src/ui/ReaderScreen.tsx:120 |
| `N/ui/screen/rss/LlmTokenUsageScreen.kt:63` | src/ui/LlmUsageScreen.tsx:11 |
| `N/ui/screen/rss/ReadAloudPlaybackScreen.kt:60` | src/ui/SpeechPlaybackScreen.tsx:14 |
| `N/ui/screen/rss/RssRecommendScreen.kt:45` | src/ui/RecommendationScreen.tsx:9 |
| `N/ui/screen/rss/RssSearchScreen.kt:36` | src/ui/RssSearchScreen.tsx:19 |
| `N/ui/screen/rss/SavedItemsScreen.kt:83` | src/ui/SavedItemsScreen.tsx:30 |
| `N/ui/screen/rss/SettingsScreen.kt:74` | src/ui/SettingsScreen.tsx:56 |
| `N/ui/screen/rss/SettingsScreenHost.kt:19` | src/ui/routes/settings.tsx:60 |
| `N/ui/screen/rss/TtsSettingsScreen.kt:49` | src/ui/SettingsScreen.tsx:98 |

### 5.3 设置项、后台任务、接收器、通知与快捷入口

| 盘点项 | 原生位置 | PodJS当前实现 / 判定 |
| --- | --- | --- |
| 阅读主题、字号、滚轮音量、防干扰、静音开播上限 | `N/ui/settings/MainSettingsCatalog.kt:9`、`:14`、`:19`、`:24`、`:29`；`N/data/settings/SettingsRepository.kt:68` | `P/src/ui/SettingsScreen.tsx:56`、`P/src/ui/media-volume-settings.tsx`、`P/src/settings/store.ts:18`，播放器/朗读有真实消费。字号设置与阅读预设字号的作用边界两端都需按实际阅读路径理解，不能只凭设置值变动判正文全生效 |
| 阅读预设主题选择、深色跟随浅色、固定时间、日出日落、定位/时间输入 | `N/ReaderPresetActivity.kt:101`、`:220`、`:299` | `P/src/ui/ReaderPresetScreen.tsx:46`、`:59`、`:84`、`:94`、`:104`；`P/src/reader/theme-schedule.ts:16`。主功能存在，旧菜单锚点D02已关闭 |
| 预设字体、图片/视频背景、同步资源、实时预览 | `N/data/reader/ReaderPresetRepository.kt:123`；`N/data/reader/WatchReaderPresetPreviewSession.kt:37` | `P/src/reader/preset-store.ts:18`、`P/src/sync/reader-actions.ts:4`、`P/src/reader/preview-session.ts:21`、`P/src/ui/ReaderPreviewScreen.tsx:26`；手表选择手机预设是原生产品边界，不要求复制手机预设编辑器 |
| 自动滚动的会话播放/暂停、自动开始、速度与返回正文 | `N/AutoScrollControlActivity.kt:41`、`:54`；`N/data/settings/SettingsRepository.kt:74` | `P/src/ui/AutoScrollSettingsScreen.tsx:24`、`P/src/ui/ReaderScreen.tsx:128`、`P/src/reader/autoscroll.ts`，0.5–10档位与会话控制存在 |
| 正式TTS语速、手机配置、debug引擎/模型/音色/端点/密钥/测试 | `N/TtsSettingsActivity.kt:25`；`N/ui/screen/rss/TtsSettingsScreen.kt:121`、`:206`、`:289` | `P/src/ui/SettingsScreen.tsx:96`–`:116`、`P/src/tts/config-store.ts:37`、`P/src/tts/config-http.ts:12`、`P/src/debug/tts.ts`。详细debug字段已补；不能把原生VM方法误认成原生手表一定已有同款文本编辑UI |
| 缓存容量、已用、媒体预取档位 | `N/data/settings/SettingsRepository.kt:62`；`N/data/cache/ManagedCacheService.kt:79`、`:130` | `P/src/ui/advanced-cache-settings.tsx:22`、`P/src/cache/managed.ts:7`、`:20`、`P/src/cache/policy.ts:18`。已有管理路径；E01的私有离线文件生产不能由这个用量/桶名存在推断 |
| 同步无声音频保活、系统分享可用条件及说明 | `N/WatchRssApplication.kt:108`；`N/data/settings/SettingsRepository.kt:85`、`:91` | `P/src/ui/advanced-cache-settings.tsx:24`、`P/src/ui/SettingsScreen.tsx:62`、`P/src/sharing/policy.ts:4`、`P/src/sync/application-host.ts:52`、`:55`。能力条件/独占lease/释放接线存在，未在本轮测功耗或锁屏传输 |
| AI可见条件、自动总结、四提示词、Token开关/统计 | `N/SettingsActivity.kt:78`；`N/ui/viewmodel/LlmSummaryViewModel.kt:126`；`N/ui/screen/rss/LlmTokenUsageScreen.kt:121` | `P/src/ui/SettingsScreen.tsx:46`、`P/src/ui/ReaderScreen.tsx:120`、`P/src/llm/runtime.ts`、`P/src/ui/LlmUsageScreen.tsx:13`。本机统计、订阅、清空、手机导出均有实现 |
| 每频道原文/媒体后台续播、导入频道清空/删除；平台退出/清cookie | `N/ChannelSettingsActivity.kt:38`；`N/BiliSettingsActivity.kt:82`；`N/DouyinSettingsActivity.kt:52` | `P/src/ui/ChannelScreens.tsx:41`、`P/src/ui/PlatformSettingsScreen.tsx:48`、`:50`、`:60`、`P/src/media/logout.ts`；不再沿用旧C13“缺手机下载按钮” |
| 历史遗留配置键 | `N/data/settings/SettingsRepository.kt:88`、`:118` | `P/src/settings/store.ts:8` 保留原生无实际消费的phoneConnectionEnabled，及迁入的LLM字段。仅仓储有键、没有原生当前UI/消费路径，不算缺少一个设置按钮；不凭原生VM有setter发明新产品功能 |
| 应用全局蓝牙/IP、屏幕/前台接收器、前台动作策略 | `N/WatchRssApplication.kt:106`；`N/phoneconnection/bluetooth/WatchBluetoothForegroundSyncManager.kt:38`、`:73`、`:127` | `P/src/main.tsx:24`、`P/src/sync/application-foreground.ts:47`、`:103`、`P/src/sync/application-host.ts:45`、`:55`。实际消费lifecycle及display状态，有radio/permission/资源释放路径；不能仅因存在BLE功能判断一直扫描，本轮没有设备CPU/扫描证据 |
| 云前台触发、账号/本地库变化、网络变化 | `N/WatchRssApplication.kt:122`、`:143`、`:149` | `P/src/cloud/application.ts:31`、`:35`、`:36`；`P/src/cloud/scheduler.ts:13`、`:17`。已有5分钟节流、变化通知、暂缓重试。当前工作区还hold本地传输，不能漏审dirty tree；前台/后台差异见E08 |
| 6小时WorkManager真实后台 | `N/data/cloud/WatchCloudSyncWorker.kt:15`、`:29`；原生DEBUG gate在`:20` | `F/platforms/android/runtime/src/main/java/dev/podjs/runtime/PodCloudWork.java:28`、`PodCloudWorker.java:32`；`P/src/cloud/background.ts:8`、`:22`。独立headless guest，未绑定即成功退出；不是前台JS定时器冒充后台。框架首次延迟6小时（PodCloudWork:29），原生该schedule未设置initial delay；与原生后台启动时机也有取舍。普通release云现为产品能力，不再按旧B/C/D把整套隐藏 |
| 后台“服务” | 原生 main manifest无自定义 `<service>`；`N/data/rss/RssFetchService.kt:11`、`RssParseService.kt:9`、`RssReadableService.kt:11`、`N/data/cache/ManagedCacheService.kt:49`、`N/data/cloud/WatchCloudSyncService.kt:44` 均是业务类 | HTTP/XML/原文、缓存、云服务均有对应业务实现；framework另有媒体/WorkManager等Android支撑。不能因为PodJS不叫这五个类名就说少了五个Android Service |
| 推送与系统通知 | `N/HomeFeedListActivity.kt:355`、`N/data/push/PushNotificationRepository.kt:17`：首页获取消息并弹窗 | `P/src/announcement/home.ts`、`P/src/ui/HomeNoticeDialog.tsx:6`、`P/src/ui/screen.tsx` 的首页notice调用存在。当前原生应用源码/manifest没有另一套系统推送NotificationManager、通知点击PendingIntent或独立RSS通知Service，因此不虚构“缺常驻通知/推送服务”任务 |
| 分享FileProvider / 本地媒体 | `Android_WatchRSS/app/src/main/AndroidManifest.xml:48`；`N/RssPlayerActivity.kt:135`、`N/ui/screen/rss/DetailBehaviorSupport.kt:276` | `P/src/browser/open.ts:32`、`P/src/reader/offline-media.ts:11` 与同UID媒体宿主处理文件；framework自有FileProvider。authority不是用户功能迁移的同名要求，新增离线生产仍E01 |
| DebugLogProvider、外部调试alias/receiver | `N/debug/DebugLogProvider.kt:33`；`ND/AndroidManifest.xml:8`、`:18` | `P/pod.config.json:20`、`P/src/debug/external.ts:22`、`:38`、`:43`；CLI生成debug-only外部桥。release不开放是目标门控，不算缺功能。诊断细字段仍DBG-E01 |
| 桌面/深链/快捷方式 | 原生main manifest的MAIN/LAUNCHER在`:68`；debug alias另列。未见静态shortcuts元数据或ShortcutManager发布链 | PodJS主Activity桌面启动/恢复有实现，抖音debug/摘要入口另有桥；没有原生正式RSS tile、widget、分享接收ACTION_SEND/VIEW过滤入口可要求等量复制。`ACTION_SEND`/`ACTION_VIEW`的发送调用不等于应用注册接收深链 |
| 迁移与旧作业接管 | `N/data/db/WatchRssDatabase.kt:35`、`:53`；`V2/data/db/WatchRssDatabase.kt:35` | `F/…/PodRoomV18Converter.java:181`、`PodStoreConverter.java:25`、`PodTakeoverConverters.java:34`；`P/pod.config.json:51` 旧worker名称/类的接管声明。库/文章正文与原文、保存/阅读/源/游标、笔记、预设资源、账号/平台cookie/TTS等有转换；E05/E06/E07列出尚不等价边界，未泛称全量数据等值 |

### 5.4 原生main与保留v2分支的云/配对差异如何处理

两条原生分支的manifest组件集合相同；`git diff main fix/cloud-v2 -- app/src/main app/src/debug` 的业务差异集中在账号、云批准/密钥/records、配对、RSS阅读状态与Room19，没有增加另一套未盘点的正式页面。

| 核对面 | 当前PodJS判定 |
| --- | --- |
| bootstrap/watch自登记、epoch/commitment/attestation、多版本key | `P/src/cloud/runtime.ts:11`、`P/src/cloud/service.ts:74`–`:88`、`P/src/cloud/keys.ts:13`。已是v2链路，不沿用main旧云格式作为补齐方向 |
| 用户批准：请求/核对数字/拒绝/取消/超时/过期、归属冲突/清空或合并、重登记、退出 | `V2/CloudSyncActivity.kt:67`、`:125`、`:145` 对照 `P/src/cloud/approval-controller.ts`、`P/src/ui/CloudSyncScreen.tsx:158`–`:188`、`P/src/cloud/application.ts:44`。用户可达功能已有；两次确认/内联布局和原生Dialog形状不完全一样，属于交互呈现差异，未再虚增成“缺少批准/清空/退出”。`P/src/ui/routes/home.tsx:153` 实际传入完整clearLocal |
| 账号保存、令牌旋转、明确退出与身份失效 | `V2/data/account/WatchAccountStore.kt`、`V2/data/cloud/WatchCloudLogout.kt` 对照 `P/src/account/store.ts:20`–`:37`。当前区分refresh拒绝expire与显式clear/logout；不是旧401一律清密钥的空壳；原生已用身份首次迁入另见E05 |
| 扫码configure/R28自登记/key/finish、SAS两端先后 | `P/src/onboarding/watch-setup.ts:29`–`:50` prepare立即回、configure等本地确认、保存后自登记再回bound，key回当前已验证版本。`P/src/ui/PhoneConnectionScreen.tsx:24` 接openPairing、取消/完成有独立处理。保留原生分支早于后来的R43裁决，**不建议把PodJS退回旧prepare先等手表确认的时序** |
| records v1、公共RSS/私有归档与新同步域 | `P/src/cloud/records.ts:45`、`P/src/cloud/library.ts:155`、`P/src/cloud/client.ts:83`、`P/src/sync/application-host.ts:42`。PodJS包含后续S8/R45/R46能力；原生冻结树的旧RSS索引/快照格式不是必须恢复的用户功能。仍需关注E01/E02这类当前可见后果 |

## 6. 证据边界与保护

本轮没有取得设备、APK运行、网络服务或像素对拍新证据；历史报告中的PASS仅属于历史版本，不当成当前树验收。未执行会生成缓存/构建产物的bun/Gradle测试，现有测试文件只能辅助确认接口意图。无根因代码证据的旧真机卡顿/裁切没有作为本轮确定功能缺口重复登记。

**工作区并行变化补审：** HEAD未改变，但审计期间应用新增HTML实体封装修复/存量正文修复、阅读自动滚动亮屏lease、播放器循环控制/自然结束计数，框架新增相应HTML工具、video.setLoop/video.session.setLoop及状态字段。已补读这些diff及实际调用；它们没有新增普通RSS离线媒体记录生产、公共池未登录路径、原生store/Room19转换、抖音逐条预取失败事件或实际poster持久恢复，故未关闭本文对应缺口。播放器循环/亮屏是正在接入的新能力，原生所读主路径没有同款可切换循环菜单，不作为“尚缺原生功能”额外派工。受影响引用已按末轮读取的工作区刷新；该工作区非冻结发布包，后续并行编辑仍可能继续移动行号。

只写 `P/docs/parity-gap-audit-e.md`；没有checkout/switch/reset、修改产品或测试代码、改签名/manifest、ADB/设备访问、安装、登录/退出或commit。当前dirty同步/框架改动作为审计输入保留，不回退、不顺手修补。报告的源码缺口也不代表已获准实施后续迁移、清库或账号操作。

## 7. 按影响排序的 Top 缺口清单

| 顺位 | ID | 影响与优先处理理由 | 建议验收（后续任务，不是本轮已执行） |
| --- | --- | --- | --- |
| 1 | **E01** | **高**：新收藏/稍后看没有普通RSS离线媒体生产闭环，影响离线可靠性 | 未打开正文先保存→断网看图/视频；下载失败重试；取消最后一种保存清理；普通merge/权威replace分开 |
| 2 | **E02** | **高**：未绑定时公共RSS添加/刷新被阻断，影响基本阅读获取 | 未绑定添加、已有频道刷新、凭据过期、恢复账号；确认公共池未登录产品契约与正确文案 |
| 3 | **E05** | **高，条件性**：已用原生云store首次迁入可能卡住激活 | 原生18 + API30软件ECDH、平台账号/云keys联合夹具；不碰真实账号制造实验 |
| 4 | **E06** | **中，条件性**：保留v2分支Room19无法走v18接管 | 确认是否纳入发布支持范围；若纳入，19→新代际的完整数据/身份/资源夹具 |
| 5 | **E03** | **中**：抖音真实首帧/退出快照恢复能力不等价 | 在线产生实际帧→退出→断网重进；区分封面、poster、prefix，勿要求完整离线播未缓存片段 |
| 6 | **E04** | **中**：预取403/重复坏地址不能提前刷新或隔离 | 当前源/过期源403，前台/邻项分别处理；观察切片前是否完成换源/隔离 |
| 7 | **E08** | **中**：手动云同步不能默认依赖原生后台持续语义 | 离页仍前台、回桌面、锁屏、本地传输hold，分别观察持久进度/恢复和OS预算 |
| 8 | **DBG-E01** | **中，debug**：诊断落后于当前生产者，影响问题定位 | provider真实prefix下载统计、逐条隔离元数据、页面/slot状态；不伪造RAM |
| 9 | **E09** | **低**：旧/自定义非分块peer兼容边界 | 满足最低版本但supportsChunkedBodies=false的明确兼容/升级回包 |
| 10 | **E07** | **低**：首次迁入非首页稳定内容只能回首页 | 稳定文章/频道/平台Intent白名单映射或明确产品接受回首页 |
| 11 | **E10** | **低**：网页长时间打开不消费阅读主题变化 | 固定时间/日出日落跨界，确认网页不中断情况下明暗更新 |
| 12 | **DBG-E02** | **低，debug**：性能测试密度基准不等价 | 同设备、同fontScale、明确3f/正常两种场景，分别记录native帧指标 |
