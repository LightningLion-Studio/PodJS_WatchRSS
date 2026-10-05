# D2 抖音逻辑对照（离线源码证据）

原生只读根目录 Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss；PodJS 基于 b747d99 后 master。以下表先于实现编写。设备验收 PENDING。

| 项目 | 原生行为与证据 | PodJS 任务前 | 修正方向 |
|---|---|---|---|
| 历史点击 | DouyinHistoryActivity 先 markWatched、重读历史，再打开单条 DouyinDetailActivity | mark 后传整份点击前历史 playlist | 去掉历史队列传递 |
| 详情播放 | DouyinDetailActivity → DetailContent 的 Video 分支（DetailScreen.kt）→ RssPlayerActivity 单视频；主源码无 DouyinPlayerActivity.createIntent 调用点 | 无历史参数时混入 feedSnapshot，有历史参数时整份历史 | 详情只播放所选视频，index=0、hasMore=false；不混入推荐或历史 |
| 显式播放器恢复 | DouyinPlayerActivity.buildResumeIntent 保留原始 URL/ID/封面/标题/作者数组及当前页 index，不重新请求 feed/detail | resume-state 把 player 降级 detail；真实 video 页面直接跳过 | 以已存在播放器队列快照重建播放，记录当前页；不保存 Cookie/headers，不因无网丢队列 |
| 遮罩 | BiliPlayerScreen：播放中不遮罩；未播放的远程流断网遮罩；蓝牙需继续；本地源不遮罩；网络错误 OFFLINE_USER_MESSAGE 即使 monitor 可用也显示 | 未区分本地/远程，文案来自登录页；retry 被 networkPrompt 直接拦截 | 使用播放器原生文案、源类型与真实错误；修重试接线；不伪造弱网状态 |
| 网络恢复 | 原生自动移除状态遮罩；未完成 prepare 的流继续，已有播放错误由用户重试；蓝牙继续原 player | 初始 gate 恢复可 prepare；蓝牙已 ready 却走重解析 | ready 蓝牙继续 media.play，重试原源；保留队列 |
| 登录门控 | DouyinLoginActivity：Checking/Unavailable/Bluetooth/Available；BannedScreen 是网络禁止登录，不是账号封禁 | 已有相同 gate 和网络失效取消 | 保留，补验证网络恢复与迟到事件 |
| 两步验证 | DouyinLoginScreen：verifying 时清 QR 并显示网页；否则先二步 JPEG 后登录 PNG；二维码消失清除 | 任意迟到 qr 会清 verifying 并重新显示 | verifying 优先，忽略迟到 QR，退出验证等待新 QR |
| 登录失败/重试 | WebView 主帧错误映射固定中文，返回后重新进入；原生 panel 消失收 cookies | String(error) 直出；宿主仅手动 Done 返回，没有主帧错误状态事件 | 应用错误固定文案与重试隔离；宿主显式 opt-in 补主帧细分/自动完成，旧宿主保持手动（见实施结果） |

## 边界
不增加 UI 样式/布局，不操作设备，不改原生。URL 只用于恢复实际播放，凭据由 secure storage 重新构建；无效/空快照回到抖音入口。登录主帧错误与自动完成已补宿主支持；需要更新宿主后验收。

## 实施结果

- 历史/详情统一单项 index=0、hasMore=false；保留原生 RssPlayerViewModel 初次 fetchVideo 失败时可用直接 URL 的 fallback。失败恢复使用既有 DouyinRssRecovery，手动重试仍是同一项，不跳入推荐/历史队列。
- 显式静态播放器使用固定源队列；前后页、预取、重试不重新解析 URL。沉浸式仍按 feed cursor 分页。恢复从 secure playback queue 读取，KV 只记录 awemeId/模式标记，不写 URL/headers/Cookie。打开/切页时先保存队列，未准备成功的页面也可恢复；丢失/损坏/标记错配回入口。
- 标准播放器沿用 BiliPlayerScreen 的遮罩条件；沉浸式按 DouyinImmersiveScreen:1012–1035 的首帧/缓冲/错误判断，首帧已显示且用户暂停时不遮罩；网络遮罩触发的暂停在网络恢复后继续同一源。首帧与网络错误均取宿主实际字段，无计时猜测。
- Android 单播放器与 sessions 返回 network_error（UnknownHostException/ConnectException/NoRouteToHostException/SocketTimeoutException/SSLException 的 cause 链），其它错误不归为断网。sessions 的终态网络错误释放 decoder/player，保留一个可查询 error 快照到下一次 prepare/release。
- 登录 verifying 状态优先于迟到 QR；网络禁止/取消/重试隔离旧请求。宿主新增显式 completeOnLoginPanelHidden：必须先观察到面板，随后面板隐藏且无验证/QR，并有 required cookies 才完成。仅开启该模式时主帧加载错误终止授权并返回 webview_load_<数字>；应用映射原生固定中文。默认浏览器授权仍手动完成。
- 新宿主可自动完成，旧宿主忽略新增参数、保留 Done 流程。自动完成额外保留宿主既有 required-cookie 检查，防止仅因网页元素消失返回未认证状态。

## 验证边界

纯逻辑、实际 Solid 组件/路由控制器、真实内存存储 + DouyinClient、离线 JVM 策略、Android main/androidTest 编译、全量测试与 app build。没有运行设备 instrumentation 或真实抖音网页登录，不把编译和 JVM 策略结果声称为设备通过。宿主更新须与应用一起部署；原生 UI/圆屏实机由 wrss-device 后续验证。
