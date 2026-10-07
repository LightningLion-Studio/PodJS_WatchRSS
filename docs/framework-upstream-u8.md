# U8 — 第七批通用能力上移

两仓 `c/upstream-7`，基线 app `592c763` / framework `ae44bbc`。本轮完成
#3/#7/#11/#13/#24/#25 六组的通用实现及应用薄接线，保留原应用公开导出、
样式、事件次序、参数和错误文案。源码/离线完成不代表设备 parity。

## 实现与边界

| 组 | framework 入口 | 应用保留 |
| --- | --- | --- |
| #3 | text-environment.createTextEnvironment / text-carets.updateCaretMap | ReaderPreset、字体选择、raster options/高亮映射；每配置新环境 |
| #7 | variable-list.VariableList | padding18/gap6/overscan80/refresh48，document controller 白名单，trace 标签 |
| #11 | text-lines，text-layout 转出 | UI 与 unit-based 两种 profile 不合并；标题150/190、CJK normalize 显式选择及业务后缀 |
| #13 | navigation.RouteStateProvider/restoredSignal | ActivityRoute、routeMemory IDs、路由 codec/白名单、watchrss 命名空间和8192字符串上限 |
| #24 | regexp.lazyRegExpTest | app 转出；框架 text-wrap 和 line profiles 共用原语义 |
| #25 | sql.querySqlPages/readSqlText + frame-stream.StreamFrameConnection<T> | MAX_BODY_JSON_BYTES、原 SQL 错误消息、v14 编解码/strict JSON、SyncFrameConnection adapter |

纯 `text-lines` 与 `text-carets` 入口不会加载 host 服务。文本环境只缓存成功字体
查询；显式 invalidate 刷新 display/capability 并清空缓存，缺失字体每次重试。
应用原 `ReaderTextEnvironment` 结构仍兼容外部提供的三个属性。

VariableList 复用已有 windowed-list/kinetics/ScrollRestoration，不引入第二套
窗口或恢复算法。恢复 callback 在原调用点才取得内存，应用决定文档锚点排除。
通用组件默认 geometry0/0/60，app 显式传旧默认18/6/80/48；固定布局、刷新、
手势取消、D-pad、无障碍、settleKey、迟到 rows、slot 回收与清理次序保持。

SQL 保持查询文本与参数逐项相同。stream 的 codecs 注入保留 parseWireJson/
取消行为；框架不认识 action、session、WatchRSS 数据。新增通用 chunk/maxFrame
参数只验证合法配置，app 的旧常量有效且不变。没有新增 Rust 优化或性能结论。

背景刷新仍会导入 SQL/regexp。CLI 的 headless allowlist 因搬迁而需要显式
允许这两个纯模块；新增测试实跑无host的 IIFE，并继续拒绝 services/text/
variable-list 等入口。主目录 ae44bbc 的旧CLI还未含此变更，不能用旧CLI
搭配本app分支；本轮使用 wt-c 的匹配框架CLI构建成功。

#17 overlay 仍为部分；挂载、页面初始化和 onboarding 耦合，未扩大 UI 重构。
#22 ManagedCache 与 takeover/存储迁移未触碰。

## 冻结 oracle 与差分

`tests/fixtures/upstream-u8/` 冻结11个 `592c763:src/...` 原文件为 `.txt`，
`sha256.json` 和来源 README 固定完整原字节。测试 loader 仅转换 TS/Solid
并重定向模块路径，内部上移依赖使用冻结版本，其余依赖使用未改变的 app。
`upstream-u8.test.ts` 独立 browser 子进程执行两组差分，避免全套 mock 污染。

- 算法组：两种断行/省略、100个确定性随机 Unicode 样本、CJK/ASCII/URL/
  CRLF/空行/ZWJ/组合字符，标题 generator 每个测量请求与结果；regexp g/y/
  迟延异常；caret map 值、行身份和 unchanged map 引用。
- SQL：真实 SQLite 的 NUL/补充字符和32768-byte跨界，多种变更/缺失/非法/
  超限失败；分页重试和参数/SQL记录逐条相同。
- stream：分片读写、进度/关闭、deadline、EOF/零进度/超读/写失败；不注入
  clock 的生产取消路径。
- 组件组：ReaderTextRow 全树/几何、默认环境、cache hit/missing retry；saved/
  retained/功能setter/disabled；5类页面×自有/默认controller×fixed 的完整
  列表快照及事件序列、48px刷新、settle/accessibility/取消、checkpoint/slot
  回收；indexed immutable rows/height reflow 的 mount/release 完全相同。

既有 activity-components 测试仅扩展 loader 匹配新增 variable-list.tsx；
既有 progress harness 的 host mock 保留真实未覆盖导出。没有删除或放宽断言。
框架新增独立 API/production-host/default-construction tests；通用文档为
`docs/text-list-and-stream.md`。

## 离线验证与设备交接

最终命令/数量与提交见 `.codex-tmp/wrss-c-report.md`。两仓全测、typecheck、
style-props检查及指定CLI Android-watch构建均须完成后才交接。

本轮仅任务开始调用一次 `adb devices`（e3aca8af connected），未操作设备、
未安装APK、未生成userdata tar。设备 PENDING：由负责人按 device brief
独占执行；正式包使用 acceptance.py upgrade 并要求 before/after equal=true。
新包先截首页，对比 K8 参照的尺寸/布局；尺寸不一致立即停。

后续设备需要验证：频道/设置列表滚动、边缘刷新/长按/无障碍，返回/重建
恢复；reader/information/Bili/Douyin文档锚点不受普通列表恢复覆盖；字体/
阅读预设切换、标题/省略/高亮caret。图片/空白判定必须附非RGB0像素数、
ROI颜色分布及参照MAE。单测/构建不能代替手势、视觉、ANR或物理恢复证据。
