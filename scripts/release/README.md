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

所有渠道均要求非 debug、没有 debug-external 组件、APK 签名实际验证通过、当前和
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

**当前原生 `highestPublishedVerified=false`，正式接管和救援候选会失败。**
发布负责人需要先核实全部渠道最高 code、原生已安装公有 signer、来源版本和恢复
候选，再审阅更新 policy 与历史项。工具通过只表示列出的离线门槛通过；不代表数据
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
