# DBG2 — ManagedCache #22 与播放诊断

基线：应用 a32a129 / 框架 22f0cc0；两仓 `impl/debug-parity-2`，各自 wt-impl。
不操作设备，不读取或打印签名密码，不改布局、样式、文案或播放隔离行为。

机制进入框架 `@podjs/framework/cache`：FileCache / createFileCache，URL+排序
headers 的 key、下载去重/2 worker、引用 acquire/release/cancel、producer pins、
串行扫描/计费/维护/删除验证、flat clear 生命周期、stage cleanup。原子 HTTP
下载与 M3 的 hash/file.commit 接线仍用既有 host，不新增传输或存储协议。
新增 stats 只读计费不触发 cleanup、touch、publish 或 observer。

应用只保留 ManagedCache 兼容 wrapper、CacheNamespace 与 cacheEvictionOrder：
桶顺序/名称、正则、offline 深度<16/不淘汰、512MiB 默认上限、内联图 128MiB、
抖音 6→4 reserve、中文错误、图片验证与 8MiB 下载参数。合法生产输入的
操作顺序/错误/通知与冻结旧实现一致。框架额外拒绝不合法 root/bucket/filename，
路径中的空段、dot、反斜杠、NUL，以及 policy 未扫描/已 pin 文件；不改变实际
WatchRSS namespace 的合法路径。clear 仍是原 flat-bucket 语义，须先停用 decoder。

冻结 oracle：`tests/fixtures/dbg2/cache`，原始 managed/policy `.txt` SHA-256 在
`sha256.json`；可执行 managed.ts 与原文件相同；policy.ts 仅 import 路径调整。
差分比较 hash inputs、下载 headers/path、取消、touch/delete、usage 通知、
最终文件及错误文本：共享去重/header identity、hash 后取消、clear/producer、
排队取消、stage/unknown 保留、offline 递归、非法参数、native 淘汰、损坏图片重取。
保留原 managed-cache 与本地 Range/commit Bili 测试，框架增加通用约束与不注入
ports 的生产默认桥测试；session pool 同样不注入 port 走真实 service bridge。

C15 映射见 `debug-parity.md`。主 dump 把 M3 明确标为 B站 index；原生抖音
RAM 字节/preview download producer、quarantine reason/count/time 无对应概念，
保留 unavailable。视频缓冲预算绝不当成 RAM 用量。诊断来自当前播放所有者，
不从 K11/K16 renderer thread 推断，不打印 source URLs/headers/errors。

最终测试、类型检查、CLI build、unsigned debug/release manifest/DEX 检查与
提交 ID 记录在 `.codex-tmp/wrss-impl-report.md`。构建/源码测试不能代表设备
视觉、播放或正式包数据验收；需 lead 派专属设备 agent 后续验证。
