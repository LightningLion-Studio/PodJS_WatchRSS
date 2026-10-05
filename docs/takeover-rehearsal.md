# P3：真实原生数据副本隔离接管演练（lead 执行）

本流程由 lead/设备负责人执行。wrss-minor 本轮仅执行本地构建与测试，设备验收 **PENDING**。
源包固定 `com.lightningstudio.watchrss`；目标固定 `com.lightningstudio.watchrss.podjs.rehearsal`。脚本不读写正式 PodJS 包，不向原生 sandbox 写数据；原生仅 force-stop 与 run-as tar 读取。不会自动重启原生 App，以便前后摘要可比较。

## 1. 本地构建

在已包含 P3 框架 debug phase 日志变更的 worktree 中执行。PocketJS revision 必须与包的 manifest 一致。

```sh
cd /home/wilf/data/PodJS/podjs-watch.wt-minor
bun run test
(cd vendor/pocketjs && bun install --frozen-lockfile)
bun packages/cli/src/cli.ts build --target=android-watch --project=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS
bash scripts/build-android-runtime.sh
cd platforms/android
./gradlew :androidApp:assembleDebug :androidApp:assembleDebugAndroidTest \
  -PpodAppId=com.lightningstudio.watchrss.podjs.rehearsal \
  -PpodAppName=WatchRSSRehearsal \
  -PpodDistDir=/home/wilf/data/PodJS/podjs-watch.wt-minor/dist/projects/com.lightningstudio.watchrss.podjs/android-watch \
  -PpodResDir=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/android/res \
  -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash \
  -PpodTestSourceDir=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/tests/android/rehearsal --offline
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
cd /home/wilf/data/OPPO_Develop/PodJS_WatchRSS
python scripts/device/acceptance.py rehearse-takeover --dry-run \
  --package com.lightningstudio.watchrss.podjs.rehearsal \
  --apk /home/wilf/data/PodJS/podjs-watch.wt-minor/platforms/android/app/build/outputs/apk/debug/androidApp-debug.apk \
  --test-apk /home/wilf/data/PodJS/podjs-watch.wt-minor/platforms/android/app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk
```

预期：`DRY RUN: no subprocesses, local writes, or device I/O` 和计划步骤。dry-run 不检查 APK 内容或连接状态。

## 3. 设备演练

```sh
adb devices
```

预期 `e3aca8af device`。若离线，停止设备步骤，不轮询。保证原生 App 在整个抽取/复核期间保持停止，勿手动打开它。保持手表解锁以便 guest TextureView 出帧。主机 `/tmp` 需容纳原生副本及两份候选导出；设备需容纳复制源与迁移候选。脚本限制单次解包 32 GiB/100 万条，不会绕过迁移器自身空间检查。

```sh
python scripts/device/acceptance.py rehearse-takeover \
  --serial e3aca8af --package com.lightningstudio.watchrss.podjs.rehearsal \
  --apk /home/wilf/data/PodJS/podjs-watch.wt-minor/platforms/android/app/build/outputs/apk/debug/androidApp-debug.apk \
  --test-apk /home/wilf/data/PodJS/podjs-watch.wt-minor/platforms/android/app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk \
  --takeover-timeout 300
```

脚本首先核验 APK，拒绝已存在的演练安装（不会 `install -r`/清数据）。随后：

1. `am force-stop com.lightningstudio.watchrss`；`adb exec-out run-as com.lightningstudio.watchrss tar -cf - databases files shared_prefs`，流式安全解包到 `/tmp/wrss-rehearsal-*/native`，根权限 0700、文件 0600，不落 tar。
2. 安装全新演练 APK/test APK；以原生目录布局流式 tar 导入演练 sandbox；读回确认每个源文件摘要相同。拒绝链接、路径穿越、重复项及源中已有 PodJS/接管目录。
3. 从启动前开始收集 `PodTakeoverPhase` debug 日志，按该启动 PID 筛选，验证七阶段完整顺序；读取 journal 的 ACTIVE/PAUSED/BLOCKED。日志只保留阶段名，不分享 raw logcat。
4. 停止演练包并导出私有副本，确认源复制文件字节不变，journal、active 指针、activation-receipt 的 generation/receipt 一致；oracle 对比所有频道、文章、阅读进度、收藏状态与部分显式设置，不打印数据值。
5. 再次冷启动，必须同一 ACTIVE generation/receipt、没有转换阶段日志，且源复制文件及不可变迁移产物不变。
6. instrumentation 从生产 `PodTakeover` 入口打开 SQLite/KV，启动实际 MainActivity，等待非单色 guest TextureView 帧。测试拒绝在其他包执行，不播种测试数据、不合成输入。
7. 成功或失败均在 finally 再只读抽取原生包，核对完整文件 SHA256。输出 `result.json`，任何失败返回非零。

成功预期：`outcome: PASS`、`nativeUnchanged: true`、`sourceCopyUnchanged: true`、`oracle.pass: true`、`restartNoReimport: true`、`hostReadAndRender: true`。这不等于所有页面/手势/账号联网功能验收通过。渲染测试证明 guest 出帧与生产根可读，不声称逐篇内容的屏幕像素一致。

真实 Android Keystore 密钥不能随着数据目录复制到另一 UID。原生账号/密钥如不可解密，预期是 `BLOCKED`/`needs-reauth` 一类固定原因，不能删除账号文件、伪造确认或绕过阻断来制造 PASS。此时 oracle/第二次启动/guest 验收可能未执行，result 不会标 PASS。由 lead 决定后续用户确认 UI/重认证工作。

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
