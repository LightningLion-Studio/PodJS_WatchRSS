# U9 — 第二轮通用能力收尾

两仓wt-c `c/upstream-8`，基线app `d1d4515` / framework `25beb14`。
完成旧#17与第二轮五个新漏项（清单前六行）；源码/离线完成，设备PENDING。
排序、全模块覆盖和后续
候选见 `framework-upstream-plan.md` 的“U9 第二轮清单”。

## 实现

- `startup-overlay.StartupOverlayTransition`：内容ready和overlay exit独立，
  保留frame时钟、elapsed reset、开始/完成callback和Solid owner清理。独立
  JSX入口避免启动trace/gate纯模块引入UI。`startup.restoreIfOwned`保留新的
  导航发布者；app只传原导航字段/恢复callback。launch图片、样式、300ms
  preset和onboarding均留原app。没有改变挂载gate与afterFirstScreen 1500ms。
- `http-request.readHttpRequest`：原单请求HTTP/1.0/1.1 parser以相同读法上移；
  app传原limits，保留所有routing/export/write。不是新的全功能HTTP服务器。
- `json-numbers`：原JSON lexical numeric metadata上移为独立纯入口，保持弱
  引用、重复key清理、native整数/浮点区别；app errors和层数明确传入。
- `text-anchor`：原UTF-16 source/fraction锚点，app薄函数保留TextAnchor.mediaIndex
  与原public签名，不把Markdown或reader document模型带进框架。
- `theme-schedule`：日出日落/时区回调/跨午夜区间；ReaderThemeSchedule默认值、
  display格式、locationUpdatedAt、持久化和SYSTEM解释留app薄包装。
- `logging.BoundedLineBuffer`：实例内纯line/UTF-16容量和截断。debug flag、数值
  profile、dump label与gate异常留app；buffer不自行脱敏或读取host。

应用后台刷新会间接import wire-json，因此CLI headless allowlist只新增纯
`json-numbers`，测试实际执行无host IIFE并继续拒绝startup/overlay/logging/
services/伪子入口。主目录25beb14 CLI不含本轮新增allowlist：规定的主目录
CLI命令已实跑，发现拒绝此模块；修复在wt-c，使用匹配wt-c CLI构建并交接。
lead合入框架后主CLI才具该能力，不能旧CLI+新app混用。

## 差分和默认路径

`tests/fixtures/upstream-u9`保存6个`d1d4515:src/...`的完整原始字节与SHA256。
loader只转译TS/Solid并重定向依赖；StartupGate仅加载原两段私有overlay函数
及必要imports，不执行/替代onboarding。普通测试调用独立browser子进程，
避免全套host mock污染；没有删除/放宽原断言。

- HTTP：1/7/4096分片、UTF-8/NUL、64KiB边界、chunked扩展/trailer、非法CRLF/
  request/header、重复/冲突framing、过大/缺失body、迟到/空/超读；逐次read
  参数、结果、异常name/message完全相同。包含Date.now生产默认调用。
- JSON：递归token/整数属性、负零/安全范围/小数/指数、escaped key、重复key/
  清除、数组、proto-like key、malformed/非object/过深异常；100随机样本。
- 锚点：重复/缺失行、Unicode/CRLF、100随机文本、fraction/height/max边界。
- 调度：闰日/DST样式offset/极地/无效日期与坐标、跨午夜/相等边界；原native
  fixture仍由原测试验证。包含默认timezone和默认Date构造路径。
- buffer：400行/50000 UTF-16/4096截断、disabled append、disabled dump/clear、
  re-enable保留与清空，未新增遥测字段或数据。
- overlay：默认performance clock和frame hook，完整树/geometry/style/labels、
  内容mount/unmount、时钟回退、149/299/300ms、exit reset/restart、完成callback
  一次、早退清理；content发布新navigation state时overlay不得覆盖它。

框架另有8项通用API/默认构造/生产frame/配置契约测试和headless构建测试。
没有新的热点证据，不引入Rust或宣称加速。完整测试/类型/构建结果与commit
写入report；包构建只生成本地资源与bytecode，没有安装APK。

## 设备交接

任务开始一次`adb devices`：e3aca8af connected；后续未运行任何设备操作。
由设备负责人按DEVICE_BRIEF独占执行，正式安装走acceptance.py upgrade，
数据digest before/after必须equal=true；不创建完整userdata tar。

1. 首先截首页与`.codex-tmp/device/shots/s4-k8-home-after-cold.png`核对density2
   尺寸/布局，不一致停止。冷启动/已恢复非home route确认overlay、300ms退出、
   ready时内容mount、完成后输入/返回、异常retry和onboarding入口；不重置真实
   onboarding数据，异常/新用户路径仅在隔离测试包验证。
2. remote-input WiFi单请求/分片中文URL/chunked、导出完成顺序与断连处理；
   避免改变真实订阅数据，使用隔离包/测试输入。后台refresh也需要主框架合入
   allowlist后的新包验证。
3. 原有sync metadata integer/double fixture（不改用户库）、字体/宽度reflow锚点，
   固定/太阳时区调度和极地fallback；默认Reader设置/字段保持。
4. debug provider dump/clear及release门禁仅在隔离fixture验证；不修改真实日志
   或账号。空白/黑屏判定提供非RGB0数量、ROI分布与参照MAE。

这些行为、视觉和进程/物理设备恢复验收均PENDING；离线差分不替代设备证据。
