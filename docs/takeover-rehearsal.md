# T1：真实原生数据副本隔离接管演练

本流程由当前任务明确授权的设备负责人执行。T1授权wrss-minor独占e3aca8af；真正原生包覆盖仍需另派任务。本轮2026-10-07因充电层无法退出而中止，物理完整演练PENDING，详见 [takeover-readiness.md](takeover-readiness.md)。
源包固定 `com.lightningstudio.watchrss`；目标固定 `com.lightningstudio.watchrss.podjs.rehearsal`。脚本不读写正式 PodJS 包，不向原生 sandbox 写数据；原生仅 force-stop 与 run-as tar 读取。不会自动重启原生 App，以便前后摘要可比较。

## 1. 本地构建

在包含 P5 store policy/diagnostics 的框架 worktree 中执行（T1 app基线2e84513 / framework基线58ab3c4）。PocketJS revision 必须与包的 manifest 一致。

```sh
cd /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1
bun run test
(cd vendor/pocketjs && bun install --frozen-lockfile)
bun packages/cli/src/cli.ts build --target=android-watch --project=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-rs1
bash scripts/build-android-runtime.sh
cd platforms/android
./gradlew :androidApp:assembleDebug :androidApp:assembleDebugAndroidTest \
  -PpodAppId=com.lightningstudio.watchrss.podjs.rehearsal \
  -PpodAppName=WatchRSSRehearsal -PpodVersionCode=28 -PpodCleartextTraffic=true \
  -PpodDistDir=/home/wilf/data/PodJS/podjs-watch.wt-minor-rs1/dist/projects/com.lightningstudio.watchrss.podjs/android-watch \
  -PpodResDir=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-rs1/android/res \
  -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash \
  -PpodTestSourceDir=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-rs1/tests/android/rehearsal --offline
```

预期：`pod: built android-watch`、runtime revision 输出、`BUILD SUCCESSFUL`。
保留一份演练应用 APK；另一个 APK 是必需的 instrumentation runner，不是第二个应用版本。不复制到 artifacts，不生成 userdata tar。

```sh
export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"
apkanalyzer manifest application-id app/build/outputs/apk/debug/androidApp-debug.apk
apkanalyzer manifest debuggable app/build/outputs/apk/debug/androidApp-debug.apk
apkanalyzer manifest application-id app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk
```

预期依次：`com.lightningstudio.watchrss.podjs.rehearsal`、`true`、`com.lightningstudio.watchrss.podjs.rehearsal.test`。Gradle 使用 debug 签名；运行器还解析 test APK manifest，要求 targetPackage 为演练包。

## 2. 无设备 dry-run

```sh
cd /home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-rs1
python scripts/device/acceptance.py rehearse-takeover --dry-run \
  --package com.lightningstudio.watchrss.podjs.rehearsal \
  --apk /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1/platforms/android/app/build/outputs/apk/debug/androidApp-debug.apk \
  --test-apk /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1/platforms/android/app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk
```

预期：`DRY RUN: no subprocesses, local writes, or device I/O` 和计划步骤。dry-run 不检查 APK 内容或连接状态。

## 3. 设备演练

```sh
adb devices
```

预期 `e3aca8af device`。若离线，停止设备步骤，不轮询。任何设备命令前先截图检查系统充电层，按DEVICE_BRIEF的BACK/264/265/HOME顺序逐次截图；关不掉立即停止设备步骤，**不得先启动演练再检查**。装新包后第一张稳定首页须对K8尺寸/布局核对，迁移过程中恢复页不能替代首页比对。保证原生 App 在整个抽取/复核期间保持停止，勿手动打开它。保持手表解锁以便 guest TextureView 出帧。主机 `/tmp` 需容纳原生副本及两份候选导出；设备需容纳复制源与迁移候选。脚本限制单次解包 32 GiB/100 万条，不会绕过迁移器自身空间检查。

```sh
python scripts/device/acceptance.py rehearse-takeover \
  --serial e3aca8af --package com.lightningstudio.watchrss.podjs.rehearsal \
  --apk /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1/platforms/android/app/build/outputs/apk/debug/androidApp-debug.apk \
  --test-apk /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1/platforms/android/app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk \
  --takeover-timeout 300
```

脚本首先核验 APK，拒绝已存在的演练安装（不会 `install -r`/清数据）。随后：

1. `am force-stop com.lightningstudio.watchrss`；`adb exec-out run-as com.lightningstudio.watchrss tar -cf - databases files shared_prefs`，流式安全解包到 `/tmp/wrss-rehearsal-*/native`，根权限 0700、文件 0600，不落 tar。
2. 安装全新演练 APK/test APK；以原生目录布局流式 tar 导入演练 sandbox；读回确认每个源文件摘要相同。拒绝链接、路径穿越、重复项及源中已有 PodJS/接管目录。
3. 从启动前开始收集 `PodTakeoverPhase` debug 日志，按该启动 PID 筛选，验证七阶段完整顺序；读取 journal 的 ACTIVE/PAUSED/BLOCKED。日志只保留阶段名，不分享 raw logcat。
4. 停止演练包并导出私有副本，确认源复制文件字节不变，journal、active 指针、activation-receipt 的 generation/receipt 一致；完整oracle独立重建全部导入SQL表、reader catalog/selection/schedule并核对每个文件资产和store源字节；host verify负责支持的全store映射/secure回读，独立Python额外核对部分显式settings，不输出值或secret摘要。
5. 再次冷启动，必须同一 ACTIVE generation/receipt、没有转换阶段日志，且源复制文件及不可变迁移产物不变。
6. instrumentation 从生产 `PodTakeover` 入口打开 SQLite/KV，启动实际 MainActivity，等待非单色 guest TextureView 帧。测试拒绝在其他包执行，不播种测试数据、不合成输入。
7. 成功或失败均在 finally 再只读抽取原生包，核对完整文件 SHA256。输出 `result.json`，任何失败返回非零。

成功预期：`outcome: PASS`（或下述 P5 `PASS_WITH_KNOWN_DIFFERENCES`）、`nativeUnchanged: true`、`sourceCopyUnchanged: true`、`oracle.pass: true`、`restartNoReimport: true`、`hostReadAndRender: true`。这不等于所有页面/手势/账号联网功能验收通过。渲染测试证明 guest 出帧与生产根可读，不声称逐篇内容的屏幕像素一致。

P5 更新：真实 Android Keystore 密钥不能随着数据目录复制到另一 UID。固定的 rehearsal applicationId **且 debuggable** 才开启隔离政策；结构正确的加密 store 若缺失原生 master alias，记为 `isolated_uid_keystore_unavailable` 已知差异，保持源和 ciphertext snapshot 不变，目标不伪造账号/密钥，继续 core oracle、第二次启动和实际 guest render。所选 TTS 的密钥因此不可读时，保留原设置副本并暂不发布可操作的 TTS config，不修改其他设置。

完整核心验收通过且有已知差异时输出 `outcome: PASS_WITH_KNOWN_DIFFERENCES`（退出码 0），并包含 `storeDiagnostics` 的固定 store 名/类别/原因；`accountKeystoreParity: PENDING`。该结果证明其余数据迁移和重启/出帧，不证明账号/密钥接管。WebView 版本缓存、旧 toast 限流状态、安装时间元数据和已验证的 native route home fallback 也会显式列为已知差异。额外未知 store/key、XML/protobuf/keyset/schema 错误、备份冲突、配额、非预期 crypto 异常和 cloud binding 未证明仍 BLOCKED；不得把它们当作 UID 差异。用户锁定继续 PAUSED/retry。

正式模式按原生 WatchAccountStore、EncryptedBiliAccountStore、EncryptedDouyinCookieStore 的 recoverable crypto 行为发布未登录账号并记录 `needs-reauth`，同时保留其余数据；不删除任何源 XML 或 Keystore alias。LLM/TTS 原生没有同样的 crypto-recovery 实现，在正式模式不可解密仍阻塞等待确认；云密钥/缓存绑定限制保持。正常可解密时 Bili session/refresh/WBI 与 Douyin cookie 写入现有消费者的 secure key。新的 isolated converter 版本不能被正式模式 admission 使用。

真正接管必须是系统接受的同包名签名兼容升级，保留安装和 UID（不能卸载重装）。Android app Keystore 的 APP namespace 按 caller UID 隔离；因此保留 UID、同一 alias 和加密 AAD 时可以继续访问仍有效的原生 key。这是框架机制推论，仍需真升级设备验证；包名相同本身不保证密钥可用。[AOSP Keystore namespace](https://source.android.com/docs/security/features/keystore)、[Android Keystore](https://developer.android.com/privacy-and-security/keystore)。

## 4. 私有证据与 oracle 复跑

运行打印唯一 `/tmp/wrss-rehearsal-*` 路径。该目录包含真实用户数据，勿上传或复制进仓库。`native-sha256.json`、`native-after-sha256.json` 含私有文件路径，仅供本地比较；对外只分享不含值的 `result.json`。

将下方路径替换为本次实际目录与 journal 中实际 generation（不是粘贴通配符）：

```sh
python scripts/migration/takeover_oracle.py \
  --native /tmp/wrss-rehearsal-REPLACE/native \
  --candidate /tmp/wrss-rehearsal-REPLACE/first/files/package-takeover/generations/g-REPLACE
```

oracle 只在另建的私有临时副本内打开 SQLite/WAL；输出计数和布尔值。无原生设置文件时显式记录 `sourcePresent: false, checkedKeys: 0`，空数据集不能算该类别真实数据覆盖。

## 5. 失败回收与重跑

仅卸载下列两包，不对原生或正式 PodJS 包 clear/uninstall/install：

```sh
adb -s e3aca8af uninstall com.lightningstudio.watchrss.podjs.rehearsal.test
adb -s e3aca8af uninstall com.lightningstudio.watchrss.podjs.rehearsal
```

预期 `Success`；未装的包可能返回不存在。原生数据不受影响。清理本次打印的私有目录时务必使用准确路径；也可运行演练时加 `--cleanup-private`，在最终摘要打印后自动删本次主机副本（不会自动卸载设备包）。保留证据审查后才清理；进程被强杀时需人工回收私有目录和演练包。

## P5 离线诊断与复跑预期

旧 P4 结果实际先由 `WebViewChromiumPrefs` 的 retained 字段触发 `store_unsupported_or_failed`，不是先由账号阻断。旧私有报告另有 app resume、settings toast throttle、installation 元数据、未识别的 Bili/Douyin encrypted store，以及 WatchAccount/LLM crypto unavailable，共 8 个非 ready store。旧版只有泛化 crypto reason，不能从该旧报告证明具体底层异常；新版本区分缺 master 与认证/格式故障。只对外分享 `storeDiagnostics`，不要 cat 私有 `stores-report.json`（旧版可能有未脱敏的加密 key 名）。

lead 回来后按第 1 节重建最新 app/test APK，再按第 3 节用设备负责人独占设备复跑（300 秒 launch 超时保持不变）。原 t04 两演练包已卸载；如新演练包存在，只由设备负责人按第 5 节精确卸载后重跑。

预期原数据：七阶段到 ACTIVE；`storeDiagnostics.blockerCount: 0`，WatchAccount/LLM/Bili/Douyin 可能出现 `isolated_uid_keystore_unavailable`；native/sourceCopy 均 unchanged；oracle、restartNoReimport、hostReadAndRender 全通过；outcome 明确 `PASS_WITH_KNOWN_DIFFERENCES`、accountKeystoreParity PENDING。若仍 BLOCKED，按新增固定 store/category/reason 排查；不跳过新的格式、未知字段或文件绑定问题。此会话不执行任何设备命令。

P5 同时修正真实副本暴露的两项离线问题：store 回读用 JSON 结构比较，避免对象字段序列化顺序导致假失败（仍拒绝值、类型和数组顺序变化）；71 个已确定非用户文件（70 个原生 androidTest 的 exact prefix + UUID `.preferences_pb`，1 个 AndroidX ProfileInstaller 8 字节戳）保留在 private snapshot，不导入 guest。测试 DataStore 必须能按 protobuf 严格解码；近似/未知文件名、坏 protobuf 或错误 marker 长度仍拒绝。原生 TestAppContainer 是前一类的源码依据；后一类依据 [AndroidX ProfileInstaller 源码](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/profileinstaller/profileinstaller/src/main/java/androidx/profileinstaller/ProfileInstaller.java)。

离线复跑命令（显式注入 missing-key；不是 Android Keystore、字体或设备验收）：

```sh
cd /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1
bash scripts/benchmark-takeover.sh --isolated-stores /tmp/wrss-rehearsal-ma0pqm53/native
```

本轮：store_blockers=0、known_differences=8、bundle_blocker=none，source_unchanged=true；core oracle 的 16 频道、6006 文章、50 阅读位置、6 收藏/稍后读状态、4 保存时间与 3 个显式设置均一致。私有临时候选随命令结束删除，无 tar。设备七阶段、Android crypto 分类、restart 和 render 仍 PENDING。

## T1 完整差分与真实进程中断

普通一轮验收和清理完成后，用同一命令加 `--interrupt-phase COPYING` 跑第二轮（仍要求演练包未安装，拒绝覆盖/清数据）。控制器观察COPYING后只force-stop演练包，重启要求新PID、同generation、最终ACTIVE与聚合七阶段顺序；完整oracle、immutable receipt、二启不重导及guest instrumentation仍全部必须通过。仅有mock单测通过不能记设备interruptionRecovered。

完整oracle：`scripts/migration/takeover_complete_oracle.py --native <private/native> --candidate <private/generation>`。它使用已有独立Python离线映射，逐表比较nullable值/JSON/主键及sqlite_sequence，reader集合按身份比较不依赖枚举顺序，验证各snapshot/asset/store SHA256。仅排除规范中重建的sync revision及派生cache表；这些表的生产重建由框架file-consumer oracle验证。临时metadata-only tar只装2个prefs和空资产名字，不含数据库/媒体快照，随私有scratch立即删除；不生成完整userdata tar。secret校验依赖host verify与明确P5差异，不能用源密文字节相等声称凭据已可用。

可在无设备时用新oracle扩展现有私有副本replay：

```sh
cd /home/wilf/data/PodJS/podjs-watch.wt-minor-rs1
PODJS_TAKEOVER_ORACLE=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-rs1/scripts/migration/takeover_complete_oracle.py \
WATCHRSS_APP_SOURCE=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-rs1 \
bash scripts/benchmark-takeover.sh --isolated-stores /tmp/wrss-rehearsal-REPLACE/native
```

本轮本地replay通过，物理runner在COPYING时因充电安全门中止控制器：本次before摘要存在，无after摘要和result.json；不宣称nativeUnchanged、ACTIVE、二启或出帧。恢复设备任务时先比对原生after摘要，再只卸载演练app/test包，重跑两轮并最终回正式PodJS首页。保留主机私有副本便于复核，不复制进仓库。
