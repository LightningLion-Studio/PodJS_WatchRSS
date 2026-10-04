# 启动门控真机验证包

此包直接挂载生产 `StartupGate`，仅以计数主页替代正式主页。`assets -> ../../assets` 必须保留；构建日志中出现 `not found` 或 `placeholder` 时不得使用画面作为证据。

独立包 ID 为 `dev.podjs.tests.startup`，instrumentation 包为 `dev.podjs.tests.startup.test`。测试源码为 `../android-startup/StartupRuntimeTest.java`。安装前确认这两个 ID 未被占用；安装后记录 APK 哈希，清理时再次校验。禁止给正式包写测试同意记录。

测试通过 SDK 的语义动作调用当前按钮的真实 `onPress`，不注入触摸、按键、滚轮或焦点事件。它验证：

- 隐私拒绝后 Activity 销毁，全部测试数据不变。
- 隐私同意后仅版本字段改变，Activity 销毁；下次启动只挂载一次主页。
- 首次引导未同意时不挂载主页、不保存同意记录，并显示协议错误。
- 损坏启动记录不被覆盖，重试继续显示错误。
- 宿主禁止引导滑动退出、主页恢复默认；包内 `sendBack()` 验证正文和引导内部返回。

`startup-proof.json`、三张 `startup-*.png` 存在目标包的内部 files 目录。仅限本测试包使用 `run-as` 提取。比较 JSON 时使用递归排序比较，不能将 KV 序列化键顺序变化视为数据损坏。

测试还覆盖完整首次引导离线完成：勾选协议、演示字号／音量上限、列表滚动、离线取消与确认、保存版本及再次启动。`onboarding-completion-proof.json` 单独记录该路径。

已有预设主题往返测试验证浅色选择跨重启保留、切回深色后全部 KV 与初始值相等，结果为 `onboarding-theme-proof.json`。该测试依赖 `tests/android-startup/assets/theme-seed.json`；构建 instrumentation 时必须通过 `-PpodTestAssetsDir` 指向此 assets 目录。

本测试不证明正文嵌套返回和滚动恢复、真实用户阅读背景、Android 状态恢复、物理输入或逐像素一致性。

系统内部 `canScroll` 查询可能受隐藏 API 过滤，测试记录该限制，不更改系统策略。系统容器实现另用同机 framework 的 DEX 指令核对。宿主状态和回调通过不代表物理滑动或按键通过。

宿主状态测试通过仅在本包设置 `activity-state-fixture` 进入独立探针，使用公开 activityState 接口后执行实际 Activity.recreate。结果为 `activity-state-proof.json`；真实进程死亡未验证，也不代表生产引导 UI 已接入恢复。

生产引导草稿恢复测试现已接入：实际 Activity.recreate 检查协议错误、勾选和自定义页页码，以及离线完成路径中的确认弹窗恢复；正常退出重开重置草稿，全部 KV 比较确认恢复不写入同意。结果为 `onboarding-restoration-proof.json`。这更新了上面的 Android 状态恢复覆盖边界；自定义数值、滚动、协议页面栈及真实进程死亡仍未覆盖。

自定义分支现有独立 `customizationDraftAndScrollRestoreOnlyWhileStepRemainsMounted` 用例（`onboarding-customization-restoration-proof.json`）：两个实际 Activity.recreate 保留四个演示值和可见节点位置，关闭滚轮音量隐藏防干扰但保留其值，实际离页返回恢复四值及滚动默认，逐步比较全部 KV。几何允许 1px；不注入物理输入。它更新前文自定义恢复未覆盖的阶段说明；Bundle-only pending 仍只有模型测试，真实进程死亡与原生重建对照未覆盖。

后续协议与说明页覆盖见 `../../docs/onboarding.md`。`InformationDocumentRuntimeTest` 通过生产 `InformationDocument` 的公开滚动句柄定位，并实际执行系统 Activity.recreate，验证中段及真实底部的像素／几何恢复、旧命令未重放，以及原生文字资源已上传并绑定。直接读取的场景语义坐标是逻辑像素，必须按运行时 metrics 换算后才能与物理滚动位置相加。段落容器含段前间距，其边框不能当成原生 Text 内容边框。

`StartupRuntimeTest.performAction` 在同一主线程任务内取得新快照并提交其节点／哈希，避免原生异步排版导致整树哈希过期。动作被接受后不会重放。原始失败与修正后的定向结果分别保存于 `artifacts/information-document-final/`、`artifacts/information-document-test-fix/`。真实进程死亡使用单独的 `../android-process-death/` Application harness；不能在目标 instrumentation 进程内冒充该边界。
