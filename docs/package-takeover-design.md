# PodJS 接管原生包名设计（P1）

> T2（2026-10-07）：独立分支已增加原字节backup、native恢复入口和显式版本门槛清理。见 [T2演练](takeover-rehearsal.md#t2原生备份--同隔离包恢复--公测后显式清理)。以下T1/P1历史事实保留；源在ACTIVE前转存backup，不能再要求原路径存在。设备/正式签名/原生功能验收仍PENDING，ACTIVE后新数据归档而非反向合并。

日期：2026-10-04。状态：设计完成，**未实现、未进行覆盖安装验收，不可据此开启生产更新**。

用户已决定最终接管 `com.lightningstudio.watchrss`。本文仅设计，未修改 appId、版本、签名配置、迁移器或宿主代码；未操作设备，未读取 keystore 内容或口令。应用基线 `6b98ce1`，工作分支 `minor/takeover-design`。框架后续实现必须在框架 worktree，不能修改框架主目录。

## 1. 当前事实与接管边界

| 项目 | 代码事实与结论 |
|---|---|
| 原生身份 | `../Android_WatchRSS/app/build.gradle.kts:35-39`：`applicationId=com.lightningstudio.watchrss`，`versionCode=40`，`versionName=1.3.2-13`。40 是本地源码值，**不是已核实的全渠道最高发布值**。 |
| PodJS 身份 | `pod.config.json`：`com.lightningstudio.watchrss.podjs`，code 1，name `0.1.0-dev`。本设计不改变现有并存测试包。 |
| 原生库 | `data/AppContainer.kt` 打开 `watchrss.db`；`data/db/WatchRssDatabase.kt` / [迁移契约](migration-contract.md) 为 Room v18，共 15 张业务表。不能让 PodJS schema 在原库上运行。 |
| PodJS 存储 | 宿主 `PodServices.java` 打开 `databases/podjs.sqlite`；`PodRuntimeView.java` 的数据根为 `files/podjs`，Rust `crates/podjs-runtime/src/kv.rs` 使用 `podjs-kv.json`（4 MiB 配额）；`PodDeviceServices.java` 使用 `files/podjs/secure.store`、Keystore alias `podjs.secure.v1`；文件服务根为 `files/podjs/files`。 |
| 构建 | 框架 `packages/cli/src/cli.ts` 的 `build` 只打 JS/PAK/manifest；`packageTarget` 传 `podAppId/podVersionName/podVersionCode`，执行 `assembleDebug`、`bundleRelease` 等。`platforms/android/app/build.gradle.kts` 接收这些属性，但当前没有接入原生 release signingConfig。普通 build 成功不等于已生成可覆盖的 release APK。 |
| 既有工作 | 基线提交 `87a5022` 含离线迁移；[native-v18-staging](native-v18-staging.md) 末尾记录独立 PodJS 包的数据启用、6006 篇文章及文件验证，并仍保留真实手机同步/最终画面验收缺口。不能将文档早期“未启用”段落当作最终状态，也不能把历史启用等同于同包首启迁移。 |
| 更新 | C5 `289aa4c` 实现 `UpdatePort` / `AppUpdateService`，`e0090ec` 接入 UI；`src/announcement/host.ts` 的 inspect/install/progress 能力仍为 false；`VERSION_ANNOUNCEMENTS_ENABLED=false`。用户的接管决策只解除包名决策阻塞，未解除能力与验收阻塞。 |

原生源码路径以下以 `../Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/` 为根；宿主路径以 `/home/wilf/data/PodJS/podjs-watch/` 为只读参考根。

同包更新才能沿用原生沙箱；从 `.podjs` 改名不会自动搬运这个独立包的数据。如果用户同时拥有两包且都产生新数据，必须先单独设计经过确认的导出/合并流程，不能以目录复制覆盖任一方。本方案默认源为原生包，目标同包沙箱中尚无已启用的 PodJS 用户代际；发现已有目标数据就进入冲突处理，不能默认为空库。

## 2. 签名、版本与 release 流水线

`/home/wilf/data/OPPO_Develop/release.jks` 已仅通过存在性检查确认。本任务没有打开它，没有读取或打印密钥、alias、口令，也没有执行签名命令。

覆盖包必须使用**与实际原生已发布 APK 相同的签名证书**。不在首次接管中引入证书轮换；debug 证书和上传证书不能被当作原生安装证书。Android 官方说明见 [应用签名](https://developer.android.com/studio/publish/app-signing)。

拟接入步骤（全部为后续工作）：

1. 固定 app/framework/PocketJS 修订，建立独立 takeover-release 配置，appId 为原生包名。既有 `.podjs` 测试配置继续用于隔离验证。Manifest 的 provider authority、回调 URI、组件声明、权限及调试标记与最终包名一起检查，不能只改 JSON。
2. release 版本分配器从发布台账获得最高已发布 code，结合原生源码与接管渠道台账计算 `newCode > max(nativePublished, takeoverPublished, nativeSource)`。若目前最高确为 40，则最低候选为 41；**未核实发布台账前不锁定 41**。预留后续前向修复/原生救援包 code，并为灰度候选与救援包分别分配单调递增值。
3. 在框架 worktree 给 Android app 模块接入 release signingConfig；CI 从受限凭据存储注入签名材料位置及所需凭据，不写入仓库、PodJS manifest、JS、报告、命令回显或缓存。缺凭据即失败，不回退 debug 签名。此处只规定同证书约束，不提供或推测任何凭据值。
4. 先按锁定版本构建 JS/PAK，再构建最终 `:androidApp:assembleRelease` APK；若渠道需要 AAB，另做 bundle，不把 AAB 当作应用内下载 APK。确认 `debuggable=false`，宿主 `application.buildInfo().debugBuild=false`；debug-only 功能继续以宿主标记门控。
5. 用产物公开证书指纹与可信历史 release APK 对照，验证签名、包名、code、minSdk/ABI、资源、宿主 capability 和文件 SHA-256。从 APK 读实际版本，不能只信 PodJS 配置。上传原子发布清单：channel、package、versionCode、versionName、size、hash、证书摘要、最低宿主/迁移版本、灰度范围。
6. 通过下面的数据迁移及安装验收后才将清单发布给接管灰度。仅持有 `release.jks` 文件不证明它和所有历史渠道签名一致；各渠道签名、实际最高 code、商店代签情况均待确认。

## 3. 首启迁移协议：原数据始终保留

### 3.1 启动时序与持久状态

需要新增 Android 宿主迁移协调器，在创建 PodJS SQLite/KV、默认预设、设备身份、账号刷新、遥测上传和所有后台同步之前运行。Manifest 入口/后台服务/进程必须共用锁和门控；不能只在 UI 的 StartupGate 后补迁移。当前宿主尚无此协调器。

拟在 `files/package-takeover/` 建立私有 journal 和代际目录（新路径，尚未实现），记录：协议版本、转换器版本、源 schema/完整快照摘要、目标 schema、migrationId、阶段、分页游标、逐表计数/摘要、逐文件完成标记、必要 store 状态、验证回执、激活代际。migrationId 由源快照与转换器版本确定；日志不能包含账号、正文、URL、密钥或用户设置值。

状态机：

`DETECTED → SNAPSHOTTED → COPYING → VERIFYING → READY → ACTIVATING → ACTIVE`

任一步异常转 `PAUSED(reason, resumePhase)`，保留已完成批次；检测到不支持版本/目标冲突则 `BLOCKED`。首次无原生数据才进入独立的新装流程；源损坏不能冒充新装。

- `DETECTED`：确认运行包、原生库存在、v18/schema、源 store 清单、目标冲突、可用空间与解锁状态。空间估算包含一致性快照、暂存库、复制资源、保留数据及安全余量；不足时显示所需空间，不清理原生文件腾空间。
- `SNAPSHOTTED`：所有原生写入者已经停止，迁移宿主不启动旧组件。对包含 WAL 的库用可证明一致性的 SQLite 备份/受控快照，不能仅复制主 db 或对带 WAL 数据使用忽略日志的 immutable 读取。不为迁移修改/checkpoint 原始库；在副本完成恢复和检查。未知表列、Room 元数据、preferences、完整/不完整文件原样保留在源清单与可恢复副本中；Keystore 密钥不能以文件备份替代。
- `COPYING`：从固定快照按稳定主键分页转换；每批写入和游标更新在目标 SQLite 同一事务。不能依赖 offset 面对可变源。KV 构建为独立候选文件；敏感值在宿主内解密、重加密到候选 secure store。文件写 `.part`，校验后 rename；源文件只复制，不 hard-link 到后续可修改的目标。
- `VERIFYING`：通过生产读取器读回，比较逐表主键/行数/正文摘要/空值/墓碑/时间/排序/文件引用；目标 `quick_check`、`foreign_key_check`；KV 的 4 MiB 配额和 schema；secure store 只报告存在与语义校验结果，不输出值或秘密摘要。阻断性缺失不允许激活；原本缺失且可重新获取的媒体记录可带明确降级状态保留。
- `READY/ACTIVATING`：数据库、KV、secure、文件是一组，不可依次覆盖固定路径后立即启动。推荐新增宿主“活动代际”指针：所有存储读取器解析同一指针，候选文件落盘并同步后原子替换指针，指针记录摘要和代际。**当前固定路径宿主不具备此能力，需后续实现并测试**。如果选固定路径方案，必须有全局门控及逐步发布恢复日志，在崩溃恢复完成前拒绝一切服务；不能宣称多个 rename 是跨文件事务。
- `ACTIVE`：读回指针及回执后才开放同步/编辑/遥测。重复启动只验证已提交状态；不得再次把旧快照覆盖到用户新写入的数据。启动默认数据初始化只能作用于真正缺失的字段。

每次恢复先检查源快照/转换器版本/游标校验，不一致时另建候选代际并保留旧候选。重复批次以源主键和摘要去重，相同值跳过，冲突失败；不向生产变更日志重复发出同步事件。任务取消只是暂停；重启会继续或显示恢复页。源和回退基线不设置自动过期删除，清理需单独取得用户授权。

### 3.2 Room v18 逐表映射

实现基准：`scripts/migration/stage_native_v18.py`、`stage_reader_presets.py`、`src/core/schema.ts`、`src/notes/repository.ts`、`src/reader/preset-store.ts`。Python 工具只支持离线空目标、拒绝覆盖输出，**不能直接充当 Android 可续跑迁移器**。

| 原生业务表 | PodJS 目标 | 保留/转换规则与验证 |
|---|---|---|
| `rss_channels` | `channels`、`source_preferences`、`source_media_preferences` | 保留 id、URL、标题描述图片、抓取/创建时间、排序/置顶；拆出 useOriginalContent、continuePlaybackInBackground，readPreset 的缺省遵循既有转换器。 |
| `rss_items` | `articles`、`article_previews`、`article_original_chunks/meta`、`article_reading_state`、`article_native_sync_hash` | 主键、channelId、去重标识、正文/原文引用、预览/总结、已读、阅读进度/字节位置/内容哈希/changedAt 保留；5486 个非空 syncBodyHash 的历史迁移只是已验证样本数，不是算法常量。正文标记解析后必须关联文件；派生分块/metadata hash 按实际正文重建，保留源字段副本用于核对。 |
| `saved_entries` | `article_saved_states`、`article_saved_entry_times` | FAVORITE/WATCH_LATER 映射为 favorite/watchLater，原始创建时间单独存储，排序按既有降序到升序转换规则逐列表核对；不要依据 rss_items.isLiked 覆盖实际保存表状态。 |
| `offline_media` | `offline_media` | 保留 id/itemId/mediaType/originUrl/createdAt，localPath 转安全 relative_path；既存缺失文件保留失败/重试语义，不能伪造下载成功。 |
| `saved_sync_states` | `sync_saved_states`、`sync_article_ids`、`sync_article_aliases`、`sync_article_deletions`，并补本地保存状态 | 分离保存状态与文章删除墓碑，保留 articleId/sourceDeviceId/changedAt/sortOrder；已不存在文章的引用转 NULL，不能丢同步状态。历史别名按转换器规则绑定，冲突不得重绑身份。 |
| `rss_source_sync_states` | `sync_source_states` | URL/设备身份、创建更新与删除时间、排序、置顶、nullable site/image 保留。 |
| `sync_change_log` | `sync_change_log` | 保留 seq、kind、entityId、origin、reason、所有时间，维护自增序列后续高于已导入最大值；导入自身不重复产生日志。 |
| `sync_peer_state` | `sync_peer_state` | peer ID、两个序列游标、lastFullSyncAt、protocolVersion、updatedAt 原样对应；不得以“现在”重置游标。 |
| `reader_presets` | KV `watchrss.reader-presets.records` | 保留 payloadJson、id/name/updatedAt/modifiedBy/deleted，包括暂不可解码记录；生产解码失败显式列出，不能删记录。 |
| `reader_font_assets` | 同一 KV `assets.fonts` + 文件 | 保留所有 catalog 字段、哈希/长度/faceCount/metadata/tombstone；验证启用字体可加载。 |
| `reader_background_assets` | 同一 KV `assets.backgrounds` + 文件 | 保留 master、variantsJson、posterAssetId、类型/尺寸/时长/哈希与删除态；variant 和主文件分别校验。 |
| `reader_deletions` | 同一 KV `assets.deletions` | kind/entityId/deletedAt/deletedBy，不能过滤 tombstone。 |
| `watch_notes` | `memo_notes` | 全字段映射，保留 noteId/folderId、markdown/plainText、contentHash/baseContentHash/baseMarkdown、pin、作者及删除时间；正文与资产引用联合验证。 |
| `watch_note_folders` | `memo_folders` | folderId/name/sortOrder/updatedAt/modifiedBy/deleted/deletedAt 全保留；孤立关联显式报告。 |
| `llm_token_usage` | `llm_token_usage` | id/provider/model/requestId/createdAt 保留，各 nullable token 字段按既有规则组合 usage_json，经生产读取器逐字段读回，NULL 不能改成 0。 |

`sync_local_identity` 从 `watch_device_identity.device_id` 导入；source_order/device_order 使用既有编码规则。`article_sync_content`、编码缓存、快照指纹/修订、清理队列等 PodJS 派生表根据新 schema 初始化/重建，不能从未知旧值盲拷。正文大库缓存允许激活后按需重建，但首次对外同步前必须获得一致清单，不能先 ACK 再补数据。任何未列出的源表/列保留在快照并列为未知项；影响用户语义的未知项阻断发布。

### 3.3 DataStore / SharedPreferences 逐 store 处理

实际 `AppContainer.kt` 给 `preferencesDataStoreFile` 传入已含扩展名的名称；历史快照实际为 `files/datastore/settings.preferences_pb.preferences_pb`。迁移应按目录清单及版本匹配确认，不能仅硬编码契约中的简称。`bili_cache` 同样需要检测实际生成路径。

| 原生 store/键 | 目标与策略 |
|---|---|
| settings DataStore：reading_font_size_sp、reader_auto_scroll_enabled/lines_per_second | `watchrss.settings.fontSizeSp/readerAutoStart/readerScrollSpeed`，按类型、合法范围校验。 |
| 同 store：cache_limit_bytes、rss_inline_image_prefetch_mode | cacheLimitMb（精确换算，非整 MiB/不支持值不得静默取整）、mediaCacheMode（0/1/2 对应关闭/前4项/全部）。 |
| 同 store：media_volume_control_enabled、media_volume_guard_enabled、media_playback_start_volume_limit_percent、sync_media_keep_alive_enabled、share_use_system | `watchrss.settings` 对应 mediaVolumeControl/mediaVolumeGuard/playbackStartVolumeLimit/syncMediaKeepAlive/shareUseSystem，保留缺失与 null 语义。 |
| 同 store：llm_enabled/auto_summarize/show_token_usage/prompt_preset | `watchrss.settings.llmEnabled/llmAutoSummarize/llmShowTokenUsage/llmPromptPreset`，prompt preset 原生索引 +1；原值超范围阻断该字段激活。 |
| 同 store：llm_provider/model/base_url/system_prompt | 拟新增/完善 LLM 配置适配器；现有 stage_settings 未覆盖，不能只导入开关就报告 LLM 迁完。目标键和最终消费路径待实现核对，先保留源值在私有隔离区。 |
| 同 store：tts_engine/model/voice_id/speed/base_url | `watchrss.tts.config.v1` 与 settings.speechRate；engine 按 `TtsConfigStore` 枚举转换并联合 secret 验证，不支持 provider 标为需重新配置。 |
| 同 store：oobe_seen_version/privacy_policy_agreed_version | `watchrss.onboarding` 两版本逐值导入；不提升用户同意版本，不在迁移中自动点击同意；版本不足进入真实引导。既有 stage_kv_merge 为已完成 PodJS 引导的并存场景，本次不能机械照搬。 |
| 同 store：reading_theme_dark、phone_connection_enabled、temp_original_mode_hint_* | theme 优先 reader_preset_state，仅缺省时用旧 theme；phone connection 启停需接启动策略，现有离线脚本未迁；提示计数属于临时态，可不激活但保留源并登记。 |
| bili_cache DataStore | bili_feed_cache_json/at → `watchrss.bili.feed-cache.v1`；bili_search_history → `watchrss.bili.search-history.v1`；bili_local_interaction_state_json → `watchrss.bili.interactions.v1`；bili_local_playback_progress_json → `watchrss.bili.playback-progress.v1`。按 `src/bili/browse.ts/detail.ts/playback.ts` DTO 转换，不把原 JSON 直接塞入；过期 feed 可失效，搜索/操作/进度不得作为缓存丢弃。 |
| `reader_preset_state` | active/light/dark preset、darkFollowsLight、theme mode、schedule mode/light/dark minutes、经纬度及更新时间 → `watchrss.reader-presets.selection/schedule`，按 stage_reader_presets。位置不进入报告。 |
| `home_entry_placement` | notes_sort_order/notes_pinned → `watchrss.home.notes-sort-order` / `watchrss.home.notes-pinned`。 |
| `app_resume_state.intent_uri` | 仅允许已支持的原生 Activity/参数转为 `watchrss.resume-state.v1`；无法对应则安全回首页并保留源，不执行原始 Intent URI。恢复页的文章/笔记必须存在。 |
| `douyin_watch_history` | watched_ids/history_json → `douyin.watched.v1` / `douyin.history.v1`，字段与毫秒时间转换，经 `src/douyin/client.ts` 读回。 |
| `douyin_recent_window` / `douyin_feed_cache` | recent_window_json/feed_cache_json → `douyin.recent-window.v1` / `douyin.feed.v1`，按 `feed-store.ts` DTO，保留顺序/游标；失效播放 URL 重新解析，不伪造新播放队列。 |
| `watchrss_announcement` / `watchrss_push` | dismissed_version → `announcement.dismissed_version`；last_seen_notification_id → `announcement.last_seen_notification_id`；禁止因重跑再弹已读推送。 |
| `watch_device_identity` | device_id → SQLite `sync_local_identity`；禁止首启先生成新身份再导入，否则可能污染同步/云端。 |
| `watchrss_installation_identity` | install_id → `watchrss.telemetry.install-id`；first_installed_at 暂无对应已证实消费键，拟保留在迁移元数据并补适配，不能当本次安装时间。与账号里的手机 installId 分开。 |
| `watchrss_daily_telemetry` / `watchrss_download_telemetry` | days/day_* → `watchrss.sync.account-telemetry.v1` 日汇总结构；release_oobe_recorded → `watchrss.telemetry.release-oobe-recorded` 字符串语义。只迁一次，不重播事件/再次计数，按原日界线/保留规则处理，发送前才恢复调度。 |
| `watchrss_cloud_state` | 以 user/device 绑定的游标/快照状态保留；当前目标适配与消费键待确认。与云密钥/缓存一起校验，未满足则禁用云功能并保留数据，不重新登记为空身份。 |
| WebView `web_view_scale_mode` | 原生 Activity 偏好作用域须与具体文件清单核对，目标宿主浏览器缩放适配待定；暂不应用但保留并报告，不能声称完整视觉恢复。 |
| 未列出的偏好、平台登录/cookie、WebView 数据 | 首启清单全量登记后分类，不能仅覆盖历史样本的 8 个 settings 键。Bili/Douyin 登录态不能从 feed/history 推定；确认原生登录存储和目标 secure/cookie 格式前视为未迁移，允许用户重新登录但不能静默清原数据。 |

上表表示目标设计，不表示这些适配器都存在。每个 store 输出 `migrated / absent / retained-unsupported / needs-reauth / failed`，附版本、键数和原因；发布门槛必须逐项处理，不能把 retained-unsupported 计为迁移成功。

### 3.4 加密账号和秘密

源代码：`WatchAccountStore.kt` 的 `watchrss_account_state/state_json`；`LlmApiKeyStore.kt` 的 `llm_secure_prefs/llm_api_key`；`TtsApiKeyStore.kt` 的 `tts_secure_prefs/tts_api_key_<provider>`；`WatchCloudKeyManager.kt` 的 `watchrss_cloud_keys` 与 `watchrss_cloud_ecdh_<hash>` alias。

与历史异包离线复制不同，同包覆盖为复用原 UID 下的 Keystore 提供条件，但**不保证密钥未失效或可导出**。必须由兼容原加密参数的宿主读取旧 store，在内存中解析，重加密到 PodJS secure store，并用生产消费者读回。账号目标为 `WatchAccountStore` 使用的 `state_json`；TTS 目标为 `watchrss.tts.api-key.<engine>`；LLM secret 目标消费接口待补，不发明一个无人读取的 KV。证书/UID/解锁/历史加密配置仍需真机升级证明，见 [Android Keystore](https://developer.android.com/privacy-and-security/keystore)。

特别禁止调用原生 `WatchAccountStore.withPrefsLocked()` 的自修复分支：它在 recoverable crypto failure 时删除 SharedPreferences 和默认 MasterKey alias。迁移器应有独立只读打开路径，先确认 alias 存在，不因缺 alias 新建同名钥匙，不删除、重置或覆盖任何原密文/alias。

云 ECDH 私钥可能不可导出，不能复制 alias 字符串就视为完成；优先宿主兼容使用旧 alias，与已保存 publicKey/deviceId 一起验证。不可用时进入重新绑定流程并保留旧加密快照，不生成新密钥覆盖后再声称能读旧云备份。

未解锁可暂停重试；密钥损坏/永久失效则账号标为需手机 `syncAccount` 重新下发，LLM/TTS 标为待重新配置。该降级需在迁移摘要明确显示并取得用户选择，不能自动退为游客并报“全部完成”。原账号刷新 token 可能单次轮换：在建立回退策略前不刷新源 token；激活后的 token 轮换会使原生救援需重新授权，这也是回退限制。

### 3.5 文件及资产

| 源文件 | 目标与验收 |
|---|---|
| `files/article_content/`，正文 `watchrss-watch-content:` 引用 | 复制到目标文件根内对应 `article_content/` 相对路径；保持标记及正文哈希语义，逐引用验证存在性、长度、摘要，并经文章读取器读取。 |
| `files/offline/rss/`（`RssOfflineStore.OFFLINE_ROOT_DIR_NAME`）及 offline_media.localPath | 按 `stage_native_files.py` / 数据库转换白名单映射到 PodJS 文件根的受限相对路径；原绝对路径只在受限源根内解析。 |
| `files/reader_assets/fonts`、`backgrounds`、`variants` | 映射同相对目录；catalog、font face、主背景、watch variant 分别验证。历史样本曾有主背景缺失但 watch variant 有效，允许显示既有 variant，不承诺可重建主资源。 |
| `files/notes/assets` | → `files/podjs/files/notes/assets`（候选代际内同结构），匹配 `src/sync/note-assets.ts`；校验 Markdown 引用、资源名/长度/摘要，关联跨笔记共享资源；缺图保留原文和失败 UI。 |
| `files/watch-cloud-cache` | 私有保留；只有 snapshot ID、清单、分块摘要和密钥身份均一致才适配激活。否则不作为可用快照，源不删除。 |
| Bili preview、导入文本/日志/其他 files/cache | 首启逐目录清单，按是否用户内容分类；导入文本等用户资产必须映射或阻断，播放预加载/临时图片可按规则重新获取，用户日志保留但不自动上传。 |
| `.part`、临时下载、未知路径 | 不当完整资源发布，不跟随符号链接或 `..`/绝对路径穿越；保留源状态和缺失报告。 |

不能重演历史 Android tar 长文件名截断：设备内逐文件流式复制并校验，不新增整份 userdata tar。本任务也不访问历史私有快照。文件目标重名时仅在内容摘要一致时复用，不一致就失败/另建代际；不得覆盖旧目标用户文件。

## 4. packageUpdate 宿主能力：七点设计与 UI 门槛

C5 原报告当前已被后续轮次 report 覆盖，现存 `.codex-tmp` 和提交未找到七点原文；以下依据 C5 提交 `289aa4c` 的接口、注释及测试重建为七点设计，**不声称逐字还原原报告**。原文恢复后需对照差异，但不会将下面的新增要求当成已有实现。

1. **能力声明与可信运行身份**：拟新增 `packageUpdate` 宿主服务与独立 capability/version（最终名称由框架定），查询 download/progress/inspect/install/permission/recovery 的实际支持，以及运行包名、安装 code、签名摘要。默认不授权 guest 任意包安装；目标只能是宿主自身包。JS 配置与实际宿主身份不符直接拒绝。当前 `UpdatePort` 只有四个布尔能力，需要扩展。
2. **可取消的受限下载与进度**：HTTPS、重定向每跳检查、有限超时/大小/磁盘预算；宿主生成私有 updateId 和文件，guest 不提供任意路径。发送单调 bytesRead，未知总量显示已下载大小，不虚构百分比。终止后丢弃迟到回调。现有 64 MiB 上限须用真实 release 体积校准，不能下载到一半才发现所有正式 APK 都超限。支持失败后用户重试；断点下载若采用必须验证 ETag/Range 和最终完整哈希。
3. **APK 内容、版本和签名验证**：完整下载后解析 APK，拒绝 HTML/损坏文件/错误包名/不兼容 SDK ABI/非预期 split；校验发布清单 size/hash、包名、实际 longVersionCode 严格大于已安装 code、有效 APK 签名与同一证书。证书 metadata 解析不等于 APK 签名验证，二者均需验证，Android 安装器最终校验仍不能省略。当前 `ApkInspection` 仅 packageName，必须扩展。UI versionName 比较仅用于展示，不能作为安全版本门槛。
4. **系统授权与安装器**：宿主检查安装来源权限，以明确用户操作拉起系统授权/安装流程；使用仅暴露该候选文件的只读 content URI 或 PackageInstaller session，不暴露沙箱根、不静默安装、不引导卸载旧包。权限拒绝/缺安装器/OEM 禁止均返回明确状态；在实际交给安装器前再次验证候选与运行身份。系统可能要求用户操作，见 [PackageInstaller](https://developer.android.com/reference/android/content/pm/PackageInstaller)。
5. **持久安装状态与生命周期**：持久化 updateId、已验证文件摘要、预期版本、sessionId（适用时）、权限/安装状态；重启重新查询宿主版本及 session 结果。`installer-launched` 仅表示已发起，不是成功。新增 awaiting-user/installed/cancelled/failed/restart-reconcile 等状态；只有安装结果及重启后版本吻合才报更新成功，首启迁移成功另报，不能混为一步。
6. **重校验、清理和重试边界**：验证后文件冻结，拒绝符号链接/路径替换；以受控 FD/session 固定字节防 TOCTOU。取消/失败清理仅此次下载候选，活跃 session 不提前删文件；清理失败展示可重试状态，限额回收僵尸候选，不删原生数据、迁移快照、任意 cache 或 Keystore。并发点击只共享同一操作，不开多个安装器。
7. **错误契约、回退与可验证性**：结构化区分网络/空间/权限/包名/签名/版本/安装取消/系统拒绝/迁移失败；公开日志仅含错误码、版本、阶段与非敏感摘要。失败后旧应用在 APK 未替换时继续可用；替换完成但迁移失败进入恢复页，按第五节救援策略处理。针对全部分支做宿主测试和真实系统安装验收，不能用假 UpdatePort 的单测代替。

启用应用内版本公告必须同时满足：

- 生产接管包名/同证书/递增版本/分发清单确定；原生→PodJS 由原生现有更新入口或正式渠道交付，`.podjs` 内的 updater 不能更新另一个包。
- 宿主七点能力实现、实际声明与完整安装验证通过，应用 `createHostUpdatePort` 已接入；C5 的 inspect/install false、仅完成时上报进度被真正替换。
- 迁移预检/首启恢复/空间不足/Keystore 降级与回退演练通过；没有未处置的用户数据丢失项。
- `VERSION_ANNOUNCEMENTS_ENABLED` 仅在通过验收的渠道构建启用，并有服务端可撤回开关；服务器不可向未支持的老宿主推强制更新弹窗。
- 强制更新只作用于已具备可执行安装链路的候选。下载失败、权限拒绝和迁移恢复必须保留可达操作，不出现不可完成的强制弹窗循环。推送消息和版本公告的开关、已读状态继续分开。

## 5. 分阶段上线、验收与回滚

| 阶段 | 交付及进入下一阶段的证据 |
|---|---|
| P1 当前设计 | 本文、未知项、report；不改变正式包、开关或数据，完成设计不代表迁移完成。 |
| P2 离线实现/合成夹具 | 在 app/framework 各自 worktree 实现协调器和适配器；v18 15 表、所有 store、空库/未知版本/脏 WAL/缺文件/冲突目标/大库；每批和激活各边界模拟进程终止、断电式截断、空间不足、重复首启。源摘要不变、目标读回一致、恢复不重计数/不重复同步。 |
| P3 隔离安装验收 | 专用夹具包构造“原生旧 APK→同测试证书 PodJS 新 APK”，验证签名拒绝/低版本拒绝/安装取消、权限变化、重启后状态、Keystore 同 UID 延续、全部目标读取器。只用隔离数据，不能覆盖用户正式包作为首次实验。 |
| P4 小范围真实 release 灰度 | 已核验签名且同包的 release 升级，由授权设备操作人员和自愿用户执行；保留恢复基线、前向救援包，逐设备记录 APK 摘要/code、源/目标计数及迁移耗时/空间；验收字体/背景/笔记资产、收藏稍后读顺序/阅读位置、账号令牌刷新与权益、v14/v13 手机真实同步、墓碑不复活、用户物理交互。 |
| P5 分批扩大 | 建议人工名单→1%→10%→50%→全量，每阶段至少观察一个完整使用/同步周期并审核失败分布。比例/周期是建议，样本量与观察时长需负责人定；任一原数据破坏、无法恢复、错签名安装或数据错绑即停止扩量，不用总体成功率掩盖个案。 |
| P6 清理与长期支持 | 稳定期后另行征求用户同意清理旧源；明确保留期限和空间提示。未确认前继续保留，提供受控备份/导出；不要因升级次数自动删除最后恢复点。 |

验收记录分三层：实现/离线、宿主真实安装、用户功能/画面/物理操作；每项单列 PASS/FAIL/PENDING。历史 59 文件/6006 文章样本可作基准之一，不代表所有用户 store 均覆盖，也不能替代本次 release 路径证据。

回滚必须区分：

- **尚未替换 APK**：撤下灰度清单/关闭公告，取消候选；旧 APK 和旧数据继续工作。
- **已替换、未 ACTIVE**：原生源仍未改写，修复版可续跑；若需要回原生，发布同证书、同包且 code 高于当前接管版的“原生救援包”，读取保留的原生数据。不能假设系统允许直接安装旧低 code APK，也不能要求卸载再安装。救援包必须提前演练并防止旧清理逻辑删 PodJS 代际。
- **ACTIVE 后有新增数据**：切回原生快照会丢弃迁移后的写入，不能自动执行。默认优先前向修复 PodJS；保留新代际/增量。真正回原生必须先做经过验证的反向转换或手机合并/导出，解决笔记冲突、阅读状态、删除墓碑和账号刷新后的凭据，再由用户确认切换。当前无通用反向转换器，不能承诺无损回退。
- 同包无法并存两套 APK；服务端关开关只能阻止新的接管，不能把已安装的 PodJS 自动变回原生。文件副本也不能备份不可导出的 Keystore 私钥；解密失败后的回退可能仍需重新登录。

## 6. 风险与待确认清单

| 风险/未知项 | 缓解与放行要求 |
|---|---|
| 本地 code 40 与渠道实际最高值/签名不一致 | 负责人提供发布台账和可信已发布 APK；只验证公开签名摘要，不读取私钥。 |
| C5 七点原报告不在当前报告中 | 本文已用提交代码重建设计；找回原报告时逐条核对，未声称完全一致。 |
| 固定路径的 SQLite/KV/secure/file 无跨介质原子性 | 先实现全入口 gate 与代际指针，完成每一步崩溃演练，再允许覆盖 release。 |
| 原生账号失败自清理、Keystore 失效、token 轮换 | 独立只读兼容适配器，不复用 reset 分支；宿主读回及重新授权流程；灰度前实际覆盖安装测试。 |
| LLM 配置、phone connection、云状态、first_installed_at、WebView 与平台登录未完整适配 | 清单中保留并显式标 unknown/unsupported；确定目标消费者和用户降级流程，否则不能称全量无损迁移。 |
| 非 v18、未来 schema、未识别 store | fail closed，保留数据，独立开发版本迁移；不得 destructive migration。 |
| 大库、双份资源、KV 4 MiB、低电量/进程回收 | 预估空间、分页与阶段耗时、持久游标；运行预算和供电提示依据后续设备测量，不用现有离线用时承诺首启时延。 |
| 笔记/离线资源缺失或长文件名截断 | 逐文件校验，原状态保留，缺失分类；不依赖 tar，不把 `.part` 当资源。 |
| 两个包已各有用户数据 | 不能自动读取/合并异 UID 沙箱；先设计明确导出/冲突协议，接管不清除 `.podjs`。 |
| ABI/SDK、provider authority、通知/存储/安装权限与 OEM 安装器差异 | 检查最终 Manifest 和 APK，在目标系统逐项验证；PackageInstaller API 可用不等于 OEM UX 通过。 |
| 遥测/同步先于迁移初始化 | app 与所有宿主后台服务统一启动门控；既有源设备身份在首次对外请求前就绪。 |
| 回退后丢新增数据、旧 token 不再有效 | 前向修复优先，保留 ACTIVE 后数据，反向转换/合并待实现；不作自动无损回滚承诺。 |

本轮仅做源码/历史文档/平台文档核对。未读取真实用户数据库或密文，未操作设备，所有新迁移与 packageUpdate 的实现、签名验证、覆盖安装和回滚证据均为 **PENDING**。
