# 视频首段网速统计

播放器在每次 prepare 后的约 3、5、10 秒首次状态采样中记录累计网络下载字节数和实际经过的毫秒数。网速按 `累计字节 × 1000 ÷ 实际毫秒 ÷ 1024` 计算，单位为 KB/s。状态轮询约每 400ms 一次，因此采样时长会略晚于目标边界；报告保留实际时长并按它计算，不假设采样恰好发生在 3/5/10 秒。

每个播放会话最多写入三条只含平台枚举、进程内会话序号、区间、采样时长和字节数的 `VideoOpt` 记录。记录保存在本地应用日志中，不包含视频 URL、标题、账号、请求头或视频标识；这些早期网速观测不依赖实验性 metrics 开关。

## 生成 HTML 报告

从手表导出应用日志 `app_log.txt` 后，在仓库根目录运行：

```sh
bun scripts/video-speed-report.ts /path/to/app_log.txt video-speed-report.html
```

第四个参数可以填写样本来源说明；分析模拟器或限速实验时应明确标注，例如：

```sh
bun scripts/video-speed-report.ts app_log.txt video-speed-report.html '模拟器本地限速测试，不代表实际用户分布'
```

报告会分别给出首 3、5、10 秒的跨会话平均速度、速度分区饼图、分区百分比和体验说明，并可展开查看采样明细。平均值是有效播放会话速度的算术平均；饼图分母只包含对应区间有读数的会话。提前结束或未取得播放器状态的会话不会进入该区间的分母；实际读数为 0 的会话会计入最低速度分区。

默认速度区间为 `<100`、`100–300`、`300–800`、`≥800 KB/s`。体验解释是对常见码率下观看情况的直观指引，实际是否卡顿仍受视频码率、缓存和网络稳定性影响。

## 在手表上采样

仓库附带独立调试预览包 `artifacts/video-speed-preview.apk`（本地验证产物 `../artifacts/video-speed-preview.apk`，不随源码提交），包名为 `dev.codex.watchrss.videospeed`，不会替换正式应用。安装到已连接的手表后，在预览应用里播放几段超过 10 秒的视频：

```sh
adb install artifacts/video-speed-preview.apk
```

播放完成后导出调试日志。预览包的日志 provider 仅出现在 debug APK 中，且只允许 ADB shell 读取：

```sh
adb shell dumpsys activity provider dev.codex.watchrss.videospeed/dev.codex.watchrss.videospeed.debug.DebugLogProvider > app_log.txt
bun scripts/video-speed-report.ts app_log.txt video-speed-report.html
```

`DebugLogBuffer` 最多保留 400 行或 50,000 个字符；建议采样后尽快导出。报告分母仅包含达到对应采样时长且拿到播放器状态的会话。

## 已有模拟器验证

2026-11-15 已在 API 30、466×466、320dpi 模拟器运行真实播放器的本地限速场景，取得 12 条首段窗口记录并生成带体验说明的饼图。7 项相关测试和定向类型检查通过。暂停后复现了 native codec 错误，恢复播放未通过；不能据此声称完整播放功能验收通过。详见 运行报告（本地验证产物 `../artifacts/video-speed-run/run-report.md`，不随源码提交） 和 本地实验饼图（本地验证产物 `../artifacts/video-speed-run/report.html`，不随源码提交）。
