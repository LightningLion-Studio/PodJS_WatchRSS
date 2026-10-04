# Bilibili / 抖音迁移批次

用户要求本批优先迁移 Bilibili 和抖音，备忘录继续迁移暂停。Android 原工作区未修改；页面来源见 `src/ui/bili/SOURCE_LAYOUT.md` 与 `src/ui/douyin/SOURCE_NOTES.md`。

已接入共享层的范围：

- Bilibili：真实扫码登录和安全 Cookie、推荐、搜索、详情、历史、稍后再看、收藏夹、评论和回复、显式互动 API、分享二维码及设置页面。
- 抖音：官方 WebView 登录及手动 Cookie 输入、精选流、详情、播放历史、本地收藏/稍后再看、分享二维码和设置页面。抖音本地保存项进入“我的收藏”和“稍后再看”，点击按 awemeId 重新获取详情，不依赖过期播放 URL。
- 原生：Media3 视频/DASH 分离音视频、同一 service-owned ExoPlayer 的前台画面与后台播放开关、前台通知、图片文件解码/纹理释放、异步计时器、授权 WebView。
- 返回：媒体页面使用应用根导航栈及圆形侧滑；二维码登录页支持顶端下拉刷新。

兼容修复与证据：

- 原 Kotlin 抖音签名副本在固定时间/随机输入下生成三组向量，与 TypeScript 逐字节一致，原文件不变，见 `douyin-signing-differential.md`。
- Bilibili 真实匿名搜索返回 HTTP 200 JSON；四字节 Unicode 曾被便携 UTF-8 解码器破坏。已修编码/解码并加入 Unicode MD5 和长 JSON 样本，匿名真实搜索解析 20 项。
- Android package capability 校验要求顺序一致；JNI 与 target profile 已对齐，并加入自动回归测试。
- 远程图片必须输出 runtime 支持的 2 次幂纹理；取消期间检查中断并删除未交付的 RGBA 文件。

验证记录保存在 `artifacts/media-*.log`。已在 OWW242 验证实际视频解码画面、播放/暂停/seek、准备时退后台、后台开关、取消和资源处理，以及 Bilibili QR 生成与返回。二维码截图可解码为 Bilibili 官方 account 域名链接。

仍须完成的验收：

- 抖音已由用户完成真实登录，推荐、缓存详情、在线 CDN 视频、暂停/跳转/返回已验证；Bilibili 仍需用户扫码后验证账号数据和在线播放。两端收藏等完整端到端与用户主动互动仍待验收；没有自动点赞/投币。
- 各页面与旧版逐张截图对照、圆屏阅读/图文多图、长列表完整分页、沉浸式抖音上下视频切换、Bilibili 缓存进度等完整覆盖；当前不能标为全部页面 1:1 或全功能迁移完成。
- 原文阅读开关目前持久化，但对应完整 RSS 正文抓取/缓存行为还需对齐；不能只凭开关变化验收。
- 当前设备 Android 11；其他 Android 版本通知权限/前台服务拒绝分支、十分钟稳定性以及其他平台仍待验证。

本批不发布商店、不切换正式包名、不修改手机或后端契约。完整 Android 数据迁移与原总体计划其余阶段仍按原验收清单推进。

本批最终验证：共享层 66 tests；framework Bun 14 tests；podjs-runtime Rust 5 tests；OWW242 原生 12 tests、更新授权布局后追加 4 tests；应用导航 2 tests。测试日志为准，登录后在线播放/互动仍不在这些通过项中。授权 WebView 已从零高度修成全屏剩余高度布局，设备截图见 `artifacts/media-douyin-webview-fixed.png`。

后续真机反馈：用户完成抖音登录；登录凭据在覆盖安装后保留。推荐 POST 曾被 256 KiB 小响应通道截断，已改为有界流式 POST（320 KiB 本地服务样本通过）。Bilibili cookie 刷新已接入原流程和宿主 RSA-OAEP SHA-256/MGF1 SHA-256；该 RSA 运算在设备上完成公钥加密/私钥解密验证。授权新增可选 TS 提取脚本及原生 QR ImageView，业务 DOM 判断仍在共享 TS，网页继续运行，二步验证退回网页。

二维码反馈验收：`PodQrOverlayTest` 已在 OWW242 实际 WebView 中加载本地测试页面、提取 PNG，检查原生 ImageView 的缩放矩阵，显示宽度至少 320 物理像素；取消回调只触发一次且覆盖层被释放。原生兼容与授权检测另有 7 项通过（含流式 POST、RSA-OAEP、提取参数解析）。真实抖音账号登录保持不变。

真实抖音播放证据：`media-douyin-real-playing2.png`（在线8:31视频，进度0:05）、`media-douyin-pause-seek.png`（暂停且跳转到0:36）、`media-back.mp4`（圆形侧滑返回）；退出后 `dumpsys activity services com.lightningstudio.watchrss.podjs` 显示无残留服务。原工作区 diff SHA-256 保持 `87c601a6aa4ff5bf9feab97e72e5b51303cf9d17186c23b578b4d818464ff5ab`。
