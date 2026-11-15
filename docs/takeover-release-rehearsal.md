# Non-debuggable takeover classification rehearsal

Use a dedicated app/framework worktree and only `com.lightningstudio.watchrss.podjs.rehearsal` on `e3aca8af`. The fixture refuses every other package, a debuggable target, or an existing native database/journal. It writes synthetic data inside the non-debuggable target using same-signature instrumentation. Its class is packaged only in `.rehearsal.test`.

In an isolated app config, use the rehearsal applicationId, remove native signing/debugExternal configuration, set WorkManager nativeAppId to the rehearsal package, and set versionCode 1701. Verify local dependencies are source symlinks to the isolated framework and its exact PocketJS revision. Run the CLI build before packaging. Restore the ordinary app configuration after building assets; neither signing properties nor formal data are needed. T17 uses unchanged native runtime bytes from the exact T15 source/PocketJS revision; changes are Java-only.

With `T17_FRAMEWORK`, `T17_APP`, and `T17_DIST` set to the isolated paths and generated rehearsal android-watch assets:

```bash
ANDROID_SDK_ROOT=/home/wilf/Android/Sdk \
JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
"$T17_FRAMEWORK/platforms/android/gradlew" -p "$T17_FRAMEWORK/platforms/android" --offline \
  :androidApp:assembleRelease :androidApp:assembleReleaseAndroidTest \
  :runtime:testDebugUnitTest \
  -PpodAppId=com.lightningstudio.watchrss.podjs.rehearsal \
  -PpodVersionCode=1701 -PpodVersionName=T17 \
  -PpodAbis=armeabi-v7a -PpodReleaseDebuggable=false \
  -PpodDistDir="$T17_DIST" -PpodResDir="$T17_APP/android/res" \
  -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash \
  -PpodTakeoverSourceVersionCode=40 -PpodCleartextTraffic=true \
  -PpodTestSourceDir="$T17_APP/tests/android/release-rehearsal" \
  -I "$T17_APP/scripts/migration/release-rehearsal.init.gradle"
```

The init script rejects other applicationIds, uses only Android debug signing, and tests the release build type. Inspect both APK manifests and matching certificates before installation. Release debuggable must be absent/false; instrumentation targetPackage must be the isolated app; ProfileInstallerInitializer/WorkManagerInitializer must be absent from startup metadata. Require release baseline profile assets and absence of the fixture class from release DEX.

After verifying DEVICE_OWNER is released, acquire it as wrss-impl, check for existing rehearsal packages, install only these two inspected APKs, and run:

```bash
adb -s e3aca8af shell am instrument -w -r \
  -e class dev.podjs.runtime.ReleaseTakeoverMetadataTest \
  com.lightningstudio.watchrss.podjs.rehearsal.test/androidx.test.runner.AndroidJUnitRunner
```

The fixture seeds a historical migrated Room v18 layout, body/identity/no_backup data, both ProfileInstaller markers, offline RSS/Bili, reader and note assets, a private test protobuf, native log, exact AndroidX locale/history filenames, and 17 cache files. Cache includes Coil default and explicit RSS cache, generic/Room/Typeface/NanoHTTPD/Guava/provider temporary shapes, named media/TTS/update caches and an exact database lock. Nine cache paths are outside the legacy named-cache shapes.

It waits beyond the old initializer delay, seeds three retained synthetic candidates plus a legacy `BLOCKED/unknown_user_files` journal and a files-3 report containing only that blocker, then starts production MainActivity. It requires a fresh files-4 generation at ACTIVE; all three candidates unchanged; zero unknown files, nine unrecognized caches and one exact database lock; consumed body/SQLite content; no imported cache/private platform state; and exact pre/SNAPSHOTTED/ACTIVE native backup root equality. It then requires a real post-admission ProfileInstaller marker matching PackageInfo.lastUpdateTime and confirms the old marker is intact in sealed backup. This is synthetic isolated evidence, not formal sandbox equality or an exact diagnosis of formal v1002's unknown file.

Capture logs for this target PID only, including `T17RehearsalPre`, `T17Rehearsal`, `PodTakeoverDigest`, `PodTakeoverFiles`, and `ProfileInstaller`. Uninstall only the rehearsal app/test, verify cleanup, and restore DEVICE_OWNER to released. This does not authorize formal/native/.podjs package operations.

## T-TAKEOVER-UNKNOWN-FILES：2.0.1 → stores-6/files-7

本节按用户 2026-11-15 裁决执行，替代上文及旧 files-6 的阻断策略。应用基线 `v2.0.1-1 / 782485f4` 固定框架 `d99b4a0`，
实际 converter 为 stores-4/files-5。不得根据共享框架目录或历史文档猜测发布版本。
本卡执行主机测试与独立模拟器截图，不运行上文真机命令，不访问真实沙箱。

路径清单位于框架 `tests/fixtures/watchrss-path-candidates.tsv`（83 条）。
`UnknownFilesTest` 逐条核对分类/委派，检查未知普通文件静默不导入、业务资产导入、原文件摘要不变。
既有 `FileTakeoverTest` 覆盖 files-3/4/5/6 未发布候选重分类、旧候选保留、receipt/pointer/阶段反例、
升级首启自动续迁，无需点击重试。未知偏好文件跳过解析，不导入 KV 或 secrets。已发布的 ACTIVE 代际保持原指针，不重新迁移。

`ReleaseTakeoverMetadataTest` 默认播种 stores-4/files-5 的 BLOCKED journal，
增加 Douyin stock 的 inventory/64hex.mp4/临时文件、手机传输分块与临时文件、云恢复派生回执与临时文件。
要求 stores-6/files-7 ACTIVE，原生四根封存摘要相等，正文/SQLite 可读，缓存/分块/回执不导入业务目录。
手机分块保持 native-transfer-checkpoint，不制造正文或 ACK；恢复回执只描述已合并状态，
业务资料仍从 Room/stores/assets 导入。原生未完成传输和恢复进度不在 PodJS 中续跑。
旧版 `-e legacyFilesVersion 3`、`4` 分别使用新的干净隔离合成安装验证，`6` 验证前次候选，默认 `5` 对应实发基线。
未在模拟器执行该 release instrumentation 时，必须写「未验证」，不得称为设备验收。

真正未知用独立合成 fixture：`files/imports/book.txt`、`files/unknown.tmp`、
`files/douyin_unwatched_stock/notes.txt`、错误 hash 深度的恢复回执、Firebase/厂商 SDK 文件。
要求 ACTIVE、未知路径不在新业务目录、原件与原生备份逐字节不变。不得删除源文件。
files-report/日志只记录未知数量与前20条脱敏路径类别；不得向用户提示未知文件。
旧 BLOCKED/unknown_user_files 首次启动自动重新扫描，不闪现旧失败页。
另测旧未知 store 的阻断、混合旧 blocker、断电后续跑、备份封存与实际回滚。
已知业务损坏仍显示真实失败原因；所有实际失败页上下排列「重试迁移」「上传日志」。

原生诊断不依赖 JS admission。应用资源 `android/res/raw/pod_takeover_support.json` 固定既有日志服务
及公开 RSA key，`tests/takeover-support-config.test.ts` 防止与现有协议漂移。用户核对摘要，
勾选本次同意，再点击上传。没有同意时零请求。服务协议采用既有 gzip/AES256-GCM/RSA-OAEP-SHA256，
只上传白名单字段，拒绝重定向。返回取件码与到期时间，用户在原反馈渠道发送日志编号（既有取件码）。
删除回执在独立 Keystore alias 下加密，写入 package-takeover 控制目录；退出重进可以删除，
不会自动重复上传。上传失败重新同意；删除失败保留回执；本机回执保存失败会撤销远端上传。
若保存和撤销同时失败，本页保留临时删除凭据并明确提示立即删除或等待24小时到期。

离线检查必须覆盖短用户名、短 token、标题、长路径、超过20条路径、报告缺失/损坏、无网络、
回执保存失败、删除失败、界面重建、192px 视口滚动可达。不得上传 files-report 原文、源文件、hash、
完整原日志、账号偏好或删除令牌。只有完整闭合的脱敏摘要可以进入上传加密器。

### 补充要求：任何失败页面与圆屏截图

上传摘要包含迁移 generation、phase、reason、classes 数量、unknownFiles、最多20条脱敏路径、
app versionName/versionCode 和 files converter version。仅保留公开结构名；数字、hex、UUID、长段、
短用户名/标题/token 段都转成 `<id:N>`，保留目录分隔。源文件、账号值、令牌、原日志和私有 hash 不上传。
敏感字段和 Header 策略由 `src/logs/constants.ts` 同时供设置反馈日志与原生资源使用。
`PodFeedbackLogRedactor` 是 createLogRedactor 的 JVM 等价实现；12条共享差分向量检查一致性。

`PodRecoveryRoundLayout` 对应 `safeTopBlock/rectInsideCircle`。原生文本区可滚动；
两个固定按钮垂直排列，四角均在圆内。测试覆盖192/233/320/390/466px、PAUSED/BLOCKED、
store/stage/admission/active 校验失败。旧 unknown 状态只显示普通迁移进度。journal 创建前失败也显示「上传日志」，摘要标明诊断缺失。

迁移完成后，在「管理已上传日志」中点击「迁移诊断回执」继续删除。该原生入口不能启动新上传。
截图演练模块是 `scripts/migration/support-ui`，构建入口 `support-ui.init.gradle`。
该包固定为 `com.lightningstudio.watchrss.podjs.supportrehearsal`，拒绝物理硬件；
Manifest 移除 INTERNET。它使用生产 RecoveryView/上传页面，成功演练使用本机假接收器。
这些截图证明生产原生控件的界面与假接收器流程，不证明实发 APK 完整迁移或线上服务可用。
证据仅写入 `evidence/T-TAKEOVER-UNKNOWN-FILES/`；不操作既有接管模拟器或用户真表。

当前策略主机回归：

```sh
cd /home/wilf/data/PodJS/podjs-watch.wt-takeover-unknown-files
flock /tmp/wrss-heavy-podjs-watch.wt-takeover-unknown-files.lock capmem 16G bash scripts/test-stores.sh --policy
```

该命令运行83条路径矩阵、旧版自动续迁与中断、实际原生备份/回滚、未知偏好文件、
旧混合 blocker 重检、已知业务错误保留、加密上传及12条脱敏差分向量。
模拟器截图的旧 unknown 失败页仅作历史证据；当前 fixture 改用已知 store 失败，并截图核对旧 unknown 只显示普通检查进度。

### Hotfix release acceptance on a task-owned emulator

Use the actual non-debuggable, formally signed hotfix APK with the native package identity.
First inspect both source APKs: archived `1.3.3-final` artifacts with a `.compose` coexistence
applicationId do not prove same-package takeover. Build the frozen Compose source with its
ordinary applicationId when necessary; sign through the existing isolated signing worker.
Do not copy signing properties or keys into source snapshots.

Create a new task-owned AVD and private ADB server. Require an emulator serial and
`ro.kernel.qemu=1` before root/data operations. Let each native APK create its own Room database,
stop it, and seed only that fresh emulator's synthetic article, memo, font/preset, asset and
unknown files. Check the same UID across native→PodJS installation, ACTIVE, complete sealed
backup equality, business records/assets, unknown-file absence, and cold restart.
Run a separate chain with the exact published 1277 APK: it must actually reach
BLOCKED/unknown_user_files before upgrading. Require automatic continuation without a retry tap.

For real upload transport acceptance, the optional `hotfix-acceptance.init.gradle` includes a
separate instrumentation module. It never changes or links into the candidate application.
Build its CA assets from a new local-only receiver certificate; never include the private key.
Sign the test APK with the same existing signer using the signing worker's verification-only
mode. `UploadAcceptanceTest` refuses physical hardware, a debuggable target, a different package,
or a target code other than 1278. It installs a process-local trust manager for that one test CA,
preserves normal hostname verification, and proxies the expected log endpoint to the local TLS
receiver. Firewall the target UID to only that local address/port before starting it.
The production consent, encryption, OkHttp HTTPS, Keystore receipt, log-number display and
DELETE must pass; all other target network egress stays rejected. Do not publish either the
test APK or a synthetic native source APK. Stop and delete the task AVD/server after acceptance.

The native APK version is injected by the external release packaging configuration/Gradle
properties. Existing usage telemetry imports the application's original pod.config.json;
inspect the actual bundled JS rather than inferring telemetry version from PackageInfo.
Keep the established 0.x telemetry convention for this migration-only hotfix. The old release
ledger predates published 1277; compare against its independently verified archived APK too,
or use an explicit temporary ledger overlay containing only that already-published release.
Do not add a publication record for the new candidate before the coordinator publishes it.

审查修复：shared_prefs/read_aloud_secure_prefs.xml（及原生.bak）按精确完整路径作为已发布退役业务存储保留。
当前没有旧read_aloud_api_key消费者，不猜测映射到现代按引擎TTS密钥；retained-known原件封存，不导入、不阻断、不计未知。
Room阅读位置/进度迁移与novel_reading_history在线续章URL保留是两种策略，后者不导入新业务存储。
旧候选仅在重分类/断电续跑期间保留，ACTIVE后遵守原inactive清理，当前/备份关联代际仍受保护。
正式tag writer系统扫描入口为 scripts/migration/audit_compose_writers.py；偏好名无法解析或不在清单时退出失败。
