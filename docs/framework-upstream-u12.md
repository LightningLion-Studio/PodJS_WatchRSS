# U12：U1 剩余项源码复核与本批上移

本轮初始 app master `ba59997`、framework watchrss-migration `be9d439`、PocketJS `c5986b0`。两仓工作分支均为 `minor/u12`。状态只表示通用源码迁移，不代表设备验收。

依据是当前源码、git tree/show/log/merge-base，而非 U4–U11 文档的完成声明。`.codex-tmp/u12/audit-history.json` 保存25项提交/路径及应用历史；以下“已删除”含旧实现被薄封装替换，不等于必须删除兼容文件。

## U1 的25项（23拆分列出全部四个子项）

| 顺序 | 项目 | 初始状态 | 本轮后状态 | 框架提交与实际实现 | 应用旧实现删除与保留边界 |
| --- | --- | --- | --- | --- | --- |
| 1 | 原生纹理上传 | DONE | DONE | `468c0a4`；services.hasTextureFileUpload/uploadTextureFile；image loader 实际调用（`packages/framework/src/image.tsx`） | app `5879b7c` / `src/ui/RemoteImage.tsx`；RemoteImage 已无 NativeTextureFileHost/globalThis.pod 上传判断；wrapper 只保留 provider/namespace |
| 2 | 窗口索引/保留行 | DONE | DONE | `6131718`；windowed-rows.createWindowRows / windowed-list.visibleWindowRange（`packages/framework/src/windowed-rows.ts`） | app `1457e8f` / `src/ui/visible-range.ts`；旧 ui/windowed-rows.ts 已删除，visible-range.ts 转出；canonical 在 Pod facade，不重复放 Pocket |
| 3 | 文本环境/carets | DONE | DONE | `ec7fb12`；text-environment.createTextEnvironment / text-carets.updateCaretMap（`packages/framework/src/text-environment.ts`） | app `ba478af` / `src/ui/ReaderTextRow.tsx`；ReaderTextRow 无旧环境缓存实现，system-carets.ts 只转出；ReaderPreset/raster/highlight 策略保留 |
| 4 | 进度指示 | DONE | DONE | `affdb6f`；watch-ui.WatchProgressIndicator + watch-progress-animation（`packages/framework/src/watch-ui.ts`） | app `5879b7c` / `src/ui/WatchProgressIndicator.tsx`；WatchProgressIndicator 是默认颜色/中文 label wrapper；原动画已移出 |
| 5 | 返回动效 | DONE | DONE | `affdb6f`；navigation.BackMotion / back-motion.ts（`packages/framework/src/back-motion.ts`） | app `5879b7c` / `src/ui/back-motion.ts`；旧 ui/back-motion.ts 已删除；app screen.tsx / StartupGate.tsx 直接使用 framework BackMotion |
| 6 | UTF-8 chunk | DONE | DONE | `468c0a4`；bytes.decodeUtf8Chunk / nativeUtf8Decoder（`packages/framework/src/bytes.ts`） | app `5a35c0c` / `src/core/utf8-decode.ts`；core/utf8-decode.ts 去掉重复 native 分片；两种畸形输入 dialect fallback 是明确业务兼容 |
| 7 | ScrollEntries | DONE | DONE | `ec7fb12`；variable-list.VariableList + round-list（`packages/framework/src/variable-list.tsx`） | app `ba478af` / `src/ui/ScrollEntries.tsx`；ScrollEntries 无 viewport/gesture/window/slot 主实现；18/6/80/48、document 白名单和 trace 留 wrapper |
| 8 | RemoteImage | DONE | DONE | `468c0a4`；image.createImageLoader / RemoteImage（`packages/framework/src/image.tsx`） | app `5a35c0c` / `src/ui/RemoteImage.tsx`；RemoteImage 无 decode/上传/队列/LRU 主实现；headers/cache buckets/logger 文案留应用。API 结果 source dimensions 不编造 |
| 9 | SwipeCard | DONE | DONE | `229198b`；watch-ui.SwipeActionCard（`packages/framework/src/watch-ui.ts`） | app `82fb489` / `src/ui/SwipeCard.tsx`；SwipeCard 不再拥有 gesture/easing；164 reveal 和业务 actions/icons 保留 |
| 10 | DeleteConfirm | DONE | DONE | `229198b`；watch-ui.WatchConfirmDialog（`packages/framework/src/watch-ui.ts`） | app `82fb489` / `src/ui/DeleteConfirmDialog.tsx`；DeleteConfirmDialog 不再拥有模态布局/点击协调；22px measure、193宽与中文/icon 留应用 |
| 11 | 文本断行/标题 | DONE | DONE | `ec7fb12`；text-lines 两种 profile + text-layout exports（`packages/framework/src/text-lines.ts`） | app `ba478af` / `src/ui/text-layout.ts`；ui/text-layout、reader/measured-text、line-break 转出/薄标题参数；两种算法未合并，native fixtures 留应用 |
| 12 | Compose 缩放 | DONE | DONE | `ea152b1`；text-compat Compose 1.7.1 Float32 profile（`packages/framework/src/text-compat.ts`） | app `f63cea8` / `src/ui/compose-font-scale.ts`；compose-font-scale.ts 只转出；Apache 来源与 Float32 测试仍在 framework |
| 13 | 路由状态/栈编排 | PARTIAL | DONE | `a610095`；activity-state / route-state：a610095 + ec7fb12；U12 restorable-stack（`packages/framework/src/activity-state.ts`） | app `42bfeef` / `src/navigation/activity-state.ts`；U12 删除 activity-navigation 中 envelope/budget/valid-prefix/ID 防碰撞编排；argsFor/decodedRoute、home/debug/entity/checkpoint 策略留适配器 |
| 14 | ScrollRestoration | DONE | DONE | `a610095`；navigation.ScrollRestoration / validScrollSnapshot（`packages/framework/src/scroll-restoration.ts`） | app `42bfeef` / `src/navigation/scroll-restoration.ts`；navigation/scroll-restoration.ts 只转出；index anchor 语义不升级成 entity identity |
| 15 | 恢复模态输入 | DONE | DONE | `108187d`；restorable-input.useRestorableInput（`packages/framework/src/restorable-input.ts`） | app `7f532ee` / `src/ui/modal-input.ts`；modal-input 不再拥有 epoch/pending/dismiss/late result 主机制；route key/error 留 app，host 草稿仍单一来源 |
| 16 | startup trace/gate | DONE | DONE | `ea152b1`；startup.createStartupTrace / createFirstScreenGate（`packages/framework/src/startup.ts`） | app `f63cea8` / `src/core/startup-trace.ts`；startup-trace 去除 seen/origin/Promise gate；singleton、phase 和1500/3000ms业务参数保留 |
| 17 | Startup overlay | DONE | DONE | `15f8eb0`；startup-overlay.StartupOverlayTransition / startup.restoreIfOwned（`packages/framework/src/startup-overlay.tsx`） | app `a1d2c93` / `src/ui/StartupGate.tsx`；StartupGate 私有 overlay frame/mount/cleanup 已删除；协议/OOBE/readiness 和启动图留 app |
| 18 | 日志机制 | PARTIAL | DONE | `a610095`；logging.FileLogger/createLogRedactor：a610095；U12 log-file.createHostLogFile（`packages/framework/src/logging.ts`） | app `42bfeef` / `src/logs/app-logger.ts`；app-logger 不再拥有 redaction/serial/trim机制；U12 删除 logger-host 的分片 read/append/hash/commit。业务词表、5MiB、20%、启动扫描留 app |
| 19 | QR raster | DONE | DONE | `108187d`；qr.qrPixels / QRCode（`packages/framework/src/qr.ts`） | app `7f532ee` / `src/ui/QRCode.tsx`；QRCode/qr-pixels 去掉像素/纹理主实现；native UTF8/L/0-margin/invert/400 profile 和分享payload留 app |
| 20 | 圆屏 QR 布局 | DONE | DONE | `ea152b1`；watch-ui / round-layout.safeQrLayout, rectInsideCircle（`packages/framework/src/safe-qr-layout.ts`） | app `f63cea8` / `src/ui/safe-qr-layout.ts`；safe-qr-layout.ts 只转出；ShareQr 独立布局没有强行合并 |
| 21 | 大图 tiles/preview | DONE | DONE | `108187d`；tiled-image.TiledImage / image-tiles / image-preview（`packages/framework/src/tiled-image.tsx`） | app `7f532ee` / `src/ui/TiledImage.tsx`；TiledImage 是 cache provider/EXIF/RGB565/message wrapper；阈值只在 image-tiles policy，采样/halo/4decode/4delete 机制在框架 |
| 22 | ManagedCache | PARTIAL | DONE | `d48b5b5`；cache.FileCache：d48b5b5；U12 defaultCachePorts(options)（`packages/framework/src/cache.ts`） | app `60123df` / `src/cache/managed.ts`；managed.ts 仅 policy+facade，无 job/lease/scan 主实现；U12 host.ts 删除重复 digest/download/validate，8MiB+dimension1 留显式配置 |
| 23 | 队列/历史/自动滚动/草稿 | DONE | DONE | `108187d`；async.SerialWriteQueue；editing.TextHistory/DraftAutosave；navigation.AutoScrollController（`packages/framework/src/editing.ts`） | app `7f532ee` / `src/notes/draft-autosave.ts`；23a progress-write-queue 只转出；23b RawTextHistory 200/500 wrapper；23c autoscroll 只转出；23d NoteDraftAutosave 仅字段/换行/ID/600ms适配 |
| 24 | lazy regexp | DONE | DONE | `ec7fb12`；regexp.lazyRegExpTest / text-lines 复用（`packages/framework/src/regexp.ts`） | app `ba478af` / `src/core/lazy-regexp.ts`；core/lazy-regexp.ts 只转出；g/y lastIndex 语义保留，不声称设备冷启动收益 |
| 25 | SQL/stream framing | PARTIAL | DONE（U13） | `ec7fb12`；sql.querySqlPages/readSqlText；frame-stream.StreamFrameConnection（`packages/framework/src/frame-stream.ts`） | app `ba478af` / `src/sync/stream.ts`；sql-pages/sql-text/stream 已薄封装；U13 src/sync/protocol.ts 的 encodeFrame/Async、decodeFrame/Async、FrameDecoder 已改为 frame-stream.createFrameFacade 薄适配；JSON v14/UTF-8/error/signed prefix/EOF policy 留应用，通用 framing/reassembly 已移出 |

初始21 DONE / 4 PARTIAL；U12后24 DONE / 1 PARTIAL（#25）；U13后25 DONE / 0 PARTIAL。#23四个子项均源码DONE；没有把业务策略或框架底座存在算作未迁通用逻辑已完成。新增U12提交见文末。

## U1 第217行起既有能力表：逐行复核

| 行 | 状态 | 源码/git依据、删除和剩余 |
| --- | --- | --- |
| 1 services 上传 | DONE | `468c0a4` image.tsx 实际调用 hasTextureFileUpload/uploadTextureFile，app `5a35c0c` RemoteImage provider wrapper 无原生探测/handle 校验。 |
| 2 images.decode / fileChunks | DONE（应用重复桥接） | image.tsx/tiled-image.tsx 已归框架（468c0a4/108187d）；app 无这些 decode/read/delete renderer 主实现。U12 services 增 decodeOperation/decodeRegionOperation 与完整可选结果字段，cache host 重复调用也删除；框架资源所有者仍可通过 hostOperation 管理现有取消/队列，不强行替换其资源策略。 |
| 3 Pocket VirtualList | DONE | `ec7fb12` VariableList 实际复用 pocket createScroller/input/window primitives；app ScrollEntries 只注入变高默认/restoration/round策略。未机械套固定高 VirtualList。 |
| 4 bytes | DONE | `468c0a4` decodeUtf8Chunk + app 5a35c0c 快路径复用；严格与 permissive fallback 明确分离，fallback不迁为平台词汇API。 |
| 5 SystemTextLine / 低层 uploader | DONE（U13） | texture-upload.createTextureUploader 支持 RGBA/sample、可注入 ops/file/release，以及 take/unavailable 文件所有权策略。text/image/tiled-image 实际共享 primitive；像素不转换、sample=1 保留，GPU释放仍在原 call sites。各自读取、队列、LRU、文件清理与lease策略保持独立。 |
| 6 activityState / textInput / restoreActivity | DONE | a610095 Hub、ec7fb12 RouteStateProvider、108187d restorable-input，U12补stack codec编排；application.activityState 和 host pending/dismiss/prompt 仍为真实来源，无新增JS native草稿副本。 |
| 7 delay / clock.after | 不再适用（直接替换） | startup.ts 实际使用services.delay；clock.after 虚拟时钟和 wall-time fallback 不等价。没有复制第二套 timer 服务，既有引用保留。 |
| 8 animate/spring/kinetics | 不再适用（直接替换） | variable-list 已用createScroller；BackMotion/SwipeActionCard/startup frame 已在框架，拖拽提交、forceCommit和暂停是各状态机契约，不能用通用animate替换并宣称等价。 |
| 9 sync-framing | DONE（U13） | frame-stream.createFrameFacade 负责 signed/unsigned opaque framing/reassembly；error factories、push/finish poison 与成功 EOF 关闭均可配置。应用显式选择 signed、push poison、可恢复截断 EOF/非永久finish；已有 SyncFrameDecoder 的契约保持。冻结旧protocol差分覆盖全部分片边界及错误后的状态。 |

## 本批选择（按U1顺序13 → 18 → 22）

1. #13剩余stack编排（M）：createRestorableStack + createRouteMemoryAllocator。删除重复namespace/budget/prefix恢复；root、route codec、debug policy、entity lookup和durable checkpoint仍在app。独立pure入口避免navigation barrel提前加载Solid。
2. #18剩余host文件机制（M）：log-file.createHostLogFile。删除app UTF8分片、offset/size/progress校验和temporary/hash/commit算法；64KiB、logs目录、app_log.txt和中文错误显式传入。未触碰隐私词表或改变scan/trim/output。
3. #22剩余host ports（S）：defaultCachePorts参数化下载上限/可选image decode验证。应用仅传8MiB/dimension1；原hash、cancel、decoded path清理次序一致；不改namespace、eviction或producer lifecycle。同步补services图片operation类型，为真实host字段与取消提供公共入口。

没有再选L型图片资源策略统一或#25全部协议：已获较高收益的剩余S/M机制优先，后续项在表中明确PARTIAL。

## 测试、来源与限制

`tests/fixtures/upstream-u12/` 保存 ba59997 三个原始文件字节与SHA256；loader仅转译TS和相对import重定位。导航差分覆盖saved/retained、35组Unicode/预算、root/debug、坏版本/重复ID/坏route、process-loss envelope、恢复后ID、resolver顺序和microtask边界。日志差分比较64KiB边界UTF8/NUL、完整host调用、原子replace、commit失败和temporary cleanup。原activity-components、U6/U8及日志/缓存测试保留且不放宽断言。
framework新增非WatchRSS namespace/path/chunk配置契约；无注入端口的真实services event pump测试image字段/取消、cache digest/limit/decode/delete和log stat/read/hash/commit/delete。Android runtime按原完整单测执行。getting-started模块表与新API说明已补。
先CLI build，再应用全测/typecheck、framework bun run test/typecheck、Android单测；精确结果、日志和两仓提交写在 `.codex-tmp/wrss-minor-report.md`。没有设备/ADB/安装操作；视觉、内存、账号和实际进程重建仍PENDING。

## 本轮提交与验证

框架提交 `f9ce50df6bd95c5670871b0d6a738dc09f0d868b`（minor/u12），包含本轮 #13/#18/#22 和 typed image operation API。应用提交见交付报告；U12应用 framework.lock 曾锁定该 worktree/提交；lead在ed565f5已纠正path/branch回主checkout，U13继续保持主checkout值，PocketJS字段纠正为实际 `c5986b0fdf7d79d3d9346b4a1f02f7c466877852`（初始字段误填框架 SHA，未用它推定 Pocket 来源）。

CLI build PASS；应用1328 PASS/0 FAIL，应用typecheck PASS；框架Bun完整脚本与Rust PASS，框架typecheck PASS；Android runtime36 PASS/0 errors/failures/skipped。首次测试暴露 navigation barrel 提前加载 Solid 的双运行时，改用独立 pure restorable-stack 后，原17项恢复/组件差分、全测和新287断言差分均通过。未放宽测试。


## U13：最后两项收尾

基线 app `ed565f5`、framework `f9ce50d`、PocketJS `c5986b0`；两仓均在 `minor/u13` worktree 修改和提交。#25 与既有能力第5/9行已由当前源码闭合，U1共25项现为源码 DONE。此状态不代表设备像素、性能或进程重建验收。

`frame-stream.createFrameFacade` 不解释 body。四字节BE framing、整帧校验、增量拼装在框架；应用仅注入 JSON.stringify/parseWireJson、同步旧strict UTF-8/异步codec、2MiB、signed prefix、原错误工厂与EOF/poison策略。`sync-framing.SyncFrameDecoder` 现有unsigned/callback/永久finish契约未修改。CLI允许独立pure frame-stream用于headless，VM执行测试确认无需host/UI bootstrap，其他入口仍受限制。

`texture-upload.createTextureUploader` 原样传递RGBA/sample/PSM，sampled仅在nullish结果回退；负handle不重试。文件take在调用前执行，null可以注入返还策略，拒绝/throw不返还；release可注入，默认每次调用读取当前getOps。text保留consume-on-unavailable，image保留null返还，tiled保留sample=1。未迁移或统一读取/文件删除队列/LRU/取消/lease调度，原释放call sites与错误处理不变。

`tests/fixtures/upstream-u13/protocol.ts.txt` 是ed565f5原文件逐字节副本，SHA256固定；差分比较同步/异步字节与输出、numeric tokens、UTF-8/JSON错误、signed/超长/截断/尾随、byteOffset、每个两段切分、逐字节、多帧、push poison、截断EOF后续补齐与成功EOF后续push，另比较yield/cancel调用顺序。新增框架opaque/configuration、default/injected ownership/release、sampledfallback与headlessVM测试；原text/image/tiled组件验收测试保留。

按CLI build → 应用全测/typecheck、框架bun run test/typecheck、Android runtime单测执行；结果与两仓提交详见 `.codex-tmp/wrss-minor-report.md`。仅owned worktree安装依赖，Pocket/framework依赖经symlink核验。framework.lock.json 的path/branch保留主checkout值，只更新revision；PocketJS不改。无设备、ADB、安装、签名凭据读取、merge或push；设备验证PENDING。

U13框架提交 `531dcfd863bf67331aa78c35eaa6e7b5ca1d403d`。CLI build PASS；应用1332 PASS/0 FAIL（234 files）、两仓typecheck PASS；框架Bun 379 PASS、Rust 106 PASS（4 optional ignored）、完整脚本PASS；Android runtime36 PASS/0 failures/errors/skipped。首次框架isolated测试路径未被Bun匹配已补`./`；首次应用U7 mock缺新增uploadTextureFile导出，补调用即报错的占位后原断言和全测通过。首次日志保留；未放宽差分断言。
