# T-SYNCGIT-P3B 手表端

已完成：本端受控入口与合成验收。
未验证：后端联调与真实业务对象接线。

## 实现计划

1. 固定任务卡 C12–C17 为范围依据。
2. 读取规范第 12 与 17.1 节。
3. 读取规范第 18.5 与 18.6 节。
4. 读取规范第 19.3 与 20.2 节。
5. 框架提供有界资源日志与原子事务。
6. 应用提供清理策略和证明校验。
7. 本机保存 N07 最小恢复集合。
8. 执行固定向量、故障与资源检查。
9. 执行全量测试和合成模拟器验收。
10. 提交两个 `syncv2-p3b` 分支。

## 共同条件

- 应用基线：`ed62fa0b`。
- 框架基线：`bebf552`。
- `auto_evict` 默认关闭。
- 日常启动与定时器没有接线。
- `lease` 与 `custody` 路径保持关闭。
- `custody_release` 保持关闭。
- C17 只允许当前云闭包的签收证明。
- N07 密文与正文 pin 只在本机保存。
- 不推送、不合并、不部署。
- 不操作真实账号、真机和生产。
- 不删除真实本地正文。

## 改动

- `src/sync-v2/eviction.ts:4`：7 天边界与固定清理顺序。
- 旧 RSS 排在导入内容前。
- 从未打开的导入内容排在时间 0 前。
- 备忘录、图片和 unknown RSS 保持保护。
- `src/sync-v2/space-store.ts:13`：持久开关与时间水位。
- 缓存描述符最多 8192 字节。
- 超限时保留原正文并返回失败。
- `src/sync-v2/space.ts:24`：空间检测与清理窗口。
- 清理前验证当前账号与正文版本。
- 清理前验证当前 recipe 与全部 blob 摘要。
- 清理前验证 `SignedAvailability` 的签名与期限。
- 占位、引用解除与正文状态共用 CAS 事务。
- 并发打开和编辑使旧 CAS 失效。
- 崩溃续做必须再次查询当前完整副本。
- 失联或签收过期时保留物理正文。
- 释放统计只计原生层实际截断的字节。
- `space.restore` 在完整哈希通过后替换占位。
- 业务 ID、addedAt 和本地元数据保持不变。
- `src/sync-v2/space-runtime.ts:14`：显式工厂入口。
- 工厂只接收经过认证的 P3 下载缓存。
- 工厂保护全部 asset 与 note。
- 工厂在本机存在未传编辑时跳过清理。
- `src/sync-v2/content-engine.ts:43`：重新下载使用新缓存代。
- 原始导入文件与上传来源不进入删除日志。
- 原始加密传输缓存仍归 P3 管理。
- 本卡只释放派生明文缓存。
- `src/sync-v2/recovery.ts:39`：独立本机密钥与稳定 copyId。
- 恢复差异只保存会丢失的本机值。
- 部分旧输入只比较捕获的实体集合。
- 必要正文按 64 KiB 分段加密。
- 正文完整哈希通过后才提交恢复引用。
- 恢复引用、pin、active 和编辑确认共用 CAS。
- 任一准备失败均保留全部原编辑。
- 到期事务同时删除密文引用与 pin。
- 未知时间或时间回退时保留副本。
- `restoreAsEdits` 只创建新的本机待提交编辑。
- `tests/reader-page-prefetch.isolated.ts:15`：保留真实宿主导出。
- 该夹具仍只覆盖自己的 `getOps`。
- `framework.lock.json` 保持标准仓库路径。
- 依赖清单没有工作树路径。

## 提交

- 应用代码：`b4649b53ba3bf0eb14faff7e9fdf8bd82a2df137`。
- 框架代码：`849aa6f62bc87d03313cb4f10c616934f17b2de4`。
- 框架最终交付：`f7a9bc85c5a0ebd6e8d257a796dc68267258320d`。
- 本报告提交同时更新框架锁定版本。

## 验收

| 条目 | 状态 | 方法与结果 |
| --- | --- | --- |
| 1. eviction 向量与保护 | 已验证 | 固定 expected 的 2 个向量通过。边界和图片反例通过。没有改生成器。 |
| 2. 不充分副本与并发 | 已验证 | 旧版本、过期、部分、失联、同伴、租约反例分别通过。并发打开与编辑分别通过。 |
| 3. 占位重新下载 | 已验证 | 真实 P3 合成 HTTP 收发、哈希拒绝和新缓存代通过。ID 与 addedAt 保持。 |
| 4. 崩溃一致性 | 已验证 | 3 个 `SIGKILL` 子进程分别覆盖清理前、占位事务中和正文删除后。重开 SQLite 保持一致。 |
| 5. 资源 | 已验证 | 主机与模拟器数据见下表。清理扫描没有读取正文。 |
| 6. 全量测试 | 已验证 | 应用 3307 项通过、4 项跳过、0 项失败。框架全量命令退出 0。 |
| N07 本机集合 | 已验证 | 独立密钥、正文 pin、配额失败、最小差异、稳定 ID、到期 CAS 和显式恢复通过。 |
| 后端隔离联调 | 未验证 | 当前使用合成 HTTP。等待 Claude 通知。 |
| 真实业务对象闭包端口 | 未验证 | `source(refs, changes)` 当前使用合成认证来源。正式调用方必须提供完整闭包核验。 |
| 物理设备资源 | 跳过 | 任务卡只允许模拟器。 |

## 资源

| 检查 | 主机 | 模拟器 |
| --- | --- | --- |
| 扫描条数 | 2048 | 96 |
| 元数据批量上限 | 32 项 | 32 项 |
| 元数据分页查询 | 65 次 | 4 次 |
| 逐条查询基线 | 2048 次 | 96 次 |
| 全部 SQL 查询或调用 | 每轮 70 次桥调用 | 8 次查询 |
| 正文读取量 | 0 字节 | 0 字节 |
| 单窗口耗时 | 23.25 / 14.28 / 13.62 ms | 76 ms |
| 进程峰值 RSS | 82964 KiB | 157488 KiB |

- 主机峰值读取 `/proc/self/status` 的 `VmHWM`。
- 模拟器峰值包含 JVM 与原生宿主。
- QuickJS 内存上限为 32 MiB。
- 该上限不是 guest 峰值测量。
- 模拟器最大宿主请求为 155650 字节。
- 模拟器恢复正文为 131075 字节。
- 模拟器扫描没有全量读取正文。
- 退休路径不得重新使用。
- 重复删除返回 0 字节。
- 崩溃准备的暂存引用与配额保守保留。
- 自动核对孤立暂存记录不在本入口内。
- 调用方不得凭数组位置释放暂存配额。

## 验证命令

- `bun run test`：3307 项通过，4 项跳过。
- `bun run typecheck`：退出 0。
- `bun test tests/sync-v2/p3b.test.ts tests/sync-v2/p3.test.ts tests/sync-v2/p3-review.test.ts`：110 项通过。
- `bun tests/sync-v2/p3b-benchmark.ts <证据路径>`：3 个扫描窗口通过。
- 框架：`CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR=<scratch> bun run test`：退出 0。
- 模拟器：`ANDROID_SDK_ROOT=/home/wilf/Android/Sdk bash tests/sync-v2/emulator/run-p3b.sh /home/wilf/data/PodJS/podjs-watch.wt-syncv2-p3b emulator-5582 <证据路径>`。
- 模拟器结果：`OK (1 test)`。
- 首轮框架脚本使用仓库默认 Gradle 配置。
- 最终轮次使用本地 `org.gradle.workers.max=2`。
- 模拟器构建显式使用 `--max-workers=2`。
- 本地限值配置不进入提交。

## 未做

- 未接入日常启动、后台定时器和设置界面。
- 界面文案由 Claude 编写。
- 后端联调等待 Claude 通知。
- 恢复密文没有上传云。
- 没有清理原始导入文件和 P3 加密传输缓存。
- 没有开启 P4 同伴保管或释放协议。
- 没有操作主工作区、真实账号和真机。
- 没有推送、合并和部署。

## 证据

- `reports/T-SYNCGIT-P3B-watch-evidence.json`：计数与新测试名称。
- `/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/p3b-watch/`：完整日志。
- 框架报告：`/home/wilf/data/PodJS/podjs-watch.wt-syncv2-p3b/reports/T-SYNCGIT-P3B-framework.md`。

## 新测试

- 手表：62 项。
- 框架：9 项。完整名称见框架报告。
- 模拟器：1 项，`P3BSpaceGuestTest.spaceGuest`。

- `P3B fixed eviction vector 0`。
- `P3B fixed eviction vector 1`。
- `P3B factory is inert by default`。
- `P3B auto_evict defaults off and survives reopen`。
- `P3B protects memo`。
- `P3B protects memo-image`。
- `P3B protects note-image`。
- `P3B protects unknown-rss`。
- `P3B protects recent-rss`。
- `P3B protects opened-boundary`。
- `P3B protects opened-now`。
- `P3B protects dirty`。
- `P3B rejects old-version independently`。
- `P3B rejects old-recipe independently`。
- `P3B rejects expired-receipt independently`。
- `P3B rejects partial-upload independently`。
- `P3B rejects missing-blob independently`。
- `P3B rejects wrong-scope independently`。
- `P3B rejects future-receipt independently`。
- `P3B offline-copy cannot authorize deletion`。
- `P3B peer-only cannot authorize deletion`。
- `P3B ten-minute-lease cannot authorize deletion`。
- `P3B historical-copy cannot authorize deletion`。
- `P3B staged-copy cannot authorize deletion`。
- `P3B concurrent open invalidates eviction`。
- `P3B concurrent edit invalidates eviction`。
- `P3B concurrent account-change invalidates eviction`。
- `P3B concurrent disable invalidates eviction`。
- `P3B old local account proof cannot authorize current cleanup`。
- `P3B fixed ordering is old RSS then unopened import then least recently opened import`。
- `P3B shared resources are retained until their last owner detaches`。
- `P3B placeholder re-download retains metadata and rejects bad plaintext hash`。
- `P3B clock null pauses eviction`。
- `P3B clock 999999999 pauses eviction`。
- `P3B unknown free space pauses eviction`。
- `P3B crash before-placeholder reopens consistently`。
- `P3B crash during-placeholder reopens consistently`。
- `P3B crash after-body-delete reopens consistently`。
- `P3B scan uses bounded metadata pages and zero body bytes`。
- `N07 minimal differences exclude unchanged entities and unrelated captured rows`。
- `N07 business schema rejects credentials in recovery values`。
- `N07 encrypted recovery and pin commit with active/edit acknowledgement`。
- `N07 stable copy IDs survive first expiry, append, restart and later expiry`。
- `N07 quota failure preserves edits and pendingChoice`。
- `N07 encryption failure preserves edits and pendingChoice`。
- `N07 closure failure preserves edits and pendingChoice`。
- `N07 io failure preserves edits and pendingChoice`。
- `N07 cas failure preserves edits and pendingChoice`。
- `N07 disabling affects future choices and retains prior promises`。
- `N07 tampered copyId cannot decrypt another copy`。
- `N07 clock rollback and unknown time retain ciphertext and pins`。
- `N07 expiry CAS failure keeps ciphertext and pins together`。
- `P3B real SIGKILL before-placeholder opens a complete SQLite state`。
- `P3B real SIGKILL during-placeholder opens a complete SQLite state`。
- `P3B real SIGKILL after-body-delete opens a complete SQLite state`。
- `N07 necessary body closure is encrypted, pinned, readable and released at expiry`。
- `N07 body hash failure cannot acknowledge local edits`。
- `P3B real content receiver detaches atomically and re-downloads into a fresh cache generation`。
- `N07 explicit restore creates pending edits without changing cloud or active state`。
- `P3B resumed deletion requires fresh current availability after placeholder commit`。
- `P3B lease endpoint stays closed before HTTP`。
- `P3B custody endpoint stays closed before HTTP`。

## 验证环境与清理

- 本地依赖链接指向本端框架工作树。
- 依赖清单与锁文件不包含该路径。
- 子模块固定为 `214fd8c1e7450c21c5052fb060b4cb9540fba907`。
- 全量 UI 测试前生成中性样式镜像。
- 镜像只供测试初始化。该文件不进入提交。
- 初始化命令在框架根目录执行：

```sh
bun -e 'import {compileClasses,generateStylesModule} from "./vendor/pocketjs/framework/compiler/tailwind.ts"; await Bun.write("./vendor/pocketjs/framework/src/styles.generated.ts",generateStylesModule(compileClasses([])));'
```

- 已完成：清理本次 scratch 与 Android 构建产物。
- 已完成：清理中性样式镜像和临时测试日志。
- 已完成：关闭自建模拟器 `emulator-5582`。
- 完整验证日志保留在证据目录。
