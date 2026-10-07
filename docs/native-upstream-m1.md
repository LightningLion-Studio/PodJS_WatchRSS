# M1 原生上游：平台说明与使用统计

审计基准：原生只读 `origin/main=e0936f16`，功能提交 `c0fd7042`，修复 `e0936f16`；`97fb3cef` 为合并。未 fetch/pull/checkout/merge 原生。应用基线 `9ef01da`，框架基线 `06859d4`，两仓 worktree `.wt-impl`、分支 `impl/native-upstream-1`。本文文件:行均对应这个原生 ref；附录保留带原始行号的证据。

## 公告分类、状态、时机

此次上游增加的“平台公告”是内置第三方关系说明，不是服务器公告。不拉取、不轮询，没有远程公告 ID 或批量已读游标。

- `ui/components/ThirdPartyPlatformNotice.kt:23-41`：SharedPreferences `watchrss_transparency` / `initial_app_disclosure_v1`，默认 false，点击“我已了解”才持久化 true。无 debug/release 差异。
- 首次说明：OOBE 叠在原内容上；Home 仅在没有版本公告且推送列表为空时显示；Bili/Douyin entry 在平台确认之前显示。`OobeActivity.kt:66-111`、`HomeFeedListActivity.kt:195-205`、`BiliEntryActivity.kt:35-51`、`DouyinEntryActivity.kt:115-137`。对话框 onDismissRequest 空回调，不接受外部点击/普通 dismiss。
- 平台确认：Bili/Douyin entry 每个新 Activity/Composition 实例都显示；只保留 remember 内存状态，不写 KV，不因以前确认而永久消失。初始说明确认后继续显示平台确认。“知道了，继续”仅关闭当前实例。
- 常驻标签在确认后仍显示。入口、登录、播放器、操作页为顶部 compact 标签 + weight(1) 剩余内容；频道信息页另有范围卡；账号页有两平台 compact 标签及授权边界卡。完整 UI 位置见附录。
- 既有版本公告和 push 保持原服务：应用 `src/announcement/client.ts` 固定 announcement backend，`repository.ts` 按 dismissed version / last_seen_notification_id 管理；此次平台模型不替代它们。应用原有 `VERSION_ANNOUNCEMENTS_ENABLED=false` 分发策略保持。

## 统计清单与字段

`data/telemetry/WatchUsageTelemetry.kt:41-88` 的累计事件：

| 事件 | 触发与原生证据 | 累计字段 |
| --- | --- | --- |
| app_opened | WatchRssApplication.kt:106 每次进程启动 | eventCounts |
| release_oobe_opened | OobeActivity.kt:40；WatchUsageTelemetry.kt:44-52 | 每安装一次，仅 release |
| screen_opened | BaseWatchActivity.kt:79 resume；AccountStatusActivity.kt:53 另加 watch_account | eventCounts + screenOpenCounts |
| screen_duration | BaseWatchActivity.kt:198 pause，elapsedRealtime 差，正值 | eventCounts + screenDurationMs + appForegroundMs |
| sync_received | 接口保留，当前 origin/main 未找到业务调用 | eventCounts + syncSuccessCount |
| feed_refreshed | ui/viewmodel/HomeViewModel.kt:67,95；结果参数丢弃 | eventCounts |
| article_read_started / finished | DetailActivity.kt:79,121；原始 ID/标题/频道/到底/耗时参数均丢弃 | eventCounts |
| video_played | BiliPlayerActivity.kt:50、DouyinPlayerActivity.kt:60、RssPlayerActivity.kt:41；平台/ID/标题参数丢弃 | eventCounts |
| sync_account | phoneconnection/bluetooth/WatchBluetoothSyncServer.kt:1258 | eventCounts + syncSuccessCount |

DailyTelemetryStore.kt:8-36,40-123：上海时区日键，7 天累计，capture 时删除过期天；snapshots 按天升序；success 只增加于 sync_received/sync_account，failure 字段保留但本类未递增。WatchUsageTelemetry.kt:179-211：每天一次 POST `/functions/v1/telemetry-rollup`，body 包含 day/installId/deviceId/platform=watch/appVersionName/appVersionCode/screenOpenCounts/screenDurationMs/eventCounts/appForegroundMs/syncSuccessCount/syncFailureCount/diagnosticsOptedIn=false。installId 为本安装随机 UUID，不能拿手机 account.installId 代替（WatchInstallationIdentity.kt:6-40）。

新指标是独立 POST，无持久化离线队列：

| 端点 | 字段 | 条件/触发 |
| --- | --- | --- |
| /functions/v1/douyin-qr-load-time | durationMs/appVersionName/appVersionCode | >0；DouyinLoginScreen.kt:165-168 首次出现登录面板开始，:280-288 首次 login PNG QR 出现上报；二步验证 QR 不计 |
| /functions/v1/video-battery-drain | source/durationMs/batteryStart/batteryEnd/appVersionName | source=bilibili/douyin，>=60000ms，0..100 且 end<=start；BaseWatchActivity.kt:409-448 |

所有 POST 使用 freshly refreshed watch token、Authorization Bearer、X-WatchRSS-App-Version；backend 来自当前 account.backendBaseUrl。连接 8s、读写 12s（WatchUsageTelemetry.kt:148-177,219-233）。不向 OpenPanel/PostHog 直接发送。没有匿名/诊断开关 gating 或采样率 gating；account.telemetryConfig 不被本类读取。release 与 debug 均默认 capture/upload，只有首次 OOBE 指标排除 debug（:44,236）。第三方说明确认也不是 telemetry consent。

750ms coalescing（:134-145）；上传中新增事件会再调度一次；失败/未绑账号等下次 capture 重试，没有定时无限重试；成功不删除累计快照，后续重新发累计值（backend 负责累计语义）。QR/电量是 best effort，一次失败不入 backlog。电量真实读取 BatteryManager capacity（:444-448），缺失不伪造。播放器 callback 按 isActive&&isPlaying；buffering 不算。原生 BiliPlayerScreen.kt:517-529 背景播放打开时 ON_PAUSE 不 pause，因此源码也可能继续采样背景播放；迁移按 playing 状态遵循此行为，不额外按 lifecycle 排除。

## PodJS 实现与 lead UI 交接

- 框架 `@podjs/framework/telemetry`：DailyCounterStore、CaptureUploadScheduler、ActiveBatterySession；`@podjs/framework/disclosure`：持久初次确认 + 每路由确认。业务事件、端点、存储 key 留应用。
- 框架 `battery.percent` / `device.battery`：Android/WearOS 真实系统 capacity，未知返回 null，旧/其他 host unsupported；不需要权限。不伪造 fallback。
- 应用 `src/telemetry/usage.ts` 复用既有计数，实现两个指标；QR 在 login browser status 上接线；播放器通过 onPlaybackActiveChanged 接线，MediaRoutes 拥有采样寿命。
- 应用 `src/announcement/platform.ts` 导出 initialDisclosure/platformDisclosure/platformNotice/platformScope/accessBoundary 和 `createPlatformNoticeRoute(storage,target)`；host.ts 提供 `hostPlatformNoticeRoute(target)`。这是模态占位路由描述符（kind=platform-notice），尚未渲染 UI。lead 每 Activity/entry 创建一次并保留，调用 pending(homeNoticeVisible)、acknowledge()、dismiss()；dismiss 永远 false。
- 新 UI 渲染/入口弹窗阻塞/常驻标签由 lead 接入；现有 UI 没有自动显示这些说明。布局不得从 label 猜测；详见下面带行号的完整组件、theme/type 与各调用点。

## 原生 UI 尺寸与样式

入口/登录/播放器使用 Density(2f, baseDensity.fontScale)。常驻 notice fillMaxWidth、12dp 圆角；背景 surfaceVariant=#23272A，alpha=.72；horizontal 内边距10dp；compact vertical6dp、行距2dp，非compact vertical9dp、行距4dp。标题 SemiBold，compact labelSmall=9sp/11sp，完整 labelMedium=12sp/14sp；描述 bodySmall=12sp/14sp，色 onSurfaceVariant=#B6B6B6，居中。完整第三行 labelSmall 9/11sp。scope/access 卡背景同色 alpha=.46，圆角12dp、padding10x8dp、行距3dp；标题继承 bodyMedium14/17sp、SemiBold；正文 labelSmall9/11sp。外层 compact 通常 padding8x4dp。

首次 AlertDialog 标题“使用前说明”，五段原文见完整组件；text Column verticalScroll、间距10dp；确认“我已了解”。平台 AlertDialog 两段以双换行分隔，确认“知道了，继续”。Dialog 宽度/shape/默认标题与按钮样式由 Material3 默认 token 决定，源码没显式固定 dp，不能虚构尺寸；主题默认文字 bodyMedium14/17sp，色 onSurface=#F5F5F5、primary=#FF6026，surface=#1C1F21。具体代码见 Theme/Type 附录。用户 brief 的非阅读页纯黑规则仍优先于原生背景色。

### ui/components/ThirdPartyPlatformNotice.kt

```kotlin
   1 package com.lightningstudio.watchrss.ui.components
   2 
   3 import android.content.Context
   4 import androidx.compose.foundation.layout.Arrangement
   5 import androidx.compose.foundation.layout.Column
   6 import androidx.compose.foundation.layout.fillMaxWidth
   7 import androidx.compose.foundation.layout.padding
   8 import androidx.compose.foundation.rememberScrollState
   9 import androidx.compose.foundation.shape.RoundedCornerShape
  10 import androidx.compose.foundation.verticalScroll
  11 import androidx.compose.material3.AlertDialog
  12 import androidx.compose.material3.MaterialTheme
  13 import androidx.compose.material3.TextButton
  14 import androidx.compose.material3.Surface
  15 import androidx.compose.material3.Text
  16 import androidx.compose.runtime.Composable
  17 import androidx.compose.ui.Modifier
  18 import androidx.compose.ui.text.font.FontWeight
  19 import androidx.compose.ui.text.style.TextAlign
  20 import androidx.compose.ui.unit.dp
  21 
  22 
  23 object AppTransparencyStore {
  24     private const val PREFERENCES_NAME = "watchrss_transparency"
  25     private const val INITIAL_APP_DISCLOSURE_KEY = "initial_app_disclosure_v1"
  26 
  27     fun isInitialAppDisclosureAcknowledged(context: Context): Boolean = context
  28         .applicationContext
  29         .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
  30         .getBoolean(INITIAL_APP_DISCLOSURE_KEY, false)
  31 
  32     fun acknowledgeInitialAppDisclosure(context: Context) {
  33         context.applicationContext
  34             .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
  35             .edit()
  36             .putBoolean(INITIAL_APP_DISCLOSURE_KEY, true)
  37             .apply()
  38     }
  39 }
  40 
  41 @Composable
  42 fun InitialAppTransparencyDialog(
  43     onAcknowledge: () -> Unit
  44 ) {
  45     AlertDialog(
  46         onDismissRequest = { },
  47         title = { Text("使用前说明") },
  48         text = {
  49             Column(
  50                 modifier = Modifier.verticalScroll(rememberScrollState()),
  51                 verticalArrangement = Arrangement.spacedBy(10.dp)
  52             ) {
  53                 Text("本 App 由第三方开发者及社区用户贡献，与哔哩哔哩无合作关系，哔哩哔哩是上海宽娱数码科技有限公司的商标。")
  54                 Text("本 App 不是哔哩哔哩的替代品，建议能使用官方客户端时尽量使用官方客户端。")
  55                 Text("本 App 均使用来源于网络的公开信息进行开发。")
  56                 Text("本 App 中和 B 站相关的功能完全免费。")
  57                 Text("本 App 中所呈现的 B 站内容来自哔哩哔哩官方。")
  58             }
  59         },
  60         confirmButton = {
  61             TextButton(onClick = onAcknowledge) { Text("我已了解") }
  62         }
  63     )
  64 }
  65 
  66 /**
  67  * Persistent relationship label for connected third-party platforms.
  68  * Keep this visible after the entry confirmation has been dismissed.
  69  */
  70 @Composable
  71 fun ThirdPartyPlatformNotice(
  72     platform: String,
  73     modifier: Modifier = Modifier,
  74     compact: Boolean = false
  75 ) {
  76     Surface(
  77         modifier = modifier.fillMaxWidth(),
  78         color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f),
  79         shape = RoundedCornerShape(12.dp)
  80     ) {
  81         Column(
  82             modifier = Modifier.padding(horizontal = 10.dp, vertical = if (compact) 6.dp else 9.dp),
  83             verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 4.dp)
  84         ) {
  85             Text(
  86                 text = "腕上RSS提供的第三方平台功能",
  87                 style = if (compact) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
  88                 fontWeight = FontWeight.SemiBold,
  89                 modifier = Modifier.fillMaxWidth(),
  90                 textAlign = TextAlign.Center
  91             )
  92             Text(
  93                 text = "这是腕上RSS连接${platform}的精选功能，不是${platform}官方客户端。",
  94                 style = MaterialTheme.typography.bodySmall,
  95                 color = MaterialTheme.colorScheme.onSurfaceVariant,
  96                 modifier = Modifier.fillMaxWidth(),
  97                 textAlign = TextAlign.Center
  98             )
  99             if (!compact) {
 100                 Text(
 101                     text = "平台账号、平台会员和内容规则由${platform}独立管理；当前支持范围不因¥6手机版设备授权而改变。",
 102                     style = MaterialTheme.typography.labelSmall,
 103                     color = MaterialTheme.colorScheme.onSurfaceVariant,
 104                     modifier = Modifier.fillMaxWidth(),
 105                     textAlign = TextAlign.Center
 106                 )
 107             }
 108         }
 109     }
 110 }
 111 
 112 @Composable
 113 fun ThirdPartyPlatformScopeCard(
 114     platform: String,
 115     modifier: Modifier = Modifier
 116 ) {
 117     Surface(
 118         modifier = modifier.fillMaxWidth(),
 119         color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
 120         shape = RoundedCornerShape(12.dp)
 121     ) {
 122         Column(
 123             modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
 124             verticalArrangement = Arrangement.spacedBy(3.dp)
 125         ) {
 126             Text("当前支持范围", fontWeight = FontWeight.SemiBold)
 127             Text(
 128                 "已提供：精选频道浏览、搜索、视频播放、收藏与稍后再看。",
 129                 style = MaterialTheme.typography.labelSmall,
 130                 color = MaterialTheme.colorScheme.onSurfaceVariant
 131             )
 132             Text(
 133                 "平台账号相关操作受账号权限、接口和内容规则影响；当前未提供的官方客户端能力，不等于付费后解锁。",
 134                 style = MaterialTheme.typography.labelSmall,
 135                 color = MaterialTheme.colorScheme.onSurfaceVariant
 136             )
 137             Text(
 138                 "只有明确标注‘需要手机版设备授权’的功能才与¥6有关；其余平台功能与这笔付款无关。",
 139                 style = MaterialTheme.typography.labelSmall,
 140                 color = MaterialTheme.colorScheme.onSurfaceVariant
 141             )
 142         }
 143     }
 144 }
 145 
 146 @Composable
 147 fun WatchRssAccessBoundaryCard(
 148     modifier: Modifier = Modifier
 149 ) {
 150     Surface(
 151         modifier = modifier.fillMaxWidth(),
 152         color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
 153         shape = RoundedCornerShape(12.dp)
 154     ) {
 155         Column(
 156             modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
 157             verticalArrangement = Arrangement.spacedBy(3.dp)
 158         ) {
 159             Text("手机版设备授权包", fontWeight = FontWeight.SemiBold)
 160             Text(
 161                 "¥6主要用于小说、备忘录和手机与手表协同，不是哔哩哔哩或抖音会员，也不会提升播放速度或清晰度。",
 162                 style = MaterialTheme.typography.labelSmall,
 163                 color = MaterialTheme.colorScheme.onSurfaceVariant
 164             )
 165             Text(
 166                 "WatchRSS云会员与平台会员分别由WatchRSS和对应平台管理。",
 167                 style = MaterialTheme.typography.labelSmall,
 168                 color = MaterialTheme.colorScheme.onSurfaceVariant
 169             )
 170         }
 171     }
 172 }
 173 
 174 
 175 @Composable
 176 fun ThirdPartyPlatformConfirmationDialog(
 177     platform: String,
 178     onConfirm: () -> Unit
 179 ) {
 180     AlertDialog(
 181         onDismissRequest = { },
 182         title = { Text("使用前说明") },
 183         text = {
 184             Text(
 185                 "本 App 与${platform}及其关联公司或子公司不存在任何关联，也未获其授权、维护、赞助或认可。\n\n" +
 186                     "这是独立且非官方的软件，使用风险由您自行承担。平台账号、内容和平台规则由${platform}独立管理。"
 187             )
 188         },
 189         confirmButton = {
 190             TextButton(onClick = onConfirm) { Text("知道了，继续") }
 191         }
 192     )
 193 }
```

### data/telemetry/WatchUsageTelemetry.kt

```kotlin
   1 package com.lightningstudio.watchrss.data.telemetry
   2 
   3 import android.content.Context
   4 import com.lightningstudio.watchrss.BuildConfig
   5 import com.lightningstudio.watchrss.data.account.AccountStore
   6 import com.lightningstudio.watchrss.data.account.WatchTokenManager
   7 import com.lightningstudio.watchrss.data.network.withWatchRssAppVersionHeader
   8 import com.lightningstudio.watchrss.util.AppLogger
   9 import kotlinx.coroutines.CoroutineScope
  10 import kotlinx.coroutines.Dispatchers
  11 import kotlinx.coroutines.delay
  12 import kotlinx.coroutines.launch
  13 import kotlinx.coroutines.withContext
  14 import okhttp3.MediaType.Companion.toMediaType
  15 import okhttp3.OkHttpClient
  16 import okhttp3.Request
  17 import okhttp3.RequestBody.Companion.toRequestBody
  18 import org.json.JSONObject
  19 import java.util.concurrent.TimeUnit
  20 import java.util.concurrent.atomic.AtomicBoolean
  21 import java.util.concurrent.atomic.AtomicLong
  22 
  23 /** Sends only cumulative daily counters to the authenticated WatchRSS backend. */
  24 class WatchUsageTelemetry(
  25     context: Context,
  26     private val installationIdentity: WatchInstallationIdentity,
  27     private val deviceId: String,
  28     accountStore: AccountStore,
  29     private val tokenManager: WatchTokenManager = WatchTokenManager(accountStore),
  30     private val appScope: CoroutineScope,
  31     private val httpClient: OkHttpClient = defaultHttpClient()
  32 ) : UsageTelemetry {
  33     private val store = DailyTelemetryStore(context)
  34     private val downloadPreferences = context.applicationContext.getSharedPreferences(
  35         DOWNLOAD_PREFERENCES,
  36         Context.MODE_PRIVATE
  37     )
  38     private val uploadScheduled = AtomicBoolean(false)
  39     private val generation = AtomicLong(0L)
  40 
  41     override fun recordAppLaunch() = capture("app_opened")
  42 
  43     /** Records one release OOBE open per installation. */
  44     fun recordReleaseOobeOpened() {
  45         if (!shouldCountReleaseOobeOpen(BuildConfig.DEBUG)) return
  46         synchronized(downloadPreferences) {
  47             if (downloadPreferences.getBoolean(KEY_RELEASE_OOBE_RECORDED, false)) return
  48             store.record(EVENT_RELEASE_OOBE_OPENED)
  49             downloadPreferences.edit().putBoolean(KEY_RELEASE_OOBE_RECORDED, true).apply()
  50         }
  51         generation.incrementAndGet()
  52         scheduleUpload()
  53     }
  54 
  55     override fun recordScreenOpen(screen: String) =
  56         capture("screen_opened", mapOf("screen" to screen))
  57 
  58     override fun recordScreenDuration(screen: String, durationMs: Long) {
  59         if (durationMs > 0L) {
  60             capture("screen_duration", mapOf("screen" to screen, "durationMs" to durationMs))
  61         }
  62     }
  63 
  64     override fun recordSyncReceived(kind: String, itemCount: Int) = capture("sync_received")
  65 
  66     override fun recordFeedRefreshed(channelId: String?, channelTitle: String?, success: Boolean) =
  67         capture("feed_refreshed")
  68 
  69     override fun recordArticleReadStarted(
  70         itemId: Long,
  71         title: String?,
  72         channelId: String?,
  73         channelTitle: String?
  74     ) = capture("article_read_started")
  75 
  76     override fun recordArticleReadFinished(
  77         itemId: Long,
  78         title: String?,
  79         channelId: String?,
  80         channelTitle: String?,
  81         reachedBottom: Boolean,
  82         durationMs: Long
  83     ) = capture("article_read_finished")
  84 
  85     override fun recordVideoPlayed(source: String, id: String, title: String?) =
  86         capture("video_played")
  87 
  88     override fun recordSyncAccount() = capture("sync_account")
  89 
  90     /**
  91      * 上报一次抖音登录二维码加载耗时。
  92      * 失败不抛异常，仅写日志，不影响登录流程。
  93      */
  94     fun recordDouyinQrLoadTime(durationMs: Long) {
  95         if (durationMs <= 0) return
  96         appScope.launch(Dispatchers.IO) {
  97             runCatching { reportDouyinQrLoadTime(durationMs) }
  98         }
  99     }
 100 
 101     /** Reports an observed foreground video session as battery percentage points per 15 minutes. */
 102     fun recordVideoBatteryDrain(
 103         source: String,
 104         durationMs: Long,
 105         batteryStart: Int,
 106         batteryEnd: Int
 107     ) {
 108         if (source !in setOf("bilibili", "douyin") ||
 109             durationMs < MIN_BATTERY_DRAIN_SESSION_MS ||
 110             batteryStart !in 0..100 || batteryEnd !in 0..batteryStart
 111         ) return
 112         appScope.launch(Dispatchers.IO) {
 113             runCatching {
 114                 reportVideoBatteryDrain(source, durationMs, batteryStart, batteryEnd)
 115             }.onFailure { error ->
 116                 AppLogger.log("BatteryDrain", "上报视频功耗失败: ${error.message.orEmpty()}")
 117             }
 118         }
 119     }
 120 
 121     override fun backlogCount(): Int = store.snapshots().size
 122 
 123     private fun capture(event: String, properties: Map<String, Any?> = emptyMap()) {
 124         store.record(event, properties)
 125         generation.incrementAndGet()
 126         scheduleUpload()
 127     }
 128 
 129     private fun scheduleUpload() {
 130         if (!uploadScheduled.compareAndSet(false, true)) return
 131         appScope.launch(Dispatchers.IO) {
 132             delay(UPLOAD_DEBOUNCE_MS)
 133             val uploadingGeneration = generation.get()
 134             runCatching { uploadPending() }
 135             uploadScheduled.set(false)
 136             if (generation.get() != uploadingGeneration) scheduleUpload()
 137         }
 138     }
 139 
 140     private suspend fun reportDouyinQrLoadTime(durationMs: Long) {
 141         val account = tokenManager.freshAccount()
 142         val payload = JSONObject().apply {
 143             put("durationMs", durationMs)
 144             put("appVersionName", BuildConfig.VERSION_NAME)
 145             put("appVersionCode", BuildConfig.VERSION_CODE)
 146         }
 147         val request = Request.Builder()
 148             .url(account.backendBaseUrl.trimEnd('/') + "/functions/v1/douyin-qr-load-time")
 149             .header("Authorization", "Bearer ${account.watchDeviceToken}")
 150             .withWatchRssAppVersionHeader()
 151             .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
 152             .build()
 153         httpClient.newCall(request).execute().use { response ->
 154             if (!response.isSuccessful) {
 155                 AppLogger.log("DouyinLogin", "上报二维码加载时间失败: ${response.code}")
 156             }
 157         }
 158     }
 159 
 160     private suspend fun reportVideoBatteryDrain(
 161         source: String,
 162         durationMs: Long,
 163         batteryStart: Int,
 164         batteryEnd: Int
 165     ) {
 166         val account = tokenManager.freshAccount()
 167         val payload = JSONObject().apply {
 168             put("source", source)
 169             put("durationMs", durationMs)
 170             put("batteryStart", batteryStart)
 171             put("batteryEnd", batteryEnd)
 172             put("appVersionName", BuildConfig.VERSION_NAME)
 173         }
 174         val request = Request.Builder()
 175             .url(account.backendBaseUrl.trimEnd('/') + "/functions/v1/video-battery-drain")
 176             .header("Authorization", "Bearer ${account.watchDeviceToken}")
 177             .withWatchRssAppVersionHeader()
 178             .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
 179             .build()
 180         httpClient.newCall(request).execute().use { response ->
 181             if (!response.isSuccessful) {
 182                 AppLogger.log("BatteryDrain", "上报视频功耗失败: ${response.code}")
 183             }
 184         }
 185     }
 186 
 187     private suspend fun uploadPending() {
 188         val account = tokenManager.freshAccount()
 189         for (snapshot in store.snapshots()) {
 190             val payload = JSONObject().apply {
 191                 put("day", snapshot.day)
 192                 put("installId", installationIdentity.installId)
 193                 put("deviceId", deviceId)
 194                 put("platform", "watch")
 195                 put("appVersionName", BuildConfig.VERSION_NAME)
 196                 put("appVersionCode", BuildConfig.VERSION_CODE)
 197                 put("screenOpenCounts", JSONObject(snapshot.screenOpenCounts))
 198                 put("screenDurationMs", JSONObject(snapshot.screenDurationMs))
 199                 put("eventCounts", JSONObject(snapshot.eventCounts))
 200                 put("appForegroundMs", snapshot.appForegroundMs)
 201                 put("syncSuccessCount", snapshot.syncSuccessCount)
 202                 put("syncFailureCount", snapshot.syncFailureCount)
 203                 put("diagnosticsOptedIn", false)
 204             }
 205             val request = Request.Builder()
 206                 .url(account.backendBaseUrl.trimEnd('/') + "/functions/v1/telemetry-rollup")
 207                 .header("Authorization", "Bearer ${account.watchDeviceToken}")
 208                 .withWatchRssAppVersionHeader()
 209                 .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
 210                 .build()
 211             httpClient.newCall(request).execute().use { response ->
 212                 if (!response.isSuccessful) return
 213             }
 214         }
 215     }
 216 
 217     companion object {
 218         const val EVENT_RELEASE_OOBE_OPENED = "release_oobe_opened"
 219 
 220         private const val DOWNLOAD_PREFERENCES = "watchrss_download_telemetry"
 221         private const val KEY_RELEASE_OOBE_RECORDED = "release_oobe_recorded"
 222         private const val UPLOAD_DEBOUNCE_MS = 750L
 223         private const val MIN_BATTERY_DRAIN_SESSION_MS = 60 * 1000L
 224         private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
 225 
 226         private fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
 227             .connectTimeout(8, TimeUnit.SECONDS)
 228             .readTimeout(12, TimeUnit.SECONDS)
 229             .writeTimeout(12, TimeUnit.SECONDS)
 230             .build()
 231     }
 232 }
 233 
 234 internal fun shouldCountReleaseOobeOpen(debugBuild: Boolean): Boolean = !debugBuild
```

### data/telemetry/DailyTelemetryStore.kt

```kotlin
   1 package com.lightningstudio.watchrss.data.telemetry
   2 
   3 import android.content.Context
   4 import org.json.JSONObject
   5 import java.time.LocalDate
   6 import java.time.ZoneId
   7 
   8 internal data class DailyTelemetrySnapshot(
   9     val day: String,
  10     val eventCounts: Map<String, Long> = emptyMap(),
  11     val screenOpenCounts: Map<String, Long> = emptyMap(),
  12     val screenDurationMs: Map<String, Long> = emptyMap(),
  13     val appForegroundMs: Long = 0L,
  14     val syncSuccessCount: Int = 0,
  15     val syncFailureCount: Int = 0
  16 ) {
  17     fun record(event: String, properties: Map<String, Any?>): DailyTelemetrySnapshot {
  18         val screen = properties["screen"]?.toString()?.takeIf(String::isNotBlank)
  19         val durationMs = (properties["durationMs"] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L
  20         return copy(
  21             eventCounts = eventCounts.increment(event),
  22             screenOpenCounts = if (event == "screen_opened" && screen != null) {
  23                 screenOpenCounts.increment(screen)
  24             } else screenOpenCounts,
  25             screenDurationMs = if (event == "screen_duration" && screen != null && durationMs > 0L) {
  26                 screenDurationMs.increment(screen, durationMs)
  27             } else screenDurationMs,
  28             appForegroundMs = if (event == "screen_duration") appForegroundMs + durationMs else appForegroundMs,
  29             syncSuccessCount = syncSuccessCount + if (event == "sync_received" || event == "sync_account") 1 else 0
  30         )
  31     }
  32 }
  33 
  34 internal class DailyTelemetryStore(context: Context) {
  35     private val preferences = context.applicationContext.getSharedPreferences(
  36         "watchrss_daily_telemetry",
  37         Context.MODE_PRIVATE
  38     )
  39 
  40     @Synchronized
  41     fun record(event: String, properties: Map<String, Any?> = emptyMap()) {
  42         val day = LocalDate.now(TELEMETRY_ZONE).toString()
  43         val updated = read(day).record(event, properties)
  44         val days = (preferences.getStringSet(KEY_DAYS, emptySet()).orEmpty() + day)
  45             .filterTo(mutableSetOf()) { value -> isRetained(value, day) }
  46         preferences.edit()
  47             .putString(key(day), encode(updated))
  48             .putStringSet(KEY_DAYS, days)
  49             .apply()
  50         prune(days)
  51     }
  52 
  53     @Synchronized
  54     fun snapshots(): List<DailyTelemetrySnapshot> =
  55         preferences.getStringSet(KEY_DAYS, emptySet()).orEmpty().sorted().map(::read)
  56 
  57     private fun read(day: String): DailyTelemetrySnapshot {
  58         val raw = preferences.getString(key(day), null) ?: return DailyTelemetrySnapshot(day)
  59         return runCatching {
  60             val json = JSONObject(raw)
  61             DailyTelemetrySnapshot(
  62                 day = day,
  63                 eventCounts = json.optJSONObject("eventCounts").toLongMap(),
  64                 screenOpenCounts = json.optJSONObject("screenOpenCounts").toLongMap(),
  65                 screenDurationMs = json.optJSONObject("screenDurationMs").toLongMap(),
  66                 appForegroundMs = json.optLong("appForegroundMs"),
  67                 syncSuccessCount = json.optInt("syncSuccessCount"),
  68                 syncFailureCount = json.optInt("syncFailureCount")
  69             )
  70         }.getOrElse { DailyTelemetrySnapshot(day) }
  71     }
  72 
  73     private fun encode(snapshot: DailyTelemetrySnapshot): String = JSONObject().apply {
  74         put("eventCounts", JSONObject(snapshot.eventCounts))
  75         put("screenOpenCounts", JSONObject(snapshot.screenOpenCounts))
  76         put("screenDurationMs", JSONObject(snapshot.screenDurationMs))
  77         put("appForegroundMs", snapshot.appForegroundMs)
  78         put("syncSuccessCount", snapshot.syncSuccessCount)
  79         put("syncFailureCount", snapshot.syncFailureCount)
  80     }.toString()
  81 
  82     private fun prune(retainedDays: Set<String>) {
  83         val editor = preferences.edit()
  84         preferences.all.keys
  85             .filter { it.startsWith(KEY_PREFIX) && it.removePrefix(KEY_PREFIX) !in retainedDays }
  86             .forEach(editor::remove)
  87         editor.apply()
  88     }
  89 
  90     private fun isRetained(value: String, today: String): Boolean = runCatching {
  91         !LocalDate.parse(value).isBefore(LocalDate.parse(today).minusDays(RETENTION_DAYS - 1L))
  92     }.getOrDefault(false)
  93 
  94     private fun key(day: String): String = "$KEY_PREFIX$day"
  95 
  96     private companion object {
  97         val TELEMETRY_ZONE: ZoneId = ZoneId.of("Asia/Shanghai")
  98         const val KEY_DAYS = "days"
  99         const val KEY_PREFIX = "day_"
 100         const val RETENTION_DAYS = 7L
 101     }
 102 }
 103 
 104 private fun Map<String, Long>.increment(key: String, amount: Long = 1L): Map<String, Long> =
 105     toMutableMap().apply { this[key] = (this[key] ?: 0L) + amount }
 106 
 107 private fun JSONObject?.toLongMap(): Map<String, Long> {
 108     if (this == null) return emptyMap()
 109     return keys().asSequence().associateWith { key -> optLong(key).coerceAtLeast(0L) }
 110 }
```

### data/telemetry/WatchInstallationIdentity.kt

```kotlin
   1 package com.lightningstudio.watchrss.data.telemetry
   2 
   3 import android.content.Context
   4 import java.util.UUID
   5 
   6 class WatchInstallationIdentity(context: Context) {
   7     private val preferences = context.applicationContext.getSharedPreferences(
   8         "watchrss_installation_identity",
   9         Context.MODE_PRIVATE
  10     )
  11 
  12     val installId: String
  13         get() = getOrCreateString(KEY_INSTALL_ID) { UUID.randomUUID().toString() }
  14 
  15     val firstInstalledAtMillis: Long
  16         get() = getOrCreateLong(KEY_FIRST_INSTALLED_AT) { System.currentTimeMillis() }
  17 
  18     private fun getOrCreateString(key: String, create: () -> String): String {
  19         val existing = preferences.getString(key, null)
  20         if (!existing.isNullOrBlank()) return existing
  21         val created = create()
  22         preferences.edit().putString(key, created).apply()
  23         return created
  24     }
  25 
  26     private fun getOrCreateLong(key: String, create: () -> Long): Long {
  27         val existing = preferences.getLong(key, 0L)
  28         if (existing > 0L) return existing
  29         val created = create()
  30         preferences.edit().putLong(key, created).apply()
  31         return created
  32     }
  33 
  34     companion object {
  35         private const val KEY_INSTALL_ID = "install_id"
  36         private const val KEY_FIRST_INSTALLED_AT = "first_installed_at"
  37     }
  38 }
```

### ui/theme/Type.kt

```kotlin
   1 package com.lightningstudio.watchrss.ui.theme
   2 
   3 import androidx.compose.material3.Typography
   4 import androidx.compose.ui.text.TextStyle
   5 import androidx.compose.ui.text.font.Font
   6 import androidx.compose.ui.text.font.FontFamily
   7 import androidx.compose.ui.text.font.FontWeight
   8 import androidx.compose.ui.unit.sp
   9 import com.lightningstudio.watchrss.R
  10 
  11 private val WatchFontFamily = FontFamily(
  12     Font(R.font.watch_sans, weight = FontWeight.Normal),
  13     Font(R.font.watch_sans, weight = FontWeight.Medium),
  14     Font(R.font.watch_sans, weight = FontWeight.SemiBold)
  15 )
  16 
  17 private fun watchTextStyle(
  18     fontWeight: FontWeight,
  19     fontSize: Int,
  20     lineHeight: Int
  21 ) = TextStyle(
  22     fontFamily = WatchFontFamily,
  23     fontWeight = fontWeight,
  24     fontSize = fontSize.sp,
  25     lineHeight = lineHeight.sp
  26 )
  27 
  28 val Typography = Typography(
  29     displayLarge = watchTextStyle(
  30         fontWeight = FontWeight.SemiBold,
  31         fontSize = 38,
  32         lineHeight = 44
  33     ),
  34     displayMedium = watchTextStyle(
  35         fontWeight = FontWeight.SemiBold,
  36         fontSize = 34,
  37         lineHeight = 40
  38     ),
  39     displaySmall = watchTextStyle(
  40         fontWeight = FontWeight.SemiBold,
  41         fontSize = 29,
  42         lineHeight = 35
  43     ),
  44     headlineLarge = watchTextStyle(
  45         fontWeight = FontWeight.SemiBold,
  46         fontSize = 31,
  47         lineHeight = 38
  48     ),
  49     headlineMedium = watchTextStyle(
  50         fontWeight = FontWeight.SemiBold,
  51         fontSize = 26,
  52         lineHeight = 31
  53     ),
  54     headlineSmall = watchTextStyle(
  55         fontWeight = FontWeight.SemiBold,
  56         fontSize = 24,
  57         lineHeight = 29
  58     ),
  59     titleLarge = watchTextStyle(
  60         fontWeight = FontWeight.Medium,
  61         fontSize = 23,
  62         lineHeight = 28
  63     ),
  64     titleMedium = watchTextStyle(
  65         fontWeight = FontWeight.Medium,
  66         fontSize = 21,
  67         lineHeight = 26
  68     ),
  69     titleSmall = watchTextStyle(
  70         fontWeight = FontWeight.Medium,
  71         fontSize = 18,
  72         lineHeight = 22
  73     ),
  74     bodyLarge = watchTextStyle(
  75         fontWeight = FontWeight.Normal,
  76         fontSize = 17,
  77         lineHeight = 21
  78     ),
  79     bodyMedium = watchTextStyle(
  80         fontWeight = FontWeight.Normal,
  81         fontSize = 14,
  82         lineHeight = 17
  83     ),
  84     bodySmall = watchTextStyle(
  85         fontWeight = FontWeight.Normal,
  86         fontSize = 12,
  87         lineHeight = 14
  88     ),
  89     labelLarge = watchTextStyle(
  90         fontWeight = FontWeight.Medium,
  91         fontSize = 14,
  92         lineHeight = 17
  93     ),
  94     labelMedium = watchTextStyle(
  95         fontWeight = FontWeight.Medium,
  96         fontSize = 12,
  97         lineHeight = 14
  98     ),
  99     labelSmall = watchTextStyle(
 100         fontWeight = FontWeight.Medium,
 101         fontSize = 9,
 102         lineHeight = 11
 103     )
 104 )
 105 
 106 val ActionButtonTextStyle = TextStyle(
 107     fontFamily = WatchFontFamily,
 108     fontWeight = FontWeight.Medium,
 109     fontSize = 17.sp,
 110     lineHeight = 23.sp,
 111     letterSpacing = 0.sp
 112 )
```

### OobeActivity.kt

```kotlin
  14 import androidx.compose.runtime.setValue
  15 import androidx.lifecycle.Lifecycle
  16 import androidx.lifecycle.lifecycleScope
  17 import androidx.lifecycle.repeatOnLifecycle
  18 import com.lightningstudio.watchrss.ui.components.AppTransparencyStore
  19 import com.lightningstudio.watchrss.ui.components.InitialAppTransparencyDialog
  20 import com.lightningstudio.watchrss.ui.screen.OobeScreen
  21 import com.lightningstudio.watchrss.data.reader.ReaderThemeMode
  22 import com.lightningstudio.watchrss.ui.reader.readerChromeStyle
  23 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  24 import com.lightningstudio.watchrss.ui.viewmodel.AppViewModelFactory
  25 import com.lightningstudio.watchrss.ui.viewmodel.OobeEvent
  26 import com.lightningstudio.watchrss.ui.viewmodel.OobeViewModel
  27 import kotlinx.coroutines.launch
  36 
  37     override fun onCreate(savedInstanceState: Bundle?) {
  38         super.onCreate(savedInstanceState)
  39         setupSystemBars()
  40         (application as WatchRssApplication).usageTelemetry.recordReleaseOobeOpened()
  41 
  42         val returnHomeOnFinish = intent.getBooleanExtra(EXTRA_RETURN_HOME_ON_FINISH, true)
  43 
  44         lifecycleScope.launch {
  45             repeatOnLifecycle(Lifecycle.State.STARTED) {
  46                 viewModel.events.collect { event ->
  47                     if (event == OobeEvent.Finish) {
  48                         if (returnHomeOnFinish) {
  62             WatchRSSTheme {
  63                 val uiState by viewModel.uiState.collectAsState()
  64                 val activeReaderPreset by readerPresetRepository.activePreset.collectAsState()
  65                 val readerChrome = activeReaderPreset.readerChromeStyle()
  66                 var showInitialTransparency by remember {
  67                     mutableStateOf(!AppTransparencyStore.isInitialAppDisclosureAcknowledged(this@OobeActivity))
  68                 }
  69                 Box(modifier = androidx.compose.ui.Modifier.fillMaxSize()) {
  70                     OobeScreen(
  71                         uiState = uiState,
  72                         onSetIntroPage = viewModel::setIntroPage,
  73                         onContinueFromIntro = viewModel::completeOobe,
  74                         onOpenUserAgreement = {
  75                             startActivity(
  99                                 }
 100                             )
 101                         }
 102                     )
 103                     if (showInitialTransparency) {
 104                         InitialAppTransparencyDialog(
 105                             onAcknowledge = {
 106                                 AppTransparencyStore.acknowledgeInitialAppDisclosure(this@OobeActivity)
 107                                 showInitialTransparency = false
 108                             }
 109                         )
 110                     }
 111                 }
 112             }
 113         }
 114     }
 115 
```

### HomeFeedListActivity.kt

```kotlin
  40 import com.lightningstudio.watchrss.data.rss.RssChannel
  41 import com.lightningstudio.watchrss.debug.PerformanceMonitor
  42 import com.lightningstudio.watchrss.debug.StartupDurationTracker
  43 import com.lightningstudio.watchrss.sdk.douyin.DouyinVideo
  44 import com.lightningstudio.watchrss.ui.components.AppTransparencyStore
  45 import com.lightningstudio.watchrss.ui.components.InitialAppTransparencyDialog
  46 import com.lightningstudio.watchrss.ui.screen.home.HomeComposeScreen
  47 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  48 import com.lightningstudio.watchrss.ui.viewmodel.AppViewModelFactory
  49 import com.lightningstudio.watchrss.ui.viewmodel.HomeViewModel
  50 import com.lightningstudio.watchrss.data.push.PushNotificationRepository
  51 import com.lightningstudio.watchrss.data.announcement.AnnouncementRepository
  52 import com.lightningstudio.watchrss.data.update.AppUpdateDownloader
  53 import com.lightningstudio.watchrss.data.update.AppUpdateState
 191                 Box(modifier = Modifier.fillMaxSize()) {
 192                     val announcement by pendingAnnouncement
 193                     val updateState by appUpdateDownloader.state.collectAsState()
 194                     val pushMessages by pendingPushMessages
 195                     var showInitialTransparency by remember(context) {
 196                         mutableStateOf(!AppTransparencyStore.isInitialAppDisclosureAcknowledged(context))
 197                     }
 198 
 199                     val ann = announcement
 200                     if (showInitialTransparency && ann == null && pushMessages.isEmpty()) {
 201                         InitialAppTransparencyDialog(
 202                             onAcknowledge = {
 203                                 AppTransparencyStore.acknowledgeInitialAppDisclosure(context)
 204                                 showInitialTransparency = false
 205                             }
 206                         )
 207                     }
 208                     if (ann != null) {
 209                         val downloading = updateState is AppUpdateState.Downloading
 210                         AlertDialog(
 211                             onDismissRequest = {
 212                                 if (!ann.forceUpdate) dismissAnnouncement(ann.version)
```

### AccountStatusActivity.kt

```kotlin
  22 import androidx.compose.ui.unit.dp
  23 import com.lightningstudio.watchrss.data.account.WatchAccountState
  24 import com.lightningstudio.watchrss.data.cloud.WatchCloudSyncService
  25 import com.lightningstudio.watchrss.ui.components.DownloadPhoneAppButton
  26 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  27 import com.lightningstudio.watchrss.ui.components.WatchRssAccessBoundaryCard
  28 import com.lightningstudio.watchrss.ui.components.WatchSurface
  29 import com.lightningstudio.watchrss.ui.input.InstallDigitalCrownScrollHandler
  30 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  31 
  32 class AccountStatusActivity : BaseWatchActivity() {
  33     override fun onCreate(savedInstanceState: Bundle?) {
  34         super.onCreate(savedInstanceState)
  35         setupSystemBars()
  76                 modifier = Modifier.fillMaxWidth(),
  77                 textAlign = TextAlign.Center
  78             )
  79             Spacer(modifier = Modifier.height(4.dp))
  80             ThirdPartyPlatformNotice(platform = "哔哩哔哩", compact = true)
  81             ThirdPartyPlatformNotice(platform = "抖音", compact = true)
  82             WatchRssAccessBoundaryCard()
  83             if (state == null) {
  84                 Text(
  85                     text = "未绑定",
  86                     style = MaterialTheme.typography.titleMedium,
  87                     fontWeight = FontWeight.SemiBold
  88                 )
  89                 Text(
  90                     text = "请在手机端登录后点击同步账号。",
  91                     style = MaterialTheme.typography.bodySmall,
  92                     color = MaterialTheme.colorScheme.onSurfaceVariant
  93                 )
  94                 Spacer(modifier = Modifier.height(8.dp))
  95                 DownloadPhoneAppButton(
  96                     operation = if (BuildConfig.DEBUG) "登录账号与云同步" else "登录账号",
  97                     modifier = Modifier.offset(y = (-4).dp)
  98                 )
  99             } else {
 100                 Text(
 125                         }
 126                         Text(
 127                             "首次使用需在手机端的WatchRSS云会员空间中批准这块手表。",
 128                             style = MaterialTheme.typography.bodySmall,
 129                             color = MaterialTheme.colorScheme.onSurfaceVariant
 130                         )
 131                     } else {
 132                         Text(
 133                             "WatchRSS云存储：需云会员；本地资料与蓝牙同步不受影响。",
 134                             style = MaterialTheme.typography.bodySmall,
 135                             color = MaterialTheme.colorScheme.onSurfaceVariant
 136                         )
 137                     }
 138                 }
 139             }
 140             Spacer(modifier = Modifier.height(24.dp))
 141         }
 142     }
 143 }
```

### BiliEntryActivity.kt

```kotlin
  13 import androidx.compose.runtime.setValue
  14 import androidx.compose.ui.platform.LocalDensity
  15 import androidx.compose.ui.unit.Density
  16 import androidx.compose.ui.unit.dp
  17 import com.lightningstudio.watchrss.ui.components.AppTransparencyStore
  18 import com.lightningstudio.watchrss.ui.components.InitialAppTransparencyDialog
  19 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformConfirmationDialog
  20 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  21 import com.lightningstudio.watchrss.ui.screen.bili.BiliEntryNavGraph
  22 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  23 
  24 class BiliEntryActivity : BaseWatchActivity() {
  25     override fun onCreate(savedInstanceState: Bundle?) {
  26         super.onCreate(savedInstanceState)
  27         setupSystemBars()
  28 
  31                 val baseDensity = LocalDensity.current
  32                 CompositionLocalProvider(LocalDensity provides Density(2f, baseDensity.fontScale)) {
  33                     val repository = (application as WatchRssApplication).container.biliRepository
  34                     val rssRepository = (application as WatchRssApplication).container.rssRepository
  35                     var showInitialTransparency by remember {
  36                         mutableStateOf(!AppTransparencyStore.isInitialAppDisclosureAcknowledged(this@BiliEntryActivity))
  37                     }
  38                     var showPlatformConfirmation by remember { mutableStateOf(!showInitialTransparency) }
  39                     if (showInitialTransparency) {
  40                         InitialAppTransparencyDialog(
  41                             onAcknowledge = {
  42                                 AppTransparencyStore.acknowledgeInitialAppDisclosure(this@BiliEntryActivity)
  43                                 showInitialTransparency = false
  44                                 showPlatformConfirmation = true
  45                             }
  46                         )
  47                     } else if (showPlatformConfirmation) {
  48                         ThirdPartyPlatformConfirmationDialog(
  49                             platform = "哔哩哔哩",
  50                             onConfirm = { showPlatformConfirmation = false }
  51                         )
  52                     }
  53                     Column(modifier = androidx.compose.ui.Modifier.fillMaxSize()) {
  54                         ThirdPartyPlatformNotice(
  55                             platform = "哔哩哔哩",
  56                             compact = true,
  57                             modifier = androidx.compose.ui.Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
  58                         )
  59                         Box(modifier = androidx.compose.ui.Modifier.weight(1f).fillMaxSize()) {
  60                             BiliEntryNavGraph(repository = repository, rssRepository = rssRepository)
  61                         }
  62                     }
```

### DouyinEntryActivity.kt

```kotlin
  31 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_PLAYBACK_START_VOLUME_LIMIT_PERCENT
  32 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_VOLUME_CONTROL_ENABLED
  33 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_VOLUME_GUARD_ENABLED
  34 import com.lightningstudio.watchrss.debug.DouyinPlaybackDebugController
  35 import com.lightningstudio.watchrss.ui.components.AppTransparencyStore
  36 import com.lightningstudio.watchrss.ui.components.InitialAppTransparencyDialog
  37 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformConfirmationDialog
  38 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  39 import com.lightningstudio.watchrss.ui.components.WatchCircularProgressIndicator
  40 import com.lightningstudio.watchrss.ui.screen.douyin.DouyinImmersiveScreen
  41 import com.lightningstudio.watchrss.ui.screen.douyin.DouyinLoginScreen
  42 import com.lightningstudio.watchrss.ui.screen.douyin.DouyinRssFeedScreen
  43 import com.lightningstudio.watchrss.ui.screen.douyin.rememberDouyinPlayerPoolSession
  44 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  45 import com.lightningstudio.watchrss.ui.util.getWebViewUnavailableMessage
  46 import com.lightningstudio.watchrss.ui.util.warnWebViewUnavailable
 110         setContent {
 111             WatchRSSTheme {
 112                 val baseDensity = LocalDensity.current
 113                 CompositionLocalProvider(LocalDensity provides Density(2f, baseDensity.fontScale)) {
 114                     var showInitialTransparency by remember {
 115                         mutableStateOf(!AppTransparencyStore.isInitialAppDisclosureAcknowledged(this@DouyinEntryActivity))
 116                     }
 117                     var showPlatformConfirmation by remember { mutableStateOf(!showInitialTransparency) }
 118                     if (showInitialTransparency) {
 119                         InitialAppTransparencyDialog(
 120                             onAcknowledge = {
 121                                 AppTransparencyStore.acknowledgeInitialAppDisclosure(this@DouyinEntryActivity)
 122                                 showInitialTransparency = false
 123                                 showPlatformConfirmation = true
 124                             }
 125                         )
 126                     } else if (showPlatformConfirmation) {
 127                         ThirdPartyPlatformConfirmationDialog(
 128                             platform = "抖音",
 129                             onConfirm = { showPlatformConfirmation = false }
 130                         )
 131                     }
 132                     Column(modifier = Modifier.fillMaxSize()) {
 133                         ThirdPartyPlatformNotice(
 134                             platform = "抖音",
 135                             compact = true,
 136                             modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
 137                         )
 138                         Box(modifier = Modifier.weight(1f).fillMaxSize()) {
 139                             val warningMessage = remember { mutableStateOf<String?>(null) }
 140                     val uiState by viewModel.uiState.collectAsState()
 141                     val volumeGuardEnabled by container.settingsRepository.mediaVolumeGuardEnabled.collectAsState(
 262                                     onHeaderClick = {
 263                                         isNavigating = true
 264                                         startActivity(DouyinChannelInfoActivity.createIntent(this@DouyinEntryActivity))
 265                                     },
 266                                     onPlaybackActiveChanged = { active ->
 267                                         setVideoPlaybackBatteryTracking("douyin", active)
 268                                     }
 269                                 )
 270                             }
 271                         } else {
 272                             DouyinRssFeedScreen(
 273                                 uiState = uiState,
 274                                 onRefresh = viewModel::loadInitial,
 275                                 onLoadMore = viewModel::loadMoreForList,
```

### BiliLoginActivity.kt

```kotlin
  16 import androidx.compose.ui.platform.LocalContext
  17 import androidx.compose.ui.platform.LocalDensity
  18 import androidx.compose.ui.unit.Density
  19 import androidx.compose.ui.unit.dp
  20 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  21 import com.lightningstudio.watchrss.ui.screen.bili.BiliLoginScreen
  22 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  23 import com.lightningstudio.watchrss.ui.viewmodel.BiliLoginViewModel
  24 import com.lightningstudio.watchrss.ui.viewmodel.BiliViewModelFactory
  25 
  26 class BiliLoginActivity : BaseWatchActivity() {
  27     private val repository by lazy { (application as WatchRssApplication).container.biliRepository }
  28     private val viewModel: BiliLoginViewModel by viewModels {
  51                     }
  52                 }
  53 
  54                 Column(modifier = androidx.compose.ui.Modifier.fillMaxSize()) {
  55                     ThirdPartyPlatformNotice(
  56                         platform = "哔哩哔哩",
  57                         compact = true,
  58                         modifier = androidx.compose.ui.Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
  59                     )
  60                     Box(modifier = androidx.compose.ui.Modifier.weight(1f).fillMaxSize()) {
  61                         BiliLoginScreen(
  62                             uiState = uiState,
  63                             onRefreshQr = viewModel::startLogin,
```

### DouyinLoginActivity.kt

```kotlin
  21 import com.lightningstudio.watchrss.data.network.DefaultInternetAvailabilityMonitor
  22 import com.lightningstudio.watchrss.data.network.InternetAvailabilityStatus
  23 import com.lightningstudio.watchrss.ui.screen.douyin.DouyinLoginBannedScreen
  24 import com.lightningstudio.watchrss.ui.screen.douyin.DouyinLoginCheckingScreen
  25 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  26 import com.lightningstudio.watchrss.ui.screen.douyin.DouyinLoginScreen
  27 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  28 import com.lightningstudio.watchrss.ui.util.getWebViewUnavailableMessage
  29 import com.lightningstudio.watchrss.ui.util.warnWebViewUnavailable
  30 
  31 class DouyinLoginActivity : BaseWatchActivity() {
  32     private val internetAvailabilityMonitor by lazy {
  33         DefaultInternetAvailabilityMonitor(this)
  73                         }
  74 
  75                         InternetAvailabilityStatus.Available -> {
  76                             Column(modifier = Modifier.fillMaxSize()) {
  77                                 ThirdPartyPlatformNotice(
  78                                     platform = "抖音",
  79                                     compact = true,
  80                                     modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
  81                                 )
  82                                 Box(modifier = Modifier.weight(1f).fillMaxSize()) {
  83                                     DouyinLoginScreen(
  84                                 initialErrorMessage = initialWebViewError,
  85                                 onWebViewInitFailed = { warningMessage.value = it },
```

### BiliPlayerActivity.kt

```kotlin
  20 import com.lightningstudio.watchrss.data.rss.BuiltinChannelType
  21 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_PLAYBACK_START_VOLUME_LIMIT_PERCENT
  22 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_VOLUME_CONTROL_ENABLED
  23 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_VOLUME_GUARD_ENABLED
  24 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  25 import com.lightningstudio.watchrss.ui.screen.bili.BiliPlayerScreen
  26 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  27 import com.lightningstudio.watchrss.ui.viewmodel.BiliPlayerViewModel
  28 import com.lightningstudio.watchrss.ui.viewmodel.BiliViewModelFactory
  29 import kotlinx.coroutines.flow.map
  30 
  31 class BiliPlayerActivity : BaseWatchActivity() {
  32     private val container by lazy { (application as WatchRssApplication).container }
  77                                 ?.continuePlaybackInBackground ?: false
  78                         }
  79                     }.collectAsState(initial = false)
  80                     Column(modifier = androidx.compose.ui.Modifier.fillMaxSize()) {
  81                         ThirdPartyPlatformNotice(
  82                             platform = "哔哩哔哩",
  83                             compact = true,
  84                             modifier = androidx.compose.ui.Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
  85                         )
  86                         Box(modifier = androidx.compose.ui.Modifier.weight(1f).fillMaxSize()) {
  87                             BiliPlayerScreen(
  88                         uiState = uiState,
  89                         onRetry = viewModel::loadPlayUrl,
 110                         digitalCrownVolumeEnabled = volumeControlEnabled,
 111                         volumeGuardEnabled = volumeGuardEnabled,
 112                         playbackStartVolumeLimitPercent = playbackStartVolumeLimitPercent,
 113                         continuePlaybackInBackground = continuePlaybackInBackground,
 114                         onPlaybackActiveChanged = { active ->
 115                             setVideoPlaybackBatteryTracking("bilibili", active)
 116                         }
 117                             )
 118                         }
 119                     }
 120                 }
 121             }
 122         }
 123     }
```

### DouyinPlayerActivity.kt

```kotlin
  29 import com.lightningstudio.watchrss.data.rss.BuiltinChannelType
  30 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_PLAYBACK_START_VOLUME_LIMIT_PERCENT
  31 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_VOLUME_CONTROL_ENABLED
  32 import com.lightningstudio.watchrss.data.settings.DEFAULT_MEDIA_VOLUME_GUARD_ENABLED
  33 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  34 import com.lightningstudio.watchrss.ui.screen.PlatformEntryScreen
  35 import com.lightningstudio.watchrss.ui.screen.bili.BiliPlayerScreen
  36 import com.lightningstudio.watchrss.ui.viewmodel.BiliPlaybackSource
  37 import com.lightningstudio.watchrss.ui.viewmodel.BiliPlaybackSourceKind
  38 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  39 import com.lightningstudio.watchrss.ui.viewmodel.BiliPlayerUiState
  40 import kotlinx.coroutines.flow.collectLatest
  41 import kotlinx.coroutines.flow.map
  68             WatchRSSTheme {
  69                 val baseDensity = LocalDensity.current
  70                 CompositionLocalProvider(LocalDensity provides Density(2f, baseDensity.fontScale)) {
  71                     Column(modifier = Modifier.fillMaxSize()) {
  72                         ThirdPartyPlatformNotice(
  73                             platform = "抖音",
  74                             compact = true,
  75                             modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
  76                         )
  77                         Box(modifier = Modifier.weight(1f).fillMaxSize()) {
  78                     val volumeGuardEnabled by settingsRepository.mediaVolumeGuardEnabled.collectAsState(
  79                         initial = DEFAULT_MEDIA_VOLUME_GUARD_ENABLED
  80                     )
  93                                 ?.continuePlaybackInBackground ?: false
  94                         }
  95                     }.collectAsState(initial = false)
  96                     if (items.isEmpty()) {
  97                         PlatformEntryScreen(title = "腕上RSS · 抖音频道", message = "暂无可播放内容")
  98                     } else {
  99                         val headers by produceState(initialValue = emptyMap<String, String>()) {
 100                             value = repository.buildPlayHeaders()
 101                         }
 102 
 103                         val pagerState = rememberPagerState(
 104                             initialPage = startIndex,
 105                             pageCount = { items.size }
 152                                     digitalCrownVolumeEnabled = page == pagerState.currentPage && volumeControlEnabled,
 153                                     volumeGuardEnabled = volumeGuardEnabled,
 154                                     playbackStartVolumeLimitPercent = playbackStartVolumeLimitPercent,
 155                                     continuePlaybackInBackground = continuePlaybackInBackground,
 156                                     onPlaybackActiveChanged = { active ->
 157                                         if (page == pagerState.currentPage) {
 158                                             setVideoPlaybackBatteryTracking("douyin", active)
 159                                         }
 160                                     }
 161                                 )
 162                             }
 163                         }
 164                         }
 165                     }
 166                 }
```

### BiliVideoActionsActivity.kt

```kotlin
  19 import com.lightningstudio.watchrss.data.bili.buildBiliExternalSavedItem
  20 import com.lightningstudio.watchrss.data.bili.buildBiliShareLink
  21 import com.lightningstudio.watchrss.data.bili.formatBiliError
  22 import com.lightningstudio.watchrss.data.rss.SaveType
  23 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  24 import com.lightningstudio.watchrss.ui.screen.ActionDialogScreen
  25 import com.lightningstudio.watchrss.ui.screen.ActionItem
  26 import com.lightningstudio.watchrss.ui.screen.rss.shareCurrent
  27 import com.lightningstudio.watchrss.ui.screen.rss.showShareQr
  28 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  29 import com.lightningstudio.watchrss.ui.util.isSystemShareSettingSupported
  30 import com.lightningstudio.watchrss.ui.util.showAppToast
  31 import kotlinx.coroutines.launch
 133                     )
 134                 )
 135 
 136                 Column(modifier = Modifier.fillMaxSize()) {
 137                     ThirdPartyPlatformNotice(
 138                         platform = "哔哩哔哩",
 139                         compact = true,
 140                         modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
 141                     )
 142                     Box(modifier = Modifier.weight(1f).fillMaxSize()) {
 143                         ActionDialogScreen(
 144                             items = items,
 145                             extraTopPadding = 4.dp
```

### DouyinVideoActionsActivity.kt

```kotlin
  20 import com.lightningstudio.watchrss.data.douyin.buildDouyinShareLink
  21 import com.lightningstudio.watchrss.data.douyin.containsDouyinSavedItem
  22 import com.lightningstudio.watchrss.data.rss.ExternalSavedItem
  23 import com.lightningstudio.watchrss.data.rss.SaveType
  24 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformNotice
  25 import com.lightningstudio.watchrss.ui.screen.ActionDialogScreen
  26 import com.lightningstudio.watchrss.ui.screen.ActionItem
  27 import com.lightningstudio.watchrss.ui.screen.rss.shareCurrent
  28 import com.lightningstudio.watchrss.ui.screen.rss.showShareQr
  29 import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
  30 import com.lightningstudio.watchrss.ui.util.isSystemShareSettingSupported
  31 import com.lightningstudio.watchrss.ui.util.showAppToast
  32 import kotlinx.coroutines.launch
 152                     )
 153                 )
 154 
 155                 Column(modifier = Modifier.fillMaxSize()) {
 156                     ThirdPartyPlatformNotice(
 157                         platform = "抖音",
 158                         compact = true,
 159                         modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
 160                     )
 161                     Box(modifier = Modifier.weight(1f).fillMaxSize()) {
 162                         ActionDialogScreen(
 163                             items = items,
 164                             extraTopPadding = 4.dp
```

### ui/screen/bili/BiliChannelInfoScreen.kt

```kotlin
  31 import androidx.core.content.res.ResourcesCompat
  32 import android.graphics.Paint
  33 import android.text.TextPaint
  34 import com.lightningstudio.watchrss.R
  35 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformScopeCard
  36 import com.lightningstudio.watchrss.ui.components.WatchSurface
  37 import com.lightningstudio.watchrss.ui.input.InstallDigitalCrownScrollHandler
  38 import com.lightningstudio.watchrss.ui.theme.ActionButtonTextStyle
  39 import com.lightningstudio.watchrss.ui.theme.WatchDimens
  40 import com.lightningstudio.watchrss.ui.theme.rememberWatchTitleLineLimitsPx
  41 import com.lightningstudio.watchrss.ui.theme.watchActionButtonWidthFor
  42 import com.lightningstudio.watchrss.ui.util.formatTime
  43 import com.lightningstudio.watchrss.ui.util.normalizeWatchTitleWhitespace
 100                     rememberWatchTitleLineLimitsPx(availableWidthPx, density)
 101                 }
 102                 val formattedTitle = remember(availableWidthPx, titleSizePx, typeface) {
 103                     formatTitleForWidthLimits(
 104                         title = "腕上RSS · 哔哩哔哩频道",
 105                         paint = paint,
 106                         availableWidthPx = availableWidthPx,
 107                         firstLimitPx = firstLimitPx,
 108                         secondLimitPx = secondLimitPx
 109                     )
 110                 }
 111                 Text(
 112                     text = formattedTitle,
 120             Spacer(modifier = Modifier.height(titleSpacing))
 121             Text(
 122                 text = description,
 123                 style = MaterialTheme.typography.bodySmall,
 124                 color = MaterialTheme.colorScheme.onSurfaceVariant,
 125                 modifier = Modifier.fillMaxWidth(),
 126                 textAlign = TextAlign.Center
 127             )
 128             Spacer(modifier = Modifier.height(infoSpacing))
 129             Text(
 130                 text = url,
 131                 style = MaterialTheme.typography.bodySmall,
 132                 color = MaterialTheme.colorScheme.onSurface,
 136             Spacer(modifier = Modifier.height(infoSpacing))
 137             Text(
 138                 text = updateLabel,
 139                 style = MaterialTheme.typography.bodySmall,
 140                 color = MaterialTheme.colorScheme.onSurfaceVariant,
 141                 modifier = Modifier.fillMaxWidth(),
 142                 textAlign = TextAlign.Center
 143             )
 144             ThirdPartyPlatformScopeCard(
 145                 platform = "哔哩哔哩",
 146                 modifier = Modifier.padding(top = infoSpacing)
 147             )
 148 
 149             BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
 150                 val buttonWidth = watchActionButtonWidthFor(maxWidth)
 151 
 152                 Column(
```

### ui/screen/douyin/DouyinChannelInfoScreen.kt

```kotlin
  33 import androidx.compose.ui.unit.TextUnit
  34 import androidx.compose.ui.unit.dp
  35 import androidx.core.content.res.ResourcesCompat
  36 import com.lightningstudio.watchrss.R
  37 import com.lightningstudio.watchrss.ui.components.ThirdPartyPlatformScopeCard
  38 import com.lightningstudio.watchrss.ui.components.WatchSurface
  39 import com.lightningstudio.watchrss.ui.input.InstallDigitalCrownScrollHandler
  40 import com.lightningstudio.watchrss.ui.theme.ActionButtonTextStyle
  41 import com.lightningstudio.watchrss.ui.testing.DouyinChannelInfoTestTags
  42 import com.lightningstudio.watchrss.ui.util.formatTime
  43 import com.lightningstudio.watchrss.ui.util.normalizeWatchTitleWhitespace
  44 import kotlin.math.min
  45 
 103             BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
 104                 val availableWidthPx = with(density) { maxWidth.toPx() }
 105                 val formattedTitle = remember(availableWidthPx, titleSizePx, typeface) {
 106                     formatTitleForWidthLimits(
 107                         title = "腕上RSS · 抖音频道",
 108                         paint = paint,
 109                         availableWidthPx = availableWidthPx,
 110                         firstLimitPx = firstLimitPx,
 111                         secondLimitPx = secondLimitPx
 112                     )
 113                 }
 114                 Text(
 115                     text = formattedTitle,
 123             Spacer(modifier = Modifier.height(titleSpacing))
 124             Text(
 125                 text = description,
 126                 style = MaterialTheme.typography.bodySmall,
 127                 color = MaterialTheme.colorScheme.onSurfaceVariant,
 128                 modifier = Modifier.fillMaxWidth(),
 129                 textAlign = TextAlign.Center
 130             )
 131             Spacer(modifier = Modifier.height(infoSpacing))
 132             Text(
 133                 text = url,
 134                 style = MaterialTheme.typography.bodySmall,
 135                 color = MaterialTheme.colorScheme.onSurface,
 139             Spacer(modifier = Modifier.height(infoSpacing))
 140             Text(
 141                 text = updateLabel,
 142                 style = MaterialTheme.typography.bodySmall,
 143                 color = MaterialTheme.colorScheme.onSurfaceVariant,
 144                 modifier = Modifier.fillMaxWidth(),
 145                 textAlign = TextAlign.Center
 146             )
 147             ThirdPartyPlatformScopeCard(
 148                 platform = "抖音",
 149                 modifier = Modifier.padding(top = infoSpacing)
 150             )
 151 
 152             Spacer(modifier = Modifier.height(buttonSpacing))
 153             ActionButton(
 154                 label = "设置",
 155                 enabled = true,
```

### ui/screen/bili/BiliFeedScreen.kt

```kotlin
 211                 item {
 212                     if (uiState.isLoadingMore) {
 213                         Text(
 214                             text = "加载中...",
 215                             color = MaterialTheme.colorScheme.onSurfaceVariant,
 216                             textAlign = TextAlign.Center,
 217                             modifier = Modifier.fillMaxWidth()
 218                         )
 219                     }
 220                 }
 221             }
 222         }
 223 
 455             horizontalAlignment = Alignment.CenterHorizontally,
 456             verticalArrangement = Arrangement.spacedBy(spacing)
 457         ) {
 458             Text(
 459                 text = channelTitleWithStyledHint("腕上RSS · 哔哩哔哩频道", titleSize),
 460                 color = MaterialTheme.colorScheme.onSurface,
 461                 fontSize = titleSize,
 462                 textAlign = TextAlign.Center,
 463                 modifier = Modifier.fillMaxWidth()
 464             )
 465             Text(
 466                 text = if (isLoggedIn) "已登录" else "未登录",
 467                 color = MaterialTheme.colorScheme.onSurfaceVariant,
 468                 fontSize = captionSize,
 469                 textAlign = TextAlign.Center,
 470                 modifier = Modifier.fillMaxWidth()
 471             )
 472         }
 473         if (!isLoggedIn) {
 474             Spacer(modifier = Modifier.height(4.dp))
 475             Row(
```

### ui/screen/bili/BiliRssFeedScreen.kt

```kotlin
 190                 item {
 191                     if (uiState.isLoadingMore) {
 192                         Text(
 193                             text = "加载中...",
 194                             color = MaterialTheme.colorScheme.onSurfaceVariant,
 195                             textAlign = TextAlign.Center,
 196                             modifier = Modifier.fillMaxWidth()
 197                         )
 198                     }
 199                 }
 200             }
 201         }
 202     }
 373                 overflow = TextOverflow.Ellipsis
 374             )
 375             Text(
 376                 text = summary,
 377                 color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
 378                 fontSize = summarySize,
 379                 lineHeight = summaryLineHeight,
 380                 maxLines = 2,
 381                 overflow = TextOverflow.Ellipsis,
 382                 modifier = Modifier.padding(top = summaryTop)
 383             )
 384         }
 385     }
 406             horizontalAlignment = Alignment.CenterHorizontally,
 407             verticalArrangement = Arrangement.spacedBy(spacing)
 408         ) {
 409             Text(
 410                 text = channelTitleWithStyledHint("腕上RSS · 哔哩哔哩频道", titleSize),
 411                 color = MaterialTheme.colorScheme.onSurface,
 412                 fontSize = titleSize,
 413                 textAlign = TextAlign.Center,
 414                 modifier = Modifier.fillMaxWidth()
 415             )
 416             Text(
 417                 text = if (isLoggedIn) "已登录" else "未登录",
 418                 color = MaterialTheme.colorScheme.onSurfaceVariant,
 419                 fontSize = captionSize,
 420                 textAlign = TextAlign.Center,
 421                 modifier = Modifier.fillMaxWidth()
 422             )
 423         }
 424         if (!isLoggedIn) {
 425             Spacer(modifier = Modifier.height(4.dp))
 426             Row(
```

### ui/screen/douyin/DouyinRssFeedScreen.kt

```kotlin
 122             verticalArrangement = Arrangement.spacedBy(itemSpacing)
 123         ) {
 124             item {
 125                 FeedHeader(
 126                     title = "腕上RSS · 抖音频道",
 127                     isRefreshing = uiState.isLoading,
 128                     enabled = !isScrolling,
 129                     onClick = {
 130                         if (!closeOpenSwipe()) {
 131                             onHeaderClick()
 132                         }
 133                     }
 134                 )
 143                         horizontalAlignment = Alignment.CenterHorizontally
 144                     ) {
 145                         Text(
 146                             text = "未登录",
 147                             color = MaterialTheme.colorScheme.onSurfaceVariant,
 148                             textAlign = TextAlign.Center,
 149                             modifier = Modifier.fillMaxWidth()
 150                         )
 151                         Spacer(modifier = Modifier.height(itemSpacing))
 152                         FeedPillButton(text = "登录", onClick = onLoginClick)
 153                     }
 154                 }
 155             } else if (uiState.items.isEmpty()) {
```

### ui/screen/douyin/DouyinImmersiveScreen.kt

```kotlin
 594     ) -> Unit,
 595     onDiscardPlaybackItem: (String) -> Unit,
 596     onMessageShown: () -> Unit,
 597     onHeaderClick: () -> Unit,
 598     onPlaybackActiveChanged: (Boolean) -> Unit = { }
 599 ) {
 600     var entryStartIndex by rememberSaveable {
 601         mutableIntStateOf(
 602             resolveDouyinEntryStartIndex(
 603                 currentPage = uiState.currentPage,
 604                 itemCount = uiState.items.size
 605             )
 606         )
 669         }
 670     }
 671     val view = LocalView.current
 672     val lifecycleOwner = LocalLifecycleOwner.current
 673     val playbackActiveCallback = rememberUpdatedState(onPlaybackActiveChanged)
 674     val poisonedAwemeIds by DouyinPlaybackDebugController.poisonedAwemeIds.collectAsState()
 675     val quarantinedPlaybackRecords = remember { mutableStateMapOf<String, DouyinPlaybackQuarantineRecord>() }
 676     val automatic403RefreshSources = remember { mutableStateMapOf<String, String>() }
 677     val handledRefreshFailureEventIds = remember { linkedSetOf<Long>() }
 678     val playbackAnchorPagerPage = resolveDouyinPlaybackAnchorPagerPage(
 679         isScrollInProgress = pagerState.isScrollInProgress,
 680         pagerPage = pagerState.currentPage,
 681         settledPagerPage = settledPagerPage
1017         foregroundSlot.boundAwemeId == activeItem.awemeId
1018     val activeIsBuffering = activeSlotMatchesCurrentItem && foregroundSlot.isBuffering
1019     val activeIsPlaying = activeSlotMatchesCurrentItem && foregroundSlot.isPlaying
1020     LaunchedEffect(activeIsPlaying, uiState.showTitlePage, settledPagerPage) {
1021         playbackActiveCallback.value(
1022             activeIsPlaying && !uiState.showTitlePage && settledPagerPage > 0
1023         )
1024     }
1025     DisposableEffect(Unit) {
1026         onDispose { playbackActiveCallback.value(false) }
1027     }
1028     val activeHasError = activeSlotMatchesCurrentItem && foregroundSlot.hasError
1029     val activePlaybackNeedsInternet = (activeMediaUri ?: preparedPlaybackTargetMediaUri)
1030         .requiresInternetConnection()
1031     val shouldShowBluetoothPrompt =
1032         internetAvailabilityStatus == InternetAvailabilityStatus.Bluetooth && !allowBluetoothPlayback
1033     val showNetworkUnavailable = (
1034         internetAvailabilityStatus == InternetAvailabilityStatus.Unavailable ||
2873                             horizontalAlignment = Alignment.CenterHorizontally
2874                         ) {
2875                             Text(
2876                                 text = channelTitleWithStyledHint(
2877                                     title = "腕上RSS · 抖音频道",
2878                                     titleSize = MaterialTheme.typography.titleMedium.fontSize
2879                                 ),
2880                                 style = MaterialTheme.typography.titleMedium,
2881                                 color = MaterialTheme.colorScheme.onSurface,
2882                                 textAlign = TextAlign.Center
2883                             )
2884                             Spacer(modifier = Modifier.height(subtitleSpacing))
2885                             Text(
2890                                 } else {
2891                                     "暂无内容，下拉刷新或点箭头重试"
2892                                 },
2893                                 style = MaterialTheme.typography.bodySmall,
2894                                 color = MaterialTheme.colorScheme.onSurfaceVariant,
2895                                 textAlign = TextAlign.Center
2896                             )
2897                         }
2898 
2899                         Surface(
2900                             shape = CircleShape,
2901                             color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.92f),
2902                             modifier = Modifier
3161                         ) {
3162                             Text(
3163                                 text = infoText,
3164                                 style = MaterialTheme.typography.bodySmall,
3165                                 color = MaterialTheme.colorScheme.onSurfaceVariant,
3166                                 textAlign = TextAlign.Center,
3167                                 maxLines = 1,
3168                                 overflow = TextOverflow.Ellipsis
3169                             )
3170                         }
3171                     }
3172                 }
3173             }
```

### ui/screen/douyin/DouyinLoginScreen.kt

```kotlin
  84     var webViewRef by remember { mutableStateOf<WebView?>(null) }
  85     var loginPanelExists by remember { mutableStateOf(false) }
  86     var loginPanelWasVisible by remember { mutableStateOf(false) }
  87     var isOnLoginPage by remember { mutableStateOf(false) }
  88     var loginStartTime by remember { mutableStateOf<Long?>(null) }
  89     var webViewLoadComplete by remember { mutableStateOf(false) }
  90 
  91     // QR code detection states
  92     var needTwoStepVerification by remember { mutableStateOf(false) }
  93     var qrCodeBase64 by remember { mutableStateOf<String?>(null) }
  94     var qrCodeType by remember { mutableStateOf<String?>(null) } // "login" or "twoStep"
  95     var jsErrorMessage by remember { mutableStateOf<String?>(null) }
  96     var qrLoadTimeReported by remember { mutableStateOf(false) }
  97 
  98     // Loading state tracking
  99     var loadingStateStartTime by remember { mutableStateOf(System.currentTimeMillis()) }
 100     var loadingStateCounter by remember { mutableStateOf(1) }
 101 
 102     // Swipe back gesture state
 103     var screenWidth by remember { mutableFloatStateOf(0f) }
 104 
 164                 // Update login page status
 165                 if (exists && !isOnLoginPage) {
 166                     isOnLoginPage = true
 167                     // Record login start time when first entering login page
 168                     loginStartTime = System.currentTimeMillis()
 169                 }
 170 
 171                 if (loginPanelWasVisible && !exists) {
 172                     // Login panel disappeared - login successful
 173                     val cookieManager = CookieManager.getInstance()
 174                     val allCookies = cookieManager.getCookie("https://www.douyin.com") ?: ""
 175                     val douyinCookies = allCookies.split(";")
 176                         .map { it.trim() }
 177                         .filter { it.isNotEmpty() }
 178                         .joinToString("; ")
 179 
 180                     // Calculate and log login duration
 181                     val startTime = loginStartTime
 182                     if (startTime != null) {
 183                         val duration = System.currentTimeMillis() - startTime
 184                         AppLogger.log("DouyinLogin", "登录耗时: ${duration}ms (${duration / 1000.0}秒)")
 185                     }
 186 
 187                     cookieResult = douyinCookies
 188                     onLoginComplete(douyinCookies)
 189                 }
 277                             qrCodeType = "login"
 278                             AppLogger.log("DouyinLogin", "检测到登录二维码")
 279 
 280                             // 上报从登录页出现到二维码出现的耗时
 281                             val startTime = loginStartTime
 282                             if (startTime != null && !qrLoadTimeReported) {
 283                                 qrLoadTimeReported = true
 284                                 val duration = System.currentTimeMillis() - startTime
 285                                 AppLogger.log("DouyinLogin", "二维码加载耗时: ${duration}ms (${duration / 1000.0}秒)")
 286                                 (context.applicationContext as? WatchRssApplication)
 287                                     ?.usageTelemetry
 288                                     ?.recordDouyinQrLoadTime(duration)
 289                             }
 290                         } else if (qrCodeType == "login") {
 291                             // Login QR disappeared
 292                             qrCodeBase64 = null
 293                             qrCodeType = null
 294                         }
 295                     } catch (e: Exception) {
 296                         AppLogger.e("DouyinLogin", "检查登录二维码失败", e)
```

### ui/screen/bili/BiliPlayerScreen.kt

```kotlin
 163     digitalCrownVolumeEnabled: Boolean = true,
 164     volumeGuardEnabled: Boolean = true,
 165     playbackStartVolumeLimitPercent: Int? = 10,
 166     continuePlaybackInBackground: Boolean = false,
 167     onPlaybackActiveChanged: (Boolean) -> Unit = { }
 168 ) {
 169     val safePadding = watchDimensionResource(R.dimen.watch_safe_padding)
 170     val spacing = watchDimensionResource(R.dimen.hey_distance_6dp)
 171     val accent = watchColorResource(R.color.brand_orange)
 172     val timeSize = textSize(R.dimen.hey_caption)
 173     val controlSize = watchDimensionResource(R.dimen.hey_button_height)
 174     val iconSize = watchDimensionResource(R.dimen.hey_listitem_widget_size)
 175     val lifecycleOwner = LocalLifecycleOwner.current
 176     val context = LocalContext.current
 177     val view = LocalView.current
 178     val continuePlaybackInBackgroundState = rememberUpdatedState(continuePlaybackInBackground)
 179     val playbackActiveCallback = rememberUpdatedState(onPlaybackActiveChanged)
 180     var playerRef by remember { mutableStateOf<ExoPlayer?>(null) }
 181     var textureViewRef by remember { mutableStateOf<TextureView?>(null) }
 182     var isTextureAvailable by remember { mutableStateOf(false) }
 183     var playbackError by remember { mutableStateOf<String?>(null) }
 184     var isPrepared by remember { mutableStateOf(false) }
 185     var isPlaying by remember { mutableStateOf(false) }
 186     var isBuffering by remember { mutableStateOf(false) }
 187     var durationMs by remember { mutableStateOf(0) }
 514         onDispose { }
 515     }
 516 
 517     LaunchedEffect(isActive, isPlaying) {
 518         playbackActiveCallback.value(isActive && isPlaying)
 519     }
 520     DisposableEffect(Unit) {
 521         onDispose { playbackActiveCallback.value(false) }
 522     }
 523 
 524     DisposableEffect(lifecycleOwner) {
 525         val observer = LifecycleEventObserver { _, event ->
 526             if (event == Lifecycle.Event.ON_PAUSE) {
 527                 if (!continuePlaybackInBackgroundState.value) {
 528                     pausePlayback()
 529                 }
 927                 verticalArrangement = Arrangement.spacedBy(spacing)
 928             ) {
 929                 Text(
 930                     text = errorText,
 931                     color = MaterialTheme.colorScheme.onSurfaceVariant
 932                 )
 933                 Row(horizontalArrangement = Arrangement.spacedBy(spacing)) {
 934                     BiliPillButton(text = "重试", onClick = onRetry)
 935                     BiliPillButton(text = "浏览器打开", onClick = onOpenWeb)
 936                 }
 937             }
 938         }
 939 
1006                             progress = {
1007                                 if (durationMs > 0) positionMs.toFloat() / durationMs else 0f
1008                             },
1009                             color = accent,
1010                             trackColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f),
1011                             modifier = Modifier
1012                                 .weight(1f)
1013                                 .height(4.dp)
1014                                 .clip(androidx.compose.foundation.shape.RoundedCornerShape(100))
1015                                 .semantics {
1016                                     contentDescription = "播放进度"
1017                                     stateDescription = "${(if (durationMs > 0) positionMs * 100 / durationMs else 0)}%"
1018                                 }
1019                         )
1020                         Text(
1021                             text = formatTime(durationMs),
1022                             color = MaterialTheme.colorScheme.onSurfaceVariant,
1023                             fontSize = timeSize,
1024                             modifier = Modifier.semantics {
1025                                 contentDescription = "总时长 ${formatTime(durationMs)}"
1026                             }
1027                         )
1028                     }
1029 
1030                     Row(
```

### BaseWatchActivity.kt

```kotlin
 202         super.onPause()
 203     }
 204 
 205     override fun onDestroy() {
 206         setVideoPlaybackBatteryTracking(source = batteryDrainActiveSource ?: "", active = false)
 207         if (isFinishing) {
 208             buildResumeIntent()?.let { AppResumeStateStore.clearIfMatches(this, it) }
 209         }
 210         super.onDestroy()
 211     }
 212 
 213     override fun startActivity(intent: Intent) {
 214         startActivity(intent, null)
 405     /**
 406      * Starts/stops a battery sample only while a real video is actively playing.
 407      * Login, title pages, search/history browsing, buffering and paused time are excluded.
 408      */
 409     protected fun setVideoPlaybackBatteryTracking(source: String, active: Boolean) {
 410         val normalizedSource = source.takeIf { it == "bilibili" || it == "douyin" }
 411         if (active && normalizedSource != null) {
 412             if (batteryDrainActiveSource == normalizedSource && batteryDrainStartedAt > 0L) return
 413             finishVideoPlaybackBatterySample()
 414             batteryDrainActiveSource = normalizedSource
 415             batteryDrainStartedAt = SystemClock.elapsedRealtime()
 416             batteryDrainStartLevel = currentBatteryPercent()
 417             return
 418         }
 419         if (!active && (normalizedSource == null || batteryDrainActiveSource == normalizedSource)) {
 420             finishVideoPlaybackBatterySample()
 421         }
 422     }
 423 
 424     private fun finishVideoPlaybackBatterySample() {
 425         val source = batteryDrainActiveSource
 426         val startedAt = batteryDrainStartedAt
 427         val startLevel = batteryDrainStartLevel
 428         batteryDrainActiveSource = null
 429         batteryDrainStartedAt = 0L
 430         batteryDrainStartLevel = null
 431         if (source == null || startedAt <= 0L || startLevel == null) return
 432         val durationMs = SystemClock.elapsedRealtime() - startedAt
 433         if (durationMs < MIN_BATTERY_DRAIN_SESSION_MS) return
 434         val endLevel = currentBatteryPercent() ?: return
 435         if (endLevel > startLevel) return
 436         telemetryOrNull()?.recordVideoBatteryDrain(
 437             source = source,
 438             durationMs = durationMs,
 439             batteryStart = startLevel,
 440             batteryEnd = endLevel
 441         )
 442     }
 443 
 444     private fun currentBatteryPercent(): Int? {
 445         val value = getSystemService(BatteryManager::class.java)
 446             ?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
 447             ?: return null
 448         return value.takeIf { it in 0..100 }
 449     }
 450 
 451     private fun telemetryOrNull(): WatchUsageTelemetry? {
 452         return (applicationContext as? WatchRssApplication)?.container?.watchUsageTelemetry
```

### ui/theme/Theme.kt

```kotlin
  40 
  41 /** Current translation applied by the app-wide rubber-band container. */
  42 internal val LocalRubberBandOverscrollOffset = staticCompositionLocalOf<State<Float>?> { null }
  43 
  44 internal val WatchDarkColorScheme = darkColorScheme(
  45     primary = BrandOrange,
  46     secondary = BrandOrangeDark,
  47     tertiary = WatchPinnedSurface,
  48     background = WatchBackground,
  49     surface = WatchSurface,
  50     surfaceVariant = WatchSurfaceVariant,
  51     onPrimary = Color.Black,
  52     onSecondary = Color.Black,
  53     onTertiary = WatchTextPrimary,
  54     onBackground = WatchTextPrimary,
  55     onSurface = WatchTextPrimary,
  56     onSurfaceVariant = WatchTextSecondary,
  57     outline = WatchDivider,
  58     error = WatchDanger,
  59     onError = Color.Black,
  60     errorContainer = WatchDangerContainer,
  61     onErrorContainer = WatchTextPrimary,
  62     secondaryContainer = WatchPillSurface,
  63     onSecondaryContainer = WatchTextPrimary,
  64     tertiaryContainer = WatchPinnedSurface,
  76     onSecondary = Color.White,
  77     onTertiary = Color.White,
  78     onBackground = Color(0xFF1C1B1F),
  79     onSurface = Color(0xFF1C1B1F),
  80     onSurfaceVariant = Color(0xFF4A4A4A),
  81     outline = Color(0xFFDDD4CB),
  82     error = Color(0xFFB3261E),
  83     onError = Color.White,
  84     errorContainer = Color(0xFFF9DEDC),
  85     onErrorContainer = Color(0xFF410E0B),
  86     secondaryContainer = Color(0xFFEAE2DA),
  87     onSecondaryContainer = Color(0xFF1C1B1F),
  88     tertiaryContainer = Color(0xFFD8D2CC),
  96     // Dynamic color is available on Android 12+
  97     dynamicColor: Boolean = false,
  98     content: @Composable () -> Unit
  99 ) {
 100     val colorScheme = if (darkTheme) WatchDarkColorScheme else WatchLightColorScheme
 101 
 102     MaterialTheme(
 103         colorScheme = colorScheme,
 104         typography = Typography,
 105         content = {
 106             CompositionLocalProvider(
 107                 LocalOverscrollConfiguration provides null,
 108                 LocalContentColor provides colorScheme.onSurface
 109             ) {
 110                 ProvideTextStyle(Typography.bodyMedium) {
```

