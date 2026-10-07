# A2 — 原生 40 与上游增量功能差异审计

审计日期：2026-10-07。结果：**DONE（源码审计完成；设备验收 PENDING）**。

清库、三种库模式、权威合并/清理及 TXT 小说导入识别在当前 PodJS 已有实际实现和生产接线，不应重复开发。仍有前台动作权限范围、诊断读失败及上游抖音二维码等待提示等行为差异。本文“已实现”仅代表源码路径存在；本次没有运行测试、构建、ADB 或手机操作，没有确认当前安装包行为。

## 1. 范围与版本

| 仓库 | 审计快照 | 范围 |
| --- | --- | --- |
| 原生 `/home/wilf/data/OPPO_Develop/Android_WatchRSS` | `734121c3c11304f4ef014b75aa3c5a21f4caf55f` → `6bb99ed4f5d197d44fbdc5be31e51143d19f62eb` | native40 / 1.3.2-13，16 文件，229 插入/59 删除 |
| 同仓库现有 `origin/main` ref | `e0936f167a04dafbaab25d3a64e02d59bb354f92` | 上游 3 提交；未 fetch，不代表联网确认远端状态 |
| 应用 `master` | `eec0a381c4c40a703066dd91d25c1a75ddb61c58` | 当前应用实现 |
| 框架 `watchrss-migration` | `e9f568487becf16a7bf43396ada7daa4e9883659` | 通用日志、Android browser auth 宿主 |

证据约定：`N:` 是原生 `app/src/main/java/com/lightningstudio/watchrss/` 下文件，行号来自 **6bb99ed4 的 git show**；`U:` 同目录但来自 **e0936f16**。`A:` 是应用根目录；`F:` 是 `/home/wilf/data/PodJS/podjs-watch`。行号均在本次源码读取时核对。

**分支拓扑：** `6bb99ed4` 的父提交是 `734121c3`；`97fb3cef` 的第一父提交也是 `734121c3`，第二父提交是 `c0fd7042`，其后才是 `e0936f16`。因此上游不包含 native40。`git diff 6bb99ed4 origin/main` 显示同步/DAO/TXT 识别被删除及版本回退，是两条分支净树差异，**不是要求 PodJS 删除已迁能力**。

## 2. 缺口与行为差异（按影响排序）

### G1 / P1：前台蓝牙/IP 动作 allowlist 未按原生区分

- 原生：`N:phoneconnection/bluetooth/WatchBluetoothForegroundSyncManager.kt:175-184` 和 `N:phoneconnection/ip/WatchIpSyncManager.kt:236-245` 只允许 `syncLibrary / clearLibrary / syncNotes / syncNoteAsset / syncReader / previewReader / syncAccount / syncLlmTokenUsage`。服务在 `N:phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:1231-1234` 拒绝集合外动作。
- PodJS：`A:src/sync/application-host.ts:34,45,48-53` 将完整 handler 接给前台 RFCOMM、IP 和主动 debug listener；`A:src/sync/application-actions.ts:14-24` 还处理 `ping / remoteInput / pullSavedItems / pullDebugLog`。`A:src/sync/session.ts:83-121`、`src/sync/rfcomm.ts:29`、`src/sync/ip-controller.ts:94` 没有动作过滤。`src/sync/diagnostic-log.ts:8,21` 的集合仅限制日志标签。
- 影响：新增 clearLibrary 两通道都可达，功能不缺；但集合外请求也到达 handler，与原生自动前台/连接页面边界不同。原生前台集合没有 pullDebugLog，不能从服务存在 case 推断所有原生通道都开放诊断。
- 实现建议：先核对自动前台、用户主动连接页与 debug 的所有权，给 session 加可选请求过滤入口，`application-host.ts` 分别传策略。不能给所有 listener 硬套前台集合，否则会破坏现有远程输入、保存链接与诊断入口。WatchRSS 动作名/集合留应用；若其他应用需要，可把通用请求过滤钩子放框架，框架不得内置业务动作。
- UI：连接入口和拒绝提示交 **lead**。后续测试覆盖前台拒绝及主动页面允许，再由 owner 在隔离身份读回蓝牙/IP 回包。

### G2 / P1：上游抖音等待二维码的持续加载提示未迁

- 上游：`U:ui/screen/douyin/DouyinLoginScreen.kt:542-565` 从 `if (isLoading)` 改为 `qrCodeBase64 == null && !needTwoStepVerification`，等待 QR 时持续显示加载环及“正在加载抖音登录二维码，需要 30~60 秒，请您耐心等待”。网页结束但 QR 未出现时仍显示；二步验证时隐藏。此项是平台说明/统计之外的功能改动。
- PodJS：`A:src/ui/douyin/login-state.ts:49-55` 仅按 loading 显示登录页加载文字，网页结束后改为验证/完成说明；`A:src/ui/douyin/index.tsx:192-198` 没有上述等待覆盖层。实际授权期间是宿主 Dialog：`F:platforms/android/runtime/src/main/java/dev/podjs/runtime/PodBrowserAuthServices.java:189-205,347-350` 只在有 QR 时显示 mask，无 QR 时显示网页和“登录后点完成”，没有等待环。因此只改被宿主覆盖的应用页面文字不足以完成可见行为。
- 实现建议：应用定义 provider 特有文案与 `!qr && !verifying` 判定；框架 browser auth 提供通用可配置等待覆盖层/状态提示，验证时隐藏、错误/取消时终止，不硬编码抖音或时间文案。保留旧宿主 fallback 和完成/取消能力。
- UI：应用及宿主布局都由 **lead** 写；agent 可做逻辑/参数接线。验收覆盖 loading=false 但无 QR、QR 出现/清除、二步验证、错误/取消及圆屏可见效果。

### G3 / P2：pullDebugLog 文件读失败不符合原生 best-effort 回包

- 原生：`N:util/AppLogger.kt:221-232` 读异常返回 null；`N:phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:1377-1390` `.orEmpty()` 后仍回复成功空日志，`truncated=false,totalChars=0`。
- PodJS：`A:src/logs/app-logger.ts:17` 直接 await readLogs；`F:packages/framework/src/logging.ts:66` 不捕获 read 错误，`A:src/logs/logger-host.ts:15-19` 的 stat/read/短读可拒绝。异常经 `A:src/sync/application-actions.ts:22,26` 变成 `{success:false,message:...}`。这是源码可推导的失败路径差异，本轮未注入故障运行。
- 实现建议：在应用 `AppLogger.pull()` 或 readDebugLog 接线处按原生 catch 并将 null 交 debugLogReply，记录固定读失败事件。无需改变框架默认文件读取错误契约；若需要通用能力，应新增显式 best-effort 方法/选项。无需 UI 改动。
- 后续测试：生产形状 AppLogger + 失败 LogFile.read + 实际 handler，验证空成功回包、UTF-16 字段与持久会话不中断。现有 `A:tests/sync/account-debug-session.test.ts:59-67` 覆盖格式/null，不覆盖实际 read 拒绝。

### G4 / P2（边界，已有 helper 差异）：ImportedContent URL trim 与 Kotlin 不完全相同

- 原生：`N:data/rss/ImportedContentIds.kt:11,30,37` 用 Kotlin trim/lowercase。PodJS `A:src/core/imported-content.ts:3,14` 用 JS trim，而已有 Kotlin 白字符对应实现 `A:src/sync/local-manifest.ts:14` 包括 U+001C..U+001F、不包括 U+FEFF。
- 源码推导：首尾 U+001C 包围的 TXT 小说 URL 按 native trim 会识别，JS trim 不会；首尾 BOM 反过来。未跑 Kotlin 差分，规范手机生成 URL 无此问题，不是 native40 整体分类缺失。
- 影响：imported/deletable helper 同时影响 full-body 导出、公共云源过滤、删除资格及正文阅读按钮。
- 实现建议：应用抽取公共 Kotlin 兼容分类 helper、复用一致 trim，并补真实 Kotlin oracle fixture。如框架有适合的通用 Unicode trim 能力则复用；WatchRSS URL 前缀留应用。UI 只由 **lead** 审查分类驱动的按钮变化。

### G5 / P3：上游 QR 首次加载耗时诊断日志未对应记录

- 上游：`U:ui/screen/douyin/DouyinLoginScreen.kt:281-288` 首次 login QR 既上报统计，也写“二维码加载耗时”日志。
- PodJS 统计已迁：`A:src/telemetry/qr-load.ts:8-12`、`src/ui/douyin/index.tsx:127,156-157`、`src/telemetry/usage.ts:32-34`。但 `A:src/logs/douyin-login.ts:15-26` 只记录 QR 检出和最终登录耗时；首次 QR 时长回调未写 logger。因此排除统计后，仍有此诊断事件遗漏。
- 实现建议：复用 DouyinQrLoadTelemetry 的真实 duration 回调写 AppLogger，保留页面生命周期 once flag，不重新计时/伪造值。业务事件放应用，框架已有 FileLogger。无需 UI；补 once、二步验证不报告及 production-default clock 测试。

## 3. native40 逐项实现矩阵

| 增量/语义 | 原生证据（N） | PodJS 证据（A）与结论 |
| --- | --- | --- |
| clearLibrary 与三个库模式常量 | `phoneconnection/bluetooth/BluetoothSyncProtocol.kt:29-33` | `src/sync/protocol.ts:13-16` 已定义；实际接线如下 |
| clearLibrary 在清理完成后回复 | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:1393-1398` | `src/sync/application-actions.ts:17` await；`src/sync/application-host.ts:34` 接共享仓储并 notifyLibraryChanged；已实现 |
| cursor 宣告权威覆盖能力 | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:486` | `src/sync/library-wire.ts:63` supportsAuthoritativeLibraryReplace=true；已实现。原生是在 cursor，不是 probe |
| merge 默认模式、先合来源、普通冲突合文章 | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:508-511,527-535,633-639` | `src/sync/session.ts:148-155,164`、`src/sync/source-store.ts:28-49`、`src/sync/library-repository.ts:73,76`；已实现 |
| forceFull/replace 强制全量、fromExclusive=0、fallbackReason | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:552-563` | `src/sync/session.ts:157-158`；已实现 |
| phoneToWatchReplace：权威文章，延后来源合并，保留 manifest/来源 URL，额外留 phone-imports | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:639,675-686` | `src/sync/session.ts:164-166` → `src/sync/library-repository.ts:76,116-134`；已实现 |
| watchToPhoneReplace：不请求远端正文、不合远端数据、本地全量输出、reset peer | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:581,633-637,663-665,792-794` | `src/sync/session.ts:154,158,160,164,173`、`src/sync/article-batches.ts` ignoreIncoming、`src/sync/sequence-store.ts:27`；已实现 |
| ACK 方向性序号：target 本地=0/source 远端=0，只在 applied 后记成功 | `phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:795-804` | `src/sync/session.ts:124-126,177`、`src/sync/sequence-store.ts:21-27`；已实现 |
| 来源 authoritative 绕过时钟/设备胜负 | `data/rss/DefaultRssRepository.kt:1081-1084` | `src/sync/source-store.ts:44-48` SQL ?=1 OR；已实现。来源 tombstone 直接应用亦保留于 35-41 |
| Saved/Chunked 传递 authoritative | `data/rss/RssRepository.kt:67-85`、`data/rss/DefaultRssRepository.kt:1119-1180,1241-1246` | `src/sync/library-repository.ts:76`、`src/sync/article-receiver.ts:118`、`src/sync/deletion-store.ts:12,34`；已实现 |
| 已读 true 可覆盖 false；阅读 progress/byte/hash/changedAt 可权威回退 | `data/rss/DefaultRssRepository.kt:2161-2168,2206-2227` | `src/sync/article-receiver.ts:80-98` authoritative is_read/wins/changed_at 分支；已实现，普通合并仍 OR/max |
| favorite/watchLater 权威撤销与零时钟、缺文章 tombstone | `data/rss/DefaultRssRepository.kt:2349-2355,2414-2420` | `src/sync/saved-state.ts:83-102`、`src/sync/article-receiver.ts:118`；已实现 |
| article deleted 权威绕过 deletedAt>0/冲突 | `data/rss/DefaultRssRepository.kt:2439-2450` | `src/sync/deletion-store.ts:21-35`；已实现 |
| 权威保存不自动下载离线媒体 | `data/rss/DefaultRssRepository.kt:2372-2376` | `src/sync/article-receiver.ts:118-121`、`src/sync/saved-state.ts:83-102` 没有下载副作用；符合此增量，不能据此证明普通 merge 自动下载 parity |
| 全库 identity 扫描、删除未保留 dedupKey 文章及来源 | `data/db/RssItemDao.kt:11-12,375-379`、`data/rss/DefaultRssRepository.kt:1253-1264` | `src/sync/library-repository.ts:117-127` 分页 identity+保留集 SQL；已实现，不需同名 DAO |
| saved/source 状态 prune，change log/peer 全删 | `data/db/SavedSyncStateDao.kt:21-26`、`data/db/RssSourceSyncStateDao.kt:21-26`、`data/db/SyncChangeLogDao.kt:40-41`、`data/db/SyncPeerStateDao.kt:16-17`、`data/rss/DefaultRssRepository.kt:1265-1277` | `src/sync/library-repository.ts:128-133`；已实现，另清应用专属 deletion/id/fingerprint 状态 |
| clear 全库及 saved/source/log/peer；reset 只清 peer | `data/rss/DefaultRssRepository.kt:1280-1291` | `src/sync/library-repository.ts:101,105-115`；已实现。identity/独立 memo 不在删除集合；`src/core/schema.ts:38-48` FK 级联文章与附属状态 |
| 离线文件清理 | `data/rss/DefaultRssRepository.kt:1259,1264,1282` | `src/sync/library-repository.ts:114,132` 提交后清理；`src/services.ts:383-403` 取消 refresh/original-cache，删 offline/rss 文件并清 provider bucket；已接线，文件结果未验收 |
| 蓝牙/IP 前台允许 clearLibrary | `phoneconnection/bluetooth/WatchBluetoothForegroundSyncManager.kt:177`、`phoneconnection/ip/WatchIpSyncManager.kt:238` | `src/sync/application-host.ts:34,45,48-50` 共用 handler；可达，但权限集合差异见 G1 |
| pullDebugLog 回包、1..700000 maxChars、UTF-16 tail | `phoneconnection/bluetooth/BluetoothSyncProtocol.kt:38`、`phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:1377-1390` | `src/sync/application-actions.ts:22` → `src/sync/application-host.ts:34` → `src/logs/app-logger.ts:17` → `src/sync/diagnostic-log.ts:29-36`；正常路径已实现，读失败见 G3 |
| TXT_NOVEL root imported/deletable 分类 | `data/rss/ImportedContentIds.kt:6,10-15,36-41` | `src/core/imported-content.ts:2-11`；已实现，包括 lower/prefix；Unicode trim 边界见 G4 |
| TXT novel full-body、公共云源过滤、本地删除、阅读动作分类 | `data/rss/DefaultRssRepository.kt:2075,2942,2953-2954`、`data/cloud/WatchCloudLibraryAdapter.kt:17,30-31`、`ui/screen/rss/DetailScreen.kt:386,500` | `src/sync/article-export.ts:21`、`src/sync/local-manifest.ts:135`、`src/cloud/library.ts:17,21`、`src/core/imported-article-deletion.ts:24`、`src/ui/ArticleSource.tsx:7`、`src/ui/ReaderScreen.tsx:78,119`；标准 URL 已实现 |
| isNovelContentItemUrl 新增 TXT novel | `data/rss/ImportedContentIds.kt:29-33`、`ui/screen/rss/DetailScreen.kt:385` | 无独立同名 helper，但原生 isNovelContent 局部值只有声明、无消费（git grep 核对）；仅 helper 形状不同，不能证明缺用户功能，不增加新 UI |
| versionCode40/1.3.2-13、Fake/Test 仓储参数及分类测试 | `git diff 734121c3 6bb99ed4 -- app/build.gradle.kts app/src/androidTest app/src/test` | 原生发布元数据/测试支架变化，不是要求 PodJS 复制版本号或 fake 的功能 |

兼容边界：`A:src/sync/session.ts:149` 显式拒绝未知 mode，原生无同样检查；`:151` 要求 chunked，而原生 `N:phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:580-581,666-673` 仍有非 chunked fallback。不是 native40 主流路径缺失；若目标包括自定义/降级 peer，应另列兼容任务，不可声称支持原生所有 fallback。

## 4. origin/main 的 3 提交

| 提交 | 变化 | 排除平台说明/统计后的结论 |
| --- | --- | --- |
| `c0fd7042` feat: add platform notices and usage telemetry | 22 文件；说明/确认/OOBE/home disclosure、标题/云会员范围；视频电池生命周期及 QR 时长统计；QR 等待 UI | 等待 UI 是 G2；QR 时长诊断日志是 G5。无同步库模式/DAO/TXT 增量 |
| `97fb3cef` merge（第一父 `734121c3`） | 导入同一组 22 文件 | 不重复算功能；相对第二父的 reader-video/background diff 来自已在审计基线内的本地 reader 变化，不是新上游能力 |
| `e0936f16` 编译修复 | 10 文件；weight imports、Modifier import、Activity this@、${platform} 插值 | Kotlin/Compose 编译及说明文字插值修复，无额外业务功能。`U:BiliPlayerActivity.kt:90-93` 网页打开改为正确 receiver；应用现有 `src/browser/open.ts` 接宿主，不需迁 Kotlin receiver |

已检查 `734121c3..origin/main` 的 Activity、screen、BaseWatchActivity、OOBE/HomeFeedList、telemetry 和 notice 变更。说明/统计不重新开任务；已有源码接线例如 `A:src/ui/entry-disclosure.ts:11-20`、`src/announcement/platform.ts`、`src/ui/douyin/index.tsx:192`；QR 统计见 G5，电池统计入口见 `A:src/telemetry/host.ts:51-52`、`src/telemetry/usage.ts:36-39`。这些不是本轮对 M1 或统计的完整 UI/设备再验收。

## 5. 验证与交接

本次仅执行只读 git show/diff/log/grep、rg/nl/sed 源码读取及文档写入。未 checkout/fetch/merge/commit，未改产品代码，未运行 bun/Gradle 测试或构建，未生成 APK/用户数据快照，未运行 ADB（含 devices）。A2 明确只读、不操作设备的边界优先于 LEAD_BRIEF 通用应用实现任务的构建要求；交付是审计文档。

**已有测试仅作为源码证据，本轮未运行：** `tests/sync/session.test.ts:7-30`（native frame/source mode）、`tests/sync/library-adapter.test.ts:67-95`（权威 prune/clear/失败回滚）、`tests/sync/library-repository.test.ts:19-35`（native source/article fixture）、`tests/sync/saved-state.test.ts:18-26,78`（权威零时钟）、`tests/sync/account-debug-session.test.ts:59-67`（格式/UTF-16）、`tests/sync/local-manifest.test.ts:60,104`、`tests/core/core.test.ts:178`（TXT 分类）。不能称当前测试已通过。

旧 `docs/debug-log-sync.md` 中“只导出同步时间线”的历史限定不代表当前实现：`src/sync/application-host.ts:34` 接 hostAppLogger.pull；`src/logs/logger-host.ts:29-44` 创建文件 logger，`src/main.tsx:50` 启动，通用 FileLogger 在框架。未改旧文档，建议 lead 更新历史限定/验收范围。文件日志存在也不证明所有原生子系统事件完整，G5 是本次发现的具体遗漏。

**设备证据：PENDING。** 下列步骤由 lead 指派 DEVICE_OWNER agent 执行，本审计 agent 不等待或抢占设备：

1. 只用 OWW242 e3aca8af，在隔离包、私有身份/UUID 和独立 peer 数据库中操作。不得向正式资料库发 clear/replace，不操作用户手机 RFCX70EGH6K 或账号按钮。
2. 三模式 seed 同 ID 不同正文、较新的本地已读/位置/saved 时钟及仅本地文章/来源：merge 保留正常胜者；target 权威回退并 prune；source 忽略非空输入且无 bodyRequests。检查 applied ACK 前后及 missing/rejected ACK 的游标。
3. 隔离 clear seed 来源/文章/状态/离线文件，并 seed 独立 memo/identity：核对清理与保留、故障不成功回包；检查实际文件，不只计文章数。
4. 分别测试蓝牙/IP 前台拒绝、主动页允许边界；pullDebugLog 空、UTF-16 tail、上限和 read 故障。单通道不代表另一通道证据。
5. TXT novel 使用真实生成 chapter URL 验证 full-body/分类/删除资格；G2 接线后检查等待 QR、二步验证、取消。新包先与 s4-k8-home-after-cold.png 比尺寸；正式升级必须 acceptance.py upgrade 且摘要 equal=true，不新增完整 userdata tar。

建议下一任务：先修 G1 通道策略和 G3 best-effort；G2 UI/通用宿主参数交 lead，G4/G5 可做小范围逻辑修复。本任务到此停止，不自行开展实现或设备工作。
