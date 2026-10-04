# 系统分享与二维码分享

主应用部署证据见 `artifacts/system-share-deployment-receipt.json`。Android Host 增加 `share.environment` / `share.text`，使用 `ACTION_SEND`、`text/plain`、`EXTRA_TEXT` 和 chooser。选择收件人由用户完成。WatchRSS 按原生规则仅在 API 31 以上且非 Wear OS 时显示系统分享开关，否则使用二维码。

频道和 B 站详情去除标题/链接的首尾 Kotlin 空白，允许只有链接。阅读详情保留原始文本并拒绝空白标题。RSS/B 站/抖音操作页分享后移除自身，详情页保留；等待环境查询时离开来源页面会取消后续导航。B 站链接支持字符串长 aid，抖音 ID 按原生规则拼接。

二维码页使用 UTF-8、白码黑底和频道提示；提示按原生的单行文本显示。长链接曾在 256 像素纹理缩放到 260 像素时无法稳定识别。现在按实际显示像素生成整数栅格，放入框架要求的二次幂纹理，通过裁切按原尺寸呈现。其他二维码页面维持其原有参数。

验证：

- 应用 500 项测试、类型检查和 SDK 32 项服务契约测试通过。
- 手表 e3aca8af（API 30）2 项 instrumentation 测试通过。18 组文本输入调用已安装原生参考 APK 的实际函数，核对 chooser 标题、MIME 类型和文本；验证 Host 分发、启动前取消、无 Activity/无效参数拒绝以及设备支持判断。
- 原生解码器（显式指定 UTF-8）验证 3 类链接（普通、中文、长链接）的 256/260 像素栅格，并从真实 GPU 帧读回二维码；保存频道提示和设置开关两种状态，共 6 张截图。当前设备的支持判定为 false，确认隐藏设置；展示开关的截图使用测试注入的支持标志。
- 主应用安装包的 JS/资源包和部署哈希核对，DEX/本地库与原生测试 fixture 核对；主应用鉴权、只读同步及阅读器预设/预览回归通过。后者使用蓝牙引导和 ADB relay，不作为 Wi-Fi LAN 验证。
- 安装前后 30 张业务表、188 个受保护的非数据库文件保持一致，只有 WorkManager 的停止时间推进。独立测试包和 relay 已清理，原有参考 APK、手机应用哈希保持不变。

`CaptureActivity.startActivity` 截获 Intent，没有向任何收件人发送内容。原生测试输入由 `scripts/verification/generate-system-share-cases.ts` 从生产规则生成。GPU 截图测试使用 `tests/runtime-system-share` 中的生产组件，不模拟物理点击。

仍未验证：跨手机扫码器的自动字符集识别、真实系统选择器界面与返回交互、操作页返回的端到端行为、API 31+ 非 Wear OS 和 Wear OS 真机分支、完整像素/动画一致性。二维码矩阵编码和进入动画仍未与原生逐像素对齐，标题/提示的 marquee 测量和完整布局也未完成原生像素验收。完整迁移尚未完成。
