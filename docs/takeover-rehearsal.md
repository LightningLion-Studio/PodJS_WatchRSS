# T5 固定基线与 T6 同 UID 合成账号链（2026-10-07）

本节替代下文 T2 的 source39 基线及“跨 UID 导入后账号不可用”的合成夹具流程。
原生恢复分支为 `Android_WatchRSS.wt-recovery` 的 `podjs-recovery-40`：
基于本地 main **6bb99ed4**（1.3.2-13、业务 code40），重放 T2 `3d31ec31` 和
T4 `9563c88`。seed40 与 recovery900000 都使用这棵业务树及 WorkManager 2.11.2；
所以本轮 seed workdb 可以已经是 schema24，不能声称物理测到了 2.10.1/schema23。
schema23→24 的单测证据在 T4，物理历史版本迁移另验。

本节是 **T6 设备负责人执行单**；T5 只构建/编译，未安装、播种或操作设备。
所有应用 APK 固定 `com.lightningstudio.watchrss.podjs.rehearsal`，同 debug 证书、
`40 < 1000 < 900000`，持续 `install -r`，因而应保留同 UID 和该 UID 的 AndroidKeyStore。
仍须记录实际 UID 三次相等；appId 相同或安装成功本身不是解密证据。
正式 PodJS/native 包及手机不在本演练范围。不得卸载、clear-data、降级或复制真实账号。
若已有隔离安装，先由负责人确认其归属/处理方式；不要为本链自动删除。

## 主机构建与身份门

以下使用 bash。Gradle 使用本机支持的 JDK（本轮 JDK21），不读取生产签名 properties。
两个原生应用 APK 是 T5 明确要求的例外；只保留下面两份隔离候选，不再复制到 artifacts。
测试 APK 是 Gradle 输出，仅由 T6 按阶段安装；测试代码没有打入应用 APK。

```sh
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export ANDROID_HOME=/home/wilf/Android/Sdk
WRSS_APP=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS
WRSS_NATIVE=/home/wilf/data/OPPO_Develop/Android_WatchRSS.wt-recovery
WRSS_FRAMEWORK=/home/wilf/data/PodJS/podjs-watch
WRSS_PKG=com.lightningstudio.watchrss.podjs.rehearsal
WRSS_OUT="$WRSS_APP/.codex-tmp/t5"
mkdir -p "$WRSS_OUT"
cd "$WRSS_NATIVE"
./gradlew :app:testDebugUnitTest assembleDebug \
  -PrecoveryRehearsal=true -PrecoveryVersionCode=900000 --offline
cp app/build/outputs/apk/debug/app-debug.apk "$WRSS_OUT/recovery900000.apk"
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest \
  -PrecoveryRehearsal=true -PrecoveryFixture=true -PrecoveryVersionCode=40 --offline
cp app/build/outputs/apk/debug/app-debug.apk "$WRSS_OUT/seed40.apk"
# 不复制 test APK；当前输出可以同时检查 code40 和恢复900000。
WRSS_NATIVE_TEST="$WRSS_NATIVE/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"

# 主线框架已有 podTestSourceDir 接口，无需修改框架源码。
bun "$WRSS_FRAMEWORK/packages/cli/src/cli.ts" build --target=android-watch --project="$WRSS_APP"
cd "$WRSS_FRAMEWORK"
bash scripts/build-android-runtime.sh
cd platforms/android
./gradlew :androidApp:assembleDebug :androidApp:assembleDebugAndroidTest --offline \
  -PpodAppId="$WRSS_PKG" -PpodAppName=WatchRSSRecoveryRehearsal \
  -PpodVersionCode=1000 -PpodTakeoverSourceVersionCode=40 -PpodCleartextTraffic=true \
  -PpodDistDir="$WRSS_FRAMEWORK/dist/projects/com.lightningstudio.watchrss.podjs/android-watch" \
  -PpodResDir="$WRSS_APP/android/res" -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash \
  -PpodTestSourceDir="$WRSS_APP/scripts/migration/rehearsal-credentials"
WRSS_PODJS="$WRSS_FRAMEWORK/platforms/android/app/build/outputs/apk/debug/androidApp-debug.apk"
WRSS_PODJS_TEST="$WRSS_FRAMEWORK/platforms/android/app/build/outputs/apk/androidTest/debug/androidApp-debug-androidTest.apk"

WRSS_ANALYZER="$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer"
WRSS_SIGNER="$ANDROID_HOME/build-tools/36.1.0/apksigner"
for apk in "$WRSS_OUT/seed40.apk" "$WRSS_PODJS" "$WRSS_OUT/recovery900000.apk"; do
  "$WRSS_ANALYZER" manifest application-id "$apk"
  "$WRSS_ANALYZER" manifest version-code "$apk"
  "$WRSS_ANALYZER" manifest version-name "$apk"
  "$WRSS_ANALYZER" manifest debuggable "$apk"
  "$WRSS_SIGNER" verify --print-certs "$apk"
  sha256sum "$apk"
done
"$WRSS_ANALYZER" manifest print "$WRSS_NATIVE_TEST"
"$WRSS_ANALYZER" manifest print "$WRSS_PODJS_TEST"
```

判定：三个 appId 完全相等、实际 code 为 40/1000/900000、debuggable=true、
公开证书 SHA256 相等；native versionName 为 `1.3.2-13` / `1.3.2-13-podjs-recovery`。
两个 instrumentation manifest 的 targetPackage 必须是隔离 appId；runner 分别为
`com.karumi.shot.ShotTestRunner`、`androidx.test.runner.AndroidJUnitRunner`。
未通过身份门不得安装。T5 只验证两个原生应用 APK 和测试源码编译，PodJS1000
完整 APK/JNI 的重建和三 APK 证书门由 T6 执行；不要把旧 APK 当这次源码的产物。

## 设备阶段（仅 T6 授权后执行）

先读 DEVICE_BRIEF；只用 `e3aca8af`，满足充电/系统弹窗安全门。截图尺寸先比 K8，
异常立即停；空白/黑屏判断要记录 ROI 非零像素、颜色分布及参照 MAE。
以下测试只报告 stage/uid/三个 matches 布尔值，不导出凭据或密钥。
fake Watch token、Bili cookie 和 Douyin cookie 是源码中的固定 `t5-fake-*`，
Watch backend/telemetry 使用 `https://rehearsal.invalid`，不进行登录或真实账号操作。

```sh
umask 077
WRSS_PRIVATE=$(mktemp -d /tmp/wrss-t6-XXXXXXXX)
adb -s e3aca8af shell pm path "$WRSS_PKG"
# 必须为未安装；已有安装时停止，不能卸载/清数据绕过。
adb -s e3aca8af install "$WRSS_OUT/seed40.apk"
adb -s e3aca8af install -r "$WRSS_NATIVE_TEST"
adb -s e3aca8af shell am instrument -w -r \
  -e class dev.podjs.takeover.RehearsalCredentialsTest#seedNative40 \
  "$WRSS_PKG.test/com.karumi.shot.ShotTestRunner" > "$WRSS_PRIVATE/seed40.txt"
adb -s e3aca8af shell dumpsys package "$WRSS_PKG" > "$WRSS_PRIVATE/seed40-package.txt"
adb -s e3aca8af shell am start -W -n "$WRSS_PKG/com.lightningstudio.watchrss.MainActivity"
# 原生频道/正文/设置/备忘录/媒体等完整业务夹具沿下文 T2 另播种和核验。
# seedNative40 已用生产 DefaultAppContainer 打开 Room18，账号由原生三个存储 API 写入。
adb -s e3aca8af shell am force-stop "$WRSS_PKG"
adb -s e3aca8af shell run-as "$WRSS_PKG" sha256sum \
  shared_prefs/watchrss_account_state.xml shared_prefs/bili_account_store.xml \
  shared_prefs/douyin_account_store.xml files/recovery-rehearsal/seed.json \
  > "$WRSS_PRIVATE/seed-credentials.sha256"

adb -s e3aca8af install -r "$WRSS_PODJS"
adb -s e3aca8af install -r "$WRSS_PODJS_TEST"
adb -s e3aca8af shell am start -W -n "$WRSS_PKG/dev.podjs.androidwatch.MainActivity"
# 等实际 ACTIVE 后按尺寸门检查首页，再执行只读 secure.get 探针。
adb -s e3aca8af shell am instrument -w -r \
  -e class dev.podjs.runtime.RehearsalCredentialProbe \
  "$WRSS_PKG.test/androidx.test.runner.AndroidJUnitRunner" > "$WRSS_PRIVATE/podjs1000.txt"
adb -s e3aca8af shell dumpsys package "$WRSS_PKG" > "$WRSS_PRIVATE/podjs1000-package.txt"
adb -s e3aca8af shell run-as "$WRSS_PKG" cat files/package-takeover/active \
  > "$WRSS_PRIVATE/active.properties"
# 从 active.properties 人工核对同 journal/activation-receipt 的 generation，并填 WRSS_G。
# WRSS_G 仅允许 [A-Za-z0-9_-]+，不把未知外部文本直接拼接执行。
WRSS_G=REPLACE_WITH_VERIFIED_GENERATION
adb -s e3aca8af shell run-as "$WRSS_PKG" sh -c \
  "'cd files/.podjs-takeover-backup/$WRSS_G/data && sha256sum shared_prefs/watchrss_account_state.xml shared_prefs/bili_account_store.xml shared_prefs/douyin_account_store.xml files/recovery-rehearsal/seed.json'" \
  > "$WRSS_PRIVATE/backup-credentials.sha256"
cmp "$WRSS_PRIVATE/seed-credentials.sha256" "$WRSS_PRIVATE/backup-credentials.sha256"
# 二次 force-stop/start，再跑同探针；ACTIVE generation 和 backup 摘要不变。
adb -s e3aca8af shell am force-stop "$WRSS_PKG"
adb -s e3aca8af install -r "$WRSS_OUT/recovery900000.apk"
adb -s e3aca8af install -r "$WRSS_NATIVE_TEST"
adb -s e3aca8af shell am start -W -n "$WRSS_PKG/com.lightningstudio.watchrss.MainActivity"
adb -s e3aca8af shell am instrument -w -r \
  -e class dev.podjs.takeover.RehearsalCredentialsTest#verifyRecovered900000 \
  "$WRSS_PKG.test/com.karumi.shot.ShotTestRunner" > "$WRSS_PRIVATE/recovery900000.txt"
adb -s e3aca8af shell dumpsys package "$WRSS_PKG" > "$WRSS_PRIVATE/recovery900000-package.txt"
adb -s e3aca8af shell am force-stop "$WRSS_PKG"
adb -s e3aca8af shell run-as "$WRSS_PKG" sha256sum \
  shared_prefs/watchrss_account_state.xml shared_prefs/bili_account_store.xml \
  shared_prefs/douyin_account_store.xml files/recovery-rehearsal/seed.json \
  > "$WRSS_PRIVATE/restored-credentials.sha256"
cmp "$WRSS_PRIVATE/seed-credentials.sha256" "$WRSS_PRIVATE/restored-credentials.sha256"
# 再次 start + verifyRecovered900000，检查不重复恢复、不覆盖恢复后新写入。
```

每次 instrument 必须出现 **OK (1 test)**、无失败/进程崩溃；不能只看 adb exit0。
三段报告 UID 必须与 seed marker、installed package userId 相同，三个 matches=true。
PodJS 探针通过生产 `secure.get` 读取 ACTIVE secure.store，逐值比较 Watch access/refresh
token、Bili session/csrf/refresh、Douyin cookie，并核验 backup 原始密文字节未变。
恢复测试在独立进程以原生默认存储名读回完整账号对象，核验没有触发原生清空/修复逻辑；
禁止重新 seed 或手工重新登录掩盖失败。native wrappers 遇到损坏可能执行自身 repair，
任何 mismatch/密文变化立即失败并保留证据，不能反复运行测试直到通过。

以上密文摘要文件只存本机 0700 私有目录，报告仅写相等布尔值，不公开 secret digest。
完整四根 manifest/planned paths、空目录、backup seal/ready 和 `.podjs-recovery-state/G/complete`
仍按下文 T2 核验；不要只凭三账号通过声称整个数据恢复通过。恢复启动后 Room/WorkManager
可能写数据库，不能以运行后的整库 SHA 相等代替恢复阶段字节校验及行/UUID语义检查。
T4 的 jobs receipt、PodJS unique work 不再执行、native debug unique 唯一、二启不重播取消
另逐项记录；本轮 seed 已是 WorkManager2.11.2，这不覆盖历史 schema23 物理迁移。

通过这一链只能证明**同隔离 UID 的合成凭据**可迁移和恢复，不能证明真实账号有效、
正式签名轮换、WebView 登录态、网络登录/刷新或正式包升级。其余业务/中断/清理验收仍
PENDING。完成后按负责人要求回正式 PodJS 首页；本节不授权清理任何现存正式数据。


---

以下为历史 T1/T2 执行记录；基线与同 UID 合成账号以顶部 T5 为准。

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

## T2：原生备份 → 同隔离包恢复 → 公测后显式清理

2026-10-07。wrss-c **没有任何设备操作**。以下仅供有设备独占权的 wrss-minor/设备负责人
执行；开始前仍遵循 DEVICE_BRIEF 和充电层安全门。所有安装、force-stop、run-as 操作仅针对
`com.lightningstudio.watchrss.podjs.rehearsal`，不使用正式/native包作为覆盖目标。
不得 uninstall/clear-data/downgrade 绕过演练流程；不用生产签名，也不读取/打印签名密码。

T2 将原生源从原路径 rename 到备份。因此前文旧 runner 的 `sourceCopyUnchanged`
（假设原文件仍在原路径）不能直接套用，旧 `rehearse-takeover` **尚不验证T2恢复链**。
恢复演练改为比较 originalRelativePath → backup data → restored originalRelativePath
三个位置的逐文件大小/SHA256，并额外验证空目录；不要把原路径缺失判成数据丢失。

### 构建和版本台账

framework/app 分支均为 `c/takeover-backup`，worktree均为 `.wt-c`；原生独立目录
`/home/wilf/data/OPPO_Develop/Android_WatchRSS.wt-recovery` 为 `podjs-recovery`。

1. 原生隔离起点：在 recovery worktree 运行下列命令，得到同隔离包 debug APK code40。
   将此**隔离**APK作为起点安装，播种已验证的**合成 Room v18 + prefs/DataStore + 文件**
   夹具，或将既有经授权获得的私有原生副本导入隔离沙箱。不得为T2临时读取正式/native数据。
   原生起点启动后验证频道、阅读正文、设置、备忘录、离线媒体和 reader assets；记录基线
   counts/摘要，force-stop隔离包后才切换实现。不同UID不能导入真实Keystore，账号项PENDING。

   ```sh
   cd /home/wilf/data/OPPO_Develop/Android_WatchRSS.wt-recovery
   ./gradlew :app:assembleDebug --offline --no-daemon \
     -PrecoveryRehearsal=true -PrecoveryFixture=true -PrecoveryVersionCode=40
   ```

2. 在 app wt-c 运行 `bash scripts/migration/build_recovery_rehearsal.sh`，仅主机构建：
   framework 的 `:androidApp:assembleDebug` 为 code1000，native恢复包为 code900000。
   两者同固定隔离appId及本机debug证书；不打正式release，不加载原生签名properties。
   原生起点APK已安装后，重建900000会替换同一路径的40APK，不额外保留起点APK。

3. 构建后分别用 `apkanalyzer manifest application-id/version-code/debuggable` 和
   `apksigner verify --print-certs` 检查三阶段身份、40 < 1000 < 900000、debug=true、
   同debug公有证书。不要根据Gradle参数猜实际APK。APK位置：
   framework `platforms/android/app/build/outputs/apk/debug/androidApp-debug.apk`；
   native `app/build/outputs/apk/debug/app-debug.apk`。脚本构建并不证明设备安装或原生可用。

生产版本统一前向台账：首次接管保留1000..899999，恢复900000..999999；恢复900000后
下一轮PodJS至少1001000，下一轮恢复1900000。已发布最高code由全部渠道核实，未知就
不能发布。`python scripts/migration/allocate_takeover_version.py --highest-published 40
--kind podjs` 仅输出建议1000；不自动分配或发布。每次台账需记录 package、渠道、
最高code、分配code、app/framework/native修订、APK hash、公有cert、beta状态及清理阈值。
本轮原生提交基线source39，T1观察40；其业务源码差异仍需发布负责人核对。
Android要求新code大于安装code，见[官方版本管理](https://developer.android.com/studio/publish/versioning)。

### 设备负责人的精确验收顺序

1. 安装前验证全部APK均为固定隔离appId；仅隔离包原地 `install -r` 从native40覆盖为
   PodJS1000。不得卸载、清数据或 `-d`。等完整ACTIVE，检查首页对K8尺寸/布局和像素统计。
   读取私有journal/active/activation-receipt，要求同generation/receipt；读取
   `native-backup-receipt`，与backup seal、manifest规范摘要一致。
2. 备份 `files/.podjs-takeover-backup/G/data` 的全部源路径、字节、空目录与夹具基线相等；
   包括数据库/WAL/SHM、prefs、files/datastore及所有native files/no_backup条目。
   仅保留本地私有摘要，不打印账号值、设置值、secret digests或分享manifest。
   两次冷启动仍同ACTIVE，不重导；在PodJS新建一个合成note，确认backup摘要始终不变。
3. force-stop隔离包；只对同隔离包 `install -r` 覆盖native900000恢复APK并启动
   `com.lightningstudio.watchrss.MainActivity`（完整component的package仍为隔离包）。
   恢复入口在Application.attachBaseContext、先于providers/stores；不能靠普通onCreate
   恢复，因为[Application文档](https://developer.android.com/reference/android/app/Application)
   明确providers不在onCreate的先行保证范围。失败应 `podjs_recovery_pending`，不继续打开空库。
4. 成功后检查 `files/.podjs-recovery-state/G/complete`；原生所有planned paths逐文件相等，
   备份仍相等。PodJS代际、新建note、transport/no_backup及冲突目标已在
   `.podjs-recovered/G/` 保存。再次启动不覆盖恢复后的新native写入。打开原生频道/正文、
   设置、备忘录、离线媒体、字体/背景和后台调度，逐项记录功能/像素验收。演练UID下
   unavailable真实账号/KeyStore继续PENDING，不能宣称同UID原生登录态连续性。
5. 中断测试只force-stop**隔离**包：分别在backup rename、restore copy、archive、restore
   install阶段中断；重启/重新覆盖须恢复同代际，backup摘要不变。同步文件流写入受损或
   真实断电需要专门验收；没有观察到对应阶段就标PENDING，不把Linux测试当设备结果。
6. 显式清理另起一轮夹具，或从恢复900000前向升级到新PodJS1001000（绝不能回1000）；
   默认配置只含 `android.takeover.sourceVersionCode`，backup必须一直存在。公测通过后
   才出更高版本声明 `purgeBackupAfter` 门槛（例1001001），检查所有retained backup已删除、
   converter-only源payload已删除、active用户数据和`.podjs-recovered`不变。原生900000不能
   覆盖这个新code；若需再恢复，按台账构建1900000。清理后原生baseline备份不再可回滚。
7. 完成独立演练后，仅由设备负责人按前文安全规则回收隔离包，并回到正式PodJS首页。
   每一步记录实际APK metadata/摘要、PID、阶段、boolean/count与验收状态；所有操作仍需
   设备负责人独占，不将本任务解释为正式同包覆盖授权。

恢复是原生接管时刻baseline。ACTIVE后PodJS新增资料会被归档，**不会**自动合并进
native；保留`.podjs-recovered`供再次接管或人工分析。备份包含四个指定数据根，未涵盖
app_webview、系统/Keystore状态；这两项及正式账号解密仍是独立验收门槛。物理耐久性、
恢复后native功能、真实同UID/签名升级、公测清理和最终设备状态全部PENDING。
