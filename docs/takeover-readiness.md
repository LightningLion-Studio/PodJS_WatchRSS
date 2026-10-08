# T14：v1000 PAUSED → v1001 前向修复候选（2026-10-08；设备验收 PENDING）

冻结 app `e69d23c` / framework `367c706` / PocketJS `78b1c86`。
框架包含 T13 按列名核验历史迁移 Room v18 布局、DETECTED 失败的新代际重试及 release 一行诊断。
当前正式包为 v1000、非 debuggable、UID10132，首次启动 PAUSED / stage_failed / UI 5%，
不是原生 v40。身份依据现有 `t12/device/upgrade/installed-readback.json` 与 V5 报告，
本轮未重新查询设备。当前候选与操作清单以本节为准；后文 T12/T11b 等命令只保留历史证据。

| 候选 | 路径 / APK SHA256 | T14 离线结果 |
|---|---|---|
| 前向接管 | `.codex-tmp/t14/watchrss-takeover-v1001.apk`；`72fce61794fb25ec8ae5cc5ab0cfeb3fa9adab6e0742f12a0922d3114ec3efec`；121779452 bytes | `takeover-release` PASS 13/13；正式 appId / 1001；非 debuggable；sourceVersionCode40 / purgeBackupAfter0 |
| 原生恢复 | `.codex-tmp/t14/watchrss-native-recovery-v900000.apk`；`a9747852a71ea5919b8dd7df271afdb58a195bd033409152c6835cc034cf9127`；25277224 bytes | `recovery` PASS 14/14；同正式 appId / 900000；复用 `.codex-tmp/t12/watchrss-native-recovery-v900000.apk`，SHA256 不变 |

v1000、v1001 与恢复包的当前及 SDK30 公有 signer 相同：
`f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d`。
版本关系 **40 < 1000 < 1001 < 900000**；原生 sourceVersionCode40 是数据来源，不是现装版本。
台账新增 `policy.packages[正式appId].installedObservation`，记录已有 V5 安装证据；
没有新增 release/publication 记录，也未执行 `record`。门禁同时取历史全部渠道与现装版本的最高值，
拒绝 ≤1000 的候选。既有签名、lineage、非 debug、保留版本区间规则继续生效，
新测试覆盖 PAUSED 前向/恢复、等号/降级、异签名与错区间拒绝。
实际 release DEX 含 `PodTakeoverDigest` 及 `phase=… exception=… frame=…` 的诊断常量；
见 `t14/release-dex-audit.json`。这只证明打包；设备诊断、摘要和迁移结果仍 PENDING。
先 CLI build 后 app 全测 1321 PASS、framework Bun 366 PASS / Rust 105 PASS（4 optional ignored）及全部 host suites通过；两者 typecheck PASS；preflight 48 tests / takeover_verify 14 tests / Android runtime 26 tests 均通过。
源码、依赖链接、dist/APK 资产与测试详情见 `t14/artifact-provenance.json`、`summary.json`。

## v1000 PAUSED → v1001 前向升级清单（仅供获授权设备负责人执行）

1. 按 DEVICE_OWNER 规则取得设备使用权，仅 `e3aca8af` / `com.lightningstudio.watchrss`。
   复核两个 APK 的 SHA256 和两渠道 preflight，安装前只读复核现装 v1000 APK/公有签名、
   UID10132、非 debug、设备解锁/空间。若现装身份发生变化，停止并重新制定升级基线。
   本清单不是本轮设备操作授权；本轮只做离线构建，不安装、不 record、不 commit。

   ```sh
   (cd .codex-tmp/t14 && sha256sum -c SHA256SUMS)
   python3 scripts/release/preflight.py check .codex-tmp/t14/watchrss-takeover-v1001.apk --channel takeover-release --ledger docs/release-ledger.json
   python3 scripts/release/preflight.py check .codex-tmp/t14/watchrss-native-recovery-v900000.apk --channel recovery --ledger docs/release-ledger.json
   ```

   此处 `scripts/release/` 与 `docs/` 使用 `minor/takeover-t14` 的待审变更；APK/receipt 位于主仓库
   `.codex-tmp/`。待 lead 集成后可直接从主仓库根目录执行；未集成时，preflight 脚本及台账改用
   `/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-minor-t14/` 的绝对路径。

2. **不再执行 pre**。`takeover_verify.py pre` 要求现装源 DEBUGGABLE，当前 release 不满足。
   `acceptance.py upgrade` 对 release 也无条件调用这个 pre，因此会在安装前拒绝；
   它没有接收旧 pre 的选项。本轮保留该保护，采用下面的直接 `adb install -r` 加原有 post。
   旧基线固定为 `.codex-tmp/t12/device/upgrade/takeover-pre.json`（code40 / UID10132；
   155 文件、267202456 bytes），SHA256 为 **cd0a65b0809266eef3bb65e8acd44308383d998edb7f2526535307183cd0d190**。不要改写、重采或伪造 receipt。

   有效性论证：V5 第一次启动显示 5%“检查数据”，随后同为 5% PAUSED；未重试、未二启、未 ACTIVE。
   代码将 DETECTED 映射为 5%，snapshot 只读原生源，副本/WAL replay/转换输出都在私有 generation；
   Store→Room→File 顺序可留下半成品但不改写源。原生 backup 的 prepare/移动只在
   coordinator **ACTIVATING → publisher.beforePublish** 执行。因而在 PAUSED 发生于 ACTIVATING
   之前且无外部源写入的前提下，T12 pre 仍是原始源基线，v1001 新代际应与其相等。
   这是源码和既有 UI 的证据推论：V5 的私有 journal/resumePhase 不可读，缺 digest 不能独自证明阶段，
   不能宣称真实源已确认未变。最终只以 post 的 **pre == 新代际 SNAPSHOTTED == ACTIVE** 证明。
   源被后台/平台改写、旧 receipt 不完整、日志缺失或摘要不等，一律停止并报告，不更新基线以迁就结果。

3. 输出使用 `.codex-tmp/t14/device/`。安装前开启独立终端连续日志捕获并保持至 post 完成：

   ```sh
   mkdir -p .codex-tmp/t14/device
   adb -s e3aca8af logcat -v epoch -T 1 > .codex-tmp/t14/device/logcat.txt
   ```

   在另一终端执行同包前向安装；不加降级参数、不卸载、不清数据：

   ```sh
   adb -s e3aca8af install -r .codex-tmp/t14/watchrss-takeover-v1001.apk
   ```

   必须 Success，并只读核对现装 code1001、UID10132、非 debug、公有 signer 和 APK SHA256。
   安装成功只是身份/升级证据，原字节保护仍 PENDING。若身份核对失败，不首启。

4. 首启（日志须已经捕获；只启动一次）：

   ```sh
   adb -s e3aca8af shell am start -W -n com.lightningstudio.watchrss/dev.podjs.androidwatch.MainActivity
   ```

   观察新迁移至 ACTIVE；DETECTED stage_failed 重试代码会先持久化新的 `g-*` journal，
   保留旧失败 candidate，再重新采只读源。不硬编码或复用 v1000 未知代际。
   若 journal 的实际 resumePhase 已是 SNAPSHOTTED/COPYING/VERIFYING/READY/ACTIVATING，
   修复会继续原固定代际，此时停止“新代际”清单、交 lead 审核，不能冒称本路径通过。
   PAUSED/BLOCKED 或 `PodTakeover: phase=… exception=… frame=…` 失败行出现，立即停止后续验收；
   不点重试、不二启、不擅自恢复。记录第一条诊断、进度和时间，未观测项标 PENDING。

5. 同一进程首次 ACTIVE 后立即 post；generation 从本次真实日志唯一提取，禁止填造值：

   ```sh
   generation="$(python3 .codex-tmp/t14/read-generation.py .codex-tmp/t14/device/logcat.txt)" && \
   python3 scripts/device/takeover_verify.py post --serial e3aca8af --package com.lightningstudio.watchrss --pre .codex-tmp/t12/device/upgrade/takeover-pre.json --generation "$generation" --out .codex-tmp/t14/device/takeover-post.json
   ```

   `read-generation.py` 仅解析本地日志，要求唯一代际且 SNAPSHOTTED/ACTIVE 各五 root 完整；
   不替代 post 的 UID、当前 PID、时戳、代际、schema、摘要校验。post 不需要 run-as，
   会保留旧原生 code40 receipt 并核对安装 code>40/UID一致；v1001>v1000 另由 preflight/身份读回证明。
   必须报告 PASS/equal=true，所有 root 和 manifest 相等；日志环形缓冲丢失、PID变化、
   代际歧义或摘要不等即停止，不以连续日志文件代替当前 post 门禁、不重写基线。

6. 保护证明通过后才继续 Home/K8 MAE、sourceVersion40/purge0、active pointer/receipt/backup 同代际、
   旧 WorkManager 取消和 PodJS 工作保留，以及真实账号解密、频道、正文、进度、备忘录、设置、
   资源、手机同步与二启不重导/不覆盖新写。`使用前说明` 未经授权不点击；不能完成的项标 PENDING。
   本轮这些设备事实全为 PENDING。

## v1000 PAUSED 时的原生恢复判断

**覆盖安装条件离线满足**：同 appId、同 signer，900000>1000（也>1001），恢复包预检通过且原字节不变。
若实际处于 ACTIVATING 之前、无 active/备份，原生源保留在原位置；恢复 APK 的
`NativeRecovery.beforeProviders` 调用 `recoveryGeneration()` 得到 null，确认无 active 后直接 return，
随后原生 Room/Prefs/资源读取原位数据，不要求一个尚未生成的 sealed backup。
`NativeBackup` 构造/recoveryGeneration 不创建备份。`t14/paused-recovery-proof.json` 的合成
PAUSED/DETECTED+半成品 case 验证返回 null 与源字节不变；它不是正式设备恢复证明。
恢复与框架均用 WorkManager 2.11.2，避免恢复包重新打开框架已升级的 workdb 时发生版本降级；
当前 PAUSED 路径的真实系统 jobs/WorkManager 兼容性仍须设备验证。

若已经进入 ACTIVATING 且有 backup，恢复会验证选定代际的 manifest/seal/证书/字节，
完成未完备份并恢复、归档 PodJS 输出，撤销旧 WorkManager 系统 jobs；损坏/缺失计划或 active 无备份
继续 fail-closed 为 `podjs_recovery_pending`。**PAUSED 并不普遍等于可直接读原位源**。
V5 未读私有 journal，因此真实源可用、Keystore/账号、Room/WorkManager 启动均 PENDING，
不能保证仅安装恢复包就通过。若需恢复，另派授权设备任务；本轮只复核 APK，不运行下面命令：

```sh
adb -s e3aca8af install -r .codex-tmp/t14/watchrss-native-recovery-v900000.apk
adb -s e3aca8af shell am start -W -n com.lightningstudio.watchrss/.MainActivity
```

恢复到900000后不可正常降级装1001；优先前向修复。ACTIVE后新增 PodJS 数据只归档、不自动合并。

---

## 历史 T12（已被上方 T14 候选与前向清单替代）

# T12：最新主线正式接管候选（2026-10-08；设备 PENDING）

冻结 app `1690bb3` / framework `7e516a9` / PocketJS `78b1c86`。
接管 release 已重建；原生 `podjs-recovery-40` 仍为 `8d65e148`，复用 T8 恢复 APK，
SHA256 逐字节不变。当前候选以本节和 T12 门禁为准，下方 T11b/T10/T9/T8 保留来源与历史证据。

| 候选 | 路径 / APK SHA256 | 当前离线结果 |
|---|---|---|
| 接管 | `.codex-tmp/t12/watchrss-takeover-v1000.apk`；`98798197629bd9569af770eb2fbbed84190fc1ba6baf3a65c183896a80c0fad7`；121779452 bytes | `takeover-release` PASS 13/13；`com.lightningstudio.watchrss` / 1000；非 debuggable；sourceVersionCode40 / purgeBackupAfter0；WorkManager 接管配置出现并精确匹配台账 |
| 原生恢复 | `.codex-tmp/t12/watchrss-native-recovery-v900000.apk`；`a9747852a71ea5919b8dd7df271afdb58a195bd033409152c6835cc034cf9127`；25277224 bytes | `recovery` PASS 14/14；同原生 appId / 900000；非 debuggable；复用 T8 原字节 |

两个 APK 当前及 SDK30 公有 signer 均为台账已核验的原生 v40 证书：
`f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d`。
签名仅经 CLI 隔离 SigningWorker，无 debug→release 轮换 lineage；不读取或打印签名密码。
实际 release DEX 含 `PodTakeoverDigest`，见 `t12/release-dex-audit.json`；字符串存在不等于设备日志验收。
`main.js/main.qbc/main.pak/pod.manifest.json` 与冻结 dist 逐字节相同，PocketJS revision 精确匹配，
源码构建前后无漂移，所有 nested local 依赖均指向快照 symlink。

先 CLI build 生成 styles，再完成 app 全测 **1321 PASS / 0 FAIL**、framework 全套测试
（Bun **366 PASS / 0 FAIL**、Rust **105 PASS / 4 optional ignored**，
browser/Java/C++/crypto/http/acoustic host checks 通过）；两者 typecheck PASS。
preflight 单测 **45 PASS**、takeover_verify 离线测试 **14 PASS**、CLI release package PASS。
共享 NativeBackup 与原生恢复树 SHA256 一致性守卫通过。

审阅 worktree `minor/takeover-t12` 只修改本文件，未 commit，交 lead 提交。
主目录未 bun install；三份构建快照已删除。APK、JSON/log、来源与源码审计、SHA256 和清理证据
保存在 `.codex-tmp/t12/`。第2/4/5步给出 T12 的确切 pre/install/post 命令，仅供正式安装时审阅。
**本轮未操作设备、安装、record 或提交；同 UID 迁移、真实账号/数据、原字节保护、恢复、
WorkManager 系统行为和功能验收仍 PENDING。**

---

# T11b：release 原字节保护核验通道（源码实现，设备 PENDING）

`PodTakeoverDigest` 在 SNAPSHOTTED 与 ACTIVE 各输出每个 root 一行，另有
`root=manifest` 的合并摘要。字段仅 `phase/generation/root/files/bytes/sha256`，
无文件名、账号、cookie 或内容。T11b 保持共享 `NativeBackup.java` 与恢复树逐字节相同，
不改变恢复 manifest 格式。SNAPSHOTTED 复用 converter 文件/store/原始 DB/WAL 哈希，
补充测量四个保护 root 中转换器未覆盖的文件，写入 generation 内独立私有摘要快照；
重试只读该快照，不重写基线，也不提前封存或移动 NativeBackup 的源计划。
ACTIVE 前沿用原有 prepare/verify 校验字节、原子移动并持久化 manifest/seal/ready，
再从这些 Properties 元数据投影并与私有摘要快照比较，不同则阻止 ACTIVE 发布。
ACTIVE 日志只读封存元数据，不重读大文件，沿用迁移后台线程。
取舍：恢复计划仍在原有 prepare 阶段封存，不在 SNAPSHOTTED 提前冻结；
哈希复用用于独立摘要快照，NativeBackup 原有 prepare/verify 的实际字节读取保持不变。

摘要 v1：root 内采用去掉 root 前缀的相对路径；合并 manifest 采用 sandbox 相对路径。
按 UTF-8 字节升序，逐文件 SHA256 输入为 `uint32be(path UTF-8 bytes length)`、
路径 UTF-8 字节、`uint64be(size)`、文件 SHA256 的32个原始字节。目录不计数；
空/不存在 root 为 files=0、bytes=0、SHA256(empty)。root 范围是
`databases/files/shared_prefs/no_backup`；cache 是 Android 可丢弃数据，不进入备份或比较。
排除框架自有 `files/podjs`、`files/package-takeover`、`files/.podjs-*`、
`databases/podjs.sqlite*` 和 `no_backup/podjs-*`，与 NativeBackup 规则一致。
比较协议只接受上述四个 root 与 manifest；不扩大共享恢复 manifest 的 root 定义。
manifest 汇总是原字节清单摘要，不是 manifest 文件自身 SHA256，亦不单独证明
证书、sourceVersion、active 指针、迁移业务结果或 Keystore 可用性。

**T12 已从包含 T11b 摘要通道的 framework `7e516a9` 重建并通过离线发布门禁；release DEX 字符串检查通过，实际日志与原字节保护设备验收仍 PENDING。**
T11b 不再扩展 cache root；共享 NativeBackup 与原生恢复树 `8d65e148` 字节一致，
保持现有恢复候选的 manifest 兼容性。实际恢复 APK 仍须独立门禁和设备验收；
此轮只改框架/脚本/文档，不构建或安装 APK。
框架全套测试包含 SHA256 守卫：`PODJS_RECOVERY_TREE` 默认指向
`/home/wilf/data/OPPO_Develop/Android_WatchRSS.wt-recovery`；路径不存在打印 SKIP，
路径存在而共享源码缺失或不同即失败。

`pre` 只允许现装 debuggable 原生，force-stop 后 run-as tar 全程在主机内存流式计算，
只落聚合 JSON；不落 tar/文件内容/文件名/原始 stderr。现有 takeover journal/backup、
run-as 拒绝、坏 tar、links/越界/重复条目均拒绝生成基线。`post` 只读取同包 UID/更高
versionCode、当前单一 PID 的过滤 logcat；按 epoch 时间排除 pre 前日志，要求主机与
设备时钟同步。须在首次 ACTIVE 后、进程重启前及时 post；日志缺失/轮转、进程改变、
代际歧义、格式错误或任一 root 不等均 FAIL，不能用旧日志/重新安装补成 PASS。
可用 `--generation g-...` 明确选择观测到的代际；receipt/report 不覆盖，失败报告仅固定
reason 或变化 root，无原始日志。PASS 只证明原生基线字节与封存备份清单一致，设备业务
验收、同 UID 账号解密、WorkManager 和恢复实测继续分别 PENDING。

离线测试命令（本轮报告记录实际结果）：

```sh
PODJS_T11_FRAMEWORK=/home/wilf/data/PodJS/podjs-watch.wt-t11 PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/device -p 'test_*.py'
```

跨语言测试使用两仓库字节一致的 `takeover-digest-v1.tsv`，Python 将该夹具构造为内存 tar，
Java 使用同一个夹具的路径/长度/内容哈希，断言四个 root 加 manifest 共五个聚合摘要完全相等；包含 binary、
UTF-8 排序、空文件与空 root。后续合并后测试默认 framework 主 checkout，可用上述环境变量
指定未合并 worktree。以下 T10/T9/T8 候选及结论保留为历史证据，正式清单按本节通道执行。

---

# 历史 T10：正式接管候选（2026-10-08）

冻结 app `873fbd9` / framework `ecc8d3e` / PocketJS `78b1c86`，
接管 APK 已重新构建；原生恢复 `podjs-recovery-40` 仍为 `8d65e148`，
复用 T8 恢复 APK，SHA256 与 T8 逐字节一致。本节保留 T10 当时的候选与门禁，当前候选以顶部 T12 为准，
下方 T9b 保留决定与现装基线，T8/T1 等保留历史证据。

| 候选 | 路径 / APK SHA256 | 当前离线结果 |
|---|---|---|
| 接管 | `.codex-tmp/t10/watchrss-takeover-v1000.apk`；`7b7308aeb9b2b06ad9e9b39a3b046c2e643a3e5e3cad696759a1b95a287625e0`；121779452 bytes | `takeover-release` PASS 13/13；`com.lightningstudio.watchrss` / 1000；非 debuggable；sourceVersionCode40 / purgeBackupAfter0；WorkManager 接管配置出现并精确匹配台账 |
| 原生恢复 | `.codex-tmp/t10/watchrss-native-recovery-v900000.apk`；`a9747852a71ea5919b8dd7df271afdb58a195bd033409152c6835cc034cf9127`；25277224 bytes | `recovery` PASS 14/14；同原生 appId / 900000；非 debuggable；复用 `.codex-tmp/t8/` 原字节 |

两个 APK 的当前及 SDK30 公有 signer 与已核验现装原生 v40 相同：
`f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d`。
接管签名仅经 CLI 隔离 SigningWorker，不使用并存包的 debug 轮换 lineage。
接管 `main.js/main.qbc/main.pak/pod.manifest.json` 与冻结 dist 逐字节相等，
PocketJS revision 精确匹配；源码构建前后无漂移，所有 nested local 依赖均为快照 symlink。
候选 appId/code/signing/dependency 路径只在已删除的快照中修改；审阅 worktree
`minor/takeover-t10` 仅修改本文件，未 commit，主目录未执行 bun install。

完整验证：先 CLI build 生成 styles，再运行 app 全测 **1321 PASS / 0 FAIL**、
framework 全套测试（Bun **366 PASS / 0 FAIL**、Rust **105 PASS / 4 optional ignored**，
browser/Java/C++/crypto/http/acoustic host checks 通过）；两者 typecheck PASS，
preflight 单测 **45 PASS**，CLI release package PASS。
证据在 `.codex-tmp/t10/`：`artifact-provenance.json`、`source-{before,after}-build.json`、
`{takeover,recovery}-preflight.{json,log}`、`SHA256SUMS`、测试日志及 `cleanup.json`。

**本轮没有操作设备、安装、record 或提交；正式同 UID 迁移、真实账号/数据、
保护性备份、WorkManager 系统行为和设备功能验收仍 PENDING。** 候选准备不等于
正式安装授权；用户决定和保护性安装/恢复清单仍适用，清单路径已更新到 T10。

---

# T9b：接管决定与现装基线（2026-10-08）

本节替代下方 T8/T1 的全渠道版本未确认、并存资料合并待决和回滚优先级旧结论。
指定最新主线的候选已由 T12 重建并过门禁；T8 的 app `31d6612` 接管 APK 仅为历史证据，
门禁通过不代替安装授权、用户数据保护和真实设备验收。本轮不安装、不执行 record。

用户三项决定：

1. 原生全渠道最高 versionCode 就是本机 build 最高值。用户于 2026-10-08 确认，
   原生 `app/build.gradle.kts` 全部 git 历史58个修订的最大值为40；
   `release-ledger.json` 的 `highestPublishedVerified=true`，证据在
   `.codex-tmp/t9/native-gradle-history.json`。现装 APK 摘要另补，不依赖恢复组件例外获准。
2. 接管丢弃 `.podjs` 测试包数据，不从 `com.lightningstudio.watchrss.podjs` 迁移或合并
   任何数据。接管来源为原生包。接管后是否卸载 `.podjs` **待用户另行确认**，本轮不执行。
3. 出问题优先前向修 PodJS，原生恢复包为最后手段；保留封存原生备份及恢复 APK。
   ACTIVE 后新增资料只归档，不自动反向合并；前向修复仍需版本与数据保护门禁。

## 现装 v40 与最终离线门禁

设备 owner 从 `released` 取得 `wrss-minor` 后，仅查询目标包路径并拉取 base.apk，
完成即释放；没有访问私有数据、run-as、安装、卸载或 record。现装原生 APK：

- appId `com.lightningstudio.watchrss`，versionCode40，versionName `1.3.2-13`。
- APK SHA256 `decf31983a9936262eb76c89987acf10d8ba49d15de747d2f6dd61be973a11b7`。
- AXML SHA256 `4edee494056198ccf37e7fd06cafb7da2fdda38855f7b5b79128720f683cb199`。
- 当前及 SDK30 公有 signer 均为
  `f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d`，apksig验证通过，
  与两个候选及台账期望匹配。**现装原生 signer 匹配已验证，解除 T8 的该项 PENDING。**
- 现装包 `debuggable=true`；这是已安装基线，不将它写成非 debug release。
  APK/AXML/公开证书证据：`.codex-tmp/t9/native-installed-v40-facts.json`。

四组件 LlmSummaryActivity、debug.DebugLogProvider、debug.PerfLargeArticleActivity、
debug.PerfLargeListActivity 的完整属性与子节点均相同，包括 DebugLogProvider authority
`com.lightningstudio.watchrss.debuglog`。不归一化 authority，AXML 相等不证明 DEX runtime
门控或资源内容相等。比对证据 `.codex-tmp/t9/installed-baseline-comparison.json`。
恢复渠道只给这四个精确组件例外，要求实际 APK 完整节点与
[现装四组件摘要](release-baselines/native-installed-v40-debug-components.json)相等；
台账绑定 APK、AXML、公开证书及摘要文件 SHA256。原有 recovery 全组件身份子集门禁
继续保留；接管与并存仍拒绝 debug-external。

| T12 当前候选 | 当前门禁结果 | 证据 |
|---|---|---|
| 接管1000（app `1690bb3` 新构建） | PASS 13/13 | `.codex-tmp/t12/takeover-preflight.json` |
| 恢复900000（原生 `8d65e148`，复用 T8 原字节） | PASS 14/14（含 recoveryComponents 和精确 debugExternal） | `.codex-tmp/t12/recovery-preflight.json` |

Python preflight 测试45 PASS；应用完整 `bun run test` **1321 PASS / 0 FAIL**，结果见
`.codex-tmp/t9/app-test.log`（T9b 历史测试）。**T12 已按指定最新主线重建接管候选，
原生恢复源码未变，复用 T8 恢复 APK 并用当前门禁复查；当前候选及哈希见顶部 T12**。
T8 app `31d6612` 的旧接管 APK 不用于正式安装。设备接管/用户数据保护、真实账号和功能验收仍
PENDING；本轮未安装、不 record，也没有 protected-data/equal=true 结论。

---

# 历史 T8：正式接管候选与发布就绪清单

2026-10-07，冻结 app `31d6612` / framework `2c0b2cd` / PocketJS
`78b1c8629c31b2eca8642c8c03f481783042306f`；原生恢复树
`podjs-recovery-40` 的 `8d65e148`。应用审阅分支为 `minor/takeover-candidate`。
本节是 T8 冻结时状态，当前决定与门禁以顶部 T9b 为准；下面的 T1/T3 是更早历史证据，其中“未构建恢复包”“C15 尚无实现”
等旧结论由本节替代。**候选准备不等于允许正式安装。** T8 不操作设备、不安装、
不执行 `record`，不把发布策略中的未知事实改成已确认。**本轮结果PARTIAL：
两个候选均已构建，接管门禁1项失败，恢复门禁2项失败，均不得安装/发布。**

## T1–T8 状态与证据边界

| 项目 | 已验证 | 仍 PENDING / 阻塞 |
|---|---|---|
| T1 / T1b：真实原生副本隔离迁移 | T1b 普通及 COPYING 中断均到 ACTIVE；独立 DB/store/file oracle、二启不重导、guest 出帧通过；原生153文件摘要不变，隔离包已回收。证据 `.codex-tmp/t1b/{ordinary-result,interrupt-result,final-safety-result}.json` | 原副本在隔离 UID 中不能验证真实 Keystore。普通首启247376ms、中断重启249447ms是当轮控制器观察值，不能作为本候选性能承诺。正式用户账号/真实数据量耗时、ANR、全部页面像素仍需验收 |
| T2：原字节备份与恢复 | 源移到封存 backup，seal/manifest/ready 校验；恢复在 providers 前，PodJS 新数据归档；中断重试、二启保留新增数据有 JVM/进程测试。证据 `.codex-tmp/t2/summary.json` | 正式包的备份可读性与恢复入口尚未设备验收；不支持 PodJS 新写入反向合并 |
| T3：接管 WorkManager | 同 nativeAppId 才打包旧 worker/name 配置；旧类 factory 在 ACTIVE 前等待，之后按精确身份取消，不删 workdb，不 cancelAll/prune；独立 receipt | 真实历史 WorkManager 数据及系统回收/后台唤醒顺序；本候选须核对打包配置实际出现 |
| T4：恢复 WorkManager | 原生恢复固定2.11.2；providers 前旧路径迁移、仅撤销 WorkManager 系统 jobs、持久 receipt；562 JVM测试含12个新增调度/版本测试通过。证据 `.codex-tmp/t4-summary.json` | 物理历史2.10.1 schema23→2.11.2 schema24仍 PENDING；合成夹具同用2.11.2不能证明此项 |
| T5：code40 基线 | 恢复树固定业务40/Room18，seed40/recovery900000及探针离线编译通过；共享 NativeBackup 与框架逐字节核对。证据 `.codex-tmp/t5-summary.json` | 固定源码不是所有原生渠道最高 code 已确认；旧 debug 隔离 APK 不作为正式候选 |
| T6 / T6b / T6c：同 UID 合成链 | T6c round3 seed40→PodJS1000→recovery900000 保持 UID10243；Watch/Bili/Douyin三项合成凭据在迁移和恢复后解密；11探针，二启、业务/资源/旧WorkManager UUID、PodJS归档及native新note保留通过。证据 `.codex-tmp/t6c/summary.json` 和 `round3/device-results.jsonl` | 仅隔离 debug 包/合成账号证据；真实正式UID/证书/账号、LLM/TTS/cloud binding、联网登录和实际手机同步仍 PENDING |
| 中断恢复 | T1b 验证 COPYING 中断；T6c round3 验证原生备份部分移动时 ACTIVATING 中断、ready/active缺席，新进程续同generation到ACTIVE；JVM逐持久化边界测试 | T6c round1/2的“恢复过程被中断”时机未证明，不能计为成功；native restore正在执行时的设备中断、物理断电仍 PENDING |
| T7：离线发布门禁/台账 | 已有 `takeover-release` / `recovery` 策略，检查实际AXML、公有签名/SDK30 signer/lineage、release/debug、source/purge、打包WorkManager。台账跨渠道单调；接管1000..899999、恢复900000..999999 | `com.lightningstudio.watchrss.highestPublishedVerified=false`，全渠道最高版本未核实，两个渠道 fail-closed；不以本机code40观察替代 |
| T8：正式两个候选 | 冻结包及逐项检查结果见下表和 `.codex-tmp/t8/` | 所有门禁通过、安装授权、保护性数据核验和设备验收完成前不能发布/安装；没有record |

## 候选构建与公开证书

应用候选只在独立 worktree 临时改 appId/code/signing 和冻结依赖路径，主线配置不变。
完成后还原审阅分支的临时配置，精确输入另存 `pod.config.candidate.json`、
`package.candidate.json` 和 `bun.candidate.lock`；不要把候选appId当并存主线默认配置合并。
接管使用 CLI 隔离 SigningWorker，签名配置只保留原生 `keystoreProperties` 路径，
不带并存包的 Android Debug→release lineage。`purgeBackupAfter` 在源码配置中省略，
由 CLI 生成 manifest 明确值0；当前解析器不接受配置里显式0。保留公测备份。
恢复只通过原生 `:app:assembleRelease` 内部读取 properties；不读取/打印内容或密码。

| 候选 | appId / versionCode | 构建 / 检查结果 |
|---|---|---|
| 接管 | `com.lightningstudio.watchrss` / 1000 | release构建成功、非debug；source40/purge0/WorkManager配置/签名/无debug-external全部PASS，仅publicationInventory失败，见 `takeover-preflight.json` |
| 原生恢复 | `com.lightningstudio.watchrss` / 900000 | release构建成功，非debug，实际签名/SDK30 signer通过；preflight FAIL：publicationInventory、debugExternal，见 `recovery-preflight.json` |

已有本机原生 APK `Android_WatchRSS/app/build/outputs/apk/debug/app-debug.apk` 的实际身份
为原生code40/1.3.2-13，SHA256
`1d915427e2dce75a62fd71b229e476969ecd655176e6b32ff2e216e2f622895a`，
与R1历史构建证据一致；本次离线apksig验证的当前/SDK30公有证书均为
`f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d`。
证据 `native-existing-apk.json`。台账期望指纹相同。**该文件与现装原生APK逐字节一致
尚无可追溯证明，因此 T8 当时“当前已安装原生 signer 匹配”仍 PENDING。**
T9b 已从现装 APK 验证 signer，见顶部；T8 本次没有读设备。

接管候选为 `.codex-tmp/t8/watchrss-takeover-v1000.apk`，121750780 bytes，
SHA256 `41230a8fc081777bb9c6184ada42e3a3f57ff20a1ab7a90ef69f7c0d76f9bfb5`。
实际签名、SDK30 signer均与已有原生code40公有证书相等，无lineage；WorkManager配置
与台账旧worker/name精确相等；hostAbi3、viewport240×240、两AndroidABI齐全。
`main.js/main.pak/main.qbc/pod.manifest.json`与冻结dist逐字节一致，构建源码审计无漂移
（期间唯一文档变更为本文件），见 `artifact-provenance.json`、`source-after-build.json`。

恢复候选为 `.codex-tmp/t8/watchrss-native-recovery-v900000.apk`，25277224 bytes，
SHA256 `a9747852a71ea5919b8dd7df271afdb58a195bd033409152c6835cc034cf9127`。
第二个失败项来自固定原生main manifest：`LlmSummaryActivity`、`debug.DebugLogProvider`、
`debug.PerfLargeArticleActivity`、`debug.PerfLargeListActivity`。即使这些组件未导出或
runtime门控，当前T7规则要求release中缺席，不能直接放行。需要lead审查原生release
清单的修正或有证据的策略决定；本轮不改指定原生8d65e148、不削弱检查。

本轮离线验证：应用 `bun run test` **1313 pass / 0 fail**；应用typecheck PASS；
冻结框架全套 `bun run test` / typecheck PASS（Rust105 pass、4 optional ignored）；
离线门禁单测32 PASS；mandatory主CLI build和冻结CLI release package均PASS；
原生 `:app:assembleRelease` PASS。首轮生成样式缺失导致的应用测试失败已在构建生成
样式后消除；框架本地假服务测试首次request-count瞬态失败，完整复跑PASS。
未为失败修改测试或产品源码。设备验证本轮PENDING，T6c历史证据不扩大为候选验收。
门禁另以冻结worktree的台账重跑，结果相同，见 `*-preflight-frozen.json`；台账SHA256
为 `b91be7189d5d90e5fc2a10f675d5d744d0e8d8a2cec2c2745bd7e0d2e5a1974c`，
本轮没有修改它。期间其他任务在主线台账追加并存v32，本轮未改写或回退；原生policy
和版本上界不受该条目影响。

## 其他发布前门槛

| 项目 | 当前状态 |
|---|---|
| C15 / debug-only | 已有debug alias、故障/上下文广播、provider桥、host及guest debug gate，见[debug-parity.md](debug-parity.md)。接管release须证明manifest/DEX无外部桥；真实debug冷/热启动、广播、dump行为及native诊断字段完整性仍PENDING，未提供的RAM/DouyinPreviewDL等保持unavailable |
| C16 / C17 | 独立总结controller/route、TTS数据能力已有；lead布局及设备/backend/audio验收按debug-parity待办，不沿用T1“没有任何实现”的旧描述 |
| 手机/同步、文件/字体/媒体、通知/后台 | Host及迁移离线测试已有；实际手机双端、断连/ACK、大正文、真实资源加载/播放、权限和系统后台仍 PENDING |
| 全渠道版本/证书 | 发布负责人提供原生全部发行渠道最高code证据，并核对现装原生公开APK signer；更新台账policy须有证据。1000与900000是候选，不是已发布记录 |
| 同UID用户数据保护 | T11 `takeover_verify.py pre/post` 对比安装前原生聚合摘要、SNAPSHOTTED 和 ACTIVE 封存备份 manifest；release 不需要 after run-as。T12 release DEX 含摘要通道且两个候选离线门禁通过；字符串/source/host 证明不等于设备 PASS，失败/日志缺失不能宣布 equal=true |
| 回滚能力 | 恢复包还原封存原生基线、归档PodJS新增数据；不自动反向合并。ACTIVE后不能承诺所有新增资料在原生可见。恢复900000后不能重新安装1000；下一轮接管起1001000并仍需高于全部历史 |

## 正式安装清单（仅供审阅，本轮未执行）

以下步骤只由lead取得最终用户确认、授予 `DEVICE_OWNER` 后执行。任一门禁未知或
失败即停止；不能通过卸载、clear、降级参数、手改journal或备份标记绕过。

1. 固定两个APK SHA256和来源；分别跑 `scripts/release/preflight.py check`
   的 `takeover-release`、`recovery`，必须全部PASS。核对原生实际appId/code/公开signer/
   UID，确认code40对应受支持Room18及store版本、用户解锁、空间足够（迁移副本、
   原字节备份、恢复stage和PodJS归档均需预留）；审核全部渠道版本上界。
2. 安装前确认原生 DEBUGGABLE，主机与设备时钟同步，执行以下确切命令（仅在取得设备授权后）：

   ```sh
   python3 scripts/device/takeover_verify.py pre --serial e3aca8af --package com.lightningstudio.watchrss --out .codex-tmp/t12/device/pre.json
   ```

   只落聚合 JSON，覆盖 databases/files/shared_prefs/no_backup；cache 不进备份、不参与比较。
   原生保持 force-stop，不启动原生业务。pre 检测到旧 takeover journal/backup、缺少原生
   watchrss.db 或无法安全读取时即停止，不安装再补证据；已有 receipt 不覆盖，重试另建目录并同步后续路径。
   确认 T12 原格式恢复候选可用（共享 NativeBackup 与恢复树字节一致）；Keystore 不作为可导出文件备份。
3. 按 2026-10-08 用户决定，接管只用原生来源，丢弃 `.podjs` 测试数据，不从
   该包迁移或合并任何资料。接管后 `.podjs` 是否卸载待用户另行确认，本清单不执行
   卸载。确认 release after 摘要的授权验证入口已准备。
4. 步骤1/2/3全部通过且已获本轮安装授权后，按保护性清单执行同包覆盖，不加 `-d`：

   ```sh
   adb -s e3aca8af install -r .codex-tmp/t12/watchrss-takeover-v1000.apk
   ```

   第2步 `.codex-tmp/t12/device/pre.json` 是这条手动安装路径的权威基线。
   安装后只核对包名、code、公开 signer、UID 和非 debug 标志；**原字节保护保持 PENDING**，
   不要求 release after run-as。也可用下面的保护性 upgrade 命令合并第2/4步：

   ```sh
   python3 scripts/device/acceptance.py upgrade --serial e3aca8af --package com.lightningstudio.watchrss --apk .codex-tmp/t12/watchrss-takeover-v1000.apk --out .codex-tmp/t12/device/upgrade
   ```

   其 release 分支先执行同一 takeover_verify pre 逻辑，生成
   `.codex-tmp/t12/device/upgrade/takeover-pre.json`；这个新 receipt 是 upgrade 路径的权威基线，
   不混用第2步的 receipt。安装后写 `takeover-install.json` PENDING 并打印 post 命令。
   不自动首启，不把安装成功或未运行迁移时的摘要当迁移验收。
5. 在授权首启 `com.lightningstudio.watchrss/dev.podjs.androidwatch.MainActivity` 后，
   观察 DETECTED→SNAPSHOTTED→COPYING→VERIFYING→READY→ACTIVATING→ACTIVE，
   PAUSED/BLOCKED 保留源/候选并记录固定 reason；记录真实耗时、主线程/ANR、generation。
   首次 ACTIVE 后、进程重启前，手动安装路径执行：

   ```sh
   python3 scripts/device/takeover_verify.py post --serial e3aca8af --package com.lightningstudio.watchrss --pre .codex-tmp/t12/device/pre.json --out .codex-tmp/t12/device/post.json
   ```

   若第4步使用 upgrade，则执行以下确切命令：

   ```sh
   python3 scripts/device/takeover_verify.py post --serial e3aca8af --package com.lightningstudio.watchrss --pre .codex-tmp/t12/device/upgrade/takeover-pre.json --out .codex-tmp/t12/device/upgrade/takeover-post.json
   ```

   可加 `--generation` 指定实际观察到的代际。必须所有 root 和 manifest 满足
   pre == SNAPSHOTTED == ACTIVE 且报告 PASS；日志丢失/不同 PID/代际歧义/摘要不等即停止，
   绝不以安装成功替代保护证明。T12 DEX 含 `PodTakeoverDigest` 只证明字符串已打包，
   不证明正式设备产生日志。另核对 sourceVersion40、公有 cert、active 指针与 receipt 同代际、
   purge=0、旧 WorkManager 取消且 PodJS 工作不被误取消；聚合日志不替代这些事实的授权核验。
6. 第一张Home截图与 `.codex-tmp/device/shots/s4-k8-home-after-cold.png`
   核对466×466尺寸/布局，以ROI/非RGB0/MAE证据判定；说明弹窗未经授权不点击。
   然后核对真实账号解密/登录、频道/正文/阅读进度/备忘录/设置/资源/手机同步；
   二启确认不重导、不覆盖新写。没观测到的项标PENDING。
7. 优先前向修 PodJS；仅在需要最后手段恢复时，先停止业务写入，保留并核验
   当前 PodJS 代际和封存原生 backup，明确
   ACTIVE后新资料只归档、不自动合并。通过保护性安装流程覆盖
   `adb -s e3aca8af install -r .codex-tmp/t12/watchrss-native-recovery-v900000.apk`；
   启动 `com.lightningstudio.watchrss/.MainActivity`。恢复在providers前校验证书/备份、
   原字节还原及撤销旧系统WorkManager jobs；遇 `podjs_recovery_pending`停止、保留数据，
   不清空重试。校验completion/backup seal、PodJS归档、原生业务/资源/账号/WorkManager，
   二启不再恢复且保留恢复后新增资料。普通upgrade digest针对PodJS DB，不能直接当native
   恢复摘要；需要对应的原生root/oracle验证方案。
8. 实际发布成功后才 `record` 精确APK/日期/源码/渠道；只安装本机候选不能宣称公网发布。
   公测未批准清理，保持purge=0和原生backup。结束由设备负责人回Home并释放owner。

---

# 历史 T1：原生包接管就绪审计

> T7（2026-10-07）：新增[离线发布门禁](../scripts/release/README.md)及
> [结构化台账](release-ledger.json)。检查实际 APK 的身份/版本、release 标志、公开
> 签名与 lineage、debug-external、takeover metadata 和打包的 WorkManager 配置。
> 原生全渠道最高 code 尚未核实，台账明确 fail-closed；门禁通过不代替设备接管验收。

> T2（2026-10-07）：独立分支已增加原字节backup、native恢复入口和显式版本门槛清理。见 [T2演练](takeover-rehearsal.md#t2原生备份--同隔离包恢复--公测后显式清理)。以下T1/P1历史事实保留；源在ACTIVE前转存backup，不能再要求原路径存在。设备/正式签名/原生功能验收仍PENDING，ACTIVE后新数据归档而非反向合并。

2026-10-07，app 基线 `2e84513` / framework `58ab3c4` / PocketJS `78b1c8629c31b2eca8642c8c03f481783042306f`。实施分支均为 `minor/takeover-ready`。结论：**尚不具备正式接管发布条件；本轮 PARTIAL**。本轮没有向原生包安装，没有写原生沙箱，没有卸载/清理原生或正式 PodJS 包，没有读取/打印签名密码。真正同包升级必须由 lead 另行取得用户确认后派发。

## 身份、版本与签名

| 条件 | 现状 | 判定 / 发布前动作 |
|---|---|---|
| 正式接管包名 | 当前 `pod.config.json` 仍为 `com.lightningstudio.watchrss.podjs`，code 28；本轮独立演练 APK 为 `.podjs.rehearsal` | 缺失最终 takeover-release 配置；不能直接把并存包安装当接管 |
| 原生版本 | 本轮只读 `dumpsys package`：code **40**、name **1.3.2-13**、UID **10132**、DEBUGGABLE；原生 `app/build.gradle.kts` 也为 40 | 候选必须 **>40**；未核实所有发布渠道最高 code，不能直接分配 41 |
| Lightning Studio 证书 | R1/R2 release 签名能力已存在；公开历史验收指纹 `f06d28ffff88ed9ac41bbb3e0cd845a05773f8536cf1095dfe7cacfabedb831d` | 本轮演练只用 debug 签名；未生成正式接管 APK、未重新提取设备原生公有证书。正式 APK 与已安装原生公有证书逐项复核 PENDING；不需要为接管轮换证书 |
| UID / Keystore | 同包、兼容签名、系统接受的原地升级才保留安装身份；隔离 UID 不拥有原生 master key | 同 UID、原 alias、AAD 和仍有效密钥下可访问是机制推论；真实账号解密/刷新验收 PENDING |
| release 标志与渠道 | CLI 有 `--release`、`--version-code`；`--debuggable` 仅验证用。C01 用户已选择 OSS 且低优先级 | 最终 appId、非 debug、SDK/ABI/provider/权限、公开证书、哈希及渠道清单验收缺失；手动升级可独立验收，不将 OSS 延期视为授权生产更新 |

签名升级边界依据 [Android 应用签名](https://developer.android.com/studio/publish/app-signing)；APP Keystore namespace 按调用 UID 隔离依据 [AOSP Keystore](https://source.android.com/docs/security/features/keystore)。未读取凭据文件或 keystore 内容。

## 数据迁移与恢复

| 条件 | 当前实现 / 测试 | 剩余边界 |
|---|---|---|
| Room v18 的 15 张源业务表 | `PodRoomV18Converter` 校验 Room identity/schema/integrity/FK；锁住原 DB/WAL、只在私有副本恢复 WAL；稳定主键分页，批次事务和 cursor 同步；独立 Python staging oracle | 本轮原生副本离线比对 **30 张目标表**（含 sqlite_sequence）、正文/原文、7 条 memo、同步游标/墓碑/身份与全部阅读 catalog 一致。衍生 sync revision/cache 按既有规范不作为导入表相等比较；空表不证明非空真实覆盖 |
| DataStore / SharedPreferences | `PodStoreConverter` 目录识别单/双 suffix；XML/protobuf 严格验证，KV 配额、结构回读、secure 生产 decoder、encrypted retention | 本轮 **14 个存储源文件**逐字节保留；非用户 instrumentation DataStore 由 file snapshot 保留；全部支持的 settings/reader mapping 由 host verify 回读，独立 oracle 额外核对3项显式 settings及完整reader KV；不声称独立Python逐值核对全部设置/secret |
| 文件 | `PodFileConverter` 64KiB流式copy、digest、part/rename、fsync、completion receipt；字体/背景/正文引用验证；源缺媒体显式降级 | 本轮离线 **137 个快照文件 / 63 个发布资产**逐文件SHA256相等。JVM字体回调是替身，Android Typeface/实际图片加载 PENDING |
| 加密账号 / cookie：P5 | 正常解密时 Watch/Bili/Douyin及支持的LLM/TTS写对应生产secure key；只对原生明确允许crypto recovery的Watch/Bili/Douyin记录needs-reauth并未登录；不删除源XML或alias | 本轮独立UID/桌面注入missing-key；Watch/Bili/Douyin/LLM为 `isolated_uid_keystore_unavailable`；不能证明真实登录态、cookies或同UID continuity。LLM/TTS正式无法解密仍阻断；cloud binding/旧alias采用仍有专门门槛 |
| 已知保留 / 未知数据 | P5仅批准平台版本cache、旧toast限流、安装时间元数据及已验证native route首页fallback为known-difference；未知key/store/格式/backup/quota/cloud binding仍BLOCKED | 本轮8项known differences、0 blocker。不是清除原数据，也不是用户批准丢弃未来未知数据 |
| 完整源范围 | 演练只读取 `databases files shared_prefs`；框架再分类原生files/cache资产 | **不包含 no_backup、系统安装状态或完整WebView/cookie数据库验收**。不能把上述逐文件相等扩大为完整Android沙箱备份或可移植Keystore备份 |

协调器实现与当前全测覆盖如下；早期P2a/P2b/P2c的“incomplete”描述已被P2d/P5 composite supersede，不能当当前状态。

| 阶段 | 实现与恢复 | 证据 / 未完成 |
|---|---|---|
| DETECTED | 源识别、空间/解锁、版本、目标冲突；PodJS-only/NONE不创建目录或锁 | JVM无源零写入、16并发调用和已admit缓存通过 |
| SNAPSHOTTED | DB+WAL固定副本，stores/files清单；禁止源写入 | JVM源字节/写锁测试、私有副本重放通过 |
| COPYING | Room批次事务+游标、store candidate、文件part/receipt；后台单线程，MainActivity立即显示RecoveryView | JVM批次/文件真实进程终止恢复通过；本轮物理日志仅观察至COPYING后因充电安全门中止控制器 |
| VERIFYING | 重建预期DB逐表digest、production store回读、file/catalog一致性与blocker | JVM+本轮全量独立离线oracle通过；物理完成PENDING |
| READY / ACTIVATING | 完整bundle才准入；sync候选/receipt并原子替换单一active指针 | JVMpointer前后终止、torn temp、多进程锁/并发读取通过；物理PENDING |
| ACTIVE | 全存储同一代际，进程内固定路径；新进程验证当前store，终态不重导旧快照，不覆盖用户后续写入 | JVM新写保留/二启终态通过；本轮设备二启与guest出帧PENDING |
| PAUSED | 有resumePhase；解锁/空间/临时故障后重试同代际并验证cursor/receipt | JVMretry与进程退出通过；用户重试UI存在，物理PENDING |
| BLOCKED | 未支持schema/target冲突/unknown store等拒绝guest；保留源/候选 | 不能把按“重试”当批准跳过blocker；需对应adapter或版本修复。converter version变化保留并阻断，自动新candidate策略未实现 |

当前框架全测包括Takeover/Room/Store/File/Canonical/StorePolicy、synthetic consumers、60批次异常+60进程退出、store各边界异常/进程退出以及15个file/activation进程终止点。它们证明测试模型中的恢复，不能替代OWW242断电/同包升级验收。

## 原生专属能力与用户界面

| 能力 | 当前事实 | 接管前缺口 |
|---|---|---|
| 手机连接/同步 | `src/sync/application-host.ts`、foreground/IP/RFCOMM及session/reader资源/note资产/remote input已有；原生device identity先迁移再默认初始化 | 本轮不操作手机、不发账号写请求；真实双端、断连/ACK、大正文及权限验收PENDING |
| 通知与后台 | host notification/scheduler/worker/playback storage入口有admission gate；应用后台handler与6h cloud worker已有，cloud/acoustic严格debug gate | 系统权限、通知显示/点击、进程回收后调度及后台存活PENDING；不能把UI可达当后台成功 |
| WorkManager旧任务（T3） | app 声明原生类/name；框架 on-demand WorkerFactory 映射为无害 worker，ACTIVE admission 后按 unique name/显式及自动 class tag 取消并持久记录。PodJS cloud 改用 `podjs-cloud-sync-6h` | 代码兼容缺口已处理；synthetic WorkManager/Room 的旧类、取消、重复启动、磁盘重开和 2.10.1 v23→2.11.2 v24 升级有 Robolectric 覆盖。真实同包升级/系统后台唤醒仍 PENDING，正式发布门槛未撤销 |
| debug-only全覆盖 | `application.buildInfo().debugBuild` fail-closed门控；声波/云/性能/调试UI已有 | C15外部alias/故障广播/provider dump ABI仍未找到；C17详细TTS model/voice/baseURL/key手表编辑仍子集。用户要求全迁，不能擅自豁免 |
| C审计历史与决策 | C11手工Cookie在手表release保留、C12收藏持久化已获用户决定；C01 OSS低优先级。C02–C10旧行号来自较早源码，当前不能整体照抄为仍缺失 | C16隐藏独立总结页仍需用户范围决定；其余已修项需要按最新基线走页面/离线行为验收，不能从历史表直接关闭设备验收 |
| 接管进度/失败/重试 | lead的Java `RecoveryView`为圆屏黑底、边缘进度环、字节/阶段、BLOCKED说明和“重试迁移”；controller弱引用Activity，后台执行后回主线程创建guest | 没有重写UI。本轮被系统充电层覆盖，圆屏进度布局、失败文案/按钮实际点击与无缝进入guest全部PENDING |

WorkManager保存worker类名并建议旧类名兼容factory的机制依据 [WorkManager API](https://developer.android.com/reference/androidx/work/WorkManager)。这里是从当前代码推导出的风险，未在原生安装上启动或修改WorkManager数据库。

## 回滚预案与用户决策

**重装旧code40原生APK不是生产回滚方案。** Android正常更新防止安装较低versionCode；同包同签名不会解除该限制。[Android版本管理](https://developer.android.com/studio/publish/versioning)

1. 首次接管发布前应准备同包、Lightning Studio签名且code高于接管候选的**原生救援APK**，固定源码与原生业务schema；提前用隔离夹具验证升级/WorkManager schema、manifest/入口/权限与旧alias可访问。版本分配要预留前向修复和救援code。目前没有构建或验收该救援APK。
2. ACTIVE之前失败：原生Room、prefs和文件设计上保留；可用更高code的原生救援包恢复读取旧基线。Keystore、系统后台记录及救援启动仍需验证，不能承诺仅安装即可完成。
3. ACTIVE之后用户新增/修改的资料在PodJS代际中，原生库仍是旧基线。先保存PodJS代际与原生源，再做反向导出/合并（冲突、墓碑、阅读进度、资产、账号配置逐项）。当前没有反向迁移器，所以**不能承诺ACTIVE后的无损回滚**；优先同代际前向修复。禁用任何自动清源/卸载/clear方案。
4. 源与迁移候选不自动过期删除；不能把同UID密钥当可导出文件备份。两个并存包都有新数据时，需要用户决定以哪个数据源为准或如何合并，不能自动覆盖`.podjs`。

需要用户/lead决策：发布渠道最高code与救援code分配、先原生救援还是只允许前向修复及ACTIVE后写入的回滚风险、并存两包资料合并策略、C16隐藏页范围、正式LLM/TTS失败时的明确恢复选择，以及最终同包升级授权。本任务不询问或执行最终覆盖安装。

## 本轮证据与交接

- app全测1231PASS/typecheckPASS；framework全套多语言测试/typecheckPASS；CLI build和演练app/test APK构建PASS。首次Gradle失败为旧手册漏传`podCleartextTraffic=true`，已修正命令，原失败保留。
- 设备仅e3aca8af；原生只force-stop和run-as只读tar，metadata仅只读dumpsys。读取副本含153个文件，私有0700目录，无完整userdata tar落盘。正式包未安装、未清数据。
- 本轮物理控制器在看到充电层前已开始演练；随后BACK→264→265→HOME逐次截图均仍为系统充电层，遵循DEVICE_BRIEF停止所有ADB，并在主机SIGTERM结束控制器/phase logger。**没有result.json，也没有设备after摘要；不声称nativeUnchanged/equal=true。** 已安装演练app/test包的可能残留、迁移后台进程和最终前台状态未再查询；不得以离线PASS掩盖这次物理中止。
- `.codex-tmp/t1/charging-pixel-stats.json`：5张466×466图nonRGB0为80662/113320/122472/112907/122239，MAE对K8首页45.8113/44.0317/46.6253/43.7879/46.4485；截图显示92%充电圈，未证明任何guest页面或首页尺寸。
- 本次新副本离线重放：30表/完整reader KV/137文件快照/63资产/14store源均通过，0blocker/8known differences，COPYING+VERIFYING为6581ms（Linux），source_unchanged仅指主机副本；不是手表时间、Android crypto或字体验收。
- 后续先在充电层可退出且安全门解除后由授权设备负责人：只读原生after摘要与本次before复核；按文档精确卸载`.rehearsal.test`和`.rehearsal`，重跑普通+`--interrupt-phase COPYING`两轮；完成所有页面/像素核对、二启、guest instrumentation，回收演练包并回正式PodJS首页。**本轮最终首页及演练包卸载PENDING**，安全门阻止操作，不能称本任务DONE。

详细命令见 [takeover-rehearsal.md](takeover-rehearsal.md)，脱敏结果/测试日志见本轮`.codex-tmp/t1/`；真实源副本仅在私有`/tmp`，不提交或分享。此前P2–P5报告是覆盖式文件，当前report已为RS3；本轮使用P2–P5实现文档、任务记录、P5离线日志和device report-04可核查证据，不声称找到了未保存的原报告全文。


## T3：原生 WorkManager 盘点与迁移兼容（2026-10-07）

范围：原生手表仓库 `Android_WatchRSS` 的全部 Kotlin 源码使用点，未修改原生代码。
未发现其他 WorkManager request（刷新、日志、蓝牙/IP同步使用其他机制，不伪造任务清单）。
历史发布版本的其他 worker/name 仍应由 release owner 对照历史源码确认。

| 请求/入口 | worker / unique name / tag | 约束、周期、输入、策略 |
|---|---|---|
| 原生 `WatchRssApplication.onCreate` debug schedule，release cancel | `com.lightningstudio.watchrss.data.cloud.WatchCloudSyncWorker`；`watchrss-watch-cloud-sync-6h`；无显式 tag，自动 class tag | 6h、UNMETERED、无输入、无显式 initial delay，UPDATE；默认指数退避。worker release 直接 success，debug 无账号 success；同步失败最多3次 retry 后 failure |
| PodJS `src/cloud/application.ts` / `PodCloudWork` | `dev.podjs.runtime.PodCloudWorker`；T3 改为 `podjs-cloud-sync-6h`；自动 class tag | debug-only、6h、首次延迟6h、UNMETERED、指数退避30s、无输入、UPDATE；release cancel。现有生产 scheduler 在 guest admission 后注册，不迁移运行中的原生任务状态 |
| 通用 `PodBackgroundScheduler` | `dev.podjs.runtime.PodBackgroundWorker`；`podjs-bg:<app长度>:<app>:<task>`；自动 class tag | 一次性、可选 CONNECTED、earliestAt延迟、指数退避10s；输入 app/task，任务 payload/方法白名单保存在host DB；REPLACE |
| 通用 `PodNotifications.schedule` | `dev.podjs.runtime.PodNotificationWorker`；`podjs-notification:<id>` tag；自动 class tag | 一次性、at延迟、无网络约束；输入 notificationId；enqueue 后按authoritative run收敛，不与原生 cloud unique name冲突 |

应用 `android.workManagerTakeover` 明确声明原生 appId、完整 worker 类名、旧 unique name。
框架对同包名生效；当前并存 `.podjs` 及独立 rehearsal 不清理原生包记录。
自动 class tag 取消可覆盖未命名/一次性遗留请求；本次原生没有显式 tag，配置 tags 为空。
WorkerFactory 先于任何 WorkManager 调度安装；旧类不反射加载原生 Kotlin 类。
迁移前 stub 只 retry，不访问业务数据或触发迁移；ACTIVE 后返回 success 并自取消，
周期请求不再重调度。接管完成后等取消操作落盘，才放行 guest，随后现有 app scheduler
注册等价 debug cloud 工作。release 沿用原生 debug gate，禁用 cloud。

T2 合并点只有 `PodTakeover.paths` 的 post-admission 调用与 cached Activity admission
完成条件；不改 Coordinator、converter、快照/备份/恢复流程。完成标记/锁放独立
`no_backup/podjs-workmanager-takeover`，按generation与公开配置hash区分。原生 DB、prefs、
文件和 T2 备份目录不改写。生产清理只用 WorkManager cancel API，不删除 workdb、
不直接改SQL、不调用全局 cancelAllWork/pruneWork；测试中的SQL仅用于synthetic夹具。

源码/JVM验证不能证明真实系统 JobScheduler/进程回收顺序或正式同UID升级。
后续由有设备权限的 lead 派发：在专用测试包/合成旧worker DB里验证首次冷启动与
系统后台唤醒、ACTIVE前等待/ACTIVE后取消、重复启动保留PodJS工作；同包正式升级需
先完成现有版本/签名/备份/设备安全门，不能直接把并存APK安装视为验收。
本任务没有 adb、安装、仪器化执行或签名密码读取；整体接管发布仍为 PARTIAL。
