# 离线发布门禁（T7）

在应用 worktree 内运行；仅读取候选 APK、公开证书和结构化台账。工具不访问网络、
ADB、签名 properties、keystore 或密码。需要 Python 3.11+、Java 17+、Android SDK
`cmdline-tools/latest/bin/apkanalyzer` 与 `build-tools/*/lib/apksigner.jar`。
SDK 从 `--sdk`、`ANDROID_SDK_ROOT`、`ANDROID_HOME`、`~/Android/Sdk` 依次定位。

```sh
python3 scripts/release/preflight.py check /absolute/path/candidate.apk \
  --channel coexistence > preflight.json
```

stdout 为 JSON（包含 APK 身份、哈希、公有 signer、lineage 和逐项检查），stderr
为人读摘要，所有门槛通过返回 0，任一失败或工具/输入错误返回 1。
`check` 不修改台账、不创建锁文件；不提供跳过签名或手填 APK facts 的命令行参数。

渠道策略位于 `docs/release-ledger.json`：

| channel | 包名 | 版本区段（code modulo 1000000） | takeover 配置 |
|---|---|---|---|
| `coexistence` | `com.lightningstudio.watchrss.podjs` | 大于该包全部历史 code | source=40，purge=0，WorkManager 配置必须完全缺席 |
| `takeover-prebeta` / `takeover-beta` / `takeover-release` | `com.lightningstudio.watchrss` | 1000..899999 | source=40，精确匹配旧 WorkManager 身份 |
| `recovery` | `com.lightningstudio.watchrss` | 900000..999999 | source=0（可缺席），WorkManager takeover 配置缺席；不要求 PodJS 资产 |

并存和接管渠道仍拒绝所有 debug-external 组件。恢复渠道使用 `recoveryComponents`：
实际 APK 的全部 activity / activity-alias / receiver / provider / service 的
（类型、完整类名）集合必须是原生 code40 基线与显式恢复新增名单的子集；普通组件
也不能任意新增，同名换类型也拒绝。组件名缺失或未解析、基线缺失/损坏或与台账
APK 记录不匹配时拒绝。

基线为 `docs/release-baselines/native40-components.json`，来自本机 SHA256
`1d915427e2dce75a62fd71b229e476969ecd655176e6b32ff2e216e2f622895a` 的 code40 APK
的 `apkanalyzer manifest print`，共90个组件；台账 `native-local-baseline` 条目记录
摘要路径和对应APK hash。该APK实际为debug本机候选，不声称与公开发行或现装APK
相同。T2/T4通过 Application 的 attachBaseContext 恢复，无新增manifest组件，
`RECOVERY_ADDED_COMPONENTS` 显式为空；以后任何新增须单独审阅并精确列出。
T9b 为恢复渠道另外保留 `debugExternal` 检查；仅四个精确组件允许与现装 v40 的
AXML 节点逐项相同：LlmSummaryActivity、debug.DebugLogProvider、
debug.PerfLargeArticleActivity、debug.PerfLargeListActivity。完整属性与子节点必须
相同，包括 exported、permission、enabled、theme、authority、intent-filter/action/category；
不归一化 authority 或类名属性。其他 debug 组件即使在旧身份基线内也拒绝。

四组件摘要在 `docs/release-baselines/native-installed-v40-debug-components.json`，
来自 e3aca8af 只读拉取的现装 v40：APK SHA256
`decf31983a9936262eb76c89987acf10d8ba49d15de747d2f6dd61be973a11b7`。
台账 `native-observation` 将 APK、AXML、公有证书及摘要文件 SHA256 绑定；缺失、
篡改或不匹配时 fail-closed。实际现装包 debuggable=true，不声称该基线是 release；
恢复候选本身仍须非 debug。AXML 相等不证明 DEX runtime 门控、资源内容相等或
正式接管设备验收。并存和接管渠道没有这些例外。重复组件身份拒绝。

除显式 `internal-debug` 外，所有渠道均要求非 debug。所有渠道要求 APK 签名实际验证通过、当前和
SDK30 公有 signer 均为期望的 Lightning Studio 单证书。v3/v3.1 lineage 若存在，
必须通过 apksig 校验、顺序与台账允许链完全一致、末端为当前证书、链内每个证书
保留 installed-data capability。并存包允许历史 Android Debug → Lightning Studio
链；原生链尚未批准这种轮换。SHA256 来自 APK 中的 X509 公有证书，不读取独立
lineage 文件或 signing 配置。

`sourceVersionCode` / `purgeBackupAfter` 读取二进制 Android manifest；PodJS 包必须
显式含两项 metadata。WorkManager 配置检查实际打包的 `assets/pod.manifest.json`，
不是源码配置，也不因运行时 appId guard 会禁用而放行。
非零 purge 只有相应渠道 `betaAccepted=true` 且 `approvedPurgeBackupAfter` 为该精确
阈值、阈值不超过候选 code 才能通过；当前所有渠道均未批准清理。

台账里的 `published`、`installed-local`、`observed`、`local-candidate`、`source-baseline`
是不同证据状态，全部保守参与版本上界，避免复用已观察的 code。v27/v28/v29 是
本机并存包安装历史，不代表公开商店发行；原生39/40仅为源码/安装观察/本机候选。
未知 hash/cert/sourceRev 记录为 null，不补造。日期表示证据登记日期；历史 source
revision 未确认，尤其 P2 有并行构建源码漂移，不能从当时 HEAD 推定精确 APK 来源。

**T9b：原生 `highestPublishedVerified=true`。** 用户 2026-10-08 确认全渠道最高
就是本机 build 最高；Gradle 全部 git 历史最大40，现装 v40 APK 身份及公有 signer
已只读核实，证据在台账 `highestPublishedEvidence`。工具通过只表示列出的离线门槛通过；不代表数据
完整性、同 UID 加密账号可用、设备/功能验收或发布授权。真实升级继续遵守既有
`acceptance.py upgrade` 与设备独占规则。

发布完成后，手动调用 `record` 重新检查同一个 APK 并追加台账：

```sh
python3 scripts/release/preflight.py record /absolute/path/published.apk \
  --channel coexistence --date 2026-10-07 \
  --source-rev app=APP_REV --source-rev framework=FRAMEWORK_REV \
  --notes '发布渠道、发布结果和精确构建来源证据'
```

`record` 不是发布命令，也不推断发布已发生；日期/来源/说明由调用者提供。
它使用稳定 sidecar `.json.lock` 串行化写入、fsync 后原子替换台账；保持原 policy 和
历史项，失败不改台账，重复/较低 code 拒绝。同一 APK 发布到其他渠道的事实应由
发布负责人审阅历史注记，不能通过重新分配较低 code 来追加。请勿在发布前 `record`。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/release -p test_preflight.py -v
bun test tests/release-preflight.test.ts
```

测试使用文本 manifest、合成工具输出和临时 fixture ZIP；SDK 可用时额外用真实
`aapt2` 生成 unsigned binary AXML APK，通过生产默认 SDK discovery/Java/apksig
路径确认 unsigned 被拒绝。不生成签名 key，不访问网络；SDK 不可用时该一项明确
SKIP，其他离线测试仍执行。此 Python suite 也接入 `bun run test`。

## T22/T23 internal-debug（仅内部检查）

`check --channel internal-debug` 是唯一允许 debuggable=true 的通道，且要求该属性为 true。
仅允许正式包名，保留 takeover 的签名/谱系、版本、source=40、purge 和 WorkManager 全部门槛。
要求五个精确 debug 组件：私有 DebugEntry，加两个 activity-alias、receiver、provider；
四个外部组件必须 exported=true 且 permission=android.permission.DUMP，provider 不允许 URI 授权或更宽读写权限。
默认/常规 takeover-release 仍拒绝 debug APK 和这些组件。

T23现装v1005身份来自 `.codex-tmp/t22/device/v10/after-identity.json`：
UID10132、debuggable=true、APK SHA256 `e61b69b9d9e219fd0f43fef1e9437f005ecdae1b283ba43899a5aa0be81d1255`。
归档v10-summary为PASS；本轮只读取归档公有身份，不操作设备或重做验收。
版本必须严格大于1005，所有≤1005候选拒绝。
`installedObservation.postObservation` 保留v1003历史PARTIAL，不作为v1005数据验收证据。
台账policy的 `internalDebugVersionCode=1006` 预留含U12/U13的内部候选，不是发布/安装记录。
所有后续正式release必须 **>1006**（最早1007），即使内部候选未安装也不能复用1006。
内部 debug 包不得公开发布，`record --channel internal-debug` 在读取 APK/创建台账锁前即拒绝；
台账 releases 数组也不接受 internal-debug 条目。仅 `check` 返回 PASS 不表示发布授权。
