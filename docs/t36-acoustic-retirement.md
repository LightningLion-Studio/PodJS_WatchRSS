# 声波废弃（2026-10-10）

用户决定废弃声波连接。应用移除声波页面、PCM codec/原生 oracle、纯声波与引导 Wi-Fi 协议/会话、debug 外部启动/result 业务接线、两个 activity-alias 和 debug.acoustic capability。蓝牙/IP、手机同步、远程输入 inbox、收藏/稍后再看导出、TTS/媒体播放继续保留。

应用没有其他录音使用方。框架 runtime manifest 仍为通用声波能力声明 RECORD_AUDIO，所以仅删除 JS capability 不能移除 APK 权限。`bun run package:android` 现在通过 `scripts/android/package.ts` 调用原 PodJS CLI，在隔离的临时 GRADLE_USER_HOME/init.d 中应用权限合并规则：读取当前宿主 main manifest，保留所有 Activity/takeover 配置，再加入 RECORD_AUDIO 的 tools:node=remove。debug/release 都应用；正常结束或失败均删除临时目录，不改全局 Gradle init 或框架源码。缓存/wrapper 可复用。框架构建源可用 WATCHRSS_FRAMEWORK_ROOT 指定，默认仍使用 framework.lock 的 path。release/debug/version 参数继续传给原 CLI；签名流程不重新实现。

`bun run build` 仍只构建 guest/资源。直接调用裸 PodJS CLI 的 package 不包含应用 Gradle 权限规则，应使用应用 package:android；release preflight 新增 noRecordingPermission，会拒绝仍声明录音权限的 PodJS 包，避免遗漏。此规则不应用于原生 recovery APK。

原生40组件清单是带 APK/manifest 哈希的历史快照，不修改。recovery preflight 只禁止新增未批准组件，不要求保留声波组件，也没有旧快捷方式强制保留规则。internal-debug 现在要求五个精确组件（私有 DebugEntry、抖音/摘要两个 alias、receiver、provider）。两个旧声波名称继续在 debug 检测/拒绝表中，防止重新混入；它们不生成到应用 manifest，不是兼容入口。

框架 PodAcousticServices、PCM/Gzip/引导 Wi-Fi 服务和通用 debug-external activity result 能力不删除。`pod.manifest.json` 的 capabilities 来自通用 host target profile，仍会列出 debug.acoustic；这不等于应用 pod.config.json 的请求列表。应用停止调用它们并拒绝录音权限；具体剩余实现和影响面见 T36 报告，框架清理由 lead 另行决定。
