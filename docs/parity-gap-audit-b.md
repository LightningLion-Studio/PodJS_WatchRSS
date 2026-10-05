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
| 独立 BluetoothConnection 页面：权限请求、等待/结果、重试、返回 URL | 部分实现 | W/BluetoothConnectionActivity.kt:52、102、131、167、212；PodJS `src/sync/application-foreground.ts`、`remote-input/inbox.ts` 有监听/结果投递，`ui/PhoneConnectionScreen.tsx` 无该独立状态页及重试按钮。正式主页也未直接打开此页，勿与后台同步缺失混淆。 | 中 | M |
| 纯声波：接收 RSS、发送收藏/稍后再看、时长预估和录音权限 | 缺失 | W/AcousticConnectionActivity.kt:98、235、304、324、482、511；PodJS `src/` 无 acoustic 编解码/录音发送页。原生 onCreate 明确仅 debug 可用，属调试能力缺口。 | 低 | L |
| 声波引导 Wi-Fi：热点连接、拉 RSS、推收藏/稍后再看 | 缺失 | W/AcousticConnectionActivity.kt:364、420、438、456、518；W/phoneconnection/guided/WatchGuidedWifiClient.kt；PodJS `src/sync/ip-*` 是另一个 IP 同步协议，不能代替声波引导协议。原生仅 debug；TTS/B站记录/LLM 在原生此路径也是未支持分支。 | 低 | L |
| 不可用原因独立页面 | 缺失 | W/PhoneConnectionUnavailableActivity.kt:16、23、35；PodJS 没有对等独立页，目前下载弹窗/错误消息承担部分提示。 | 低 | S |
| 链接分享二维码、标题/提示、空链接拦截、失败回调、点击返回 | 已实现 | W/ShareQrActivity.kt:19、27、37；W/ui/screen/ShareQrScreen.kt:26；PodJS `src/ui/ShareQrScreen.tsx:24`、`sharing/policy.ts:12、28`、`ui/QRCode.tsx`，调用侧 share policy 验证链接。 | 中 | S |
| 分享二维码可配置宽度比例 | 部分实现 | W/ShareQrActivity.kt:22、61；W/ui/screen/ShareQrScreen.kt:35 允许 0.1–1；PodJS `src/ui/ShareQrScreen.tsx` 固定 130/233 布局，未提供 qrWidthRatio 参数；需连同不同来源分享调用核验视觉。 | 低 | S |
| Server：HTTP 输入 RSS、能力查询、二维码、接收后回填/跳转、退出停服务 | 已实现 | W/ServerActivity.kt:64、109、143；W/phoneconnection/LocalHttpServer.kt:916；PodJS `src/ui/RemoteInputScreen.tsx`、`remote-input/server.ts`、`remote-input/http.ts`。 | 高 | S |
| Server：收藏、稍后再看、B站观看记录 HTTP 导出 | 缺失 | W/ServerActivity.kt:74–87；W/phoneconnection/LocalHttpServer.kt:937、957、980；PodJS `src/remote-input/http.ts:46` 仅 RSS 路由，`src/sync/saved-links.ts` 是蓝牙 action，不是旧 HTTP 路由。正式手机采用蓝牙，旧 HTTP 兼容的优先级较低。 | 中 | M |
| Server：配对 token 的 TTS 配置、能力查询及完成反馈 | 已实现 | W/ServerActivity.kt:89；W/phoneconnection/LocalHttpServer.kt:1002；PodJS `src/ui/TtsConfigScreen.tsx`、`tts/config-http.ts`、`tts/config-pairing.ts`，带认证/加解密/一次写入。 | 中 | S |

## 2. 蓝牙诊断与库同步协议（Transport acceptance 逐项）

以下 `B/` 缩写为 `W/phoneconnection/bluetooth/`，`PB/` 为 `P/connection/bluetooth/`。

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| RFCOMM service name / UUID | 已实现 | B/BluetoothSyncProtocol.kt:22；PB/BluetoothSyncProtocol.kt:12；`src/sync/protocol.ts:6–7`、`rfcomm.ts:24` 同一 service 和 UUID，应用已接线。 | 高 | S |
| 4 字节大端长度、UTF-8 JSON、1..2 MiB、拆包/截断 | 已实现 | B/BluetoothSyncProtocol.kt:52、56、79；PB/BluetoothSyncProtocol.kt:41；`src/sync/protocol.ts:66`、`stream.ts:18` 校验范围、截止时间、EOF。 | 高 | S |
| 16 KiB 传输分块、包含 prefix 的字节进度 | 部分实现 | B/BluetoothSyncProtocol.kt:56、79、171；PB/BluetoothSyncProtocol.kt:56、76、132；`src/sync/stream.ts:31、39` 实为 64 KiB，且无 byte-progress 回调，`session.ts:95`/`library-wire.ts:65` 却声明支持 TransferByteProgress。手机侧可自行计数，但手表 src 不能提供原生同等进度。分块大小本身不改变线缆帧格式。 | 中 | M |
| v14、最低手机 v13、legacy v4 定义 | 已实现 | B/LibrarySyncPayload.kt:64–66、131；`src/sync/protocol.ts:15–17`、`session.ts:76、91`。v13/v14 可进入接收器，低于 13 返回升级错误；v4 只是历史常量，当前原生也拒绝旧手机，不能当作额外支持要求。 | 高 | S |
| cursor / manifest / probe / articles / complete | 已实现 | B/WatchBluetoothSyncServer.kt:458、489、851、904、1402；PB/PhoneBluetoothSyncManager.kt:493–680；`src/sync/session.ts:77–133`、`article-batches.ts`，清单/正文分批及请求正文集合均有处理。 | 高 | S |
| v8 change sequence、metadata-only、hash/chunk、删除和保存状态 | 已实现 | B/LibrarySyncPayload.kt:333、338、1726；W/data/rss/DefaultRssRepository.kt；`src/sync/sequence-store.ts`、`manifest.ts`、`article-receiver.ts`、`deletion-store.ts`、`saved-state.ts`、`library-wire.ts:65`，增量与 full fallback 路径存在。真实大库中断一致性待验。 | 高 | S |
| ping / pong、nonce | 已实现 | B/WatchBluetoothSyncServer.kt:1236；`src/sync/application-actions.ts:12`。 | 低 | S |
| remoteInput 校验、投递输入页面 | 已实现 | B/WatchBluetoothSyncServer.kt:1244；W/BluetoothConnectionActivity.kt:167；`src/sync/application-actions.ts:13`、`application-host.ts:33`、`remote-input/inbox.ts`。 | 高 | S |
| pullSavedItems：favorite / watchLater links-only | 已实现 | B/WatchBluetoothSyncServer.kt:1254；PB/PhoneBluetoothSyncManager.kt:421；`src/sync/saved-links.ts`、`application-actions.ts:14`、`services.ts`。 | 高 | S |
| merge 默认、phoneToWatchReplace、watchToPhoneReplace、forceFull | 已实现 | B/WatchBluetoothSyncServer.kt:509–558；PB/PhoneBluetoothSyncManager.kt:508、563、714；`src/sync/session.ts:110–133`、`library-repository.ts:93`、`library-wire.ts:63` 有 authoritative 能力声明、清理未保留项和重置 cursor。 | 高 | S |
| clearLibrary 保留账号/独立笔记/阅读配置，清库并清游标 | 已实现 | B/WatchBluetoothSyncServer.kt:1393；`src/sync/application-actions.ts:15` → `library-repository.ts:81`，删除频道及同步状态并清理内容文件。原生 action 本身不弹确认；手机确认工作流仍须配对验收，不能凭手表 handler 推断安全验收通过。 | 高 | S |
| syncReader 清单、push/pull resource、chunk ACK | 已实现 | B/WatchBluetoothSyncServer.kt:1309；PB/PhoneBluetoothSyncManager.kt:941–1003；`src/sync/reader-actions.ts:9`、`reader-resources.ts`、`reader-resources-host.ts` 已接落盘/哈希/received/applied。 | 高 | S |
| probe 中阅读器能力及媒体能力发布 | 部分实现 | B/LibrarySyncPayload.kt:112–119，B/WatchBluetoothSyncServer.kt:1423 调用 WatchMediaCapabilities；`src/sync/protocol.ts:134` 阅读器四项默认 false；`application-host.ts:22–37` 未传 capabilities/watchCapabilities，虽 handler 存在，probe 仍会报 false 且无媒体能力。手机 PB/PhoneBluetoothSyncClient.kt:1856、1951 读取媒体能力。 | 高 | M |
| previewReader 单次 update/delta/heartbeat/stop/resourceHandoff | 已实现 | B/WatchBluetoothSyncServer.kt:1324；B/ReaderPresetPreviewPayload.kt；`src/sync/reader-preview.ts:7`、`reader/preview-session.ts`、`reader/preview-host.ts` 已接页面。 | 高 | S |
| previewReader stream=true 持续预览流及 ACK 节流 | 部分实现 | B/WatchBluetoothSyncServer.kt:363、1499–1540 为专门循环；PB/PhoneBluetoothSyncClient.kt:775–810 直接连续写预览帧；`src/sync/session.ts:98–105` 所有 action 走普通 response→读 ACK，没有 stream 分支，下一预览帧可能被当 ACK 消耗后关闭。单次预览可用不等于手机拖动实时预览兼容。 | 高 | M |
| syncAccount 安全存储账号、返回身份 | 部分实现 | B/WatchBluetoothSyncServer.kt:1285–1305 同时记录 usageTelemetry 并返回 backlog；`src/sync/account-actions.ts:82` 持久化账号、HTTPS 策略已实现，但 telemetryBacklog 固定 0，未接原生 telemetry 链路。账号传递核心已有。 | 中 | M |
| syncLlmTokenUsage 限量及多供应商字段 | 已实现 | B/WatchBluetoothSyncServer.kt:1339–1375；`src/sync/token-usage.ts`、`application-actions.ts:19`、`services.ts`，从本地用量记录导出。 | 中 | S |
| pullDebugLog 截断、maxChars、totalChars | 部分实现 | B/WatchBluetoothSyncServer.kt:1377 取全局 AppLogger；`src/sync/diagnostic-log.ts:11` 只持久化同步状态/动作/失败类别，未覆盖网络、播放器、阅读等全系统日志。返回形状和 700000 上限已有。 | 中 | M |
| syncNotes 双向笔记合并 | 已实现 | B/WatchBluetoothSyncServer.kt:1459；PB/PhoneBluetoothSyncManager.kt:827；`src/sync/note-actions.ts`、`notes/repository.ts`、`application-actions.ts:22`，合并后通知 UI。 | 高 | S |
| syncNoteAsset 分块资产及完成落盘 | 已实现 | B/WatchBluetoothSyncServer.kt:1467；PB/PhoneBluetoothSyncManager.kt:894；`src/sync/note-assets.ts`、`application-host.ts:22` 绑定 fileChunks。 | 高 | S |
| ACK received 与 applied；仅应用成功后推进 cursor | 已实现 | B/BluetoothSyncProtocol.kt:148；B/WatchBluetoothSyncServer.kt:1037、1158；`src/sync/library-wire.ts:12`、`session.ts:56–61、102`。收到 received 后继续等待 applied；无 applied 不 markSuccess。 | 高 | S |
| syncSession complete/abort、持久连接协商、15 分钟空闲 | 已实现 | B/BluetoothSyncProtocol.kt:43–54、122；PB/PhoneBluetoothSyncManager.kt:377、387；`src/sync/session.ts:70–74` 协商后 15 分钟并验证结束 phase。 | 高 | S |
| IP v2、/sync WebSocket、hello HMAC、序号核对 | 已实现 | W/phoneconnection/ip/IpSyncProtocol.kt:159、175、204；P/connection/ip/WatchIpSyncServer.kt；`src/sync/ip-protocol.ts:5、40`、`ip-connection.ts:21–26`。依赖 host net.websocket 能力，本次未实测。 | 高 | S |
| RFCOMM 升级 IP、BLE 描述符、mDNS、LAN/热点/bridge 回退、冷却与重连 | 已实现 | W/phoneconnection/ip/WatchIpSyncManager.kt:187、293；W/phoneconnection/ip/IpSyncProtocol.kt:163–167；P/connection/ip/IpSyncProtocol.kt；`src/sync/ip-discovery.ts:5`、`application-host.ts:25–33`、`ip-controller.ts:34–99`，有 bonded-only、签名验证、3 候选优先级/10 秒冷却。mDNS 是发现手机服务，广告由手机负责，非手表缺项。 | 高 | S |
| guided Wi-Fi /pullRemoteInput、token action URL | 缺失 | W/phoneconnection/guided/WatchGuidedWifiClient.kt:98、114；`src/remote-input/http.ts` 是手表 HTTP 服务，`src/sync/ip-*` 是 WebSocket，均非此手机热点客户端；原生声波 debug 路径，非正式手机连接必需。 | 低 | L |
| DebugBluetoothSyncActivity：超时参数、payload 摘要、生命周期独占 | 缺失 | W/DebugBluetoothSyncActivity.kt:22、74、90、135；PodJS `src/sync/diagnostic-log.ts` 有日志但没有对应诊断 UI/启动参数工具。 | 低 | M |

**本区优先修正点：**实时预览 stream 的帧消费规则、probe 能力与实际 handler 对齐、传输进度声明与实现对齐。v13/v14 配对、双向替换、clear 确认、ACK 中断、BLE/mDNS/WebSocket 路由全部仍为真机 PENDING。

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
| Entry：原文卡片模式与 RSS 文本模式切换 | 部分实现 | W/ui/screen/bili/BiliEntryNavGraph.kt:50、89、138 读取频道 useOriginalContent（默认 true）切换两种屏；`src/ui/bili/index.tsx:62、72` 只有 RSS 样式列表，`ui/screen.tsx:427、432` 独立 KV 开关默认 false、仅保存值，未改变推荐/详情渲染。 | 高 | M |
| Entry：推荐追加、缓存先显、去重、长按/滑动快捷收藏 | 缺失 | BV/BiliFeedViewModel.kt:50、109、186、214；W/ui/screen/bili/BiliFeedScreen.kt:85–88、187；BR/BiliRepository.kt:148；`src/ui/bili/index.tsx:74、84` 只取一次 feed 并整体刷新，无追加/持久缓存/长按或侧滑动作。 | 高 | M |
| ChannelInfo：登录、搜索、稍后再看、历史、收藏夹、设置入口 | 已实现 | W/BiliChannelInfoActivity.kt:73–88；`src/ui/bili/index.tsx:89–92`，登录门槛及子页均接线；更新时间 PodJS 用“实时”代替原生状态时间，视觉/文案需回归。 | 中 | S |
| Login：二维码申请/刷新、扫码状态轮询、持久 cookie、退出取消 | 已实现 | W/BiliLoginActivity.kt:38–54；BV/BiliLoginViewModel.kt:33、79、118；`src/ui/bili/index.tsx:126–135`、`bili/client.ts:18–28`、`media-services.ts:26`。未验证实际扫码/回到来源页的栈体验。 | 高 | S |
| Search：输入关键词、热搜、视频结果点击 | 已实现 | W/BiliSearchActivity.kt:75、83；BV/BiliSearchViewModel.kt:81、105；`src/ui/bili/index.tsx:137–154`、`bili/client.ts:34–35`。 | 高 | S |
| Search：历史存储/清空、AV/BV 直达、连续结果分页 | 部分实现 | BV/BiliSearchViewModel.kt:95、105–141；BV/BiliSearchResultViewModel.kt:24；BR/BiliRepository.kt:549–566；`src/ui/bili/index.tsx:139、145` 总是关键词搜索，仅第一页；客户端接受 page 但 UI 未使用，也无历史 UI/存储。 | 高 | M |
| List：稍后再看列表、历史列表、收藏内容 | 已实现 | W/BiliListActivity.kt:50；BV/BiliListViewModel.kt:70；`src/ui/bili/index.tsx:100–123`、`bili/client.ts:53、60–61`。PodJS 额外提供收藏文件夹选择，原生 ViewModel 默认取首个文件夹，属于行为差异而非缺功能。 | 中 | S |
| List：历史 cursor 与收藏内容 loadMore | 部分实现 | BV/BiliListViewModel.kt:113、132、195；`src/ui/bili/index.tsx:101、121` 仅首请求，无 cursor/page 推进或加载更多。刷新按钮存在不能替代分页。 | 高 | M |
| Detail：标题/作者/简介、封面点击播放、分享 | 已实现 | W/BiliDetailActivity.kt:60、82、97–105；`src/ui/bili/index.tsx:157–166`、`sharing/policy.ts`；播放由 `ui/screen.tsx:403–413` 接管，不能把模块内备用 PlayerScreen 占位误判成整个播放器缺失。 | 高 | S |
| Detail：选分 P、恢复上次 cid、点赞/投币/取消收藏及互动状态 | 部分实现 | W/BiliDetailActivity.kt:109–112；BV/BiliDetailViewModel.kt:148、154、169、179、236、250；BR/BiliRepository.kt:179、220；`src/bili/client.ts:37、56–59` 有 relation/like/coin/favorite API，但 `ui/bili/index.tsx:160–164` 无相应 UI，播放仅 route cid 或第一 P；无本地互动状态合并。 | 高 | M |
| Detail：离线本地已保存信息兜底、预览视频热身 | 缺失 | BV/BiliDetailViewModel.kt:309、331、435；BR/BiliRepository.kt:426、606、634；`src/ui/bili/index.tsx:158` 必须网络 detail，仅图片缓存，未从本地 RSS saved row 构造详情/预览片段。 | 高 | L |
| CommentActivity：置顶/正文/头像、回复入口 | C11 代码/本地测试完成，设备待验 | `src/bili/comments.ts`、`src/ui/bili/CommentScreen.tsx`、`comment-layout.ts` 补全 next 分页、置顶去重、未截断正文、36dp 头像、20sp 表情、@ 蓝色、VIP/UP/置顶、时间/赞数、100dp 横向图片与前三条回复预览；rpid 导航到楼中楼，刷新/触底/失败原页重试。按原生 SDK 使用无排序参数/无 WBI 的 reply/main，匿名直读；jump_url 保留普通文本符合原生。当前详情原文模式已有评论按钮（此前审计“无入口”已过时）。本地测试不等于像素/物理验收。 | 低 | M |
| ReplyDetailActivity：根评论、楼中楼及分页 | C11 代码/本地测试完成，设备待验 | `src/bili/comments.ts`、`src/ui/bili/CommentScreen.tsx` 接 root + “所有回复”、pn/ps=20 追加，非空页继续至空页（同原生 ReplyPagingSource）；保留 root、刷新重置、失败原页重试、旧请求失效。原生 rootComment 未从 PagingSource 接入 ViewModel，本次按任务修复该链路；详情卡片不再递归导航。完整卡片与主评论共用；无回复保持原生空列表。设备截图/物理操作及系统字体缩放未验。 | 低 | M |
| VideoActions：远端收藏/稍后再看、分享/取消 | 已实现 | W/BiliVideoActionsActivity.kt:80、138、168；`src/ui/bili/index.tsx:177–187` 调用远端并提示；PodJS 用选收藏夹代替原生默认收藏夹，成功后停留与原生 finish 不同。 | 中 | S |
| VideoActions/Detail：远端成功后写本地收藏/稍后再看并缓存预览 | 缺失 | W/BiliVideoActionsActivity.kt:194–208；BV/BiliDetailViewModel.kt:257；BR/BiliRepository.kt:634；`src/ui/bili/index.tsx:179–180` 仅远端 mutation+message，无 `services` 本地 saved 写入；总收藏页 `ui/screen.tsx:194` 只合并 RSS 和抖音，B站远端新收藏不会自动出现于本地同步库。 | 高 | M |
| Settings：退出登录、删除频道确认、后台播放开关 | 部分实现 | W/BiliSettingsActivity.kt:82；BV/BiliSettingsViewModel.kt:43、66、75；BR/BiliRepository.kt:96 清互动/进度/播放源/预览；`src/ui/bili/index.tsx:192–200`、`ui/screen.tsx:433` 已接频道删除和后台播放，但 logout 仅 `clearSession()`，不清 playback-progress/WBI/预览。原文开关无渲染效果见前项。 | 中 | M |
| Player：MP4/DASH、cookie headers、播放暂停/快进/旋转/缩放/平移、音量/后台策略 | 已实现 | W/BiliPlayerActivity.kt:74、107；W/ui/screen/bili/BiliPlayerScreen.kt；`src/ui/screen.tsx:406–413`、`playback.ts:3`、`ui/VideoPlayerScreen.tsx:30–85` 有 host video 调用、双音视频轨及控件。真机解码、手势、表面合成未验。 | 高 | S |
| Player：播放错误刷新源/切候选、缓存播放源/预览回退 | 部分实现 | BV/BiliPlayerViewModel.kt:143、192；BR/BiliRepository.kt:369、777；`src/bili/client.ts:38` 有有限 WBI→legacy URL 解析回退，`VideoPlayerScreen.tsx:80` 重试只重新 prepare 同一 source，不重新解析/切 backup URL，`playback.ts` 只选首 durl 或最低带宽轨。 | 高 | M |
| Player：本地断点、结束清进度、远端历史 checkpoint | 已实现 | BV/BiliPlayerViewModel.kt:247–287、359、384；BR/BiliRepository.kt:252、321；`src/bili/playback.ts:12–23`、`ui/screen.tsx:410–413、484` 绑定 ready/tick/pause/error/ended。分 P 的入口恢复和后端失败组合仍待验证，不等于完整原生恢复导航。 | 高 | S |

## 5. 抖音（覆盖全部 8 个 Douyin Activity）

已核对 `DouyinEntry / ChannelInfo / Login / Detail / History / VideoActions / Settings / PlayerActivity`。`DV/` = `W/ui/viewmodel/`；`DR/` = `W/data/douyin/`。搜索、服务端点赞/关注不是当前原生 Repository 契约，不列为迁移缺失。

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| Entry：登录判定、推荐请求、cursor 加载更多、错误/刷新 | 已实现 | W/DouyinEntryActivity.kt:177、237；DV/DouyinFeedViewModel.kt:721、754；DR/DouyinRepository.kt:69；`src/ui/douyin/index.tsx:91、132`、`douyin/client.ts:24–35`、`douyin/signing.ts`，首屏与列表翻页已接服务。 | 高 | S |
| Entry：原文沉浸竖向流 / RSS 列表模式开关 | 部分实现 | W/DouyinEntryActivity.kt:189–237 根据 useOriginalContent 切换；`src/ui/douyin/index.tsx` 只有入口→文本列表→详情→播放器路径；`ui/screen.tsx:428、432` KV 开关不参与 feed/detail 分支，无法通过设置恢复原生沉浸入口。 | 高 | L |
| Entry：沉浸预加载播放器池、缓存引导、最近窗口/当前视频恢复、失效源刷新/跳过 | 缺失 | DV/DouyinFeedViewModel.kt:435、461、488、725、865、956；W/ui/screen/douyin/DouyinImmersiveScreen.kt:280；DR/DouyinFeedCacheStore.kt:29、DouyinRecentWindowStore.kt:43；`src/douyin/client.ts:20` 和 `ui/douyin/index.tsx:55` 仅内存窗口/URL TTL，没有持久窗口、媒体池和相应恢复流程。 | 高 | L |
| Entry：长按/侧滑视频操作、标题点击频道信息 | 缺失 | W/DouyinEntryActivity.kt:213、230、258、263、278；`src/ui/douyin/index.tsx` 列表只点击详情，操作按钮只在详情内；不能在流中直接收藏。 | 中 | M |
| ChannelInfo：专门说明/URL/更新状态页，登录、设置、历史入口 | 部分实现 | W/DouyinChannelInfoActivity.kt:56–88；W/ui/screen/douyin/DouyinChannelInfoScreen.kt；`src/ui/douyin/index.tsx:14–23` 无 channel-info route，登录/设置/历史被放在 Entry，缺独立信息与更新时间。原生 markReadEnabled=false，不将“全部已读”当缺口。 | 低 | S |
| Login：官方 WebView 登录、提取二维码、cookie 持久化 | 部分实现 | W/DouyinLoginActivity.kt:69–78；W/ui/screen/douyin/DouyinLoginScreen.kt:155、224、363、474；`src/ui/screen.tsx:416` 调用 browser authorize+QR script，`media/browser-auth.ts`、`media/douyin-login.ts` 存在；PodJS 页面需要用户点网页登录/完成，未在 src 复刻原生自动识别整页登录状态和原生 QR 覆盖流程。host 完整表现未审计/未实测。 | 高 | M |
| Login：Checking / 无网络 / 蓝牙网络禁用、WebView 不可用专页 | 部分实现 | W/DouyinLoginActivity.kt:33–69、91；`src/ui/douyin/index.tsx:114` 显示说明/Cookie 输入，主路由只 catch error，没有对应网络状态分支和禁用页。 | 中 | M |
| Login：二步验证识别及回落网页登录 | 部分实现（C10 核对） | 原生 W/ui/screen/douyin/DouyinLoginScreen.kt:231–281；现有 QR script 对 uc-second-verify/JPEG 返回 null，由 host 移除 QR overlay 回到交互网页，新增脚本执行测试。宿主 browser.authorize 只有最终 cookie，QR 接口只有 image/null，无二步状态事件/专用提示协议；未伪造二步 QR 覆盖与状态提示，真实挑战流程未验。 | 中 | M |
| Detail：作者/描述/封面/视频链接与播放 | 已实现 | W/DouyinDetailActivity.kt:49–89、214；`src/ui/douyin/index.tsx:144` 读取 detail、展示和进入 host player。原生此 Activity 收藏只是 remember 临时变量（:89），不是持久保存基准；持久行为以 VideoActions 为准。 | 高 | S |
| Detail：继承阅读器预设、字号、传入数据直接离线展示 | C10 代码/本地测试完成，设备待验 | `douyin/detail.ts` 优先传入 item、history、saved；`ui/douyin/index.tsx` 使用通用 ReaderBody；`routes/media.tsx` 传当前 readerPreset。播放解析与展示元数据分离。原生 W/DouyinDetailActivity.kt:44–103、196–231。 | 中 | M |
| History：200 条历史、1000 watched IDs、清空 | 已实现 | W/DouyinHistoryActivity.kt:49、72；DR/DouyinWatchHistoryStore.kt:29、70、146–147；`src/douyin/client.ts:36–40`、`ui/douyin/index.tsx:154` 已持久化、清空及显示。 | 中 | S |
| History：从历史构造播放队列、连续换视频记录历史 | C10 代码/本地测试完成，设备待验 | 历史 route 携带完整有序 playlist（最多 200），不混入 feed cursor；列表/历史点击在导航前 markWatched 等价写入；保留 C3 ready→queue.settled，按 awemeId 去重刷新时间/元数据。收藏入口按原生通用阅读器不写抖音观看历史。注意当前原生 W/DouyinHistoryActivity.kt:51–75 是 markWatched 后传元数据进 Detail，原审计“完整列表队列”证据不成立；历史队列是按 C10 明确任务实现的超集。 | 中 | M |
| VideoActions：收藏/稍后再看切换、分享和取消 | 已实现 | W/DouyinVideoActionsActivity.kt:102、118、134、157；`src/ui/douyin/index.tsx:162`、`douyin/saved.ts`、`sharing/policy.ts`、`ui/screen.tsx:194` 有本地状态及总收藏显示。无服务端互动符合原生。 | 高 | S |
| VideoActions：本地保存进入统一 RSS 库与手机同步 | 缺失 | W/DouyinVideoActionsActivity.kt:163 调用 rssRepository.syncExternalSavedItem；`src/douyin/saved.ts` 存独立 KV，`src/sync/local-manifest.ts:73–115` 只扫 SQL articles/article_saved_states；`ui/screen.tsx:194` 仅 UI 合并。抖音收藏虽能看见，但不会自然进入 syncLibrary/pullSavedItems，清库/替换语义也不统一。 | 高 | M |
| Settings：原文/后台开关、退出登录、频道删除确认 | 部分实现 | W/DouyinSettingsActivity.kt:52；DV/DouyinSettingsViewModel.kt:43、56、66、75；`src/ui/douyin/index.tsx:182`、`ui/screen.tsx:428–442` 已有控件/删除，后台策略接播放器；原文模式仅 KV，无频道刷新/渲染切换。 | 高 | M |
| Settings：退出清 WebView cookie、媒体缓存和最近窗口、回首页 | 部分实现 | DR/DouyinRepository.kt:35–48、141；DV/DouyinSettingsViewModel.kt:43；`src/douyin/client.ts:28` 仅 secure cookie+内存 feed，UI 清 WeakMap；未清 host browser session/媒体 bucket，停留设置页。 | 中 | M |
| Player：上下切视频、播放/暂停/重试/音量/缩放/旋转/后台开关 | 已实现 | W/DouyinPlayerActivity.kt:76–137；W/ui/screen/douyin/DouyinImmersiveScreen.kt；`src/ui/screen.tsx:418–425`、`douyin/playback-queue.ts`、`ui/VideoPlayerScreen.tsx:60–85` 接上下滑及实际媒体服务；物理滑动与播放表面待验。 | 高 | S |
| Player：网络遮罩、队列位置跨重启恢复、沉浸流长按操作 | C10 代码/本地测试完成，设备待验 | `ui/VideoPlayerScreen.tsx` 接实际网络观察、断网/蓝牙继续遮罩；播放中保留流，断网错误不自动剔除。`douyin.playback-queue.v1` 持久完整顺序/anchor，沉浸入口及列表继续播放消费。保留 C3 长按/侧滑与 settled；物理输入、重启与视频表面需真机验收。 | 中 | M |

## 6. 信息与支持（About / Info / Collaborators / ContactDeveloper / JoinGroup / Beian / LogUploadPrivacy / LogUpload / WebView）

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| 关于：项目自介、隐私、协议、开源许可、贡献者路由 | 已实现 | W/AboutActivity.kt:16–42；W/ui/screen/AboutScreen.kt:30；`src/ui/InformationScreens.tsx:128`、`ui/screen.tsx:500` 五入口均接线。 | 中 | S |
| 项目自介/开源清单正文与原生一致 | 已实现 | `../Android_WatchRSS/app/src/main/res/values/strings.xml:4、7`；W/AboutActivity.kt:18、39；`src/ui/information-data.ts:7、10` 与当前原生文本一致。这里是原生文本 parity，不是对 PodJS 实际依赖许可证清单的独立合规审计。 | 低 | S |
| Info：远端隐私/协议加载、失败重试、阅读器预设/背景/字号、备案尾链 | 已实现 | W/InfoActivity.kt:61–98、193；W/ui/screen/InfoScreen.kt:33、52、112；`src/ui/InformationScreens.tsx:110–124、147`、`InformationDocument.tsx`、`information-document.ts`，主路由提供 preset/fonts/background 和 legalBaseUrl。静态 fallback 文案存在不代表远端失败被静默替代。 | 中 | S |
| Info：Activity 重建时保留正文/加载状态/滚动 | 部分实现 | W/InfoActivity.kt:69–75 使用 rememberSaveable；`src/ui/InformationScreens.tsx:22–34` 有 snapshot/restore props，正式 `ui/screen.tsx:500` 未传 restoredState/onSnapshotChange；当前 route 保留可维持内存 UI，但不能凭组件恢复接口证明进程/宿主重建恢复。 | 中 | M |
| 合作者：姓名、角色、字母头像 | 已实现 | W/CollaboratorsActivity.kt:15；W/ui/screen/CollaboratorsScreen.kt:39、116–130；`src/ui/InformationScreens.tsx:129` 三人内容一致。阴影/字重/间距、原生 debug 圆形 mask 无完整复刻，视觉另列未验。 | 低 | S |
| 联系开发者：加群、日志说明入口 | 已实现 | W/ContactDeveloperActivity.kt:27；W/ui/screen/ContactDeveloperScreen.kt:41、86、101；`src/ui/InformationScreens.tsx:130`。当前 PodJS 按钮无原生 Groups/Upload 图标，导航语义已有。 | 中 | S |
| 加群：相同 URL/群号、二维码与无障碍说明 | 部分实现 | W/JoinGroupActivity.kt:15–18；W/ui/screen/JoinGroupScreen.kt:62、67（150dp QR+语义描述）；`src/ui/InformationScreens.tsx:154`、`information-data.ts:2–3` URL/群号一致，但使用 `SafeQrScreen.tsx:24` 固定布局并新增“链接”按钮，未接原生完整 accessibility 文案/尺寸/进场动画。 | 低 | S |
| 备案：标题/网址/QR、尺寸、文字测量、API 条件 blur 动画与 accessibility | 已实现 | W/BeianActivity.kt:11；W/ui/screen/BeianScreen.kt:22–49；W/ui/components/QrCodePanel.kt；`src/ui/BeianScreen.tsx:35–130`、`BeianText.tsx`、`BeianQrSurface.tsx` 存在对应实现和能力失败处理。只确认源码，不引用历史设备截图作为本次证据。 | 中 | S |
| 日志上传隐私说明及显式开始操作 | 部分实现 | W/LogUploadPrivacyActivity.kt:9；W/ui/screen/LogUploadPrivacyScreen.kt:84、102；`src/ui/information-data.ts:11` 文案一致，`InformationScreens.tsx:132` 有回调接口；正式 `ui/screen.tsx:500` 未传 onUploadLogs，按钮实际“上传日志（暂不可用）”。 | 中 | S |
| 日志读取、暂无/加载失败状态、WebView 自动提交加密日志、取件码 | 缺失 | W/LogUploadActivity.kt:42、66、85–117；`../Android_WatchRSS/app/src/main/assets/log_upload/assets/index-Bp_zl61y.js:59` 包含 window.logText、AES-GCM、上传成功取件码；PodJS `src/` 无 LogUpload route/日志源/上传客户端，不能由 `pullDebugLog` 代替此流程。 | 中 | L |
| WebView：应用内浏览、历史返回、缩放档位、主题、加载进度、销毁 | 部分实现 | W/WebViewActivity.kt:70–165、196–257；W/ui/screen/WebViewScreen.kt；`src/ui/screen.tsx:369` 仅 `browser.open(url)` 委托 host，src 无自有 WebView 状态/缩放/历史/阅读器主题协议。确认有打开网页能力，无法在只审 src 的范围内证明 host 内部与原生等价。 | 中 | L |
| WebView：联网前置检查、不可用提示、本地绝对路径转换 | 部分实现 | W/WebViewActivity.kt:320–351；`src/ui/screen.tsx:369` 只转 URL 和 catch 错误；未见区分本地路径、无网、WebView 不可用的前置策略。 | 中 | M |

## 7. Perf / debug 入口隔离

| 功能点 | 状态 | 当前源码证据及差异 | 用户影响 | 工作量 |
|---|---|---|---|---|
| 正式设置不暴露性能/种子测试入口 | 已实现 | W/SettingsActivity.kt:36 明确 showPerformanceTools=false；W/debug/PerfLargeListActivity.kt:21、PerfLargeArticleActivity.kt:23 拒绝非 DEBUG；PodJS `src/main.tsx:7–13`、`ui/screen.tsx:69`、`ui/SettingsScreen.tsx` 无 perf/test route，`pod.config.json:2` 指向正式 src/main。src 未检出 tests/runtime fixture 导入。仅源码入口隔离已确认，未审发布 APK。 | 中 | S |
| 原生超大列表/超大文章固定场景与指标 | 缺失 | W/debug/PerfEntryActivity.kt:12；W/debug/PerfDataFactory.kt:36、78；W/debug/PerformanceMonitor.kt:29、66；PodJS `src/` 无同等场景或 JankStats 汇总；仓库 tests/runtime-* 独立工程不等于正式 src 中有这些能力，本次未运行。 | 低 | M |
| 蓝牙/声波 debug Activity 的正式入口隔离 | 已实现 | W/DebugBluetoothSyncActivity.kt:24 检查 FLAG_DEBUGGABLE；W/DebugAcousticConnectionActivity.kt:11 检查 debug；`../Android_WatchRSS/app/src/main/AndroidManifest.xml:207–220` 采用占位 export，`../Android_WatchRSS/app/build.gradle.kts:65、71` 当前 debug/release 均为 false。PodJS `src/ui/screen.tsx` 无对应入口；诊断能力缺失已在协议区列出，不要求把它暴露到产品菜单。 | 低 | S |
| 抖音 debug alias/广播故障注入、cookie 导入、自动换片 | 缺失 | `../Android_WatchRSS/app/src/debug/AndroidManifest.xml:8、19` 限 debug source set；`../Android_WatchRSS/app/src/debug/java/com/lightningstudio/watchrss/debug/DouyinPlaybackDebugReceiver.kt:11`；PodJS `src/` 无等效入口。功能缺失同时意味着 src 未新增对应正式入口，不应把迁移这些工具排到核心用户路径前。 | 低 | M |
| DebugLogProvider / dump 与性能开关 | 部分实现 | W/debug/DebugLogProvider.kt:33；W/debug/PerformanceMonitor.kt:30、67 受 ENABLE_RUNTIME_PERF_MONITOR 控制；PodJS `src/sync/diagnostic-log.ts` 仅有限日志，不提供 provider/dump/perf 场景；pullDebugLog 是生产协议能力，应保留，不应因名称含 Debug 而整体禁用。 | 低 | M |
| 云同步/声波实验功能维持非正式入口 | 已实现 | W/WatchRssApplication.kt:100、W/AcousticConnectionActivity.kt:98；PodJS `src/main.tsx` 无 cloud 实例化、`ui/screen.tsx` 无声波 route。未来接线需明确构建/能力策略；不能仅因代码文件存在就判断已在产品启用。 | 低 | S |

## 8. 建议增量任务（按核心路径与影响排序，仅任务建议）

1. **同步协议收尾（M，高）**：先补 previewReader `stream=true` 独立帧循环及节流 ACK；对齐 probe 的阅读器/资源/媒体能力与实际 handler；修正字节进度声明和 16 KiB 语义。验收需手机连续拖动预览、资源 handoff、v13/v14、received→applied、中断重连；不要用普通单 action 成功替代流式验收。
2. **平台收藏统一入库（M，高）**：B站远端收藏/稍后再看成功后写入统一 saved 库；抖音 KV 保存状态迁入或适配 SQL 同步库，保留取消状态和时间。验收覆盖本地总列表、手机 pull/sync、双向 merge/replace/clear、重启后状态，避免只做 UI 合并。
3. **B站可连续使用的浏览路径（L，高，可拆分页与详情两步）**：补推荐/搜索/历史/收藏分页与缓存，接通原文/RSS 模式、分 P、点赞投币/取消收藏；再补播放失败重新解析和本地详情兜底。保留已有登录/播放器/断点链路，不重写已接通能力。
4. **抖音模式与连续播放恢复（L，高）**：让原文开关真正进入沉浸流，补最近窗口/当前视频恢复、预加载和换片历史记录、流中操作；同时补登录网络状态和退出清 WebView 会话/缓存。验收必须由用户完成实体手表滑动、切片、后台/前台、重启恢复。

日志上传完整流程和通用 WebView parity 放在以上核心链路之后；云同步、声波、Perf 工具遵守当前原生 debug 范围，不抢占正式路径优先级。以上均未实施。
