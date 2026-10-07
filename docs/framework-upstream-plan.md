# U1：WatchRSS 通用能力上移方案

审计日期：2026-10-06。状态：DONE（只读源码审计与迁移设计；未实施迁移）。

## 审计基线与结论

- 应用 `/home/wilf/data/OPPO_Develop/PodJS_WatchRSS`：当前 `master`，HEAD `b36e5be60b4562e8d9f656428297ab72467c209c`；检查时 `git diff --name-only -- src` 为空。这里的“最新”指本地当前 master，未 fetch，不声称远端最新。
- 框架 `/home/wilf/data/PodJS/podjs-watch`：HEAD `63ff13551d7c677d9cc7fae1f1806e95e1efeefc`；`vendor/pocketjs` HEAD `2ee82deab3c649af9b2eb9c7e3ad339e76fae73c`。检查时 framework/src 与子模块指针没有工作区差异。
- 已扫描 `src/` 文件清单，并深入读取下表候选、直接依赖、现有测试清单以及框架 exports/相关实现；这不是全部业务模块的逐行正确性审查。
- 明确可上移的核心：变高列表窗口、图片资源管理、通用手势/加载组件、文本测量辅助、生命周期状态协调、启动时序、日志脱敏机制。业务路由、阅读预设、平台协议、业务缓存淘汰策略留在应用。
- 框架已经具有部分底座。优先合并到既有能力，不能另造第二套服务桥、纹理上传或系统文本管线；也不能把“能力相近”当成直接替换的证据。
- 本轮只写本方案、进度和报告；不改源码、不安装、不操作设备、不提交。遵照 U1 的只读要求，未运行 LEAD_BRIEF 通用条款中的包构建（会写生成物）。测试及设备验证均未执行；下文是迁移时应执行的验收要求。

## 分层和 API 约定

真实包名为 `@podjs/framework`（`packages/framework`）与 `@pocketjs/framework`（`vendor/pocketjs/framework`）。以下标注“新增”的子路径都只是方案，尚不存在于 exports。

1. PocketJS 层放跨平台 UI 几何、窗口算法及渲染/输入基础能力；引擎改动才进入 `vendor/pocketjs/engine`，不要因函数通用就把它移到 Rust。
2. PodJS 层放手表组件、host 服务协调、生命周期、图片/文本适配。现有 `crates/podjs-runtime` 负责 Pod host 扩展，不把这类绑定盲目搬入 pocket 引擎。
3. 应用适配器传入文案、图标、主题、路由 codec、业务策略与存储命名空间；框架不得 import WatchRSS 文件或认识 `bili`、`douyin`、`articleId`。
4. 可注入依赖必须提供生产默认路径测试；默认参数不得自引用。先保持旧导出薄封装，逐调用点替换，行为对齐后再删旧实现。
5. S：纯算法/薄适配；M：组件、状态或异步所有权；L：多层资源、恢复或持久化。规模表示相对工作量，非日程承诺。顺序号对应建议推进次序，同阶段可单独提交。

## 推荐前 8 项

| 顺序 | 项目 | 交付边界 | 规模 |
| --- | --- | --- | --- |
| 1 | 原生纹理上传接口去重 | RemoteImage 改用已有 services helpers，保留 fallback 和文件所有权 | S |
| 2 | 变高窗口算法 | windowed-rows / visible-range 合并进 pocket virtual-list 模块 | S |
| 3 | 共享文本环境与 caret 稳定更新 | 在 Pod text 模块提供可失效的配置级环境 | S |
| 4 | WatchProgressIndicator | 通用组件与纯动画函数，颜色/标签可传入 | S |
| 5 | BackMotion | 无业务的返回手势状态机，保留阈值与释放动画 | S |
| 6 | UTF-8 分片快路径 | 统一 bytes 层入口，严格解码与历史宽松 fallback 分离 | M |
| 7 | 变高 ScrollEntries | 在现有 VirtualList 基础上补齐能力，注入恢复适配器 | M |
| 8 | RemoteImage 资源管线 | 可配置 provider、并发、纹理保留预算与生命周期 | L |

顺序 1 是 API 去重，不等于已完成第 8 项。第 7 项依赖第 2 项；第 8 项先借应用现有磁盘 cache provider，不等待第 22 项全盘缓存抽象。

## 逐项盘点

### 1. RemoteImage 原生上传探测与调用去重

- **来源/通用度**：`src/ui/RemoteImage.tsx` 的 `NativeTextureFileHost`、`nativeTextureFileHost` 和 upload 分支；直接通用。
- **目标/API**：直接复用已导出的 `@podjs/framework/services`：`hasTextureFileUpload()`、`uploadTextureFile(path,w,h,psm): number|null`；不新增同义 API。
- **耦合**：现有 host `pod.uploadTextureFile` 在 `crates/podjs-runtime/src/lib.rs` 注册；能力存在时 host 接管临时路径，失败也负责消耗文件。
- **风险/测试**：区分 `null`（不可用）与负值（拒绝），只有不可用才走字节 fallback；保留置空 outputPath 的时点，避免重复删除。迁移 `tests/image.isolated.ts` 对应快/慢路径断言，与 framework `tests/services.test.ts` 契约合测。S，顺序 1。

### 2. 窗口索引和保留行

- **来源/通用度**：`src/ui/windowed-rows.ts:createWindowRows`、`visible-range.ts:visibleEntryRange`；直接通用。
- **目标/API**：扩展现有 `@pocketjs/framework/virtual-list`：`createWindowRows<T extends {top:number;height:number;retain?:boolean}>(extraRows?)`、`visibleEntryRange(rows,offset,height)`。
- **耦合**：无 host、业务或 Solid 依赖；要求 rows 按位置有序，复用数组和 row 对象身份。来源数组更新会清空保留历史。
- **风险/测试**：渲染窗口包含边界，真实可见范围终边界排他，不能合成一个判定。保留 `tests/windowed-rows.test.ts`；补齐空列表、间隙、恰好边缘、来源替换、LRU 超额与结果引用稳定性。S，顺序 2。

### 3. ReaderTextRow 的共享环境与 system-carets

- **来源/通用度**：`src/ui/ReaderTextRow.tsx:createReaderTextEnvironment`、`src/reader/system-carets.ts:updateSystemCarets` 直接通用；`ReaderTextRow` 整体需业务适配。
- **目标/API**：扩展 `@podjs/framework/text`：`createTextEnvironment({revision?}?) -> {pixelScale,rasterSupported,fontMetrics(slot),invalidate()}`；`updateCaretMap<K>(previous,row,positions)` 保持未变化时引用。
- **耦合**：环境依赖 watch metrics/capabilities/font metrics。应用保留 `ReaderPreset`、`readerTextClass`、`requiresReaderSystemText`、`systemTextOptions` 的业务映射；继续调用现有 `SystemTextLine`。
- **风险/测试**：当前环境只缓存成功的 font 查询，缺失字体仍可异步加载；不能缓存“缺失”。字体槽替换、显示密度变更和 host 重建须失效，不做永久进程单例。迁移 `system-carets.*` 与 `reader-text-row.*` 中通用断言，应用保留阅读预设与高亮坐标回归。S，顺序 3。

### 4. WatchProgressIndicator

- **来源/通用度**：`src/ui/WatchProgressIndicator.tsx`、`watch-progress-animation.ts`；组件直接通用，默认橙色和中文 label 为应用配置。
- **目标/API**：新增 `@podjs/framework/watch-ui`：`WatchProgressIndicator({size,strokeWidth,color,trackColor,active,accessibilityLabel})`；纯 `progressArc(elapsed,strokeWidth)` 可在同模块测试。
- **耦合**：Solid、pocket View arc 属性、onFrame；现有引擎已有圆弧，无需移植新引擎实现。
- **风险/测试**：暂停时清 lastFrameAt，恢复不计后台时长；保留圆头、周期、轨道和无障碍 busy。迁移 `watch-progress-animation.test.ts`、`watch-progress-component.*`，截图验证由设备所有者执行。S，顺序 4。

### 5. back-motion

- **来源/通用度**：`src/ui/back-motion.ts:BackMotion`；直接通用。
- **目标/API**：新增 `@podjs/framework/navigation`：`BackMotion(width,{commitFraction?,velocityThreshold?,durationRange?}?)`，保留 begin/move/release/tick/reset 与 commit/cancel 输出。
- **耦合**：纯状态机；调用者提供时间、宽度与触发 pop 的回调，不搬入页面栈业务。
- **风险/测试**：维持 0.4 距离、0.12+500 速度、100–220ms cubic easing；指跟随、系统返回 forceCommit 与手势 cancel 不互换。迁移 `tests/back-motion.test.ts`。已有 animate 不提供此提交状态语义，不能机械改用。S，顺序 5。

### 6. K14 UTF-8 分片解码

- **来源/通用度**：`src/core/utf8-decode.ts`；快路径直接通用；`Utf8Dialect='douyin'|'bili'` 和畸形输入宽松行为仅为业务兼容。
- **目标/API**：`@podjs/framework/bytes` 增加 `decodeUtf8Chunk(bytes,start,{maxBytes?,fallback?}?) -> {text,next}`；严格完整解码继续用 `utf8ToString`。共享便携实现可放 `vendor/pocketjs/framework/src/bytes.ts`，由 Pod facade 暴露；原生绑定仍在 `crates/podjs-runtime`。
- **耦合**：16KiB native chunk，向后最多 3 字节避开有效序列边界，host 返回 null 才按旧算法解一个有界片段。应用用私有 fallback callback 保留 dialect，不向公共 API 塞平台名。
- **风险/测试**：现有 framework `utf8ToString` 遇 malformed 会 throw，应用两个 fallback 会产生历史结果且 next 可越过截断输入末尾；不能一刀切替换。保留 `tests/douyin/utf8-differential.test.ts` 枚举/随机/跨边界测试，新增真实默认 host、无 host、TypedArray subarray/NUL、4 字节边界测试。M，顺序 6。

### 7. ScrollEntries 变高列表组件

- **来源/通用度**：`src/ui/ScrollEntries.tsx`；需抽象掉恢复/页面策略。
- **目标/API**：在 `@pocketjs/framework/virtual-list` 增补 `VariableList({entries,height,gap,padding,overscan,retainRows,controller,inputActive,onRefresh,onSettledRange,...})`；Pod navigation 层提供 `restoration` adapter，由应用旧 `ScrollEntries` wrapper 注入。
- **耦合**：当前直接引用 routeActivity/routeMemory，并识别 reader/information/bili/douyin 来绕过普通 offset 恢复；这些页面名必须留应用。`ScrollRestoration` 可独立（第 14 项），窗口算法依赖第 2 项。
- **风险/测试**：现有固定高 VirtualList 默认 focusRows=true、overscan=60，应用 overscan=80 且触点直接 pressNode；差异必须显式保留。不能丢失 pull refresh 48px、fixed、longPress、manualScroll、settleKey、清理 stop、无障碍动作及文档锚点排除。保留窗口测试并从 activity/home/reader 组件用例抽取通用测试，补变高、连续更新、手势竞争。M，顺序 7。

### 8. RemoteImage 完整管线

- **来源/通用度**：`src/ui/RemoteImage.tsx`、`image-fit.ts`；需抽象掉业务 provider/日志/bucket。
- **目标/API**：新增 `@podjs/framework/image`：`createImageLoader({sourceProvider,logger?,maxConcurrent?,retainedBytes?,maxDimension?})`、`RemoteImage({loader,source,width,height,fit,onSize,onError})`、`loader.releaseRetained()/stats()/dispose()`；imageFitRect 可作为纯函数导出。
- **耦合**：`sourceProvider.acquire(source)->HostOperation<{path,release}>` 隔离 ManagedCache；source 可含 filePath/url/headers/cache namespace。应用保留 inline、bili-preview、授权 headers、日志标签与文案。
- **风险/测试**：当前 3 并发、POT≤512、8MiB 只约束释放后完成纹理；活跃纹理不在该预算内，`textureBytes` 按 maxDimension²×4 估算，不是实测 GPU 内存。迁移先保留估算语义，后续另测真实字节计费。key 必须含 headers、尺寸、namespace；检查最后一引用取消、迟到 decode 文件、错误重入、同 key revive、上传失败、idempotent release 与 host 重建。不能把 SystemTextLine 的零引用立即释放策略直接套上来。迁移 `tests/image.isolated.ts`，共享框架文件上传/文本资源测试模式；运行时内存、滚回、图片尺寸由设备代理验收。L，顺序 8。

### 9. SwipeCard

- **来源/通用度**：`src/ui/SwipeCard.tsx`；需抽象业务按钮。
- **目标/API**：`@podjs/framework/watch-ui` 新增 `SwipeActionCard({actions:[{id,label,icon,onPress}],revealWidth,open,onOpenChange,enabled,edgeSwipe,children,...})`。
- **耦合**：收藏/稍后再看、两个 icon 路径和 164px reveal 留应用 preset；通用层管理手势与开合动画。默认只允许一个打开的策略由父级控制。
- **风险/测试**：维持 x/y gesture 竞争、8px slop、半宽阈值、180ms easing、edge 转发与 focusable；包内不能引用应用 assets。需新增组件独立测试，保留 Bili/RSS 页面行为用例。M，顺序 9。

### 10. DeleteConfirmDialog

- **来源/通用度**：`src/ui/DeleteConfirmDialog.tsx`；需抽象业务图标、标签和 destructive 外观。
- **目标/API**：`@podjs/framework/watch-ui` 新增 `WatchConfirmDialog({width,height,title,message,confirm:{icon,label,color},cancel:{icon,label},busy,onConfirm,onCancel,measure})`。
- **耦合**：保留应用 `DeleteConfirmDialog` wrapper 配置删除图标/红色/中文；测量来自第 11 项。466 基准几何做兼容 preset，非所有屏幕强制默认。
- **风险/测试**：测量用 22 字号而文本 class/scale 另有转换，不能顺手“统一”而改变行数；busy 防连击、焦点与背景拦截必须保持。建立圆屏/不同消息长度组件快照，应用删除流程测试不迁出。M，顺序 10。

### 11. UI 文本断行、测量和标题格式

- **来源/通用度**：`src/ui/text-layout.ts`、`reader/line-break.ts`、`reader/measured-text.ts`；断行/省略直接通用，WatchTitle normalization/balance 需显式 profile 参数。
- **目标/API**：新增 `@podjs/framework/text-layout`：`wrapText(text,{width,measure,maxLines,profile})`、`ellipsizeLines(...,{firstIndent})`、`measureTitle(...,{firstWidth,otherWidth,normalize,protectedSuffix,minPrefixCharsBeforeSuffix})`；不依赖 reader/types，定义中性 LayoutOptions。
- **耦合**：应用现有两种断行算法并不相同，分别保留命名 profile；标题中的 CJK 空格删除、150/190 宽度和后缀保护属于显式策略。lazy regex 可复用第 24 项。
- **风险/测试**：不得将两个实现直接合并；保留 Unicode 标点、ZWJ/组合字符、URL、缩进、空行、ellipsis 和 native fixture。当前 graphemes 是局部处理，不宣称完整 Unicode segmentation。迁移 `ui-text-layout.test.ts`、`measured-text.test.ts` 的纯算法部分，native reader fixtures 留应用，并以差分确保旧输出。M，顺序 11。

### 12. Compose 字体缩放兼容

- **来源/通用度**：`src/ui/compose-font-scale.ts`；直接通用但限定 AndroidX 1.7.1 兼容语义。
- **目标/API**：新增 `@podjs/framework/text-compat`：`createComposeFontScale()` 与 composeSpToPx/composeDpToSp/composeLineHeightPx；命名或文档固定 profile 版本，不能当成所有平台 SP 默认值。
- **耦合**：无 host；保留 Apache-2.0 头、来源和许可归属。可接受应用传 density/fontScale，框架不在公式里读取全局配置。
- **风险/测试**：Float32 运算、1.04/1.05 key 共用、缓存插值顺序和 lineHeight 1.05 阈值均影响像素；不改成普通 double。迁移 `compose-font-scale.test.ts` 与 font-scale offline oracle，设备比对仍未验证。S，顺序 12。

### 13. route-activity 与状态协调

- **来源/通用度**：`ui/route-activity.tsx`、`navigation/activity-state.ts` 机制通用；`activity-navigation.ts` 的 route codec 需抽象；`resume-state.ts` 当前 resume 策略仅业务。
- **目标/API**：新增 `@podjs/framework/navigation`：`ActivityStateHub(publish)`、`RouteStateProvider({id,memory,changed,...})`、`restoredSignal(channel,key,initial,validate)`；可选 `createRestorableStack<Route>({namespace,encode,decode,resolve,isRoot,limits})`。
- **耦合**：已有 `application.activityState.read/write` 提供 saved/retained；框架只协调 namespace、有效前缀、ID 与限额。page 白名单、debug-tools gate、媒体身份、home 根、文章 resolver、watchrss key 留 app。M1/M2 的 WebView 草稿/输入选择范围已由 host 持有，不能又在 JS 拷贝一份。
- **风险/测试**：保留 saved 与 retained 的生命周期差异、namespace 合并、24 页/24KiB 等应用限额配置、递增 ID 防碰撞、失败前缀截断；不把 live handles/cookies 写入 saved。Hub 同步合并防止晚 ACK 覆盖本地状态，但不证明任意 publish 实现的落盘顺序，须测试默认 host 与重建。迁移 `activity-navigation.test.ts`、`activity-components.*` 通用部分；resume-state 与媒体恢复 oracle 留 app。L，顺序 13。

### 14. ScrollRestoration

- **来源/通用度**：`navigation/scroll-restoration.ts`；直接通用。
- **目标/API**：`@podjs/framework/navigation`：`ScrollRestoration(snapshot)`、`validScrollSnapshot`，保留 target/cancel/snapshot；可先单独上移供第 7 项调用。
- **耦合**：只需要有序 rows 的 top/height；应用决定哪个控制器接受恢复，不用框架识别页面名。
- **风险/测试**：当前 anchor 是行 index，不是实体 ID；列表重排不可宣称仍定位同一内容。保留 placeholder/异步加载、padding 归一、legacy absolute offset、用户输入接管和显式 scroll 取消。从 `activity-navigation.test.ts` 定位 ScrollRestoration 用例迁移，应用文档锚点用例保留。S，顺序 14（可作为 7 的准备提交）。

### 15. 恢复式模态输入

- **来源/通用度**：`ui/modal-input.ts`；需抽象 route context、key 前缀与 ModalInput 类型。
- **目标/API**：新增 `@podjs/framework/input-state`：`useRestorableTextInput({restorationKey,title,value,active,onValue,onError,port?})`，默认 port 用现有 services.textInput。
- **耦合**：应用负责稳定 route ID/key 和提交内容的业务写入；host 负责 pending/prompt/dismiss、草稿/selection。browser.open 中业务 origin/theme 选择仍留 app。
- **风险/测试**：恢复只能重新关联 continuation，不重放提交；epoch、unmount、inactive、重复 pending 与旧 host fallback 均需测试。迁移 activity component 中模态恢复断言，framework services 默认 port 要实构造。M，顺序 15。

### 16. startup-trace 与 first-screen gate

- **来源/通用度**：`core/startup-trace.ts`；需抽象 logger/实例生命周期。
- **目标/API**：新增 `@podjs/framework/startup`：`createStartupTrace({clock?,sink?}) -> {mark,step}`、`createFirstScreenGate({delay?}) -> {ready,wait(maxMs),dispose}`；app 留 phase 名称。
- **耦合**：现有 services.delay 为 host 定时器；当前模块 origin/seen/Promise 都是 bundle 单例。框架应允许按应用挂载实例，不能跨 guest 重建共享状态。
- **风险/测试**：firstScreen 在这里表示内容加载就绪，不是 GPU present，不可包装成首帧性能证据。Promise.race 当前 timeout 不取消；迁移引入取消需独立测试而非悄改。测试默认 host delay、超时拒绝、重复 ready、cleanup、step finally；不使用 QuickJS 零延迟 setTimeout 代替 host 延时。M，顺序 16。

### 17. StartupGate / startup-transition

- **来源/通用度**：`ui/startup-transition.ts` 直接通用；`StartupGate.tsx` 中 StartupTransition 可抽象，整套 onboarding gate 仅业务。
- **目标/API**：`@podjs/framework/startup`：`StartupOverlay({ready,exit,renderContent,renderOverlay,durationMs,scaleTo,onPhase})`、`startupExitFrame`。应用传启动图与 accessibility 文案。
- **耦合**：隐私版本、协议恢复文件、ReaderPresetStore、SettingsStore、遥测和 legalBaseUrl 全留 app。导航状态 ownership（仅撤销自己设置的状态）可由框架 helper 管。
- **风险/测试**：content factory 必须延后挂载，overlay 在内容 mount 后仍可存活；保持 300ms smoothstep / 1.08 默认 preset，不把 1500ms 业务 fallback 固化。迁移 `startup-transition.test.ts`，应用 `onboarding-*` 与 runtime-startup 留存。M，顺序 17。

### 18. app-logger 的脱敏和串行文件机制

- **来源/通用度**：`logs/app-logger.ts`；需分离机制/词表/协议。
- **目标/API**：新增 `@podjs/framework/logging`：`createRedactor({sensitiveKeys,sensitiveHeaders,redactUrlQuery})`、`createFileLogger({file,clock?,output?,redact,maxBytes,trimPolicy})`。
- **耦合**：Bearer/cookie/URL 用户信息和 query 的基础处理通用；bili/douyin cookie、watchrss pairing header、sign 等业务词表由 app 扩展。`debugLogReply`、APP_LOG_FILE、5MiB 与 trim 20% policy、单例安装及固定日志文案留适配器。
- **风险/测试**：抽出前先用原规则整体 golden 对照，不能因业务词表移走漏脱敏；output 也只能得到已脱敏文本。warn/error 丢弃额外参数是现有隐私语义，要保留。串行顺序、旧文件扫描、写失败不影响业务、严格大于上限才 trim 均测试。迁移 `tests/logs/app-logger.test.ts` 通用部分，native log inventory 和上传测试留 app。M，顺序 18。

### 19. QR 纹理渲染

- **来源/通用度**：`ui/QRCode.tsx`、`qr-pixels.ts`；需抽象 nativeWatch profile。
- **目标/API**：新增可选 `@podjs/framework/qr`：`qrPixels(value,{dimension,errorCorrection,marginModules,inverted,rasterProfile})`、`QRCode({value,size,pixelSize,options,onError})`。qrcode-generator 作为该入口依赖，不进入主入口 eager bundle。
- **耦合**：当前 nativeWatch 同时切换 UTF-8 编码、L 纠错、0 margin、bitmap=400 边界映射和反色；必须拆成显式兼容配置，由应用传入。现有普通路径 margin=1 也不能擅改后宣称零变化。
- **风险/测试**：≤512、POT 补边/clip、payload 容量、UTF-8、quiet zone、失败后纹理清理；不以截图好看代替扫码可用。迁移 `qr-pixels.test.ts`，保留 system-share 的 RGBA fixtures 与后续设备扫码验收。M，顺序 19。

### 20. 圆屏 QR 布局

- **来源/通用度**：`ui/safe-qr-layout.ts`；rectInsideCircle 直接通用；safeQrLayout 是可复用 preset。
- **目标/API**：`@podjs/framework/watch-ui`：`rectInsideCircle(rect,circle,margin)`、`safeQrLayout(width,height,{preset?})`；通用圆内几何可落 pocket display 辅助模块，二维码屏幕结构留 Pod。
- **耦合**：233 基准下 title/qr/status/action 固定布局，无业务数据；ShareQr 的不同布局不要强制合并。
- **风险/测试**：四角都在圆内、非方形 viewport、边界 margin 与比例缩放；迁移 `safe-qr-layout.test.ts`，保留 `share-qr-layout.test.ts` 为独立兼容用例。S，顺序 20。

### 21. 大图分块与缩放几何

- **来源/通用度**：`ui/TiledImage.tsx`、`image-tiles.ts`、`image-preview.ts`；几何直接通用，资源组件需 provider 抽象。
- **目标/API**：`@podjs/framework/image` 新增 `TiledImage({sourceProvider,geometry,state,decodeOptions,onSize,onError,...})`、`visibleImageTiles`、`zoom/pinch/clamp` 函数。
- **耦合**：managedCache、image.decodeRegion、readDecodedRgba、采样上传、__onHostEvent 删除队列；新公共 API 应隐藏私有事件监听。大图阈值、applyExif:false/rgb565:true 是现有兼容策略，应配置化。
- **风险/测试**：4 个 decode、4 个 delete 并发、busy 重试、source lease 延后释放、1px halo、510px 内容边与线性采样不可丢。不能把纹理文件直传套到 sampled 路径而丢线性采样。先统一图像资源所有权再抽底层 uploader，不强求同一缓存策略。迁移 `image-tiles.test.ts`、`image-preview.test.ts`；大图/EXIF/边缝设备用例留验收。L，顺序 21，依赖 8。

### 22. ManagedCache

- **来源/通用度**：`cache/managed.ts`、`host.ts` 的下载去重/lease/串行维护；需抽象。`cache/policy.ts` 的 bucket 顺序、离线不淘汰、抖音 6→4 reserve 与内联图 128MiB 是业务。
- **目标/API**：新增 `@podjs/framework/cache`：`createFileCache({root,buckets,ports,key,validate,evictionPolicy,limits})`，acquire/registerProducer/configure/maintain/stats；策略 callback 传已计费文件和 pinned set。
- **耦合**：当前文件名 regex、允许目录深度、清理 staged 文件和 clearBucket 类型也绑定业务，须作为 namespace policy 一并剥离，不只改 bucket 字符串类型。
- **风险/测试**：未 release 的 path 不可被维护删除；同 URL 不同 headers 分 key；clear 与正在下载、hash 后取消、原子写临时文件、路径约束全部保留。迁移 `managed-cache.test.ts` 通用部分，native eviction fixture 留 app。L，顺序 22。

### 23. 写入队列、编辑历史、自动滚动与草稿保存

| 来源 | 通用程度与目标/API 草案 | 耦合、风险与测试 | 规模/顺序 |
| --- | --- | --- | --- |
| `reader/progress-write-queue.ts` | 直接通用；新增 `@podjs/framework/async` 的 `SerialWriteQueue.enqueue/flush` | flush 返回当前 tail，不代表未来写入；前项失败不堵后项，但当前调用者必须收到拒绝。抽取 reader-progress-flush 测试；阅读退出时点留 app | S / 23a |
| `notes/raw-text-history.ts` | 直接通用；新增 `@podjs/framework/editing` 的 `TextHistory(initial,{clock,capacity,groupDelayMs})` | 保持 200 步、500ms 分组 preset、相邻编辑合并、redo 清空；字符串快照容量不是字节预算。迁移 note-raw-text-history.test.ts，必须默认构造测试 | S / 23b |
| `reader/autoscroll.ts` | 直接通用；Pod navigation/scroll 子模块 `AutoScrollController(speed,sink)` | 非有限输入、bounds 到尾暂停、后台保留 requested 语义；不与惯性 scroller.step 产生双重写入。迁移 reader/auto-scroll.test.ts | S / 23c |
| `notes/draft-autosave.ts` | 需抽象；editing `createAutosave<T>({initial,save,equal,isEmpty,clock,delayMs,onState})` | title/markdown/noteId 和换行标准化留 app；保存响应规范化可能影响 flush 收敛，慢写不能覆盖新编辑，dispose 当前仅清 dueAt。迁移 note-draft-autosave.test.ts 机制测试 | M / 23d |

### 24. lazy-regexp

- **来源/通用度**：`core/lazy-regexp.ts`；直接通用。
- **目标/API**：先作为 text-layout 内部共享工具（无需为了 1 个函数新增根公共入口），`lazyRegExpTest(source,flags)`；只有出现其他消费者再公开。
- **耦合/风险**：这是延迟构造优化，不是引擎级 regex 改造；g/y flag 会持有 lastIndex，不能把当前语义误写成无状态 predicate。保留原 Unicode pattern 与首次/后续调用测试，冷启动收益需要运行时重新测量。S，顺序 24（可并入 11）。

### 25. 有界 SQL 读取与流 framing

- **来源/通用度**：`sync/sql-pages.ts`、`sql-text.ts`、`stream.ts` 的机制需抽象。
- **目标/API**：可新增 `@podjs/framework/sql` 的 `queryPages(query,params,{pageSize,isTooLarge})`、`readText(select,params,{maxBytes,chunkBytes})`；扩展既有 `@podjs/framework/sync-framing` 的 `FramedByteStream({stream,codec,maxFrameBytes,clock,chunkBytes})`。
- **耦合**：应用 `SqlDatabase`、MAX_BODY_JSON_BYTES、JSON protocol/TransferByteProgress 改为 ports/参数；业务 snapshot revision 检查留调用者。不是上移整套 WatchRSS sync。
- **风险/测试**：分页要求稳定 ORDER BY/一致快照；SQL TEXT 分块必须保留 NUL 和 UTF-8 边界；行数缩小仍不保证单行可读。stream 要保留整个 frame 的 deadline、单读/单写、零进展失败与 close。迁移 sync/sql-pages.test.ts、sql-text.test.ts 和 framing 的通用测试。M / 顺序 25，低于 UI/资源热点。

## 框架已具备、应用应复用的能力

| 框架现有证据 | 应用现状 | 决策与差异 |
| --- | --- | --- |
| `packages/framework/src/services.ts:hasTextureFileUpload/uploadTextureFile` | RemoteImage 自读 globalThis.pod 并复制整数 handle 校验 | 直接复用，优先 1；文件消耗约定不可变 |
| 同文件 `images.decode`、`fileChunks.read/remove` | RemoteImage/缓存适配器用 hostOperation 拼相同操作 | read/remove 可减少重复；decode 现封装仅 Promise 且类型没有 sourceWidth/sourceHeight，先补 cancelable operation/完整返回类型再替换，不能丢取消 |
| `vendor/pocketjs/framework/src/virtual-list.ts:VirtualList` | ScrollEntries 复制 viewport/canvas/scroller/gesture 基础 | 变高/retained/refresh/settled/恢复仍缺；扩展现有模块，禁止直接套固定高列表 |
| `packages/framework/src/bytes.ts` → pocket bytes | app core/utf8-decode 自带分片与两种 permissive decoder | 抽共同 native 快路径；现有 strict utf8ToString 并非兼容替换 |
| `packages/framework/src/text.tsx:SystemTextLine/bindSystemTextLine` | ReaderTextRow 已使用；RemoteImage/TiledImage 有类似 decode/read/upload/cleanup | ReaderTextRow 并未重做系统 raster，不整块搬迁；低层 uploader 可后续共用，但文本/图片释放和缓存策略不同 |
| `services.ts:application.activityState`、`textInput.pending/dismiss/prompt`、browser.open 的 restoreActivity | app route-activity/ActivityStateHub/modal-input 做 JS owner 协调 | 已使用底座，缺的是可复用协调器；保留 host M1/M2 单一事实源，不再实现 native 草稿持久化 |
| `services.ts:delay` 与 pocket `clock.after` | startup-trace 已用 delay；组件多用 Date.now + onFrame | 不属于重复定时服务；clock.after 是虚拟时钟，不能代替启动 wall-time fallback |
| `pocket animation.ts:animate/spring`、kinetics createScroller | SwipeCard/BackMotion/startupExitFrame 自算 easing | 只重用适用的动画底座；forceCommit/拖拽阈值/暂停规则仍需组件状态机，不宣称自动等价 |
| `packages/framework/src/sync-framing.ts` 的 encodeSyncFrame/SyncFrameDecoder | stream/protocol 路径也做帧头长度处理 | 已有 opaque framing；先核对 app 上限、JSON codec、deadline、进度语义，公共扩展避免双 framing，非本轮直接替换 |

## 留在 WatchRSS 的内容

- 业务核心：RSS parser/去重 identity/数据库 schema 与迁移、云端/手机同步消息、支付账号、平台 API/登录签名/收藏/稍后再看、预设模型、遥测事件与法律内容。
- `StartupGate` 的启动去向/OOBE/协议同意版本、`activity-navigation` 的路由参数验证与 `resume-state` 的 native 可恢复页面白名单。
- `ReaderTextRow` 的样式→ReaderPreset/font slot 映射、reader 文档模型/阅读进度业务、平台详情排版策略；可用框架通用文本组件组装。
- `SwipeCard` 的业务 actions、DeleteConfirm 的删除含义、QR 分享/备案 payload 及 fixed native profile 配置、RemoteImage 的平台 cache bucket。
- `cache/prefetch.ts` 从 ContentBlock 选图、cacheEvictionOrder 的平台保留数、feed-window 的 Article 查询限制与阅读分页策略。
- `browser/open.ts` 的 origin 路由规则和 reader theme 映射；日志上传加密协议/密钥/固定 native inventory。通用 HTTP/传输底座的可提取性不意味着业务服务应进 framework。

## 迁移验收和提交边界

每项先框架增加中性 API+测试，再应用 wrapper 接入；框架变更由 lead 审核提交，涉及 pocket 的变更单独列子模块提交。独立入口避免 qrcode-generator、Unicode regex 和组件资源拖慢默认启动。组件迁移必须核对 CLI 对包内样式和图标的采集：现有 pocket VirtualList 故意无 class strings，不能假设应用 class 扫描自动覆盖新包。

测试分两份：纯通用契约移框架，WatchRSS native fixture、业务调用顺序和 UI 组合留 app；删除重复测试前先确认新的包入口实际被测试。Solid `*.isolated.ts` 使用 `bun --conditions=browser test ./tests/<name>.isolated.ts`，不得只运行包装测试或全注入 mock。每个可注入 clock/transport/store 的实现至少一个不注入的默认构造测试。

实施阶段执行受影响测试、两仓规定的 test/typecheck，以及：

```sh
bun /home/wilf/data/PodJS/podjs-watch/packages/cli/src/cli.ts build --target=android-watch --project=<实际实施工作树>
```

本轮不运行上述构建。实施后由 lead 按设备独占规则安排验证，不由 wrss-impl 操作设备：新包先将首页与 `.codex-tmp/device/shots/s4-k8-home-after-cold.png` 比尺寸；再测变高列表滚入滚出/刷新/返回/恢复，图片取消/滚回/大图边缝，文字/字体切换/高亮坐标，扫码、模态输入和进程重建。正式包升级遵守既有 acceptance upgrade 与数据完整性要求。源代码测试/打包通过不能代替视觉、内存或进程恢复证据。

## 本轮核验记录

已执行只读命令：读取 LEAD_BRIEF/U1；`rg --files src tests`；候选与框架 exports/源码的 cat/sed/rg；两仓和 pocket `git rev-parse HEAD`；app `git branch --show-current`；受审计源码范围 `git diff --name-only`。未执行 git 变更操作、fetch、ADB、安装、构建、测试或设备性能测量。文档内 API 草案、规模、顺序为审计建议，并非已实现事实。

## U5 completion update (2026-10-07)

On app baseline `4895139` / framework `9f09ca5`, branch `impl/upstream-4`:

- #9 DONE at source/host level: `watch-ui.SwipeActionCard`; WatchRSS keeps its
  two business actions, asset paths, labels and 164-unit reveal in a wrapper.
- #10 DONE at source/host level: `watch-ui.WatchConfirmDialog`; WatchRSS keeps
  deletion labels/icons/colors and the exact measuredLines/22px measurement.
- #17 PARTIAL: pure startup exit frame preset moved into `startup`; overlay
  lifecycle, mounting and onboarding remain application-owned and unmoved.
- Navigation/activity, douyin, secure store and notes reading paths untouched.

See `framework-upstream-u5.md` for verification and frozen oracle provenance.
Device parity remains PENDING; no device operation was performed.


## U6 状态复核（2026-10-07，app 2e84513 / framework 58ab3c4）

状态仅表示源码上移，设备验收仍 PENDING。本表取代 U1 草案与 U4 基线状态；
“部分”明确区分通用机制与仍在应用的组合层，不把 host 能力存在算作组件迁完。

| 组 | 状态 | 当前证据 / 剩余边界 |
| --- | --- | --- |
| 1 上传探测 | 已完成 | framework services/image；应用 RemoteImage provider |
| 2 窗口索引 | 已完成 | windowed-list/windowed-rows；app visible-range 转出 |
| 3 文本环境/carets | 未开始 | ReaderTextRow/system-carets 仍应用；SystemTextLine 已有但不是此项 |
| 4 进度指示 | 已完成 | watch-ui WatchProgressIndicator |
| 5 返回动效 | 已完成 | navigation BackMotion |
| 6 UTF-8 | 已完成 | bytes decodeUtf8Chunk；应用保留协议方言 |
| 7 ScrollEntries | 部分 | windowed-list 通用索引与 K15 切片；手势/刷新/恢复接线仍应用 |
| 8 RemoteImage | 已完成 | framework image 管线，应用 cache provider |
| 9 SwipeCard | 已完成 | U5 SwipeActionCard，业务动作留应用 |
| 10 确认框 | 已完成 | U5 WatchConfirmDialog，删除含义留应用 |
| 11 文字排版 | 部分 | text-layout/text-wrap 调度与 atlas wrap；ui/text-layout、line-break 等仍应用 |
| 12 Compose 缩放 | 已完成 | U4 text-compat |
| 13 Activity 协调 | 部分 | M1/M2 application.activityState 底座已有；U6 navigation.ActivityStateHub 已上移；route-activity 仍应用；路由白名单不迁移（业务专属） |
| 14 滚动恢复 | 已完成 | U6 framework navigation.ScrollRestoration，app 转出 |
| 15 恢复式输入 | 未开始 | modal-input 的 owner/epoch 协调仍应用；host pending/dismiss 已有 |
| 16 启动 trace/gate | 已完成 | U4 startup；应用标签与阶段保留 |
| 17 启动过渡 | 部分 | U5 startupExitFrame；overlay 生命周期未迁；onboarding 不迁移（业务专属） |
| 18 日志机制 | 已完成 | U6 logging 脱敏与 FIFO/trim；logs/app-logger 保留业务参数；上传加密协议不迁移（业务专属） |
| 19 QR raster | 未开始 | QRCode/qr-pixels 仍应用 |
| 20 圆屏布局 | 已完成 | U4 safeQrLayout/rectInsideCircle |
| 21 大图分块 | 未开始 | TiledImage/image-tiles/image-preview 仍应用 |
| 22 ManagedCache | 未开始 | managed.ts 仍应用；policy 淘汰桶规则不迁移（业务专属） |
| 23 编辑辅助 | 未开始 | SerialWriteQueue/TextHistory/AutoScrollController/DraftAutosave 四项仍应用 |
| 24 lazy regexp | 部分 | text-wrap 私有 helper；应用 helper 仍服务未迁算法 |
| 25 SQL/framing | 部分 | sync-framing/bytes 底座；sql-pages/sql-text/stream 编排仍应用 |

后续轮次复核：K15 的切片布局、索引/retained window 在 framework text-layout、
windowed-list；RS1/RS2 的通用 HTML parser 与 async slice 在 html/html-slices，
reader/content 仅映射业务块。K21 的 XML 在 xml、KV 原生批处理在 runtime；
K22 的 JSON projection/切片与 UTF-8 在 json/bytes；K23 的 KV checkpoint 微任务
合批在 framework watch 与 runtime kv，ActivityStateHub 只调用通用 trace，
Douyin restore/setPage 业务仍应用。RS3 的首屏源字符预算/延后调度在 text-layout，
notes header 参数、内容模型和测量组合仍应用。这些轮次不等价于迁完 #3/#7/#11/#13/#25。
