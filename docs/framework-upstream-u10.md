# U10 — 第二轮清单 7–12

两仓 wt-c `c/upstream-9`，冻结 app `035f3bd` / framework `3b9b61d`。
六项均完成源码上移，无整项跳过。设备验收 PENDING。

## 边界

| 项 | 框架 | 应用保留 |
| --- | --- | --- |
| 7 | `build-gate.FailClosedGate`：默认关闭、异步一次解析、并发共享 promise、失败不重试 | `DebugGate` 的 literal `debugBuild===true`、拒绝文案、调用方 gating |
| 8 | `media-volume`：每步 Math.fround、分数积累、按 sample 的 guard、串行读写/readback、generation reset、显示计时 | 21% cap、600ms session、反向 .01/.06、1200ms hide、通知与媒体业务 ports |
| 9 | `async.waitForFlush/ExitFlushGuard`：结果 race、timer cancel、同目标 identity 合并、防旧完成清除新目标 | 2500ms、Back target、进度保存业务及 completed callback |
| 10 | `private-response.withOwnedPrivateFile/readDownloadedBytes/readDownloadedChunks`：验证后取得路径所有权、错误发布后清理、等待清理完成、迟到失败清理；两个独立读取 profile | 路径生成/tts regex、初始 remove、GET/POST规则、8MiB/64KiB、HTTP参数、错误文案、脱敏日志 |
| 11 | `preview-session.PreviewSession`：session/sequence、accepted vs published、尾合并、heartbeat、停止/订阅/expiry | ReaderPreset decode/delta policy、失败消耗 sequence、资源 transfer 判定与120s/20s/33ms、错误文案 |
| 12 | `text-match`：大小写匹配、UTF-16位置、measure geometry、源匹配跨行、ellipsis/fallback | snippet HTML清理、140/35上下文、候选顺序与“暂无摘要” |

框架无 WatchRSS preset、账号、RSS 数据模型或新增遥测。没有 UI 文件修改。
M1 telemetry/announcement、takeover、持久化/数据迁移完全未改。
新增5个 package export 均登记在框架 `docs/getting-started.md` 模块表；
既有 `async` 行更新。框架另有 API guide 与非 reader 参数测试。
没有新 JS 热点实测证据，因此没有 Rust 改动或加速承诺。

## 差分与默认路径

`tests/fixtures/upstream-u10` 是 `035f3bd:src/...` 七个完整文件的原始字节，
有 SHA256 清单。loader 只转译和重定向 imports，不替换函数或算法。
普通测试启三个 `bun --conditions=browser test` 独立进程，避免全套 host mock
污染；原有测试及断言保留。

- gate：init前/中关闭、promise identity、literal flag、同步/异步失败不重试。
- volume：4000步确定性Float轨迹；600ms两侧、session方向/guard、默认failed
  callback、批处理、state/write期间reset、fixed/external state、错误和hide顺序。
- exit：saved/failed/timed-out、同步flush/timer异常、timer rejection与同时完成、
  timer创建/取消顺序；同目标重复、不同identity并发及旧完成不清除新尝试。
- response：请求参数/status/logs/reads/清理顺序；media弱profile含0/fractional/
  NaN/foreign path/截断；TTS严格allocation/result path/size/offset/EOF/base64
  和初始/最终remove失败；迟到失败仍等owned cleanup，不删除返回的陌生路径。
  media弱profile的历史语义原样保留，不能把TTS严格校验强行加给它。
- preview：0/33/100ms；full/delta失败与重复序号、空delta、heartbeat、资源延时、
  新session替换/stop/dispose、timer/frames及listener reentry/throw原始顺序。
- highlights：Unicode大小写扩展、emoji/UTF-16、非重叠匹配、CRLF/缺失行/
  跨行/末行ellipsis；同时比较measure调用参数/顺序，snippet原逻辑不变。
- 默认生产路径：无ports参数的 `createTtsTransport()` 和 exported singleton，
  实际框架 services `file.createTemp/delete/http.download/read` 事件pump与
  host `encodeBase64`；`DebugGate.initialize(()=>application.buildInfo())` 真正
  host事件，release/debug/host错误关闭。不是只注入替身构造。

后台刷新经debug log buffer间接依赖build gate；框架CLI headless allowlist
仅新增纯build-gate入口，测试执行无host IIFE并继续拒绝所有其他U10模块/
services/UI与伪子入口。规定的主目录3b9b61d CLI已实跑，资源/bytecode阶段
完成但后台build拒绝新入口；修复位于wt-c，需lead合入框架后旧主CLI才支持。
不能据此把旧主CLI配新app称为构建通过，匹配wt-c CLI另行全构建。

新增框架测试使用非WatchRSS profile（50%/100ms/77ms、88ms退出、数值0 payload
预览）验证通用参数和ownership边界。构建/测试结果写入wrss-c-report。

## 设备交接（PENDING）

仅任务开始运行一次 `adb devices`（e3aca8af connected），未装包或操作设备；
没有userdata tar或数据写入。设备负责人按DEVICE_BRIEF执行正式upgrade，
before/after digest需equal=true，并先对比首页与s4-k8-home-after-cold.png的
尺寸/布局（density2，不一致停止）。

1. release debug入口拒绝与debug host入口可用；不修改真实日志/账号。
2. 冠轮音量弱小连续/快速反向/间隔600ms/cap单次通知/readback/reset/1200ms
   隐藏，用隔离包及可回滚系统音量，离开后恢复原音量。
3. Reader Back快速重复/存储失败/2500ms截止/不同目标；隔离fixture保存失败，
   不破坏正式阅读进度与SQL。
4. media/TTS请求成功、HTTP错误、分片与迟到错误；隔离HTTP fixture，确认
   private临时文件最终清理，不按会改真实B站/抖音账号的按钮。
5. preview 33ms尾合并、空delta/heartbeat、资源handoff120s与20s恢复、failed
   delta序号、不匹配session/stop/dispose；不保存测试preset到真实库。
6. RSS搜索中文/英文/emoji/跨行高亮和摘要140/35边界；像素判断提供ROI颜色、
   非RGB0数量与参照MAE。视觉/设备parity仍未验证。
