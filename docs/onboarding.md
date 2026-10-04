# 首次启动引导迁移

当前状态：法律页v2已完成一次真实进程死亡后的挂起响应恢复验证：系统saved元数据与正文文件保留，恢复时重新请求，加载期间丢弃旧锚点，响应完成后回到顶部。结论限定于本轮 `am kill`／held-response路径。既有目标 `956f4e4c…` 的三轮18项专项也已通过；受控首帧前服务完成可保持锚点，但自然即时HTTP仍提交loading后归零，自然快路径尚未验证。

备案冻结相位已覆盖1.0、1.3、1.8三个字号：1.8轮全图最大8位通道差为1，1.0／1.3匹配相位轮最高为2，均非逐像素相同。新增Java分段诊断的一轮正常时钟采样中，24次完整render的P50／P95为24.854／38.175ms，硬件Bitmap复制与getPixels合计占这些调用总耗时的36.53%；TextureView通知间隔P50仍为65.466ms。诊断SDK的普通runner专项4项通过；这些数据不构成稳定性能收益或流畅性通过。低内存回收、进程死亡后的快响应保持、API31+模糊、已发布恢复文件清理和正式部署仍未完成。下文原有各节按阶段保留，其中“当前”“最新”和待办均指当时状态；本次汇总以文末“当前证据汇总：前台服务处理、法律恢复与备案呈现”一节为准。

## 原生行为与实现

原生 `MainActivity.kt` 的顺序为：引导版本不足进入引导；否则隐私版本不足进入单独确认；否则继续恢复内容／首页。版本为 `CURRENT_OOBE_VERSION=3`、`PRIVACY_POLICY_VERSION=1`。

- `src/onboarding/state.ts` 实现欢迎、协议、自定义、网络四页的状态转换。未勾选显示错误；检测中不能完成；离线／蓝牙须另行确认；网络变为可用会关闭旧警告。
- `store.ts` 独立保存版本，读取不写入、不隐式接受协议；保留未知字段，损坏记录或保存失败会报错。
- `controller.ts` 在保存成功后才进入内容；失败保留确认界面，成功后重复点击不再重复写入。
- `OnboardingScreen.tsx` 与两个子页面实现布局、协议链接、回调、返回和滚轮接口。字号、滚轮音量、防干扰和静音开播均为局部演示状态；静音开播默认不限，关闭滚轮音量隐藏防干扰。只有阅读主题调用外层保存回调，符合原生行为。
- `PrivacyPolicyConsentScreen.tsx` 接收标题、背景及明确的查看／同意／不同意回调。`useReaderTitleEntry` 复用阅读器字体解析、排版和系统文字绘制；测试入口使用默认阅读预设，外层已通过 StartupGate 接入预设与背景，真实用户自定义组合仍未验收。

## 构建与真机证据

`tests/runtime-onboarding` 是独立包 `dev.podjs.tests.onboarding`。`tests/android-onboarding` 捕获真实 GPU 帧，不注入触摸、按键或滚轮输入。12 个状态覆盖欢迎、协议／错误／勾选、自定义、网络检测／不可用／蓝牙／可用、两种警告及隐私确认。首次截图发现横向布局和静默失效的样式，现已修正，原始问题截图保留为 `onboarding-first-*.png`。

组件对照阶段的构建为 125 个样式记录、24 项资源包。构建期间修正了动态圆角、字号别名、SVG 尺寸、渐变烘焙和纹理必须为 2 的幂等限制。渐变由 `scripts/build-onboarding-glow.py` 生成透明 PNG。静态字号使用编译器支持的别名，下划线使用单独细线；样式回归测试直接调用实际编译器，避免整条样式被静默丢弃。

- 类型检查：`artifacts/onboarding-native-alignment-typecheck.log`。
- 状态／保存／样式回归：6 项、124 次断言通过，见 `onboarding-native-alignment-tests.log`。
- 组件对照阶段 PodJS 真机测试：`onboarding-native-alignment-device-test.log`，1 项通过。
- 构建哈希：`onboarding-fixture-build-receipt.json`。
- GPU 帧与清理记录：`onboarding-device-receipt.json`。

## 原生画面对照

`tests/native-onboarding` 将未修改的原生生产组件编入独立包 `com.lightningstudio.watchrss.onboardingreference`。Release 的 `BuildConfig.DEBUG=false`，保留正式版画面分支；测试只调用本包的语义回调，不保存同意记录。`onboarding-native-device-test.log` 的 1 项测试通过，12 张原生截图为 `onboarding-native-*.png`，来源哈希与清理记录见 `onboarding-native-receipt.json`。

`scripts/reference/compare-onboarding.py` 按原始 466×466 尺寸比较两组截图，不缩放。修正圆环父容器约束、协议错误提示居中、按钮行高及隐私标题后，隐私页平均 RGB 绝对误差从 12.15 降至 3.24，协议勾选页从 3.96 降至 1.83（0–255 标尺）。完整结果见 `onboarding-native-comparison.json`，修正前结果另存 `onboarding-native-comparison-before.json`。这些诊断数值不是验收阈值；目前没有一页逐像素相同，加载动画相位也没有同步。

仍存在下划线位置、文字基线细节、圆形边缘平滑等差异。网络检测环暂为固定弧长近似，尚未匹配原生 Material 动画的弧长变化和缓动。

## 真实网络验证

新增只读 Host 方法 `discovery.networkSnapshot`，返回活动网络及 INTERNET／VALIDATED、Wi-Fi／移动／蓝牙标志。`observeHostInternet` 使用已有网络订阅重新读取快照，旧结果不会覆盖新状态，释放后停止通知。分类遵循原生，不进行 HTTP 探测。

真机测试实际执行了该 JS → Host 路径：手表当时没有活动网络，六个标志均为 false；JS 快照与直接读取 Android ConnectivityManager 一致，监听先发出 `checking`，再发出 `unavailable`。反射确认一个订阅注册了默认网络与本地 Wi-Fi 两个回调，取消后订阅表为空、两个回调均已释放。证据保存在设备 receipt 的 `network` 字段。本次未切换网络，在线／蓝牙连接变化及真实变化回调仍未验证。

## 尚未完成

`StartupGate.tsx` 已在源码中连接版本门控、协议正文导航栈、网络监听、主题保存、返回／滚轮接口及退出请求；已验证该入口的隐私更新及拒绝、首次未同意门控、损坏记录重试；其余集成路径仍待真机验证。SDK 新增 `app.finishTask`（host.lifecycle 能力），Android 端结束当前 Activity affinity；同意单独隐私更新后保存并结束任务、拒绝不写版本，以及下次启动路由已通过独立包运行验证（见下）；首次引导离线完成与单层隐私正文返回已验证；正文内容、嵌套返回及滚动恢复仍待验证。Android 状态恢复、DEBUG 强制网络状态和引导重放入口仍未接入。真实用户预设／背景、物理返回与滚轮、链接点击、运行中网络变化及完整视觉一致性仍未验收。

原生／组件对照阶段的四个临时测试包均已按安装哈希校验后移除；已有其他参考包未改动。正式 PodJS APK 哈希保持 `d8f2f4a1ebe321b3dc628f4656f970fb69fc3cafe66412109142f9e31a24b637`。这些证据不代表完整迁移完成。

## 启动集成当前校验

启动相关状态／样式测试 7 项、140 次断言通过，类型检查通过（`onboarding-startup-tests.log`、`onboarding-startup-typecheck.log`）。SDK 服务测试 34 项、198 次断言通过，Java 编译通过（`onboarding-exit-sdk-tests.log`、`onboarding-exit-java.log`）。这些离线检查本身不证明完整启动流程的真机行为。

新增退出真机验证：独立包通过公开 `application.finishTask()` JS 接口调用 Android Host，仪器测试等待并断言实际 Activity `isDestroyed()`；1 项测试通过，耗时 27.312 秒，同时重新执行 12 阶段画面捕获与网络监听释放检查。证据为 `onboarding-exit-device-test.log` 和 `onboarding-exit-device-proof.json`（`publicFinishTaskDestroyedActivity=true`）。该测试没有调用隐私按钮或写同意记录，因此不证明完整门控、隐私持久化或下次启动路由。独立测试包已核对安装哈希后移除，正式包哈希不变（`onboarding-exit-cleanup.json`）。主应用源码构建通过（`onboarding-startup-build.log`），尚未部署。

## 启动门控真机链路

`tests/runtime-startup` 直接挂载生产 `StartupGate`，仅将主页替换为记录挂载次数的页面，独立包为 `dev.podjs.tests.startup`。仪器测试通过当前 UI 节点的语义激活动作调用真实按钮回调，不注入触摸、按键、滚轮或焦点事件。最终 1 项测试通过，耗时 24.569 秒（`startup-device-test.log`）。验证了拒绝后 Activity 销毁且全部测试数据不变；同意后只有隐私版本改变、主页仍未挂载并退出；再次启动主页仅挂载一次。新安装未勾选协议时保持门控、不写同意记录并显示错误；损坏记录重试不覆写原值。详见 `startup-proof.json` 与源码哈希 `startup-device-receipt.json`。

新包首次构建漏接 assets 目录导致光晕占位图，已补齐与正式包同源的资源链接，确认最终构建日志无 missing/placeholder 后重新测试和捕获。最终 `startup-welcome.png`、`startup-agreement-error.png`、`startup-privacy.png` 为当前入口截图；它们没有单独证明逐像素一致。两个独立测试包已按哈希校验并移除，正式包未替换（`startup-cleanup.json`）。

此阶段只覆盖默认阅读预设和测试命名空间数据；首次引导完成的后续证据见下。真实用户自定义背景、物理输入或状态恢复仍未验证。宿主滑动退出策略的后续修正与证据见下；组件未注册横滑手势本身不能证明宿主禁止退出。

## 宿主滑动退出策略

SDK `setNavigationState` 新增可选 `rootSwipeEnabled`，省略时恢复默认策略，独立于 `canGoBack`。引导、隐私更新与损坏记录页面显式关闭根级滑动退出，离开门控时恢复默认；协议正文仍使用自己的返回栈。Android 与 Wear OS 宿主都在原生滑动退出和兜底边缘手势路径检查策略。`PodRuntimeView.canScrollHorizontally` 在应用接管返回或禁止退出时返回 true，供系统滑动容器判断；系统返回键的原有路径没有改变。

源码验证：SDK 13 项测试、38 次断言；启动相关 7 项、140 次断言；类型检查与 Android/Wear OS Java 编译通过。主应用构建通过，尚未部署（`startup-swipe-*-tests.log`、`startup-swipe-typecheck.log`、`startup-swipe-java.log`、`startup-swipe-main-build.log`）。

独立启动包真机测试通过，耗时 24.643 秒（`startup-swipe-final-device-test.log`）：回读隐私／首次引导／损坏记录页面的 `canSwipeDismiss=false` 与横向接管状态，主页恢复 true；通过包内 `sendBack()` 回调验证协议正文返回隐私页、协议确认页退回欢迎页。该调用没有创建或注入 KeyEvent/MotionEvent，也不等同于物理按键验收。此前的隐私持久化、拒绝不写入、重新启动门控检查再次通过。

设备上实际容器为 `com.android.internal.widget.SwipeDismissLayout`，系统隐藏 API 过滤使内部 `canScroll` 无法通过反射访问，receipt 明确记为 `childScrollMethodAccessible=false`。没有修改系统策略；改为只读提取同机 framework.jar 并检查 classes4.dex 的相关指令，确认容器调用递归 `canScroll`，查询子视图 `canScrollHorizontally`，返回 true 后设置 `mDiscardIntercept`。原始反汇编及 framework 哈希见 `startup-watch-SwipeDismissLayout.dex.txt`、`startup-swipe-system-audit.json`。这属于系统实现核对，物理滑动与动画仍未验收。

最终测试包按哈希确认后移除，正式包保持不变（`startup-swipe-cleanup.json`）；当前源码/验证边界见 `startup-swipe-device-receipt.json`。正文内容与滚动恢复、Android 状态恢复、DEBUG 重放及实际物理操作仍需继续。

## 首次引导完成链路

引导勾选框增加明确的 checkbox 语义和勾选状态；字号及静音开播加减按钮使用原生对应的无障碍说明，离线确认／取消图标提供名称。检测中按钮正确暴露禁用状态，非活动引导／隐私页禁止语义操作，离线弹窗隐藏下层页面的语义节点。`ScrollEntries` 可通过显式 `accessibilityLabel` 提供列表滚动动作，本轮只在自定义页启用；动作遵循活动状态、固定布局与滚动边界，不改变物理滚动逻辑。

新增真实完整路径测试：欢迎页 → 勾选协议 → 自定义页增大到 16sp → 两次列表语义滚动 → 静音开播上限改为 0% → 网络页 → 取消离线确认 → 再次确认 → 计数主页。设备实际状态为 `unavailable`，没有切换网络。每个演示操作和取消动作后比较全部 KV；直到最终明确确认才保存 oobe=3/privacy=1，保留未知字段与其他测试数据。测试同时确认同一 Activity 的主页恢复默认滑动退出策略、网络订阅释放、重新启动跳过已完成引导。

完整路径与之前隐私／损坏记录／宿主策略测试共 2 项通过，耗时 38.013 秒（`onboarding-completion-device-test.log`）；结果与源码哈希见 `onboarding-completion-proof.json`、`onboarding-completion-device-receipt.json`。`startup-customization-font.png` 和 `startup-customization-limit.png` 已检查，分别显示 16sp 和 0%；未将这些演示值写入持久设置。主应用构建、类型检查及 7 项/140 次启动回归通过（`onboarding-completion-*.log`）。

两个独立包已校验安装哈希后移除，正式包仍未替换（`onboarding-completion-cleanup.json`）。阅读主题保存的后续验证见下；演示音量开关／防干扰交互、真实在线与蓝牙变化、状态恢复、重放和物理操作仍未由这组测试证明；计数主页也不代表正式主页全部功能已验收。

## 阅读主题与已有预设保留

发现并修正 `ReaderPresetStore.load()` 丢弃未知顶层字段的问题：先前重建返回对象只保留已知字段，后续主题保存可能覆盖未来版本扩展信息。现在保留完整外层对象，并继续复制已知选择／计划字段；不重写原始预设或资源载荷。回归在修复前复现字段丢失（`onboarding-theme-preservation-before.log`），修复后预设测试 7 项/1378 次断言及阅读同步测试 8 项/133 次断言通过。

独立启动包新增已有预设测试：种入浅色／深色预设、删除记录、未来版本记录、资源元数据、未知外层／选择／计划字段及独立设置；通过真实主题按钮切为浅色，重新启动进入自定义页，再切回深色。每一步比较全部 KV，只允许主题选择变化；第二次切换后与初始数据完全相等，同意记录也未变。`startup-theme-light.png`／`startup-theme-dark.png` 已检查，主题指示正确显示白／黑；演示字号仍为原生规定的 14sp，并未改写已有阅读字号。

主题、首次引导完成、隐私与宿主返回的 3 项真机测试全部通过，耗时 49.355 秒。证据为 `onboarding-theme-device-test.log`、`onboarding-theme-proof.json` 和源码哈希 `onboarding-theme-device-receipt.json`。类型检查及正式主应用构建通过，尚未部署。测试包已按安装哈希核对后移除，正式包保持不变（`onboarding-theme-cleanup.json`）。

这验证了已有预设下的主题选择往返及元数据保留，不证明自定义背景资源的实际绘制、系统计划跨时间切换、Android 状态恢复、物理操作或完整视觉一致性。

## 状态恢复宿主基础

原生 `OobeViewModel` 的页码只保留在 ViewModel 中，没有 SavedStateHandle；Activity 重建可继续当前页，进程重建则从欢迎页开始。协议勾选、错误和离线警告是 `rememberSaveable` 状态。自定义页的演示控件及 ScrollState 位于该页的条件分支中，不能将它们永久保存后跨离页恢复为不同于原生的行为。

SDK 已新增 `application.activityState.read/write`：`saved` 进入系统 Bundle，`retained` 仅经过非配置实例保留通道。两个 JSON 对象合计限制 64 KiB UTF-8，原子替换、读取副本，超限不覆盖旧值；不写应用持久存储。Android/Wear OS Activity 已连接保存与恢复回调，在 guest 启动前恢复数据。

独立包用公开 JS 接口写入测试状态后执行真实 `Activity.recreate()`，确认新实例收到两类状态；正常结束并重新启动后两类状态为空。实际保存 Bundle 中不包含 retained 数据；Bundle-only 的恢复边界单独检查，不冒充真实进程死亡。新增宿主边界测试和原有引导测试共 5 项通过，耗时 61.262 秒（`activity-state-device-test.log`、`activity-state-proof.json`）。SDK 服务测试 35 项/203 次断言、类型检查、Android/Wear OS Java 编译与主应用构建通过。

**引导 UI 尚未接入这些状态通道**，因此引导状态恢复仍未完成。源文件哈希与该边界见 `activity-state-device-receipt.json`。测试包已按哈希确认后移除，正式包未替换（`activity-state-cleanup.json`）。

## 引导草稿接入状态恢复

`StartupGate` 在挂载引导前读取宿主 activityState。协议勾选、错误与离线警告使用 saved 通道；页码与网络状态使用 retained 通道。恢复和普通导航不会保存同意记录，正常结束重新启动清空草稿；已有其他状态键保留。网络观察的初始回调使用不参与响应式依赖跟踪的恢复快照，避免会话变化触发重复订阅并递归溢出。

独立包实际 `Activity.recreate()` 验证协议错误、协议页与勾选、自定义页页码恢复；离线完成路径在确认弹窗出现时重建，确认弹窗仍在，取消不写入，最终明确确认才保存版本。全部六项真机测试通过，耗时 82.664 秒；原有主题、隐私与宿主边界测试同时通过。证据为 `onboarding-restoration-device-test.log`、`onboarding-restoration-proof.json` 和 `onboarding-restoration-device-receipt.json`。启动单元测试 9 项/151 次断言、类型检查和正式应用构建通过。初次失败日志保留为 `onboarding-restoration-device-test-first.log`。

测试包已校验安装哈希后移除，正式包哈希保持不变（`onboarding-restoration-cleanup.json`）。自定义控件数值与滚动、协议页面栈与滚动仍未接入恢复；真实进程死亡、Wear OS 真机、物理输入与完整视觉一致性仍未验证。以上更新了前节“引导 UI 尚未接入”的阶段状态，不代表迁移完成。

## 自定义分支的保存语义

原生 `OobeScreen.kt` 的自定义页只在页码 2 分支挂载，四个演示值均为 rememberSaveable：14sp、滚轮调音量开启、防干扰关闭、静音开播上限 null（无限制）。防干扰状态定义在显示条件外，所以关闭滚轮音量不会重置防干扰或开播上限。主题仍立即保存到阅读预设，不归演示草稿。`rememberScrollState` 保存物理像素偏移。原生源文件哈希与边界见 `onboarding-customization-native-audit.json`。

另核对 [Compose 1.7.1 官方 runtime-saveable 源码](https://dl.google.com/dl/android/maven2/androidx/compose/runtime/runtime-saveable/1.7.1/runtime-saveable-1.7.1-sources.jar)：SaveableStateRegistry 仅在 consumeRestored 时移除保存值，performSave 继续携带未消费的数据。因此 Bundle-only 恢复使 ViewModel 页码回到欢迎页时，自定义草稿应继续等待首次进入；实际离开已挂载的自定义页后再次进入则使用默认值。不能无条件在页码不为 2 时删除草稿。

实现通过 StartupGate 单一 owner 保存自定义值与滚动，每次 controller 页码变化同步检查离页；恢复时按当前密度换算物理像素。组件向 owner 提交时不跟踪 owner 的响应式依赖，避免重复订阅。单元回归涵盖配置恢复、Bundle-only 未消费草稿、首次进入与离页清除，并保护未知外层状态键；此模型测试不代表真实进程死亡验收。

本轮真机七项回归通过，耗时 103.863 秒（`onboarding-customization-restoration-device-test.log`）。新增用例通过真实按钮语义回调修改为 16sp、防干扰开启、静音开播 0%，滚动到页面下段后实际 Activity.recreate；比较重建前后节点内容、状态及几何，允许物理像素量化带来的 1px 差异。向上检查字体和防干扰，再关闭滚轮音量执行第二次重建，确认禁用状态保留、防干扰控件在整张列表中消失、再次启用仍保留 guard=true。离开自定义进入网络页再返回后，四值和滚动均恢复默认。全部测试 KV 与含已有预设、资源、未知字段的初始数据逐步比较相等。

三张截图 `startup-customization-restore-before.png`、`startup-customization-restore-after.png`、`startup-customization-return-defaults.png` 已检查；它们分别显示原位置的 0% 及返回后的 14sp。截图不表示原生逐像素对齐。独立结果与源码哈希见 `onboarding-customization-restoration-proof.json`、`onboarding-customization-restoration-device-receipt.json`。十二项源码测试/146 次断言、类型检查与正式应用构建通过。独立包按安装哈希确认后移除，正式包未替换（`onboarding-customization-restoration-cleanup.json`）。

这补齐前节尚未接入的自定义数值与滚动。Bundle-only pending 行为只有源码对照及模型测试，真实进程死亡、原生重建真机对照、跨密度设备恢复仍未验证。协议页面栈及其滚动恢复的后续证据见下；物理操作与整体迁移仍未完成。

## 协议正文、嵌套返回与容量边界

`legal-restoration.ts` 将协议→备案的导航栈放入 saved，将被覆盖的协议正文／错误／物理像素滚动放入 retained。栈顶远程协议在重建时重新请求；下层页面复用已完成内容。仅有 Bundle 时重新请求下层正文，并在完成后立即写回 retained，避免随后再次重建时重复请求。正常退出重新启动不恢复旧栈。正文用严格 UTF-8 和 base64url 编码，避免 Android JSON 的斜杠转义使较大正文超限；未知外层状态键保留。

此前协议请求把 512 KiB 传给最大只接受 256 KiB 的旧 fetch 路径，在真正发起 HTTP 前即失败。现在 `legal-document.ts` 使用宿主分配的自有临时文件和流式下载，按 64 KiB 分块校验并读取完整 512 KiB 文本，取消及完成后仅清理该请求的文件。按原生保留返回正文，仅 trim，不擅自解析 JSON 或剥离 HTML。十二项下载测试／156 次断言涵盖容量、跨块 UTF-8、取消竞争、错误块及文件所有权；合并的启动／协议测试为 27 项／319 次断言，类型检查与正式应用源码构建通过（`onboarding-legal-restoration-*.log`）。

SDK 的通道上限现为 **saved 64 KiB、retained 896 KiB，分别计量**，替代前文阶段性的合计 64 KiB；超限原子拒绝。两个 JSON 对象与服务回执仍在 1 MiB 事件上限内。真机通过公开 JS API 同时写满两路，逐字符回读，真实 Activity.recreate 后先读取而不重新 seed；每路各超出 1 字节均拒绝且两路旧值保持。系统 Bundle 只含 saved，没有 retained。见 `activity-state-capacity-proof.json`。

最新九项真机回归全部通过，耗时 156.949 秒（`onboarding-legal-restoration-device-test.log`）。协议用例使用仅绑定 127.0.0.1 的 HTTP 服务和生产门控：实际滚到长隐私正文底部、打开备案、重建后仍在备案、返回保持原正文及滚动（节点几何误差≤1逻辑像素），请求数保持 1；再次返回隐私门控。清空 retained 后模拟 Bundle-only 边界并实际重建，下层重新获取一次；随后再重建不重复获取。另验证栈顶用户协议重建会重新请求、返回保留引导勾选、正常退出后新启动回欢迎页且未勾选。全程比较完整测试 KV，已有预设及未知字段不变。

独立结果与源码哈希为 `onboarding-legal-restoration-proof.json`、`onboarding-legal-restoration-device-receipt.json`。首次失败因带 onPress 的语义父节点合并了备案标题／二维码，修复为独立隐藏点击层后通过；失败日志保留为 `onboarding-legal-restoration-device-test-first.log`。此测试调用当前节点的语义动作和真实 Activity.recreate，没有触摸、按键、滚轮或焦点注入。Bundle-only 明确是模拟，不能称真实进程死亡。

## 备案页原生对照

备案页已改为原生的标题、域名和 120dp 白色二维码布局。固定 URL 使用 ZXing 3.5.2 对应的 ECI／版本／mask 矩阵及整数像素留白；13 种尺寸的全部 RGBA 字节与直接运行的 ZXing oracle 相同（`beian-qr-pixel-oracle.json`），该检查本身不代表 GPU 画面一致。

独立 release 参考包启动未修改的真实 `BeianActivity`，等待进入动画结束后 PixelCopy，并执行真实重建；系统 Bundle 回调、实例替换和原生语义均通过，重建前后 PNG 完全一致。真机一项测试耗时 13.518 秒，见 `native-beian-reference-device-test.log`、`native-beian-proof.json`。参考包已按哈希核对并移除，原生正式包及已有 PodJS 包哈希均不变（`native-beian-cleanup.json`）。

`scripts/reference/compare-beian.py` 比较两份未缩放的 466×466 原始截图，同时从实际截图反色解码；原生及 PodJS 均解码为 `https://beian.miit.gov.cn/`，PodJS 重建前后截图也完全一致。首次对照发现标题字体／基线、副标题及二维码纵向位置仍有差异，旧结果保存在 `beian-native-static-comparison-before.json`。后续同源字体修正见文末；本次设备实际为 API 30，Compose 在该版本不应用 blur，API 31+ 效果必须在较新系统另验。进入动画相位与物理操作仍未验收。

原生 `InfoActivity` 每次 composition 重新请求正文，其列表位于 loading 分支之外；快慢响应会影响恢复后的列表是否短暂卸载。真实进程死亡、不同密度、正式主页与真实用户资源组合及完整迁移均未完成。

## 原生协议页恢复观测

`InfoRestorationReferenceTest` 使用真实 `InfoActivity`、`InfoScreen` 和生产 OkHttp 请求。独立 `inject-info-restoration.gradle` 仅将隔离 release 的后端改为本包 127.0.0.1 服务；每个请求可独立放行，不修改生产源文件，不注入触摸、按键或焦点。

首轮六项（含备案）有四项通过、两项失败，记录为 `native-info-restoration-reference-device-test.log`，原始证据另存 `native-info-first/`。静态正文及立即响应时，观测到重建前后滚动轴均为6037、PNG相同；延迟响应时捕获了loading画面且列表不存在，随后滚动轴由6037变为0。分别见 `native-info-static-proof.json`、`native-info-fast-proof.json`、`native-info-slow-proof.json`。6037是由条目索引与局部偏移构成的Compose语义滚动轴，不是累计物理像素。快／慢proof均标记 `scrollOutcomeAsserted=false`、`processDeathTested=false`；快响应没有逐次loading／列表挂载事件记录，不能据前后相同推定中间从未切换分支。Compose测试时钟自动推进，因此这些是该调度环境下的真实Activity／网络观测，不能推导所有自然帧时序。PodJS目前栈顶协议总是重新加载到顶部，快响应保留滚动的对齐仍未实现。

保持原有断言补采失败现场并重跑后，两项仍未通过（`native-info-restoration-diagnostic-device-test.log`）：

- 覆盖返回确实回到同一个 Info 实例、正文底部和滚动轴 16565，且只有一次 HTTP 请求；但原生导航加载圈仍覆盖在页面上，窗口没有焦点。只读系统状态显示屏幕开启，焦点在 `SysUI.Charging`（`native-info-reference-window-condition.json`）。没有人为修改焦点或关闭充电界面；完整遮罩退出仍未验收。
- 旧请求晚于新请求返回时，新正文先显示，随后实际 PixelCopy 和语义树变成“协议正文加载失败，请检查网络后重试。”。两份响应都已成功发送，旧 Activity 已销毁，新实例已接收系统 Bundle。见 `native-info-late-old-proof.json`、`native-info-late-old-new-response.png`、`native-info-late-old-failure.png`。默认 saveable 状态在同进程 Bundle 中共享引用以及原生捕获取消异常后的错误写入，是源码和字节码支持的原因候选；尚未直接测量该状态对象的引用身份。迁移版保留旧请求取消及迟到结果保护，此已复现的原生缺陷不作为要复制的行为。

备案页另通过真实 `GetTextLayoutResult` 确认：density=2、fontScale=1，标题高度49px／baseline39px／top51px，副标题28px／baseline22px／top116px；实际重建后相同，见 `native-beian-metrics-proof.json`。不使用 marquee 内部无界排版的异常大 line-left/right 作为屏幕坐标。新 PodJS 同源字体测量方案已实现，新的 GPU 对照尚在进行。

## 备案字体与渲染组件的后续验证

SDK 新增 `resources.assets` 原样资源打包和 `fontAsset` 字体入口；备案标题与网址通过同一原生 `watch_sans.ttf` 测量并绘制。实际测量高度决定整列居中位置，未加针对截图的偏移补丁。当前 466×466、density=2、fontScale=1 真机截图中，标题、网址、二维码内容边界分别为 `[133,55,335,95]`、`[148,120,318,144]`、`[120,183,345,408]`，与原生参考完全一致；二维码正确解码，PodJS 重建前后 PNG 相同。

仍有 840 个像素每通道相差 1 色阶：标题407、网址209、二维码224。二维码的 PodJS 图像与二值原始数据完全相同，原生默认位图过滤在模块边缘产生1/254；文字软件栅格与硬件显示的舍入差异尚未分阶段确定。`beian-native-static-comparison.json` 记录原始尺寸、各区域误差和 `nativePixelEqualityVerified=false`，没有采用误差阈值宣称逐像素相同。

新版目标 APK 的九项启动／恢复用例再次全部通过，155.083秒的总测试中另外两个 SDK 类加载失败；这是测试源未进入 APK，不能把该轮整套测试称为通过。修复 `android-startup-sdk.gradle` 的明确源目录与复制依赖后，已补跑字体／媒体12项，其中8项媒体和2项字体通过，1项API31模糊在API30跳过，1项文件字体因测试包存储目录不可写失败。将文件放到目标包自有目录后，3项字体重跑全部通过（`beian-font-context-device-test.log`，0.196秒）；合计20项适用用例已通过，1项按API跳过。原始失败与补跑日志均保留。该阶段完整截图、proof、APK和源码哈希保存在 `beian-native-text/device-receipt.json`。

API31+ 路径现已实现：无损 PNG 源、独立图像面、CLAMP 模糊、亮度增益与偏置，图像真正 ready 后开始1650ms进入动画；API30继续使用直接纹理并修正多层alpha合成。原始 PNG 在8种尺寸均与二维码 RGBA 全字节相等；`scripts/verification/check-beian-qr-readiness.ts` 实际编译生产组件，覆盖10种成功／失败／取消／迟到时序、37次断言。它们属于离线源与生命周期验证，不证明 API31+ GPU模糊或动画逐帧一致。

上述首次字体截图使用系统字体缩放1。后续系统配置读取与 Compose 缩放实现及验证范围如下；真实进程死亡、物理输入和完整迁移仍未完成。

## 系统字体环境及启动回归

SDK 的 `textLayout.environment()` 读取当前 Activity 的 density、fontScale，并按 Android 平台规则转换可选 SP 数组。应用另外复现原生 Compose 1.7.1 的非线性字体表、Float 运算和 SP 行高规则；平台换算值不能直接代替该 Compose 版本的换算。离线比较真实 AndroidX class 的1008个 Float 结果，以及17种比例、两种密度下按实际标题／行高调用顺序产生的272个 Float 结果，均一致。备案文字已接入系统配置；较大系统字号的实际显示和 marquee 仍待真机对照。

隔离目标 APK `739f7bb6…` 中的公开 JavaScript API 已在真实 Activity 重建前后读取到 density=2、fontScale=1，数组 `[12,14,21,26,12]` 返回 `[24,28,42,52,24]`，调用次数从1到2，测试 KV 哨兵及系统配置不变。六项 Android 服务测试另覆盖配置上下文切换、参数边界和非有限值拒绝；这不能冒充实际大字体 Activity 的显示验证。

最初完整38项执行在第9项启动期间崩溃。logcat 明确显示约250MB `main.pak` 的 `mmap` 失败，随后才抛出误导性的资源缺失异常；APK 内资源并未缺失。32位地址空间采样及源码检查支持连续映射压力，并确认原测试仅调用 `finish()` 后等待主线程空闲，允许旧、新 Runtime 短时重叠。未发现所审查的 Rust／QuickJS 引用环，也未证明整个进程不存在泄漏。

同一旧目标和旧测试包单独重跑10项启动用例通过，162.584秒（`startup-mmap-reproduction/`），表明失败并非每次发生。随后仅把测试结束条件加强为旧 Activity 已销毁且宿主指针为0，重新安装测试 APK `c0192085…`；完整38项于165.281秒结束，**37项通过，1项API31模糊因当前API30跳过**。覆盖10项启动／恢复、3项字体、8项适用媒体、6项文字环境和10项原子写入；完整日志、逐项状态、源码、截图及内存采样在 `startup-mmap-finish/run-receipt.json`。两正式包哈希保持不变。此轮只加强测试生命周期条件，没有修改生产资源读取，不能据此宣称生产内存问题已修复；通用分条目读取修正另行验证。

## 协议正文与加载状态接入

成功的隐私政策、用户协议、项目自介和许可证页面现接入 `InformationDocument`，使用实际段落测量、同源标题规划、当前阅读预设／字体／背景和 Compose 缩放，替换按字符宽度估算的正文。每个原始区块保留单独语义节点，视觉行按视口创建；恢复位置在标题、正文和备案排版结束后才按真实范围应用，主动滚动会取消尚未应用的目标。大于4096个UTF-8字节的语义标签会截短，正文不因此截短；极端长段落的框架上限和性能仍有边界。项目自介中原生不存在的额外许可证按钮已移除，关于页的许可证入口保留。

加载页接入40dp／3dp原生参数圆环，网络检查页使用18dp／3dp。圆弧首尾与旋转按 Material3 1.3.0 时序运行，页面被覆盖或应用退后台时暂停，离页释放回调。错误页使用原生居中正文及重试按钮排版；后台页面隐藏语义并拒绝重试。通用圆弧渲染的抗锯齿与Skia不同，尚不称加载动画逐帧像素一致。

当前集成完成全量614项应用测试、51569次断言及类型检查；主JS和独立fixture构建成功。生产源和产物哈希保存在 `information-document-final/build-source-receipt.json`；此前613项对应的旧构建收据保留在 `information-document/`。SDK新增匿名只读文字资源状态快照，区分排版结束、纹理上传、绑定成功与各阶段失败；测试不能再用队列清空替代原生文字成功。栈顶协议快速重建时的滚动对齐仍未完成。

新版隔离目标 `15b98407…` 已包含上述正文和SDK分段PAK读取。完整40项运行于194.551秒结束：37项通过、2项失败、1项API31模糊因当前API30跳过。失败分别是旧语义动作测试跨主线程调用使用过期整树哈希，以及新增中段定位把233逻辑像素的节点坐标与466物理像素的原生参考直接相加；原失败保留在 `information-document-final/`。正文／代码／引用角色用例确认所有当前原生文字资源完成上传和绑定，真实重建前后截图及节点几何相同。

仅修正测试后，在未改变的目标APK上补跑两项，90.123秒全部通过，证据位于 `information-document-test-fix/`。动作现在在同一主线程任务内取新快照、解析节点并提交，不重放已接受的动作；中段坐标从实际display metrics换算。合并39项适用用例通过，另1项API跳过，不能把首次失败轮次改写成40项一次全过。新增说明页验证中段、真实clamped底部、实际Android Bundle恢复、完成命令未重放及原生文字资源成功；中段锚点明确是Pod段落容器，其包含段前间距，不声称与原生Text边框对齐。两正式包保持原哈希，正式部署仍未进行。

资源读取现按最多64KiB回调、逐条目载入，避免Android对约250MB PAK整体建立连续映射。本轮37次、约5秒间隔的真机采样中，最大APK映射为11,309,056字节，采样RSS峰值387,164KiB；没有观测到旧的PAK整包映射或OOM。离散采样不能证明每个瞬间的峰值，也不代表字体常驻内存已消除。离线兼容性证据及其来源限制见 `pak-reader/README.md`。

原生静态说明页的首次严格几何比较混入了LazyColumn未显示的预加载节点。测试现在读取真实 `layoutInfo` 全祖先的placement状态，保留所有原始节点及排除原因，再筛选可见几何；没有按段号排除。单次真实重建重跑9.511秒通过，现场第14段虽然bounds落在视口内，却明确 `isPlaced=false`；第09–12段可见，中段与底部重建前后坐标、像素、预设和字体比例均相同。原失败及修正后结果分别保存在 `native-information-document/` 和 `native-information-document-placement/`。此结论不代表PodJS与原生逐像素一致。

## 此前证据汇总：2026-09-21（法律恢复v2设备回归前）

备案约束修正版的归档检查为615项测试、51571次断言、94个测试文件全部通过，类型检查通过，见 [应用测试日志](../artifacts/beian-constraints-final/beian-constraints-app-tests.log) 和 [类型检查日志](../artifacts/beian-constraints-final/beian-constraints-app-typecheck.log)。这批冻结源码包含说明页原生文字排版和备案页按剩余空间测量、缩放二维码的修正，对应隔离目标APK `b089e27f…`。后续备案动画修正正在进行，这些结果不代表后续源码已验收。正式包没有部署此增量，独立启动夹具仍以计数页面替代正式主页。

设备整套回归的已归档结果仍须按轮次读取：[首轮结果](../artifacts/information-document-final/run-result.json) 为37通过、2失败、1跳过，194.551秒；在同一目标APK `15b98407…` 仅修正测试后，[两项补跑](../artifacts/information-document-test-fix/receipt.json) 于90.123秒通过。合计39项适用用例通过，API31模糊在API30跳过。首轮失败、过期设备文件标记和补跑证据全部保留；不能写为单轮40项通过，也不能将这组旧目标结果替代后续新增修正的设备验收。

说明页跨实现比较直接使用466×466原始PNG，没有裁切、缩放、平移、滤波或修改图像。默认字体比例的静态顶部、正文／代码／引用顶部及真实clamped底部，非黑像素掩码和所测逐行字形边界一致；分别有4229、2350、4000个像素出现RGB差异，最大单通道差值为1，Alpha相同。各自Activity重建的中段／底部，以及Pod角色页重建，前后画面零像素差异。见 [默认比例汇总](../artifacts/information-document-comparison/summary.json) 和 [完整测量](../artifacts/information-document-comparison/native-pod-document-comparison.json)。跨实现中段锚点未作对齐结论，外层逻辑语义框也不能直接与原生物理文字框相减。

较大系统字号的静态说明页结果如下；实际Activity配置分别读取到density=2、fontScale约1.3／1.8，未把平台线性SP换算值当成Compose实际渲染字号。

| fontScale | 位置 | 差异像素／217156 | 最大单通道差值 | 非黑掩码差异像素 |
| --- | --- | ---: | ---: | ---: |
| 1.3 | 顶部 | 3681 | 1 | 0 |
| 1.3 | 底部 | 4056 | 1 | 0 |
| 1.8 | 顶部 | 3395 | 1 | 0 |
| 1.8 | 底部 | 3137 | 1 | 0 |

四组原始PNG哈希均与捕获记录相符；两端各自中段／底部的八组真实Activity重建前后PNG逐字节相同。底部备案文字在1.8比例下均换为两行，底边均为物理y=350。见 [大字号对照索引及原图](../artifacts/information-document-comparison/font-scale/index.md)。这些是静态说明页证据。旧1.3比例法律栈测试等待重新请求超时的失败继续保留；此前在旧实例清空retained存在被后续状态写回覆盖的可能，但归档现场未证明这就是该次失败原因。测试随后改为新Activity收到实际Bundle后、guest尚未启动时注入saved-only状态，验证saved不变、retained为空；这是确定边界的模拟，后续补跑范围见下。

冻结目标 `b089e27f…` 的法律栈用例已在三种字体配置分别补跑：[默认比例](../artifacts/beian-constraints-final/default-run-summary.json) 1项通过，56.017秒；[1.3／1.8比例](../artifacts/beian-constraints-final/font-scale-run-summary.json) 各1项通过，分别57.228／62.921秒。这是同一用例的三次定向运行，并非三个完整套件。大字号runner分别记录7个Activity实例使用本地比例覆盖，系统全局配置保持不变。三轮新proof均记录saved-only注入通过：新宿主指针在操作前后均为0，实际Bundle未修改，saved原值保留，retained在guest启动前清空。各轮按设备时间核对的capture index仅纳入本轮新文件，旧目录中遗留的其他proof不计入本轮结果。该模拟验证不替代下述真实进程死亡证据。

备案三档[静态对照汇总](../artifacts/beian-constraints-final/comparison-index.md) 已归档：[默认](../artifacts/beian-constraints-final/comparison-default.md)、[1.3](../artifacts/beian-constraints-final/comparison-1.3.md)、[1.8](../artifacts/beian-constraints-final/comparison-1.8.md) 的全图差异像素分别为840、1178、2610，最大单通道差值分别为1、1、2。三档标题、网址及二维码可见边界均与对应原生参考一致，Pod各自重建前后PNG逐字节相同，但二维码语义框前后仍有纵向1逻辑单位差异；较早采样的投影／取整框不能代替较晚的稳定像素证据。默认轮使用普通runner且未覆盖字号，没有本轮逐Activity数值fontScale读数，不复用旧文件补证。默认及1.3的二维码各有224个差异像素、91个非黑掩码差异像素，阈值≥128的掩码相同。

备案1.8比例的对照使用原始466×466截图，修正后两端二维码可见边界均为 `[128,214,337,423)`（右、下边界不含）。二维码仍有1721个像素不同：最大单通道差值为2，其中只有6个像素达到2；非黑掩码差异3个像素，阈值≥128的掩码差异1个像素。标题／网址分别有431／458个像素不同，最大差值均为1。二维码实际像素与此前固定精度双线性采样模型预测一致，说明本次尺寸与采样修正得到预期输出，仍不是原生逐像素相同。语义框采样早于PNG且可含入场缩放，不能将这些框当成已稳定的物理绘制边界；这组静态PNG也不证明入场动画或API31+图像面已通过验收。

真实进程死亡另有独立目标APK `9bb6f09d…` 的链路，见 [核心验证](../artifacts/process-death-live-20260921-01/20260921T012747584523Z-validate-1491a0ed/0015-validation.json)。旧PID18246完成系统保存及停止后由外部 `am kill` 终止；死亡时task175、ActivityRecord `e439b06` 保留，随后PID20559恢复同一系统记录。新进程在guest启动前已收到实际系统Bundle，saved恢复且retained为 `{}`。逐字节一致的191字节是Bundle中SDK activity-state键的UTF-8字符串内容；[死亡时系统记录](../artifacts/process-death-live-20260921-01/20260921T012631946874Z-kill-6cf7dd9c/0014-activity-dump.txt) 显示 `mIcicle=Bundle[mParcelledData.dataSize=704]`，二者不能混称。保存草稿包含font=16、volume=true、guard=false、limit=null、scrollOffset=347。

后续 [语义树与几何证据](../artifacts/process-death-live-20260921-01/ui-followup-proof.json) 记录页面序列自定义→欢迎→协议→自定义，协议勾选保留，进入自定义后显示16sp及与保存草稿一致的设置。前后12个可见语义节点的标签、角色、状态和顺序相同，只有两个文字节点顶部各差1逻辑像素。scrollOffset=347及limit=null来自host state；裁切节点几何支持滚动恢复，但没有独立滚动偏移回读，也没有记录内部pending草稿消费／清空事件。四阶段KV均为274字节且哈希一致，比较基准是完整应用数据备份后写入的测试seed，并非prepare前的原始KV。

该链路确实更换了进程，不再属于手动清空retained的模拟；终止方式是系统保存／停止后执行 `am kill`，没有触发真实低内存回收，也没有采集截图或进行原生应用进程死亡对照。核心proof的 `uiParityVerified=false` 保持原值，后续语义证据不将其改写为像素验收。栈顶远程协议快速重建时的滚动保持、API31+备案模糊及动画、运行中真实网络变化、其他密度、正式主页与真实用户资源组合、物理操作和完整迁移仍未完成。

## 此前证据汇总：法律恢复v2既有栈用例（2026-09-21）

本轮目标APK为 `c79b7f53…`，测试APK为 `611680d9…`；[构建收据](../artifacts/legal-restoration-v2/app-build-receipt.json)、[测试源码收据](../artifacts/legal-restoration-v2/test-build-receipt.json)、[运行参数](../artifacts/legal-restoration-v2/legal-stack-run.json) 与[采集后的包哈希](../artifacts/legal-restoration-v2/device-existing-stack-default/collection.json) 一致。普通AndroidJUnitRunner仅运行既有 `legalActivityStackRestoresAcrossRecreationButNotFreshLaunch`，原始[设备日志](../artifacts/legal-restoration-v2/legal-stack-device.log) 为1项通过、56.651秒，没有字号覆盖参数。这不是全套设备回归，也没有新增栈顶快／慢响应测试结果。对应[应用测试收据](../artifacts/legal-restoration-v2/test-summary.json) 为673项通过、0失败、52318次断言、98个文件；[定向源码测试](../artifacts/legal-restoration-v2/focused-tests.log) 为106项通过。离线通过不等于设备对齐完成。

v2将页面身份、加载／重试状态及 `listAnchor={index,offsetPx}` 放入saved／retained的 `snapshots`；saved另存页面栈。`offsetPx` 是条目内物理偏移，旧总 `scrollOffset` 留作兼容／回读，不能与原生6037一类语义滚动轴直接比较。正文不再内嵌base64，而是通过仍为version1的 `bodyReference` 指向目标包 `files/podjs/files/legal-recovery/v1/<owner>/…utf8` 下的不可变文件。引用绑定owner、精确页面／URL身份、身份摘要、UTF-8字节长度及正文SHA-256；单篇上限仍为512KiB。恢复前校验身份与正文，缺失／损坏正文会丢弃旧列表锚点并重新请求，身份错误不降级为另一个页面。实现与冻结哈希见 [源码收据](../artifacts/legal-restoration-v2/source.json) 和[恢复编码器](../artifacts/legal-restoration-v2/source/src/onboarding/legal-restoration.ts.txt)。

正文先提交为文件，再发布引用；串行写入器合并尚未发布的中间快照，并在提交宿主状态前标记引用已发布。列表恢复候选由文档挂载消费，加载状态与实际帧提交的显示分支分开；真正卸载列表时丢弃已消费的锚点。相关[页面生命周期实现](../artifacts/legal-restoration-v2/source/src/ui/InformationScreens.tsx.txt) 已归档，但当前单项设备测试不足以证明快响应保持锚点、慢响应卸载归零及自然帧时序均与原生一致。新增栈顶快／慢响应验证仍在进行。

已通过的[法律栈proof](../artifacts/legal-restoration-v2/device-existing-stack-default/files/onboarding-legal-restoration-proof.json) 记录四次真实Activity重建：隐私页被备案覆盖后重建、返回，隐私请求数保持1→1，原正文底部的语义几何在1逻辑像素容差内保留；saved-only模拟使请求数2→3，随后再次重建仍为3；栈顶用户协议重建使请求数1→2，证明重新请求。退出后新启动回到欢迎页且协议勾选清空，各阶段测试KV与对应seed比较不变。此用例不包含处于非零列表位置的栈顶快／慢响应专项断言。

[saved-only注入proof](../artifacts/legal-restoration-v2/device-existing-stack-default/files/onboarding-legal-saved-only-injection-proof.json) 明确 `simulated=true`、`actualProcessDeath=false`。新宿主启动guest前验证实际Bundle的saved原值及两路正文引用，再只清空retained；宿主指针前后均为0，saved及实际Bundle保持原值。509字节隐私正文的路径、owner／URL身份、原始字节长度、摘要和UTF-8均经过校验，重新请求后仍可复用同一不可变正文引用。该结果不是法律页真实进程死亡证据，前述另一个目标的自定义草稿进程死亡结果也不能补足这一项。

本轮[采集索引](../artifacts/legal-restoration-v2/device-existing-stack-default/collection.json) 中18个文件均按设备时间判为本轮新文件，包括8张PNG、2份proof和2份正文文件；归档大小与SHA均一致。备案[重建前](../artifacts/legal-restoration-v2/device-existing-stack-default/files/startup-legal-beian-before.png)／[重建后](../artifacts/legal-restoration-v2/device-existing-stack-default/files/startup-legal-beian-after.png) PNG哈希分别为 `34c28e90…`／`82a0f7d3…`，文件不同。直接比较原始466×466 RGBA还可见5641个像素不同、最大通道差48，Alpha相同；这是本Pod目标重建前后的差异，不是原生跨实现比较，尚未确定具体产生阶段。设备用例通过不表示这些截图逐像素相同或新二维码呈现已验收；旧 `b089e27f…` 的静态结果保持其原版本范围。

恢复文件的生命周期清理仍未完成。[文件实现](../artifacts/legal-restoration-v2/source/src/onboarding/legal-recovery-files.ts.txt) 只允许清理尚未发布且仍归当前分配所有的文件；已发布文件保留，包括状态写入确认丢失、页面退栈或请求结束任务之后。`finishTask` 的请求确认不能证明Android已经销毁全部旧saved Bundle引用，因此不能据此安全回收已发布的 `legal-recovery` 文件。当前没有已发布文件的生命周期回收或淘汰策略；这项保留规则用于避免旧Bundle悬空，不应写为清理已完成。正式包哈希本轮仍未变；法律页真实进程死亡、栈顶快／慢响应、新二维码呈现、API31+效果、物理操作与完整迁移仍待验证。

## 当前证据汇总：前台服务处理、法律恢复与备案呈现（2026-09-21）

前台服务完成事件现可独立推进Promise及后续服务请求，绘制帧仍由原有帧回调驱动。隔离目标APK `956f4e4c…`、测试APK `d5ede7f4…` 及JNI `e77b8c48…` 的[构建收据](../artifacts/foreground-service-results/build-receipt.json) 绑定归档源码和包成员；239份归档源码及两个APK的摘要已核验。对应[应用测试](../artifacts/foreground-service-results/app-tests.log) 为673项通过、0失败、52318次断言、98个文件，[类型检查](../artifacts/foreground-service-results/app-typecheck.log) 通过。

同一目标和测试APK分三次运行共18项通过，均无失败或跳过：[前台服务SDK专项](../artifacts/foreground-service-results/sdk-completion-first-device.log) 3项、1.837秒；[法律完成链专项](../artifacts/foreground-service-results/app-completion-first-device.log) 2项、39.482秒；[启动与栈顶回归](../artifacts/foreground-service-results/startup-restoration-regression-device.log) 13项、251.583秒，最后一组为10项 `StartupRuntimeTest` 加3项 `LegalTopRestorationRuntimeTest`。[法律完成链采集索引](../artifacts/foreground-service-results/app-completion-first/collection.json) 收录8项新证据，[启动／栈顶回归索引](../artifacts/foreground-service-results/startup-restoration-regression-collection/collection.json) 收录55项本轮新文件；索引中文件大小／SHA与两个tar摘要均已核对。三组[SDK运行收据](../artifacts/foreground-service-results/sdk-completion-first-run.json)、[法律运行收据](../artifacts/foreground-service-results/app-completion-first-run.json) 和[回归运行收据](../artifacts/foreground-service-results/startup-restoration-regression-run.json) 分别保留；不是单轮18项或全SDK套件。SDK专项覆盖真实文件写入／HTTP下载／读取／删除在零guest帧下连续完成、取消实际待执行定时器，以及已销毁宿主的排队结果不能进入替换宿主。

[受控法律用例](../artifacts/foreground-service-results/app-completion-first/files/legal-service-completion-controlled.json) 暂停SDK首次帧回调后释放真实HTTP响应，没有在保护期主动调用服务泵、原生帧、语义查询或Activity状态getter。实际事件顺序是 `document-mounted → candidate-consumed → response-applied`，三者的frameCount均为0；响应观察时宿主 `active=true`、`lifecycleState=0`、`firstFrameLogged=false`，关闭保护期与恢复回调在同一UI操作完成。首帧结论同时依赖SDK原始状态与该原子检查。这证明服务完成链可先于首次绘制帧推进，并未提交loading或卸载列表。重建前后的canonical锚点 `{index:7,offsetPx:155}`、可见段落及几何保持，本Pod前后PNG字节也相同；兼容字段 `scrollOffset` 实际从746变为0，不能写成整个checkpoint或旧总偏移均不变。受控proof中的 `fastUnverified=false` 仅适用于这一受控分支，不代表自然快路径通过。

[自然即时HTTP用例](../artifacts/foreground-service-results/app-completion-first/files/legal-service-completion-natural.json) 在响应观察前同样没有语义／状态轮询，也未由测试主动泵送服务或帧；实际仍在第11帧挂载并消费候选、第12帧卸载并提交loading、第19帧应用响应、第20帧重新挂载，锚点 `{7,155}→{0,0}`，`fastUnverified=true`。因此受控保持和自然重置必须分开报告。两项均为同进程Activity重建；事件与帧探针仍写入测试KV且可能影响调度，后续语义检查也会推进帧。原生文字资源就绪、原生参考重跑、自然时序性能及物理操作均未由这组用例证明。

法律完成链的[独立读回审计](../artifacts/foreground-service-results/app-completion-first/readback-audit/audit.md) 核对两例均为真实 `Activity.recreate()`，incoming Bundle未修改、未注入，旧Activity和宿主已释放，但同为PID27744，仍不是进程死亡。每例两次HTTP响应全部写完且无错误，日志无丢弃。受控前后截图相同仅指本Pod重建前后；自然重建后PNG与初始顶部PNG逐字节相同，顶部语义几何最大差1个scene单位，均不构成跨原生像素验收。

法律完成链的索引只枚举8份proof／PNG，完整tar含194个普通文件，二者范围不能混称。审计从tar读取两例精确 `bodyReference` 对应的2345字节正文，核对owner、路径、页面／URL身份摘要、严格UTF-8及正文SHA，并与冻结fixture源码生成的完整正文逐字比较。最终归档KV属于受控场景：依据已验证测试APK中的seed重建，排除唯一自有事件日志后，全部10个键完整深比较相同，事件日志也与controlled最终proof相同。natural单独KV已被随后controlled覆盖，其KV不变结论仅来自instrumentation的完整深比较断言及通过回执；没有独立归档快照。具体收据与检查结果见[审计JSON](../artifacts/foreground-service-results/app-completion-first/readback-audit/audit.json)。

法律页真实进程死亡现有独立的run02证据，目标APK `5516518c…`／测试APK `fb241647…`，见[包身份](../artifacts/legal-process-death/live-after-pump-20260921-02/owned-packages.json)、[协调器最终验证](../artifacts/legal-process-death/live-after-pump-20260921-02/coordinator/20260921T035114939322Z-validate-b76f967c/0034-validation.json) 与[独立原始证据复核](../artifacts/legal-process-death/live-after-pump-20260921-02/audit/independent-legal-process-death-audit.md)。本轮系统先停止并保存Activity，外部 `am kill` 终止旧PID31248，随后新PID2790以原task224、ActivityRecord `72199d3` 恢复；进程实例nonce也不同。恢复使用原系统记录，不是同进程重建或手工清空retained模拟。协调器13个步骤完成且独立复核通过，不将其算作JUnit单项或混入其他APK的18项回归。

旧 `postSave` 与新进程实际 `preCreate` Bundle中的SDK saved字符串逐字节相同：919个UTF-8字节，SHA `4e636e77…`；guest启动前saved已恢复，retained为 `{}`。系统[死亡时Activity记录](../artifacts/legal-process-death/live-after-pump-20260921-02/coordinator/20260921T034925723862Z-kill-b7e1966e/0018-activity-dump.txt) 的 `mIcicle=Bundle[mParcelledData.dataSize=2160]` 是整个序列化Bundle的记录，不能与919字节SDK字符串混称。该次真实保存顺序为 `postStop → postSave`，未假定平台必须先保存后停止。

同一正文引用R及其10174字节UTF-8正文，在初始顶部、死亡前、死亡后、挂起加载和最终恢复五个阶段均核对一致，正文SHA为 `30662ffa…`；owner、精确页面／URL身份及文件引用保持。原 `listAnchor={index:6,offsetPx:7}`、兼容偏移746，在第二次响应挂起期间成为 `isLoading=true`、anchor=null、偏移0，语义树中正文列表缺席；响应完成后anchor为 `{0,0}`，最终可见语义几何逐值等于原始顶部。这个实际过程证明正文引用跨进程保留和加载后归零，未证明快响应时保持旧列表。

同一独立HTTP服务器的精确隐私端点GET数从1增至2，两个响应均为200；另有两次根路径探测，未计入法律请求数。挂起快照先于持久化释放指令约5.383ms，释放时距离服务器10秒截止仍约1.652秒，随后第二次响应完成；采样前后都确认同一request 2仍被挂起。相关原始时间、正文及引用检查见[独立审计JSON](../artifacts/legal-process-death/live-after-pump-20260921-02/audit/independent-legal-process-death-audit.json)。这不等于内部候选消费、挂载次数或事件时序均已验证，后者仍明确为未覆盖。

42份原始KV读回均为完整测试seed文件的357字节，SHA `32569252…`，未排除任何键；一致性限于记录的采样点，比较基准是完整数据备份后写入的seed，不是prepare前原始KV。13个已完成步骤的六个包哈希均保持不变。最终[收集与清理收据](../artifacts/legal-process-death/live-after-pump-20260921-02/final-collection/collection-cleanup.json) 绑定13059584字节、295个tar成员的全文件归档；166份审计输入及最终tar摘要已核验。仅本轮TCP35335反向映射被移除，核对命令行后向独立服务器PID231579发送SIGTERM；这项测试资源清理不等于已发布 `legal-recovery` 文件的生命周期回收。

本轮仅验收 `legal-v2-held` 的外部 `am kill` 进程更替、实际系统saved恢复、正文文件存续、重新请求及语义顶部结果。没有触发低内存回收，没有原生应用进程死亡对照，也没有验证像素、物理操作、快响应进程死亡分支或性能。此前run01在prepare预检中因服务器不满足全新请求条件而[被拒绝](../artifacts/legal-process-death/live-after-pump-20260921-01/root-steps/01-prepare.log)，原始失败保留；随后修正独立根路径404探测，以新nonce重新执行run02，未将失败轮次并入成功记录。

在引入前台服务完成处理之前，法律专项使用目标APK `b5f33459…`／测试APK `4b2d1355…`，普通AndroidJUnitRunner运行 `LegalTopRestorationRuntimeTest`，原始[设备日志](../artifacts/legal-top-restoration/all-three-device.log) 为3项通过、64.642秒。[运行收据](../artifacts/legal-top-restoration/all-three-run.json) 记录测试前后两包哈希相同；[采集索引](../artifacts/legal-top-restoration/device-all-three/collection.json) 收录的16个文件均为本轮新文件，大小与SHA校验一致。这是新增栈顶专项，不替代前一轮 `c79b7f53…` 的既有法律栈用例，也不是全套设备回归。

[等待响应用例](../artifacts/legal-top-restoration/device-all-three/files/legal-top-restoration-held-proof.json) 从 `listAnchor={index:7,offsetPx:155}` 重建：旧正文挂载并消费候选后，记录 `document-unmounted`、`loading-committed`，等待的响应返回后重新挂载为 `{index:0,offsetPx:0}`。这证明该次实际提交加载分支、卸载列表后的重置，而不是按HTTP耗时猜测分支。这里的155是条目内物理偏移，不是整页滚动轴。

[候选尚未挂载便再次重建的用例](../artifacts/legal-top-restoration/device-all-three/files/legal-top-restoration-pending-proof.json) 有两次saved-only模拟。第一次实际传入Bundle的 `isLoading=false`；测试在guest启动前只把宿主saved副本的该字段改为 `true`，并清空retained，实际Android Bundle不变。第二次传入状态自然保存为 `isLoading=true` 且保留 `{7,155}`；此时saved字节不变，只清空retained。最终运行记录 `response-applied → document-mounted → candidate-consumed`，候选只消费一次且仍为 `{7,155}`，没有 `loading-committed`／卸载事件。不能将第一次人工构造的loading状态写成自然保存结果，也不能把loading元数据等同于已提交加载画面。

[即时响应用例](../artifacts/legal-top-restoration/device-all-three/files/legal-top-restoration-immediate-proof.json) 使用真实、未人为延迟的HTTP响应，但实际仍记录候选消费、列表卸载、`loading-committed` 和响应后的重新挂载，锚点 `{7,155}→{0,0}`。proof将分支标为 `immediate-http-but-committed-loading-reset`，保留 `trueFastVerified=false`；这次通过验证的是正确记录并判定实际分支，未覆盖真正响应先于加载提交的保持路径。

三份法律proof均明确 `sameProcessActivityRecreation=true`、`actualProcessDeathVerified=false`。事件日志写入测试KV、语义查询主动推进原生帧，均可能影响调度，因此这些是插桩下的分支观察，不能外推为自然帧时序。原生文字资源就绪屏障、与原生参考重跑和精确像素一致均未验证；这轮也没有物理操作。这组三项不覆盖法律正文文件的真实进程死亡恢复；已发布文件生命周期清理仍待完成。

备案通过原生媒体呈现统一应用入场缩放及透明度。此前冻结相位使用目标APK `9ca70485…`，见[构建收据](../artifacts/beian-native-presentation/app-build-receipt.json)。对应归档[应用测试](../artifacts/beian-native-presentation/app-tests.log) 为673项通过、0失败、52318次断言、98个文件，[类型检查](../artifacts/beian-native-presentation/typecheck.log) 通过。[SDK设备结果](../artifacts/beian-native-presentation/sdk-regression-summary.json) 为15项通过、0失败、1项因API30而跳过的API31模糊用例；[原始日志](../artifacts/beian-native-presentation/sdk-regression-device.log) 与[运行包哈希](../artifacts/beian-native-presentation/sdk-regression-run.json) 保留。通过范围包括呈现帧校验、解码／纹理复用、组合透明度、采样和颜色行为，不包含API31模糊验收。

同一备案目标另装测试APK `b06ec043…`，在OPPO OWW242／Android 30、density=2、Activity本地fontScale约1.8下运行生产 `BeianScreen`；系统全局设置未改。请求相位为0、256、512、992、1504、1664ms，最后一项生产动画有效时长钳制为1650ms。测试逐相位冻结guest时钟并等待稳定帧，宿主定时器保持正常。[设备日志](../artifacts/beian-native-presentation/pod-1.8-device.log) 为1项通过、22.095秒，[运行参数](../artifacts/beian-native-presentation/pod-1.8-run.json) 与[原始proof](../artifacts/beian-native-presentation/pod-1.8/files/beian-animation-proof.json) 一并归档。这是六个暂停相位的设备采样，不是自然播放性能测量。

[原生回读复核](../artifacts/beian-native-presentation/readback-audit/README.md) 核对57次夹具观察、63份原生快照和18次捕获观察：每相位均等待两项原生文字资源上传、一项媒体面就绪、新的发布帧及至少4个后续帧；同一宿主、媒体面、图像源和decodeRevision=1贯穿六相位。实际Style、返回呈现状态及公开RenderNode回读一致：240×222入口位于固定280×258视口的局部(20,18)，中心(120,111)，由512×512线性采样纹理承载；缩放及透明度作用于入口，root／media保持单位变换；这不改变 `outerAlphaScaleReadback=false` 所限定的外层scene属性未回读边界。24张PNG的文件及解码像素摘要通过，六个原生媒体视口补零至纹理大小后的摘要与原生纹理一致，每相位三张窗口PNG逐字节相同。26项文件绑定、归档包和runner哈希均匹配，Activity、原生宿主及自有命令清理通过；详见[复核结果](../artifacts/beian-native-presentation/readback-audit/readback-result.json) 和[收据](../artifacts/beian-native-presentation/readback-audit/receipt.json)。这份复核没有再次运行设备测试，也不替代跨实现像素比较。

新[六相位跨实现比较](../artifacts/beian-native-presentation/comparison-1.8.md) 使用未修改的466×466窗口PNG，在相同坐标直接比较，没有缩放、对齐或滤波；透明补边的原生媒体中间图单独核验，不作为窗口图替代。复用此前成功运行的Native参考，本轮没有重采原生图。六组最大8位RGBA通道差均为1，旧版992ms最大差108在新一轮已不再出现；旧[差异报告](../artifacts/beian-animation-final/comparison-1.8.md) 保留不改。精确统计及文件摘要见[比较JSON](../artifacts/beian-native-presentation/comparison-1.8.json)。

| Native实际经过／Pod请求ms | Pod有效ms | 全图差异像素／217156 | 二维码视口差异像素／72240 | 全图最大通道差 |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 889 | 0 | 1 |
| 256 | 256 | 1278 | 389 | 1 |
| 512 | 512 | 1076 | 187 | 1 |
| 992 | 992 | 1679 | 790 | 1 |
| 1504 | 1504 | 966 | 77 | 1 |
| 1664 | 1650 | 966 | 77 | 1 |

二维码统计采用 `[93,190,373,448)` 的280×258视口。标题／网址每相位分别有431／458个差异像素，最大差1；全部差异位于标题、网址和二维码视口，均无差值大于1的像素。992ms的二维码非黑边界仍为Native `[111,206,355,432)`、Pod `[111,207,355,431)`，不能写成各相位可见边界完全相同。38张原始PNG的文件与ARGB摘要均通过，包含14张复用Native图、18张新Pod窗口图及6张新Pod媒体图；七组Native双图和六组Pod三图各自完全一致。终点行比较的是两端已结束状态，Native实际经过1664ms与Pod有效1650ms并非相同终点时钟。以上仍是API30、所测设备和1.8字号下六个冻结相位的近似结果，不能声明逐像素完全一致、通用渲染容差或API31+模糊通过。

新增[fontScale约1.3冻结相位比较](../artifacts/beian-font-phases-after-pump/comparison-1.3.md) 使用目标 `50cd0f68…`／测试APK `fb241647…`，JNI为 `e77b8c48…`。只采用 `pod-1.3-reference-phases-collection` 的0、256、512、992、1504、1664ms匹配相位；首轮默认相位运行虽通过，但中间时刻与Native不同，未混入比较。[匹配Pod日志](../artifacts/beian-font-phases-after-pump/pod-1.3-reference-phases-device.log) 为1项测试覆盖六相位、21.371秒，复用的Native参考单项为55.021秒。原始466×466窗口图同坐标比较，未修改或重采样；本轮最大8位RGBA通道差达到2，不能沿用1.8轮“全部最大差1”的结论。

| Native实际经过／Pod请求ms | 全图差异像素 | 二维码视口差异像素 | 全图最大通道差 | 差值大于1的像素 |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 954 | 0 | 1 | 0 |
| 256 | 2200 | 1246 | 2 | 2 |
| 512 | 1928 | 974 | 2 | 3 |
| 992 | 2615 | 1661 | 2 | 7 |
| 1504 | 1345 | 391 | 2 | 1 |
| 1664 | 1345 | 391 | 2 | 1 |

1.3轮二维码视口为 `[93,164,373,444)`、280×280；标题／网址每相位分别有674／280个差异像素且最大差1。没有差值大于2的像素，仍非逐像素相同。38张PNG的文件与ARGB摘要均通过，其中14张旧Native、18张匹配Pod窗口及6张媒体图；七组Native双图与六组Pod三图各自相同，63份Pod原生观察含实际入口RenderNode回读。终点仍为Native实际1664ms与Pod有效1650ms，Native参考早于本Pod事件泵版本。runner日志记录了选定远端路径，本地runner已核对哈希与配置，但采集索引没有另行固化其拉取路径／哈希；不能声称该来源绑定已完整归档。详见[1.3完整JSON](../artifacts/beian-font-phases-after-pump/comparison-1.3.json)。这轮仅覆盖API30、所测设备与字号的冻结相位，不证明自然播放、API31+模糊或物理显示，也不与其他APK专项混算。

新增[fontScale 1.0匹配相位比较](../artifacts/beian-font-phases-after-pump/comparison-1.0.md) 单独重采Native与Pod；Native测试APK为 `f8a5fcfb…`，Pod目标仍为 `50cd0f68…`、测试APK为 `8623c973…`。两侧各1项测试覆盖六相位，分别为55.208／21.532秒；两侧均使用隔离字体runner显式覆盖Activity为fontScale=1.0；各记录一个实际Activity、三次fontScale=1.0／density=2观察和八次全局状态不变检查。两侧选定runner的远端路径、拉取结果及SHA均另有独立采集收据；18份归档源码及Pod APK成员身份核对一致，没有混入其他字号截图。

| Native实际经过／Pod请求ms | 全图差异像素 | 二维码视口差异像素 | 全图最大通道差 | 差值大于1的像素 |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 616 | 0 | 1 | 0 |
| 256 | 1862 | 1246 | 2 | 2 |
| 512 | 1590 | 974 | 2 | 3 |
| 992 | 2277 | 1661 | 2 | 7 |
| 1504 | 1007 | 391 | 2 | 1 |
| 1664 | 1007 | 391 | 2 | 1 |

1.0轮仍按原始466×466窗口图同坐标比较，二维码视口为 `[93,156,373,436)`、280×280；标题／网址每相位分别有407／209个差异像素且最大差1，没有差值大于2的像素。38张PNG文件及ARGB摘要、七组Native双图、六组Pod三图和63份就绪原生回读均核对通过。入口为240×240、局部(20,20)、中心(120,120)，512×512纹理线性采样；实际内部入口RenderNode回读不改变外层scene变换未回读的限制。Native运行起点为mainClock=48ms，终态实际经过1664ms时Transition自身playTime已重置为0，Pod请求1664ms则钳制为有效1650ms；本轮比较已结束状态，不声称终态时钟相同。分轮包身份、原始图和runner绑定见[1.0完整JSON](../artifacts/beian-font-phases-after-pump/comparison-1.0.json)。这仍仅为API30、所测设备与字号下的冻结采样，不证明自然播放流畅性、API31+模糊或物理面板效果。

前台事件泵修改前另有[备案正常时钟性能基线](../artifacts/beian-performance-before-event-pump/baseline-analysis/analysis.md)，限定目标 `532abbc6…`、测试APK `a035c65c…`，API30／OPPO OWW242／density=2／fontScale约1.8的一轮；不属于新 `956f4e4c…` 目标。首次变化的CPU纹理写入开始至首次终态CPU写完的1526.352ms区间内，TextureView更新通知间隔P50／P95／最大值为66.652／78.641／82.570ms，22个间隔全部超过两个名义刷新周期；Choreographer回调间隔P50／P95为26.905／59.707ms。持续的稀疏更新不能只归因于启动尖峰，尚不能验收动画流畅性，也不能把这些通知计数称为实际显示FPS或GPU present时序。

该基线的正常时钟窗口终态与指定冻结1664ms窗口图逐字节相同；两者是不同夹具APK，只能在核对共同源码、DEX、JNI及字体后陈述所采终态一致。API30的DEADLINE／GPU_DURATION均为-1，有效deadline分母为0；记录的JNI CPU纹理写入不包括此前的渲染等待、Bitmap读回／getPixels及实际Vulkan GPU上传完成时间，不能用于完整成本分摊。报告把前台服务完成依赖下一帧列为待验证原因，没有将约66ms间隔全部归因于它。原始记录、计时窗口和哈希见[分析JSON](../artifacts/beian-performance-before-event-pump/baseline-analysis/analysis.json)。

事件泵后的[正常时钟对照报告](../artifacts/beian-performance-after-event-pump/after-analysis/analysis.md) 使用另一隔离目标 `b00853f6…`／测试APK `69e170c9…`，JNI为 `e77b8c48…`。[设备日志](../artifacts/beian-performance-after-event-pump/pod-1.8-first-device.log) 为1项通过、7.609秒，包含准备、测量、截图和清理，不是动画时长。这项不与 `956f4e4c…` 的18项功能回归合并为同一APK的19项。前后四份fixture文件逐字节一致，测量Java保持 `616f0569…`，生产页面源码未变；[构建收据](../artifacts/beian-performance-after-event-pump/build-receipt.json) 及[刷新后的SDK源码收据](../artifacts/beian-performance-after-event-pump/source-sdk-current.json) 绑定实际归档版本，当时未加入Java分段诊断；下述另一个APK的诊断轮不属于这次事件泵对照。

前后均为同设备、API30、fontScale约1.8各一轮，按相同的“首次变化CPU写入开始至首次终态CPU写完”规则筛选，区间分别为1526.352／1543.307ms。通知间隔要求两个端点均在窗口内，不把不同观测流逐帧配对：

| 指标 | 事件泵修改前 | 修改后 |
| --- | ---: | ---: |
| TextureView通知间隔P50／P95／最大值 | 66.652／78.641／82.570ms | 64.959／69.384／70.551ms |
| 通知间隔数／超过两个名义刷新周期 | 22／22 | 23／23 |
| Window TOTAL P50／P95／最大值 | 18.378／23.696／27.170ms | 11.673／21.863／22.655ms |
| TOTAL超过名义16.667ms的样本 | 13／23 | 4／24 |

通知中位数本次下降约2.54%，仍持续约65ms；Window TOTAL在这对样本中更低，但尚无重复轮次方差或因果隔离，不能称统计显著或稳定性能改善。JNI CPU纹理写入合计分别为158.386／159.500ms，测量范围仍不包含此前渲染／读回和后续GPU工作，不能宣称完整媒体成本降低。修改后、修改前及指定冻结1664ms的终态466×466窗口PNG逐字节、逐像素相同，证明捕获终态保持，不证明物理呈现或流畅性。两轮API30仍无有效deadline／GPU duration，通知也不代表present、buffer latch或显示FPS；完整统计、原始输入摘要及边界见[对照JSON](../artifacts/beian-performance-after-event-pump/after-analysis/analysis.json)。

新增[Java阶段测量](../artifacts/beian-performance-render-timing/stage-analysis/analysis.md) 使用目标 `a0d1b3fc…`／测试APK `2c53a4f9…`，冻结测量Java为 `00ef2e20…`，SDK媒体服务源码为 `e69c8dc8…`。fixture、字体及JNI与上一轮事件泵APK逐字节相同，185份归档源码和分析输入摘要已核对；见[构建收据](../artifacts/beian-performance-render-timing/build-receipt.json)。[本轮日志](../artifacts/beian-performance-render-timing/pod-1.8-first-device.log) 为1项通过、7.788秒，包含准备、测量、截图与清理，不是动画时长。真实Activity使用局部fontScale约1.8、density=2，全局设置不变；[运行包身份](../artifacts/beian-performance-render-timing/pod-1.8-first-run.json) 及[runner独立采集绑定](../artifacts/beian-performance-render-timing/pod-1.8-first-collection/runner-collection.json) 保留。

该轮共记录30次render和29次dispatch，全部成功，render与同步CPU纹理写入逐条对应。沿用首次变化CPU写入开始至首次终态写完的选择规则，1472.314ms窗口内24次写入所对应的完整render耗时如下；这些调用的完整包络在窗口两端分别超出32.496／0.290ms，不能直接用完整调用合计除以该窗口作为占比。所有数值为包含阻塞的CPU墙钟毫秒，分位数采用最近秩。

| 阶段 | 样本数 | P50／P95／最大值ms | 实际耗时合计ms |
| --- | ---: | ---: | ---: |
| RenderNode录制 | 24 | 0.646／4.945／5.388 | 31.918 |
| syncAndDraw等待 | 24 | 5.317／11.691／15.462 | 160.898 |
| acquire／buffer／wrap | 24 | 0.614／2.907／9.739 | 29.720 |
| 硬件Bitmap复制为软件Bitmap | 24 | 4.713／13.515／15.227 | 140.032 |
| getPixels | 24 | 3.012／7.794／8.887 | 85.946 |
| recycle／close | 24 | 0.821／1.375／1.649 | 21.498 |
| 完整sink wrapper | 24 | 6.030／7.033／7.109 | 146.898 |
| 完整render调用 | 24 | 24.854／38.175／38.343 | 618.556 |

按这24次完整调用的实际耗时求和后计算，copy+getPixels占36.53%，draw占26.01%，sink占23.75%；不能相加各阶段P50。draw含离屏ImageReader surface的 `syncAndDraw(waitForPresent=true)` 等待，读回也可能阻塞，均不等于纯GPU／CPU执行时间。sink包含原JNI CPU写入及其观察记账；同组JNI的P50／P95／最大值为5.930／6.900／6.996ms，不能再与完整sink或render重复相加。dispatch work也包含同步render；其主队列等待P50／P95为10.884／20.369ms，对应UPDATE入队至CPU写完为37.958／50.576ms。严格裁剪后的dispatch／render调用区间并集为618.623ms，未覆盖的853.691ms仍可含JS、native、Vulkan、UI工作或等待，不能称空闲时间或据此算CPU利用率。

同一选择窗口的TextureView通知间隔P50／P95／最大值为65.466／80.381／83.240ms，22个间隔全部超过两个名义刷新周期；Window TOTAL为14.180／22.911／55.254ms，报告丢失0，仍无有效GPU duration／deadline。终态窗口PNG与上一轮事件泵及冻结1664ms参考逐字节、逐像素相同。终态后名义350ms采样尾段还记录3次style／session／decodeRevision相同的render，合计73.796ms；这证明重复处理相同CPU输入，未证明三个独立GPU呈现帧。

这是一轮启用诊断观察者的采样，未校准全部计时开销或重复轮次方差，不作为优化前后收益对照。它补足Java录制、等待、读回及同步sink范围，仍没有测量后续Vulkan纹理分配、上传、fence或物理面板呈现；通知不是显示FPS。JNI与前轮相同，归档CMake指定 `-O2`，不能将耗时归因为未优化的O0构建。完整原始ID关联、边界、分组与限制见[阶段分析JSON](../artifacts/beian-performance-render-timing/stage-analysis/analysis.json)。

同一目标 `a0d1b3fc…` 另配普通AndroidJUnitRunner测试APK `11be7a84…`，`PodMediaSurfaceTimingTest` 的有效[专项日志](../artifacts/beian-performance-render-timing/sdk-timing-ordinary-built-device.log) 为4项通过、0.760秒；[构建收据](../artifacts/beian-performance-render-timing/sdk-ordinary-runner/build-receipt.json) 与[运行收据](../artifacts/beian-performance-render-timing/sdk-timing-ordinary-built-run.json) 绑定本轮测试包并记录前后包哈希不变。这四项覆盖实际图像的dispatch／render因果时间线、sink和像素读回失败时保留原始异常及部分记录、诊断默认关闭且移除观察者后停止，以及观察者AssertionError不改变解码图像或样式输出。它们是SDK诊断专项，不是全SDK回归，也不与另一个测试APK的7.788秒性能用例混称同一轮。此前字体runner因未执行允许的真实Activity而[拒绝首轮](../artifacts/beian-performance-render-timing/sdk-timing-first-rejected-collection/interpretation.json)，随后调用未声明的普通runner也[启动失败](../artifacts/beian-performance-render-timing/sdk-timing-ordinary-device.log)；两次原始结果均保留且不计入通过数。

上述隔离测试均未替换正式PodJS或原生应用，正式包测试前后哈希保持不变。法律自然快响应保持、进程死亡后的快响应路径及低内存回收、备案自然动画流畅性与API31+模糊、其他密度、真实用户资源组合和物理操作仍未完成。已发布 `legal-recovery` 文件继续保留；`finishTask` 请求确认仍不足以证明旧Bundle引用已消失。
