# 声波废弃（2026-10-10）

用户决定废弃声波连接。应用移除声波页面、PCM codec/原生 oracle、纯声波与引导 Wi-Fi 协议/会话、debug 外部启动/result 业务接线、两个 activity-alias 和 debug.acoustic capability。蓝牙/IP、手机同步、远程输入 inbox、收藏/稍后再看导出、TTS/媒体播放继续保留。

应用没有其他录音使用方。框架 runtime manifest 不再无条件声明 RECORD_AUDIO，以及声波引导 Wi-Fi 专用的 CHANGE_WIFI_STATE、CHANGE_NETWORK_STATE、NEARBY_WIFI_DEVICES。标准 PodJS CLI build/package 从应用 pod.config.json 的 capabilities 生成宿主 manifest：只有显式声明 debug.acoustic 才注入这四项权限。NEARBY_WIFI_DEVICES 的 neverForLocation 属性保留；蓝牙/IP 发现、定位和媒体播放的共享权限保留。

Android/Wear OS 的常规 Gradle 宿主读取 CLI 生成的 main manifest，保留宿主 Activity、启动主题、接管 metadata 和各 variant 的 debug-external 配置。不使用应用 Gradle init、package 包装或全局 Gradle 配置。package:android 恢复原 CLI 入口；应用 framework.lock 仅更新 revision。release preflight 的 noRecordingPermission 继续拒绝声明录音权限的 PodJS 包；此规则不应用于原生 recovery APK。

原生40组件清单是带 APK/manifest 哈希的历史快照，不修改。recovery preflight 只禁止新增未批准组件，不要求保留声波组件，也没有旧快捷方式强制保留规则。internal-debug 现在要求五个精确组件（私有 DebugEntry、抖音/摘要两个 alias、receiver、provider）。两个旧声波名称继续在 debug 检测/拒绝表中，防止重新混入；它们不生成到应用 manifest，不是兼容入口。

框架 PodAcousticServices、PCM/Gzip/引导 Wi-Fi 服务和通用 debug-external activity result 能力不删除。`pod.manifest.json` 的 capabilities 来自通用 host target profile，仍会列出 debug.acoustic；这不等于应用 pod.config.json 的请求列表。权限生成以应用请求列表为准，不能用 host profile 的可用能力代替应用授权。应用停止调用它们并拒绝录音权限；具体剩余实现和影响面见 T36 报告，框架清理由 lead 另行决定。
