# 原生 → PodJS 功能差距审计 B

审计者：`wrss-minor`；日期：2026-10-04。范围仅任务 1B；只读当前源码，不以旧迁移文档结论为证据。`docs/acceptance.md` 只作为 Transport 项目清单。

路径约定：`W/` = `../Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/`；`P/` = `../Android_WatchRSS_Phone/app/src/main/java/com/lightningstudio/watchrss/phone/`；`src/` 为当前 PodJS 仓库。所有行号对应本次工作树。

状态含义：**已实现** = 当前源码有可达实现及相应数据路径，不代表真机/视觉验收通过；**部分实现** = 已有子集或行为有差异；**缺失** = 当前 `src/` 未找到相应路径。影响为缺口或该能力失效时的用户影响。工作量 S ≤ 1 人日、M = 2–5 人日、L > 5 人日，为补齐差异和针对性验证的粗估；已实现项的 S 表示确认/回归工作量。历史/隐藏原生入口单独说明，不能自动列为正式产品阻塞。

验证边界：`adb devices` 无设备，真机验证 **PENDING**；未运行 bun test、构建或安装；772 pass 是 lead 提供的基线，本次未复跑。

## 1. 手机连接、声波、二维码与 Server

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| 手机连接主页说明、下载手机端弹窗 | 已实现 | W/PhoneConnectionActivity.kt:11；W/ui/screen/phoneconnection/PhoneConnectionScreen.kt:26、56、66；PodJS `src/ui/PhoneConnectionScreen.tsx:9`、`DownloadPhoneAppDialog.tsx`。当前原生主页并非连接方式选择器。 | 高 | S |
| 前台 RFCOMM 监听、亮屏/生命周期及传输保活 | 已实现 | W/phoneconnection/bluetooth/WatchBluetoothForegroundSyncManager.kt；W/BluetoothConnectionActivity.kt:86、113；PodJS `src/main.tsx:8` → `sync/application-host.ts:20` → `application-foreground.ts`，检查 radio 权限/启用和屏幕状态、监听资源释放。权限异常真机体验待验。 | 高 | S |
| 独立 BluetoothConnection 页面：权限请求、等待/结果、重试、返回 URL | **已实现（源码级，设备待验）**（`bee3e71`、`e0090ec`） | W/BluetoothConnectionActivity.kt:52、102、131、167、212；PodJS `src/ui/BluetoothConnectionScreen.tsx`、`src/ui/bluetooth-connection.ts`、`src/ui/routes/phone.tsx` 以只读 facade 复用现有前台同步和 remote-input inbox，接等待/结果/重试/URL handoff；原生正式主页同样无直接 launcher，本次未额外发明入口。 | 中 | M |
| 纯声波：接收 RSS、发送收藏/稍后再看、时长预估和录音权限 | 缺失 | W/AcousticConnectionActivity.kt:98、235、304、324、482、511；PodJS `src/` 无 acoustic 编解码/录音发送页。原生 onCreate 明确仅 debug 可用，属调试能力缺口。 | 低 | L |
| 声波引导 Wi-Fi：热点连接、拉 RSS、推收藏/稍后再看 | 缺失 | W/AcousticConnectionActivity.kt:364、420、438、456、518；W/phoneconnection/guided/WatchGuidedWifiClient.kt；PodJS `src/sync/ip-*` 是另一个 IP 同步协议，不能代替声波引导协议。原生仅 debug；TTS/B站记录/LLM 在原生此路径也是未支持分支。 | 低 | L |
| 不可用原因独立页面 | **已实现（源码级，设备待验）**（`bee3e71`、`e0090ec`） | W/PhoneConnectionUnavailableActivity.kt:16、23、35；PodJS `src/ui/PhoneConnectionUnavailableScreen.tsx`、`src/ui/routes/phone.tsx` 已接独立原因页。 | 低 | S |
| 链接分享二维码、标题/提示、空链接拦截、失败回调、点击返回 | 已实现 | W/ShareQrActivity.kt:19、27、37；W/ui/screen/ShareQrScreen.kt:26；PodJS `src/ui/ShareQrScreen.tsx:24`、`sharing/policy.ts:12、28`、`ui/QRCode.tsx`，调用侧 share policy 验证链接。 | 中 | S |
| 分享二维码可配置宽度比例 | **已实现（源码级，设备待验）**（`18cc10c`） | W/ShareQrActivity.kt:22、61；W/ui/screen/ShareQrScreen.kt:35 允许 0.1–1；PodJS `src/ui/ShareQrScreen.tsx`、`src/ui/share-qr-layout.ts` 接 `qrWidthRatio`（0.1–1，默认 0.88；文章分享 0.7）。 | 低 | S |
| Server：HTTP 输入 RSS、能力查询、二维码、接收后回填/跳转、退出停服务 | 已实现 | W/ServerActivity.kt:64、109、143；W/phoneconnection/LocalHttpServer.kt:916；PodJS `src/ui/RemoteInputScreen.tsx`、`remote-input/server.ts`、`remote-input/http.ts`。 | 高 | S |
| Server：收藏、稍后再看、B站观看记录 HTTP 导出 | **已实现（源码级，设备待验）**（`9e13e05`、`e0090ec`） | W/ServerActivity.kt:74–87；W/phoneconnection/LocalHttpServer.kt:937、957、980；PodJS `src/remote-input/http.ts`、`src/ui/RemoteInputScreen.tsx` 已接原生兼容的导出 route/ability/cursor/payload 和错误映射，数据来自统一 SQL 保存库与 Bili 客户端；收藏、稍后再看和 Bili 设置页已挂载对应模式。 | 中 | M |
| Server：配对 token 的 TTS 配置、能力查询及完成反馈 | 已实现 | W/ServerActivity.kt:89；W/phoneconnection/LocalHttpServer.kt:1002；PodJS `src/ui/TtsConfigScreen.tsx`、`tts/config-http.ts`、`tts/config-pairing.ts`，带认证/加解密/一次写入。 | 中 | S |

## 2. 蓝牙诊断与库同步协议（Transport acceptance 逐项）

以下 `B/` 缩写为 `W/phoneconnection/bluetooth/`，`PB/` 为 `P/connection/bluetooth/`。

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| RFCOMM service name / UUID | 已实现 | B/BluetoothSyncProtocol.kt:22；PB/BluetoothSyncProtocol.kt:12；`src/sync/protocol.ts:6–7`、`rfcomm.ts:24` 同一 service 和 UUID，应用已接线。 | 高 | S |
| 4 字节大端长度、UTF-8 JSON、1..2 MiB、拆包/截断 | 已实现 | B/BluetoothSyncProtocol.kt:52、56、79；PB/BluetoothSyncProtocol.kt:41；`src/sync/protocol.ts:66`、`stream.ts:18` 校验范围、截止时间、EOF。 | 高 | S |
| 16 KiB 传输分块、包含 prefix 的字节进度 | **已实现（源码级，设备待验）**（`0954193`） | B/BluetoothSyncProtocol.kt:56、79、171；PB/BluetoothSyncProtocol.kt:56、76、132；PodJS `src/sync/stream.ts` 使用 16 KiB 分块，并以包含 4 字节 prefix 的 byte delta 发布进度。 | 中 | M |
| v14、最低手机 v13、legacy v4 定义 | 已实现 | B/LibrarySyncPayload.kt:64–66、131；`src/sync/protocol.ts:15–17`、`session.ts:76、91`。v13/v14 可进入接收器，低于 13 返回升级错误；v4 只是历史常量，当前原生也拒绝旧手机，不能当作额外支持要求。 | 高 | S |
| cursor / manifest / probe / articles / complete | 已实现 | B/WatchBluetoothSyncServer.kt:458、489、851、904、1402；PB/PhoneBluetoothSyncManager.kt:493–680；`src/sync/session.ts:77–133`、`article-batches.ts`，清单/正文分批及请求正文集合均有处理。 | 高 | S |
| v8 change sequence、metadata-only、hash/chunk、删除和保存状态 | 已实现 | B/LibrarySyncPayload.kt:333、338、1726；W/data/rss/DefaultRssRepository.kt；`src/sync/sequence-store.ts`、`manifest.ts`、`article-receiver.ts`、`deletion-store.ts`、`saved-state.ts`、`library-wire.ts:65`，增量与 full fallback 路径存在。真实大库中断一致性待验。 | 高 | S |
| ping / pong、nonce | 已实现 | B/WatchBluetoothSyncServer.kt:1236；`src/sync/application-actions.ts:12`。 | 低 | S |
| remoteInput 校验、投递输入页面 | 已实现 | B/WatchBluetoothSyncServer.kt:1244；W/BluetoothConnectionActivity.kt:167；`src/sync/application-actions.ts:13`、`application-host.ts:33`、`remote-input/inbox.ts`。 | 高 | S |
| pullSavedItems：favorite / watchLater links-only | 已实现 | B/WatchBluetoothSyncServer.kt:1254；PB/PhoneBluetoothSyncManager.kt:421；`src/sync/saved-links.ts`、`application-actions.ts:14`、`services.ts`。 | 高 | S |
| merge 默认、phoneToWatchReplace、watchToPhoneReplace、forceFull | 已实现 | B/WatchBluetoothSyncServer.kt:509–558；PB/PhoneBluetoothSyncManager.kt:508、563、714；`src/sync/session.ts:110–133`、`library-repository.ts:93`、`library-wire.ts:63` 有 authoritative 能力声明、清理未保留项和重置 cursor。 | 高 | S |
| clearLibrary 保留账号/独立笔记/阅读配置，清库并清游标 | 已实现 | B/WatchBluetoothSyncServer.kt:1393；`src/sync/application-actions.ts:15` → `library-repository.ts:81`，删除频道及同步状态并清理内容文件。原生 action 本身不弹确认；手机确认工作流仍须配对验收，不能凭手表 handler 推断安全验收通过。 | 高 | S |
| syncReader 清单、push/pull resource、chunk ACK | 已实现 | B/WatchBluetoothSyncServer.kt:1309；PB/PhoneBluetoothSyncManager.kt:941–1003；`src/sync/reader-actions.ts:9`、`reader-resources.ts`、`reader-resources-host.ts` 已接落盘/哈希/received/applied。 | 高 | S |
| probe 中阅读器能力及媒体能力发布 | **已实现（源码级，设备待验）**（`0954193`） | B/LibrarySyncPayload.kt:112–119，B/WatchBluetoothSyncServer.kt:1423 调用 WatchMediaCapabilities；PodJS `src/sync/application-host.ts`、`src/sync/protocol.ts` 从实际接线的 handler 和物理屏幕尺寸发布能力，不声明未验证的 codec。手机 PB/PhoneBluetoothSyncClient.kt:1856、1951 读取媒体能力。 | 高 | M |
| previewReader 单次 update/delta/heartbeat/stop/resourceHandoff | 已实现 | B/WatchBluetoothSyncServer.kt:1324；B/ReaderPresetPreviewPayload.kt；`src/sync/reader-preview.ts:7`、`reader/preview-session.ts`、`reader/preview-host.ts` 已接页面。 | 高 | S |
| previewReader stream=true 持续预览流及 ACK 节流 | **已实现（源码级，设备待验）**（`0954193`） | B/WatchBluetoothSyncServer.kt:363、1499–1540 为专门循环；PB/PhoneBluetoothSyncClient.kt:775–810 直接连续写预览帧；PodJS `src/sync/session.ts` 已为 `stream=true` 使用独立帧循环并按原生 50ms 节流回复，避免把下一帧误当 ACK。 | 高 | M |
| syncAccount 安全存储账号、返回身份 | **已实现（源码级，设备待验）**（`7e85fb0`、`f7b4f3a`，合并 `2e06c09`） | B/WatchBluetoothSyncServer.kt:1285–1305 同时记录 usageTelemetry 并返回 backlog；PodJS `src/sync/account-actions.ts` 通过共享 secure account store 持久化账号，返回 boundUserId/deviceId 和真实七日 `sync_account` backlog；`src/telemetry/` 接入 release 事件与日汇总上传。 | 中 | M |
| syncLlmTokenUsage 限量及多供应商字段 | 已实现 | B/WatchBluetoothSyncServer.kt:1339–1375；`src/sync/token-usage.ts`、`application-actions.ts:19`、`services.ts`，从本地用量记录导出。 | 中 | S |
| pullDebugLog 截断、maxChars、totalChars | **已实现（源码级，设备待验）**（`7e85fb0`、`d293e2d`，合并 `60b9ba2`） | B/WatchBluetoothSyncServer.kt:1377 取全局 AppLogger；PodJS `src/logs/app-logger.ts` 提供原生格式/级别、私有文件、5 MiB 阈值与脱敏，网络、播放器、阅读、TTS、同步路径已接入；`pullDebugLog` 保留 1..700000 限幅、UTF-16 尾部和截断前 totalChars 语义。 | 中 | M |
| syncNotes 双向笔记合并 | 已实现 | B/WatchBluetoothSyncServer.kt:1459；PB/PhoneBluetoothSyncManager.kt:827；`src/sync/note-actions.ts`、`notes/repository.ts`、`application-actions.ts:22`，合并后通知 UI。 | 高 | S |
| syncNoteAsset 分块资产及完成落盘 | 已实现 | B/WatchBluetoothSyncServer.kt:1467；PB/PhoneBluetoothSyncManager.kt:894；`src/sync/note-assets.ts`、`application-host.ts:22` 绑定 fileChunks。 | 高 | S |
| ACK received 与 applied；仅应用成功后推进 cursor | 已实现 | B/BluetoothSyncProtocol.kt:148；B/WatchBluetoothSyncServer.kt:1037、1158；`src/sync/library-wire.ts:12`、`session.ts:56–61、102`。收到 received 后继续等待 applied；无 applied 不 markSuccess。 | 高 | S |
| syncSession complete/abort、持久连接协商、15 分钟空闲 | 已实现 | B/BluetoothSyncProtocol.kt:43–54、122；PB/PhoneBluetoothSyncManager.kt:377、387；`src/sync/session.ts:70–74` 协商后 15 分钟并验证结束 phase。 | 高 | S |
| IP v2、/sync WebSocket、hello HMAC、序号核对 | 已实现 | W/phoneconnection/ip/IpSyncProtocol.kt:159、175、204；P/connection/ip/WatchIpSyncServer.kt；`src/sync/ip-protocol.ts:5、40`、`ip-connection.ts:21–26`。依赖 host net.websocket 能力，本次未实测。 | 高 | S |
| RFCOMM 升级 IP、BLE 描述符、mDNS、LAN/热点/bridge 回退、冷却与重连 | 已实现 | W/phoneconnection/ip/WatchIpSyncManager.kt:187、293；W/phoneconnection/ip/IpSyncProtocol.kt:163–167；P/connection/ip/IpSyncProtocol.kt；`src/sync/ip-discovery.ts:5`、`application-host.ts:25–33`、`ip-controller.ts:34–99`，有 bonded-only、签名验证、3 候选优先级/10 秒冷却。mDNS 是发现手机服务，广告由手机负责，非手表缺项。 | 高 | S |
| guided Wi-Fi /pullRemoteInput、token action URL | 缺失 | W/phoneconnection/guided/WatchGuidedWifiClient.kt:98、114；`src/remote-input/http.ts` 是手表 HTTP 服务，`src/sync/ip-*` 是 WebSocket，均非此手机热点客户端；原生声波 debug 路径，非正式手机连接必需。 | 低 | L |
| DebugBluetoothSyncActivity：超时参数、payload 摘要、生命周期独占 | **已实现（G1 源码与本地测试；设备 PENDING）** | 原生 W/DebugBluetoothSyncActivity.kt；PodJS `src/debug/bluetooth.ts`、`src/ui/DebugToolsScreen.tsx`、`src/sync/application-foreground.ts`：120000ms 默认/可编辑超时、native 字段摘要、前台监听 quiesce 后独占，后台/退出取消与释放。仅 `application.buildInfo().debugBuild === true` 可达。 | 低 | M |

**本区结论：**实时预览 stream、probe 能力、16 KiB/字节进度、账号 backlog、usage telemetry 与全局日志源均已有源码路径；v13/v14 配对、双向替换、clear 确认、ACK 中断、BLE/mDNS/WebSocket 路由及新增页面仍全部为设备 PENDING。声波/引导 Wi-Fi 仍未迁移；G1 已补 debug 蓝牙页，本地验证通过，设备 PENDING。

## 3. 云同步

**范围判断：当前原生云同步受 DEBUG 限制。** W/WatchRssApplication.kt:100–104 只在 DEBUG 安装调度，否则取消 worker；W/AccountStatusActivity.kt:38–42 仅 DEBUG 注入 cloud service；W/data/cloud/WatchCloudSyncWorker.kt:20 非 DEBUG 直接成功退出。以下影响描述针对启用云功能后的体验，不应把整套云迁移当作正式发行版核心阻塞。

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| bootstrap、设备注册、会员/空间和 heads API | 部分实现 | W/data/cloud/WatchCloudClient.kt:76、107、132；`src/cloud/client.ts:20–32` 有客户端，但 registerDevice 的 platform 写成 `phone`，原生为 `watch`（:119）；全 src 搜索未找到实例化调用，未接运行时。 | 中 | M |
| 设备 P-256 密钥、手机批准、信封解封、多版本账号密钥 | 缺失 | W/data/cloud/WatchCloudKeyManager.kt:30、61、74；W/data/cloud/WatchCloudCrypto.kt:374；`src/cloud/types.ts` 仅 envelope 类型，无对应密钥管理/解封；账号 token secure store 不能替代云主密钥。 | 中 | L |
| 快照 manifest/chunk 加密、gzip、哈希及缓存复用 | 缺失 | W/data/cloud/WatchCloudCrypto.kt:139、190、212、333；W/data/cloud/WatchCloudCache.kt:9、24、30；`src/cloud/types.ts` 仅加密快照接口，没有 codec/cache 实现。 | 中 | L |
| 拉远端快照及分块、验 hash/长度、解密并恢复本地库 | 缺失 | W/data/cloud/WatchCloudSyncService.kt:99–170；W/data/cloud/WatchCloudClient.kt:147、295；W/data/cloud/WatchCloudLibraryAdapter.kt:106、123；`src/cloud/client.ts` 没有 snapshot download 方法，未接 `src/sync/library-repository.ts`。 | 中 | L |
| 本地 RSS/保存状态导出、序列/heads 因果合并、ACK、防重复上传 | 缺失 | W/data/cloud/WatchCloudSyncService.kt:179–256；W/data/cloud/WatchCloudLibraryAdapter.kt:27、44；W/data/cloud/WatchCloudStateStore.kt:13–30；PodJS `src/cloud/client.ts:33–35` 有 reserve/complete/ack HTTP 封装，但无 state store/调度和库适配。 | 中 | L |
| TUS 大对象上传：6 MiB 分块、offset、重试 | 部分实现 | W/data/cloud/WatchCloudClient.kt:307、405–406；`src/cloud/tus.ts:30` 有上传器和校验，但没有运行时 caller，不能从存在类推断已可云备份。 | 中 | M |
| 公共 RSS 库 resolve/recent128/all 与本地合并 | 部分实现 | W/data/cloud/WatchCloudClient.kt:233；W/data/cloud/WatchCloudSyncService.kt:172；`src/cloud/client.ts:36` 可 resolve，但没有接库合并/调用。 | 中 | M |
| 计费网络仅小状态、Wi-Fi/手动正文、状态及会员空间展示 | 缺失 | W/data/cloud/WatchCloudSyncService.kt:54、119、175、259；W/AccountStatusActivity.kt:111–130；`src/ui/AccountStatusScreen.tsx` 无 cloud service/status，`src/cloud/` 无网络策略协调器。 | 中 | M |
| 前台 5 分钟节流、账号/网络/数据变化触发、6 小时 worker | 缺失 | W/WatchRssApplication.kt:109–140；W/data/cloud/WatchCloudSyncWorker.kt:28；`src/main.tsx` 只启动前台本地同步，`src/cloud/` 无调度。 | 低 | M |

## 4. B站（覆盖全部 11 个 Bili Activity）

已逐一核对 `BiliEntry / ChannelInfo / Login / Search / List / Detail / Comment / ReplyDetail / VideoActions / Settings / PlayerActivity`，并跟踪 Screen、ViewModel、Repository 与 PodJS 主路由。下表 `BV/` = `W/ui/viewmodel/`；`BR/` = `W/data/bili/`。

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| Entry：登录状态、推荐请求、空/错态、手动刷新 | 已实现 | W/BiliEntryActivity.kt:12 → W/ui/screen/bili/BiliEntryNavGraph.kt:45；BV/BiliFeedViewModel.kt:40、50；`src/ui/bili/index.tsx:72–86`、`bili/client.ts:33`、`ui/screen.tsx:452` 有入口和调用。 | 高 | S |
| Entry：原文卡片模式与 RSS 文本模式切换 | **已实现（源码级，设备待验）**（`1744667`，合并 `1f70ec5`） | W/ui/screen/bili/BiliEntryNavGraph.kt:50、89、138 读取频道 useOriginalContent（默认 true）切换两种屏；PodJS `src/bili/browse.ts`、`src/ui/bili/index.tsx` 以频道 `useOriginalContent`（默认 true）驱动原文卡片或 RSS 文本渲染。 | 高 | M |
| Entry：推荐追加、缓存先显、去重、长按/滑动快捷收藏 | **部分实现**（`1744667`，合并 `1f70ec5`） | BV/BiliFeedViewModel.kt:50、109、186、214；W/ui/screen/bili/BiliFeedScreen.kt:85–88、187；BR/BiliRepository.kt:148；PodJS 已接前 5 条缓存先显、追加分页、bvid/aid/title 去重及最多 50 条缓存；操作仍从外部 actions route 进入，没有原生 feed 卡片的长按/横向滑动状态。 | 高 | M |
| ChannelInfo：登录、搜索、稍后再看、历史、收藏夹、设置入口 | 已实现 | W/BiliChannelInfoActivity.kt:73–88；`src/ui/bili/index.tsx:89–92`，登录门槛及子页均接线；更新时间 PodJS 用“实时”代替原生状态时间，视觉/文案需回归。 | 中 | S |
| Login：二维码申请/刷新、扫码状态轮询、持久 cookie、退出取消 | 已实现 | W/BiliLoginActivity.kt:38–54；BV/BiliLoginViewModel.kt:33、79、118；`src/ui/bili/index.tsx:126–135`、`bili/client.ts:18–28`、`media-services.ts:26`。未验证实际扫码/回到来源页的栈体验。 | 高 | S |
| Search：输入关键词、热搜、视频结果点击 | 已实现 | W/BiliSearchActivity.kt:75、83；BV/BiliSearchViewModel.kt:81、105；`src/ui/bili/index.tsx:137–154`、`bili/client.ts:34–35`。 | 高 | S |
| Search：历史存储/清空、AV/BV 直达、连续结果分页 | **已实现（源码级，设备待验）**（`1744667`，合并 `1f70ec5`） | BV/BiliSearchViewModel.kt:95、105–141；BV/BiliSearchResultViewModel.kt:24；BR/BiliRepository.kt:549–566；PodJS `src/bili/browse.ts`、`src/ui/bili/index.tsx` 已接 20 条搜索历史/清空、AV/BV 直达详情和结果分页。 | 高 | M |
| List：稍后再看列表、历史列表、收藏内容 | 已实现 | W/BiliListActivity.kt:50；BV/BiliListViewModel.kt:70；`src/ui/bili/index.tsx:100–123`、`bili/client.ts:53、60–61`。PodJS 额外提供收藏文件夹选择，原生 ViewModel 默认取首个文件夹，属于行为差异而非缺功能。 | 中 | S |
| List：历史 cursor 与收藏内容 loadMore | **已实现（源码级，设备待验）**（`1744667`，合并 `1f70ec5`） | BV/BiliListViewModel.kt:113、132、195；PodJS `src/bili/browse.ts`、`src/ui/bili/index.tsx` 已接收藏 mediaId 分页及历史 cursor；历史 loadMore 是当前原生禁用路径之上的有意超集。 | 高 | M |
| Detail：标题/作者/简介、封面点击播放、分享 | 已实现 | W/BiliDetailActivity.kt:60、82、97–105；`src/ui/bili/index.tsx:157–166`、`sharing/policy.ts`；播放由 `ui/screen.tsx:403–413` 接管，不能把模块内备用 PlayerScreen 占位误判成整个播放器缺失。 | 高 | S |
| Detail：选分 P、恢复上次 cid、点赞/投币/取消收藏及互动状态 | **已实现（源码级，设备待验）**（`ba0ea98`，合并 `4a917f1`） | W/BiliDetailActivity.kt:109–112；BV/BiliDetailViewModel.kt:148、154、169、179、236、250；BR/BiliRepository.kt:179、220；PodJS `src/bili/detail.ts`、`src/ui/bili/index.tsx` 已接分 P、上次 cid、手动选择及 like/coin/favourite 状态与 mutation；收藏写入统一保存库。 | 高 | M |
| Detail：离线本地已保存信息兜底、预览视频热身 | **部分实现**（`ba0ea98`，合并 `4a917f1`） | BV/BiliDetailViewModel.kt:309、331、435；BR/BiliRepository.kt:426、606、634；PodJS 已能从统一 SQL saved row 构造离线详情，并在联网结果到达后替换；当前源码仍未找到与原生 `preparePreviewVideo` 对等的视频预热调用。 | 高 | L |
| CommentActivity：置顶/正文/头像、回复入口 | **已实现（源码级，设备待验）**（`bb8c0d7`，合并 `f02e8c7`） | `src/bili/comments.ts`、`src/ui/bili/CommentScreen.tsx`、`comment-layout.ts` 补全 next 分页、置顶去重、未截断正文、36dp 头像、20sp 表情、@ 蓝色、VIP/UP/置顶、时间/赞数、100dp 横向图片与前三条回复预览；rpid 导航到楼中楼，刷新/触底/失败原页重试。按原生 SDK 使用无排序参数/无 WBI 的 reply/main，匿名直读；jump_url 保留普通文本符合原生。本地测试不等于像素/物理验收。 | 低 | M |
| ReplyDetailActivity：根评论、楼中楼及分页 | **已实现（源码级，设备待验）**（`bb8c0d7`，合并 `f02e8c7`） | `src/bili/comments.ts`、`src/ui/bili/CommentScreen.tsx` 接 root + “所有回复”、pn/ps=20 追加，非空页继续至空页（同原生 ReplyPagingSource）；保留 root、刷新重置、失败原页重试、旧请求失效。原生 rootComment 未从 PagingSource 接入 ViewModel，本次按任务修复该链路；详情卡片不再递归导航。设备截图/物理操作及系统字体缩放未验。 | 低 | M |
| VideoActions：远端收藏/稍后再看、分享/取消 | 已实现 | W/BiliVideoActionsActivity.kt:80、138、168；`src/ui/bili/index.tsx:177–187` 调用远端并提示；PodJS 用选收藏夹代替原生默认收藏夹，成功后停留与原生 finish 不同。 | 中 | S |
| VideoActions/Detail：远端成功后写本地收藏/稍后再看并缓存预览 | **已实现（源码级，设备待验）**（`b857422`） | W/BiliVideoActionsActivity.kt:194–208；BV/BiliDetailViewModel.kt:257；BR/BiliRepository.kt:634；PodJS 在远端 mutation 成功后写统一 SQL saved library，并让总保存列表、manifest 与后续同步读取同一数据源。 | 高 | M |
| Settings：退出登录、删除频道确认、后台播放开关 | **已实现（源码级，设备待验）**（`1744667`、`911a56d`，合并 `50bcfd6`） | W/BiliSettingsActivity.kt:82；BV/BiliSettingsViewModel.kt:43、66、75；BR/BiliRepository.kt:96；PodJS 已让频道原文开关参与渲染，并在退出时清账号、WBI、互动、播放进度和预览 bucket，保留原生保留的 feed/search/saved；删除确认和后台播放沿用既有接线。 | 中 | M |
| Player：MP4/DASH、cookie headers、播放暂停/快进/旋转/缩放/平移、音量/后台策略 | 已实现 | W/BiliPlayerActivity.kt:74、107；W/ui/screen/bili/BiliPlayerScreen.kt；`src/ui/screen.tsx:406–413`、`playback.ts:3`、`ui/VideoPlayerScreen.tsx:30–85` 有 host video 调用、双音视频轨及控件。真机解码、手势、表面合成未验。 | 高 | S |
| Player：播放错误刷新源/切候选、缓存播放源/预览回退 | **已实现（源码级，设备待验）**（`ba0ea98`，合并 `4a917f1`） | BV/BiliPlayerViewModel.kt:143、192；BR/BiliRepository.kt:369、777；PodJS `src/bili/playback.ts`、`src/ui/VideoPlayerScreen.tsx` 先切未失败的 MP4/DASH 候选，再强制重新解析；不会重新 prepare 已失败 URL，离线详情可从统一 saved row 回落。 | 高 | M |
| Player：本地断点、结束清进度、远端历史 checkpoint | 已实现 | BV/BiliPlayerViewModel.kt:247–287、359、384；BR/BiliRepository.kt:252、321；`src/bili/playback.ts:12–23`、`ui/screen.tsx:410–413、484` 绑定 ready/tick/pause/error/ended。分 P 的入口恢复和后端失败组合仍待验证，不等于完整原生恢复导航。 | 高 | S |

## 5. 抖音（覆盖全部 8 个 Douyin Activity）

已核对 `DouyinEntry / ChannelInfo / Login / Detail / History / VideoActions / Settings / PlayerActivity`。`DV/` = `W/ui/viewmodel/`；`DR/` = `W/data/douyin/`。搜索、服务端点赞/关注不是当前原生 Repository 契约，不列为迁移缺失。

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| Entry：登录判定、推荐请求、cursor 加载更多、错误/刷新 | 已实现 | W/DouyinEntryActivity.kt:177、237；DV/DouyinFeedViewModel.kt:721、754；DR/DouyinRepository.kt:69；`src/ui/douyin/index.tsx:91、132`、`douyin/client.ts:24–35`、`douyin/signing.ts`，首屏与列表翻页已接服务。 | 高 | S |
| Entry：原文沉浸竖向流 / RSS 列表模式开关 | **已实现（源码级，设备待验）**（`c4cbe8d`、`7ef2bf3`，合并 `fed3782`、`c68bc13`） | W/DouyinEntryActivity.kt:189–237 根据 useOriginalContent 切换；PodJS `src/ui/douyin/index.tsx`、`src/ui/routes/media.tsx` 以频道 `useOriginalContent`（默认 true）为唯一来源，原文模式进入沉浸流，RSS 模式保持列表→详情；旧 KV 只迁移一次。 | 高 | L |
| Entry：沉浸预加载播放器池、缓存引导、最近窗口/当前视频恢复、失效源刷新/跳过 | **已实现（源码级，设备待验）**（`c4cbe8d`、`c0a40cb`，合并 `fed3782`、`060f78c`） | DV/DouyinFeedViewModel.kt:435、461、488、725、865、956；W/ui/screen/douyin/DouyinImmersiveScreen.kt:280；DR/DouyinFeedCacheStore.kt:29、DouyinRecentWindowStore.kt:43；PodJS `src/douyin/feed-store.ts`、`src/ui/douyin/video-sessions.ts` 持久 feed/recent 窗口、TTL 失效源重解/隔离/跳过，并以当前 session + 一个静音前向 prewarm session 构成播放器池；缺少新能力的旧 host 保留单播放器路径。 | 高 | L |
| Entry：长按/侧滑视频操作、标题点击频道信息 | **已实现（源码级，设备待验）**（`c4cbe8d`，合并 `fed3782`） | W/DouyinEntryActivity.kt:213、230、258、263、278；PodJS 沉浸流支持长按/横向滑动进入 actions，标题进入独立 ChannelInfo。 | 中 | M |
| ChannelInfo：专门说明/URL/更新状态页，登录、设置、历史入口 | **已实现（源码级，设备待验）**（`c4cbe8d`，合并 `fed3782`） | W/DouyinChannelInfoActivity.kt:56–88；W/ui/screen/douyin/DouyinChannelInfoScreen.kt；PodJS `src/ui/douyin/index.tsx` 已接 channel-info route、说明/URL/更新时间和登录、设置、历史入口；原生 markReadEnabled=false，未添加“全部已读”。 | 低 | S |
| Login：官方 WebView 登录、提取二维码、cookie 持久化 | **已实现（源码级，设备待验）**（`69e253f`，合并 `2e160e7`；框架 `7956455`） | W/DouyinLoginActivity.kt:69–78；W/ui/screen/douyin/DouyinLoginScreen.kt:155、224、363、474；PodJS `src/ui/douyin/index.tsx`、`src/media/browser-auth.ts` 使用宿主 auth-status 事件识别登录/二验二维码和页面状态，完成后持久 cookie；旧 host 保留旧提取路径。 | 高 | M |
| Login：Checking / 无网络 / 蓝牙网络禁用、WebView 不可用专页 | **已实现（源码级，设备待验）**（`911a56d`、`db75a8d`，合并 `50bcfd6`） | W/DouyinLoginActivity.kt:33–69、91；PodJS `src/ui/douyin/login-state.ts`、`src/douyin/browser.ts` 已接检测中、离线、蓝牙网络和 WebView availability 分支；旧 host 缺能力时回落原路径。 | 中 | M |
| Login：二步验证识别及回落网页登录 | **已实现（源码级，设备待验）**（`69e253f`，合并 `2e160e7`；框架 `7956455`） | 原生 W/ui/screen/douyin/DouyinLoginScreen.kt:231–281；PodJS auth-status 路径区分 PNG 登录码与 JPEG 二步验证码，显示 verifying/cancelled/page-state，并在需要时回落交互网页；真实挑战仍待设备验收。 | 中 | M |
| Detail：作者/描述/封面/视频链接与播放 | 已实现 | W/DouyinDetailActivity.kt:49–89、214；`src/ui/douyin/index.tsx:144` 读取 detail、展示和进入 host player。原生此 Activity 收藏只是 remember 临时变量（:89），不是持久保存基准；持久行为以 VideoActions 为准。 | 高 | S |
| Detail：继承阅读器预设、字号、传入数据直接离线展示 | **已实现（源码级，设备待验）**（`74447e2`，合并 `949d2a8`） | `douyin/detail.ts` 优先传入 item、history、saved；`ui/douyin/index.tsx` 使用通用 ReaderBody；`routes/media.tsx` 传当前 readerPreset。播放解析与展示元数据分离。原生 W/DouyinDetailActivity.kt:44–103、196–231。 | 中 | M |
| History：200 条历史、1000 watched IDs、清空 | 已实现 | W/DouyinHistoryActivity.kt:49、72；DR/DouyinWatchHistoryStore.kt:29、70、146–147；`src/douyin/client.ts:36–40`、`ui/douyin/index.tsx:154` 已持久化、清空及显示。 | 中 | S |
| History：从历史构造播放队列、连续换视频记录历史 | **已实现（源码级，设备待验）**（`74447e2`，合并 `949d2a8`） | 历史 route 携带完整有序 playlist（最多 200），不混入 feed cursor；列表/历史点击在导航前 markWatched 等价写入；保留 ready→queue.settled，按 awemeId 去重刷新时间/元数据。收藏入口按原生通用阅读器不写抖音观看历史。历史队列是当前原生行为之上的明确超集。 | 中 | M |
| VideoActions：收藏/稍后再看切换、分享和取消 | 已实现 | W/DouyinVideoActionsActivity.kt:102、118、134、157；`src/ui/douyin/index.tsx:162`、`douyin/saved.ts`、`sharing/policy.ts`、`ui/screen.tsx:194` 有本地状态及总收藏显示。无服务端互动符合原生。 | 高 | S |
| VideoActions：本地保存进入统一 RSS 库与手机同步 | **已实现（源码级，设备待验）**（`b857422`） | W/DouyinVideoActionsActivity.kt:163 调用 rssRepository.syncExternalSavedItem；PodJS 将旧 `douyin/saved.ts` KV 状态一次性、幂等且可恢复地迁入统一 SQL saved library，保存列表和 `syncLibrary`/`pullSavedItems` 读取同一数据源。 | 高 | M |
| Settings：原文/后台开关、退出登录、频道删除确认 | **已实现（源码级，设备待验）**（`c4cbe8d`、`7ef2bf3`、`911a56d`） | W/DouyinSettingsActivity.kt:52；DV/DouyinSettingsViewModel.kt:43、56、66、75；PodJS 的频道 `useOriginalContent` 实际驱动沉浸/RSS 分支，后台策略接播放器；退出清理与删除确认均有接线。 | 高 | M |
| Settings：退出清 WebView cookie、媒体缓存和最近窗口、回首页 | **已实现（源码级，设备待验）**（`911a56d`、`db75a8d`、`e0090ec`） | DR/DouyinRepository.kt:35–48、141；DV/DouyinSettingsViewModel.kt:43；PodJS 退出清 cookie、feed/recent window、preload bucket，并通过宿主 `browser.clearSiteData` 清原生 origins，最后重置导航栈到首页；旧 host 缺能力时记录日志后继续退出。 | 中 | M |
| Player：上下切视频、播放/暂停/重试/音量/缩放/旋转/后台开关 | **已实现（源码级，设备待验）**（`c0a40cb`，合并 `060f78c`） | W/DouyinPlayerActivity.kt:76–137；W/ui/screen/douyin/DouyinImmersiveScreen.kt；PodJS `src/ui/douyin/ImmersiveScreen.tsx`、`video-sessions.ts`、`douyin/playback-queue.ts`、`ui/VideoPlayerScreen.tsx` 接手指驱动竖向 transition、原生阈值/速度/回弹、session promote/reuse 及现有播控；旧 host 继续使用单播放器路径。 | 高 | S |
| Player：网络遮罩、队列位置跨重启恢复、沉浸流长按操作 | **已实现（源码级，设备待验）**（`74447e2`、`c0a40cb`，合并 `949d2a8`、`060f78c`） | `ui/VideoPlayerScreen.tsx` 接实际网络观察、断网/蓝牙继续遮罩；`douyin.playback-queue.v1` 持久完整顺序/anchor，沉浸入口及列表继续播放消费；长按/侧滑和 session settle/promote 已接。物理输入、重启与视频表面需真机验收。 | 中 | M |

## 6. 信息与支持（About / Info / Collaborators / ContactDeveloper / JoinGroup / Beian / LogUploadPrivacy / LogUpload / WebView）

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| 关于：项目自介、隐私、协议、开源许可、贡献者路由 | 已实现 | W/AboutActivity.kt:16–42；W/ui/screen/AboutScreen.kt:30；`src/ui/InformationScreens.tsx:128`、`ui/screen.tsx:500` 五入口均接线。 | 中 | S |
| 项目自介/开源清单正文与原生一致 | 已实现 | `../Android_WatchRSS/app/src/main/res/values/strings.xml:4、7`；W/AboutActivity.kt:18、39；`src/ui/information-data.ts:7、10` 与当前原生文本一致。这里是原生文本 parity，不是对 PodJS 实际依赖许可证清单的独立合规审计。 | 低 | S |
| Info：远端隐私/协议加载、失败重试、阅读器预设/背景/字号、备案尾链 | 已实现 | W/InfoActivity.kt:61–98、193；W/ui/screen/InfoScreen.kt:33、52、112；`src/ui/InformationScreens.tsx:110–124、147`、`InformationDocument.tsx`、`information-document.ts`，主路由提供 preset/fonts/background 和 legalBaseUrl。静态 fallback 文案存在不代表远端失败被静默替代。 | 中 | S |
| Info：Activity 重建时保留正文/加载状态/滚动 | **已实现（源码级，设备待验）**（`18cc10c`） | W/InfoActivity.kt:69–75 使用 rememberSaveable；PodJS `src/ui/information-route-state.ts`、`src/ui/InformationScreens.tsx`、`src/ui/routes/info.tsx` 已让正式 route 保存并恢复正文、加载态和滚动快照。 | 中 | M |
| 合作者：姓名、角色、字母头像 | 已实现 | W/CollaboratorsActivity.kt:15；W/ui/screen/CollaboratorsScreen.kt:39、116–130；`src/ui/InformationScreens.tsx:129` 三人内容一致。阴影/字重/间距、原生 debug 圆形 mask 无完整复刻，视觉另列未验。 | 低 | S |
| 联系开发者：加群、日志说明入口 | 已实现 | W/ContactDeveloperActivity.kt:27；W/ui/screen/ContactDeveloperScreen.kt:41、86、101；`src/ui/InformationScreens.tsx:130`。当前 PodJS 按钮无原生 Groups/Upload 图标，导航语义已有。 | 中 | S |
| 加群：相同 URL/群号、二维码与无障碍说明 | **已实现（源码级，设备待验）**（`18cc10c`） | W/JoinGroupActivity.kt:15–18；W/ui/screen/JoinGroupScreen.kt:62、67；PodJS `src/ui/InformationScreens.tsx`、`information-data.ts`、`SafeQrScreen.tsx` 保留 URL/群号并补齐二维码和群号无障碍描述；实体读屏与进场画面未验。 | 低 | S |
| 备案：标题/网址/QR、尺寸、文字测量、API 条件 blur 动画与 accessibility | 已实现 | W/BeianActivity.kt:11；W/ui/screen/BeianScreen.kt:22–49；W/ui/components/QrCodePanel.kt；`src/ui/BeianScreen.tsx:35–130`、`BeianText.tsx`、`BeianQrSurface.tsx` 存在对应实现和能力失败处理。只确认源码，不引用历史设备截图作为本次证据。 | 中 | S |
| 日志上传隐私说明及显式开始操作 | **已实现（源码级，设备待验）**（`03b1619`、`e0090ec`，合并 `455502c`、`dd3532f`） | W/LogUploadPrivacyActivity.kt:9；W/ui/screen/LogUploadPrivacyScreen.kt:84、102；PodJS `src/ui/information-data.ts`、`InformationScreens.tsx`、`routes/info.tsx` 已将隐私页显式操作接到 `LogUploadScreen`。 | 中 | S |
| 日志读取、暂无/加载失败状态、WebView 自动提交加密日志、取件码 | **已实现（源码级，设备待验）**（`03b1619`、`d293e2d`、`e0090ec`） | W/LogUploadActivity.kt:42、66、85–117；PodJS `src/logs/` 与 `src/ui/LogUploadScreen.tsx` 实现原生兼容的 gzip + AES-256-GCM + RSA-OAEP-SHA256 framing、InstantDB 上传/取件码及状态 UI；日志源现为全应用 AppLogger。真实后端、WebView/网络和取件流程未在设备验收。 | 中 | L |
| WebView：应用内浏览、历史返回、缩放档位、主题、加载进度、销毁 | **已实现（源码级，设备待验）**（`d716e07`，合并 `bbcdffe`；框架 `144848a`） | W/WebViewActivity.kt:70–165、196–257；W/ui/screen/WebViewScreen.kt；应用 `src/browser/open.ts` 将原文和 Bili/Douyin/RSS 播放链接按原生调用点送入 `system.browser.inApp`，传阅读预设明暗/背景；框架接历史返回、三档缩放、加载进度、生命周期和销毁，旧 host 回落 `browser.open`。 | 中 | L |
| WebView：联网前置检查、不可用提示、本地绝对路径转换 | **已实现（源码级，设备待验）**（`d716e07`，合并 `bbcdffe`；框架 `144848a`） | W/WebViewActivity.kt:320–351；框架 `PodInAppBrowser` 在 HTTP(S) 前检查 validated network，区分离线/WebView 不可用，并用 `Uri.fromFile` 转换绝对路径；应用保留现有错误展示。 | 中 | M |

## 7. Perf / debug 入口隔离

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| 正式设置不暴露性能/种子测试入口 | **已实现（G1 release 门控测试通过；设备 PENDING）** | `src/debug/gate.ts`、`src/debug/host.ts` 仅接受框架 buildInfo 的布尔 true；缺失/旧 host/失败均关闭；设置菜单、路由、工具构造及操作检查门控。生产同步 pullDebugLog 保持可用。 | 中 | S |
| 原生超大列表/超大文章固定场景与指标 | **已实现（G1 源码；设备 PENDING）** | `src/debug/perf.ts` 保留 10000 条、100000+ 字符与图片分布；`src/ui/DebugToolsScreen.tsx` 复用正式 RssFeedScreen/ReaderScreen；框架 `PodDebugPerformance.java` 采集 Android JankStats/FrameMetrics，非 JS 帧间隔，退出汇总、后台暂停、session token 隔离；native 指标需要更新 host。 | 低 | M |
| 蓝牙/声波 debug Activity 的正式入口隔离 | **已实现（G1 release 门控测试；设备 PENDING）** | 蓝牙工具仅 debug 设置页可达，框架 debugBuild 查询失败时隐藏；未增加 exported Activity 或广播；声波本次未迁移。 | 低 | S |
| 抖音 debug alias/广播故障注入、cookie 导入、自动换片 | **已实现（G1 等效设置页；设备 PENDING）** | `src/debug/douyin.ts`、`src/ui/DebugToolsScreen.tsx`、`src/ui/routes/media-controller.ts`：下一片/指定 ID 故障 URI、Cookie 安全导入、上下文、单次/定时换片、清除；故障 URL 仅用于播放器输入，不污染缓存。未新增系统广播。 | 低 | M |
| DebugLogProvider / dump 与性能开关 | 部分实现 | W/debug/DebugLogProvider.kt:33；W/debug/PerformanceMonitor.kt:30、67 受 ENABLE_RUNTIME_PERF_MONITOR 控制；PodJS `src/sync/diagnostic-log.ts` 仅有限日志，不提供 provider/dump；G1 已补原生指标与 perf 场景；pullDebugLog 是生产协议能力，应保留，不应因名称含 Debug 而整体禁用。 | 低 | M |
| 云同步/声波实验功能维持非正式入口 | 已实现 | W/WatchRssApplication.kt:100、W/AcousticConnectionActivity.kt:98；PodJS `src/main.tsx` 无 cloud 实例化、`ui/screen.tsx` 无声波 route。未来接线需明确构建/能力策略；不能仅因代码文件存在就判断已在产品启用。 | 低 | S |

## 8. 建议增量任务（按核心路径与影响排序，仅任务建议）

1. **设备验收（高）**：按 `docs/acceptance.md` 与设备 runbook 验证蓝牙/实时预览/替换与清库、Bili 浏览/互动/评论/播放、抖音登录/沉浸拖动/预热/后台恢复、日志上传和应用内 WebView；源码单测与打包均不能替代这些证据。
2. **版本分发决策（高）**：PodJS 包名不同于原生，且宿主没有 `packageUpdate`；在用户决定下载、目标包校验、安装与回滚策略前，继续保持 `VERSION_ANNOUNCEMENTS_ENABLED=false`。
3. **debug-only 范围（G1 更新）**：按用户要求已迁移 debug 蓝牙页、性能场景/指标、抖音调试、详细 TTS 与重新进入引导，仅 host debugBuild 开放。云同步、声波/引导 Wi-Fi 不在本次 G1 范围；设备验证全部 PENDING。
