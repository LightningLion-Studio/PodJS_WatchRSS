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

`pod.config.json` 定义入口、应用标识、字库和所需宿主能力。`framework.lock.json` 记录本次框架基线；目前还依赖框架工作区的配套未提交改动，不能只按该提交号构建。应用使用 `com.lightningstudio.watchrss.podjs`，不会覆盖已安装的正式版。

## 已接入的开发流程

- SQLite 持久化订阅、文章、已读、收藏和文章笔记。
- 通过原生流式 HTTP 下载 RSS/Atom，支持离线阅读和长正文分块存储。
- Solid TSX 订阅、文章、收藏、搜索、笔记和基础设置页面；原生文本输入、分页、表冠与返回事件。
- 共享阅读文本布局、原生 TTS，以及自定义字体和图片／视频阅读背景；具体原生画面对照范围见功能文档。
- 生产前台同步监听与协议分发；配对蓝牙已完成隔离手机／手表的阅读资源上传、断线续传、回读与实际渲染验证。

## 尚未完成

完整功能、交互与画面一致仍未达到。阅读资源的最新进展见 [手机资源传输](docs/reader-resource-transfer.md)、[字体](docs/reader-fonts.md)、[背景](docs/reader-backgrounds.md) 和 [预览](docs/reader-preview.md)。段落排版与真机原生对照见 [段落渲染](docs/reader-paragraphs.md)。音量设置入口进展见 [音量设置](docs/media-volume-settings.md)。「从手机输入」与蓝牙地址交接见 [远程输入](docs/remote-input.md)。图片缓存与高级设置见 [缓存进展](docs/managed-cache.md)。分享分流、二维码与设备限制见 [分享进展](docs/system-share.md)。设置占位清理、备案入口与分享启用规则见 [设置范围核对](docs/settings-parity-audit.md)。该已部署设置增量通过 501 项应用测试。正在进行的独立包验证见 [启动引导与协议页](docs/onboarding.md)；新增代码尚未据此视为正式部署或完整产品验收。

原生手机伴侣 UI、Wi-Fi／自动发现、任意资源格式和大文件、完整文章排版、长期性能／耗电及物理手势等仍需逐项验证。独立开发包的有保护升级已验证，但不代表可以替换原生正式包或已达到发布条件。

功能验收基线见 [docs/acceptance.md](docs/acceptance.md)，数据/协议约定见 [docs/migration-contract.md](docs/migration-contract.md)。当前测试证据与限制见 [docs/implementation-status.md](docs/implementation-status.md)。
