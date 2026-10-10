# T32 Android 系统 Splash 接线

配置由 `pod.config.json` 的 `android.splash` 声明；主题、保持条件与退出动画由 PodJS 宿主提供。WatchRSS 使用黑色背景、现有 `watchrss_splash_icon`，alpha 淡出并放大到 1.12，配置时长 80ms，与原生 `SYSTEM_SPLASH_FADE_DURATION_MS` 一致。普通 Activity 主题是 `Theme.WatchRSS.PodJS`，不再声明另一套 API 31 启动主题。

`StartupGate` 挂载时调用 `@podjs/framework/splash` 的 `hold('startup')`；首次使用、隐私页、错误页就绪时释放，常规内容等待 `afterFirstScreen(8000)`。清理时也释放。框架在实际释放后等待下一次有内容的 texture 回调；Activity 的绝对 8 秒兜底不会被 JS hold 延长。系统 Splash 始终由 AndroidX/platform provider 持有，应用不再绘制 `launch-native` 覆盖层或执行退出动画。

目的页面、首次使用和错误界面的原有渲染路径保留。非 Home 恢复路由未必发出首页数据就绪信号，可能等待宿主 8 秒兜底；应由 lead 复核此类恢复体验及本次最小 UI 接线。T32 真机验证范围是独立 rehearsal 的已初始化 Home 冷启动，不包括正式包迁移或账户操作。

旧 `upstream-u9` 覆盖层冻结差分测试只适用于已删除的自绘组件。本次改为检查生产接线与删除；它不再声称与旧覆盖层行为等价。框架旧通用 startup/startup-overlay API 和冻结 fixture 保留，其他使用者仍可使用。新宿主保持、超时、RecoveryView 和一次退出由框架测试覆盖，实际三轮录屏和数值见主 checkout 的 `.codex-tmp/wrss-impl-report.md`。
