# WatchRSS · PodJS

WatchRSS 手表端的 TypeScript / Solid TSX 重写工程，使用本机 `../../PodJS/podjs-watch` 框架。当前是开发中的独立 Android 测试应用，**尚未达到完整 Android 版功能对齐**。

## 开发

```sh
bun install
bun run typecheck
bun test tests
bun run build
bun run package:android
```

`pod.config.json` 定义入口、应用标识、字库和所需宿主能力。`framework.lock.json` 锁定已提交的框架基线与 PocketJS revision（`requiresLocalChanges=false`）；构建环境必须能取得这两个提交。应用使用 `com.lightningstudio.watchrss.podjs`，不会覆盖已安装的原生正式版。

## 已接入

- RSS/Atom、SQLite 订阅与文章库、离线长文、收藏／稍后再看、文章笔记、导入内容删除、首页刷新和频道管理。
- 阅读器正文/原文、媒体与离线回退、阅读预设、最终进度冲刷、自动滚动、TTS 播控、首页朗读卡片与实时频谱。
- protocol v14 蓝牙/IP 同步、实时预览流、阅读资源、统一平台保存库、账号/Token/日志动作、旧 HTTP 导出页面与连接状态页。
- B 站推荐/搜索/列表分页、原文模式、分 P/互动/离线详情、播放失败换源、评论与楼中楼。
- 抖音沉浸/RSS 双模式、最近窗口与队列恢复、离线详情、网络遮罩、登录/二步验证、退出清理，以及双 session 预热和跟手竖向切片；旧宿主保留单播放器回落。
- 信息页状态恢复、应用内 WebView、应用级脱敏日志和加密上传、分享二维码比例、用量 telemetry；版本公告/更新代码存在但仍关闭，见下方边界。

以上均按源码与自动化验证描述，不等于设备验收。当前集成树通过 1021 项应用测试、TypeScript 检查和 Android-watch 打包；本轮无在线设备，真机证据仍为 PENDING。提交与逐项边界见 [2026-10-04 迁移冲刺](docs/implementation-status.md#2026-10-04-迁移冲刺)。

## 尚未完成

- **等待设备验收（全部）**：本轮所有源码完成项都需要 OWW242/配对手机上的安装升级、数据完整性、页面/视觉、物理手势、媒体表面、登录、网络/后台、蓝牙/IP/HTTP 互通和错误恢复证据。当前没有在线 ADB 设备；不要把 1021 项单测或打包成功写成产品验收。
- **等待用户决定版本分发策略**：PodJS 使用 `com.lightningstudio.watchrss.podjs`，与原生包名不同；宿主没有 `packageUpdate` 能力，尚不能完成目标包校验、下载进度与系统安装器链路。`VERSION_ANNOUNCEMENTS_ENABLED=false`，在分发/安装/回滚策略确定前不启用版本公告更新。
- **原生仅 debug 构建存在、release 无的能力**：云同步（`WatchRssApplication` 在 release 会取消 worker）、声波/引导 Wi-Fi、Debug 蓝牙同步页、性能探针、抖音调试注入、TTS 调试设置、重新进入引导。它们未迁移，但不列为当前 release 对齐阻塞；是否迁移等待用户决定。

设备验收清单仍以 [docs/acceptance.md](docs/acceptance.md) 为准，其中 `NOT VERIFIED` 未因本轮源码与打包结果而改动。功能差距和提交级证据见三份审计：[A-1](docs/parity-gap-audit-a.md)、[A-2](docs/parity-gap-audit-a2.md)、[B](docs/parity-gap-audit-b.md)。

功能验收基线见 [docs/acceptance.md](docs/acceptance.md)，数据/协议约定见 [docs/migration-contract.md](docs/migration-contract.md)。当前测试证据与限制见 [docs/implementation-status.md](docs/implementation-status.md)。
