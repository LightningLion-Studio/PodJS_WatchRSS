# RSS 列表与保存操作迁移

本轮参照 `Android_WatchRSS` 的 `FeedScreen.kt`、`ItemActionsActivity.kt`、`ActionDialogScreen.kt` 和 `SavedItemsScreen.kt` 推进 RSS 主流程。

## 已实现

- RSS 列表使用独立的全屏滚动页面，18px 安全边距、6px 间距、16px 圆角、标题/摘要分区和未读圆点；支持下拉刷新当前订阅以及翻页。正文阅读后同步更新列表的已读状态与首页未读数。
- 列表长按或阅读页“操作”进入收藏、稍后再看、分享、取消菜单。操作按钮使用原生的 160×48 逻辑像素、47px 圆角、8px 间距和 17px 字号。分享使用已有二维码页面，无链接时禁用。
- RSS 稍后再看与收藏分别持久化；“我的”两个列表均查询 RSS 数据，支持分页。取消保存保留本地状态记录；重复设置相同状态保留原排序和变更时间。
- 初始化保留当前 PodJS 数据，将原来的 `is_saved` 收藏回填到新增表；不读取、修改或宣称迁移了正式原生应用的数据库。

## 验证边界

Bun 服务测试使用真实 SQLite，覆盖两个保存类型互不影响、分页排序、取消记录和重复初始化。新增 Android instrumentation 用独有测试订阅/文章验证阅读、稍后再看、取消收藏的真实应用写库路径，并只清理这些测试行。

尚未达到 RSS 全功能或画面完全一致：图片卡片、精确字体测量和标题折行、列表侧滑、保存列表拖动排序/撤销、频道信息和设置、完整阅读排版/图片/自动滚动、原生保存同步身份与变更日志均需继续迁移。当前 `article_saved_states` 是 PodJS 本地状态，不是 v14 同步协议适配。真实截图需要与相同数据的原生页面比较后才能报告视觉一致性。

## 2026-09-12 本轮结果

- 最新 TypeScript 检查、应用构建通过；Bun 90 项通过、0 失败。
- Android APK 构建成功并安装 OWW242；11 项 smoke 在系统充电窗口持有焦点时运行，多项在 TextureView 不可用/黑帧阶段失败，随后终止剩余运行。没有取得本轮 RSS 操作页有效截图，也没有取得 RSS 真机写库通过证据。
- 系统截图显示 98% 充电界面，`dumpsys window` 显示 `SysUI.Charging` 为焦点窗口。此状态不能用于判断应用视觉一致性。已请求重新插拔充电线，后续应先重跑 RSS 独立用例，再重跑完整 smoke。

最新开发包已通过 Gradle `installDebug` 安装，并启动独立应用 `com.lightningstudio.watchrss.podjs`。归档文件 `artifacts/watchrss-podjs-0.1.0-dev.apk` 的 SHA-256 为 `778becb716b802a3f82e0e65d0b2e19e08206e668703ed679d2cbebf91fc79e3`。测试/安装日志与充电窗口截图存放在 `artifacts/rss-migration-*`。

## Goal 后续推进与诊断更正

此前把黑帧 smoke 失败归因于充电界面不准确。播放器宿主会在主渲染视图之前插入一个空白 `TextureView`，旧测试选中了它。现已将 RSS 和媒体导航测试改为寻找 `PodRuntimeView`，并等待首页实际就绪。系统充电界面仍影响最终面板验收，但不妨碍独立检查应用渲染层。

进一步发现阅读页曾使用不存在的 `fontSize` 内联样式属性，导致实际打开文章时渲染抛错、停在“处理中”。已改为合法的 `fontSlot`，正文换行使用同一字库的实际测量。12/14/16/18 字号使用对应原始字库；大于 18 的设置目前通过该字库缩放实现，仍不能记作原生字体栅格一致。

本阶段同时补充：

- RSS 图片卡片：100px 最小高度、圆角裁剪、按原始宽高比居中裁切、原生配色渐变、底部标题摘要和橙色未读圆点；列表顶部 12px、间距 8px 按原生修正。
- 标题按实际字库测量，并保留首行 150px、后续 190px 的原生限宽和单字孤行平衡。受保护信息符号及完整 Unicode 排版仍未全部移植。
- 预览优先正文、60 字摘要、正文首图；事务保存预览侧表，刷新可替换旧图而保留保存状态。修复协议相对 URL 产生双冒号的问题。老数据没有预览侧表记录时使用有限正文/描述回退，完整历史预览回填仍待完成。
- 原生解码新增 `sourceWidth/sourceHeight`，避免上传纹理变为 2 的幂后丢失原始比例；保留旧调用方的默认图片行为。4 项原生图片测试在 OWW242 通过。
- 新建独立 Wear OS 466×466、320dpi 圆屏模拟器 `WatchRssPodJsMigration`，序列号 `emulator-5580`。仅在该模拟器中模拟断电，未更改真实手表的电池状态。它不能代替 OWW242 最终验收。
- 框架支持显式 `PODJS_ANDROID_ABIS=x86_64` 构建及 Gradle `-PpodAbis=x86_64`；默认仍是两个 ARM ABI。重编译暴露并修复 Android errno 与 32 位文件类型常量不匹配，两个 ARM ABI 均编译通过，Rust runtime 55 项通过。

本阶段应用 TypeScript、构建及 97 项 Bun 测试通过。模拟器实际点击“收藏列表 → 阅读 → 稍后再看 → 取消收藏”通过，SQLite 证实已读、收藏、稍后再看分别正确写入。测试仅清理独有标记的数据。

原生参考包为 `com.lightningstudio.watchrss.reference`，使用生产 `ActionDialogScreen`，未修改正式原生包的数据或源码；原生工作区构建前后 diff 指纹一致（`17fbfdbe1bae93dc9e14eee7efc81dbbc896cb0f67ae9b69a51d6ca79130027f`）。

同一模拟器的 `artifacts/reference-rss-actions.png` 与 `artifacts/podjs-rss-actions.png` 对比：7107 像素不同，占 3.2728%，平均 RGB 绝对误差 1.9562/255。包含 1 物理像素水平布局偏差和字形栅格差异，**不是逐像素一致或完整 RSS 验收**。诊断用半逻辑像素平移没有改善，已撤除。

复现可运行：

```sh
ANDROID_SERIAL=emulator-5580 PODJS_TEST_CLASS='dev.podjs.androidwatch.WatchRssSmokeTest#rssWatchLaterAndFavoriteStayIndependent' bash scripts/android-smoke.sh
ANDROID_SERIAL=e3aca8af bash scripts/android-smoke.sh
```

脚本会先重建匹配设备 ABI 的原生库及应用，避免无意复用旧预编译库；首次模拟器构建需要安装 Rust 的 `x86_64-linux-android` target。

## 朗读链路补齐（Goal 继续）

新增原生发布版对应的“朗读语速”子页，范围 0.5–2.0x、步长 0.1；旧设置升级保留原字号和其他偏好。阅读器使用该值调用宿主 TTS。原宿主要求先 `tts.init`，应用此前没有调用，因此直接朗读会失败；现在先初始化，并补 Android 11+ TTS 服务可见性声明。

长文按不超过 3000 UTF-16 单元分段，不拆代理对，上一段完成后才提交下一段。停止操作会使初始化中或后续分段失效；界面在请求开始时显示停止，完成/失败后恢复。宿主忽略已替换 utterance 的迟到回调，避免上一段回调覆盖当前播放状态；初始化失败会释放引擎，允许再次尝试。

应用侧 103 项测试、TypeScript 检查通过；框架服务协议 7 项通过。此增量仍使用系统 TTS，不等同于原生调试版的云端语音源、模型、密钥及试听配置迁移。实际声音、整篇朗读与原生音频一致性尚未验收。


最终增量验证：OWW242 全量 smoke 11/11 通过；随后强化设置路由断言，修正滚到最底部时“关于”被误记成“设置”的旧坐标，实际“设置→朗读语速→设置→首页”定向复测通过。不能把前一轮 11 项全通过解释为当时已经验证了真实设置入口。

宿主媒体测试 3/3 通过，包含初始化失败后重新尝试不会挂起。但真机两次中文初始化均返回 `tts_language_unavailable`（系统已安装 `com.yuemeng.speechsuite`），**当前设备中文朗读尚不可用**。这不属于成功发声验证，也没有播放测试音频。系统引擎适配和原生云端语音源迁移仍需继续。

最终 ARM APK：`artifacts/watchrss-podjs-0.1.0-dev.apk`，SHA-256 `ed9ae39709d7f5c49cd1584c3bb93077fa42dd8d20d1dcd34b9985c8b503e500`，与 OWW242 安装路径下 `base.apk` 实测一致。截图 `artifacts/podjs-speech-settings.png` 来自主渲染视图，不代表系统充电覆盖层上的最终面板验收。全量回归及最后定向/宿主日志见 `artifacts/rss-goal-device-smoke.log`、`artifacts/rss-goal-speech-route.log`、`artifacts/rss-goal-native-tts.log`。

后续阅读位置、自动滚动、宿主计时与最终安装包回执已移至 [阅读器迁移记录](reader-migration.md)。上文 APK 哈希为上一阶段历史包，当前包以该记录的最终回执为准。

### 2026-09-13: ordinary RSS channel details and settings

The feed title now opens channel details with its title, description, URL, update time, unread count and Settings/Search/Share/Mark read actions. Channel search passes the channel ID through the service filter; leaving search reloads the underlying channel feed. Share uses the existing QR screen. Mark read updates only that channel's article flags and visible unread count, retaining body, progress, saved states and notes.

Channel settings exposes the existing original-reading preference. It preserves the stored read preset, survives restart and is consumed by the existing reader's automatic-original path. The explanatory text accurately describes opening an article: native Android also triggers a background refresh and prefetch when the setting changes, which is **not yet implemented** here. The native media-dependent background-playback setting and local-import Clear action also remain to be migrated.

Delete requires a separate confirmation screen; cancel preserves the channel. Confirm waits for the local database operation before returning to the home root. The host enables SQLite foreign keys, so channel deletion cascades through articles, stored body/original chunks, previews, source preferences and the article-bound local saved states/notes. Unrelated channels are preserved. This is the existing PodJS local database model, not the native cross-device source tombstone/change-sequence implementation; synchronization and disk media cleanup remain outstanding.

Validation includes 132 Bun tests (18603 assertions), TypeScript and application build. The new adapter test verifies preference isolation/read-preset preservation, read-state isolation, retained saved states and notes before deletion, and local dependent-row cleanup. OWW242 instrumentation exercises the actual feed-title/details/settings route, preference persistence across activity/runtime restart, the rendered orange switch and deletion confirmation/cancel/confirm. Only uniquely seeded data is deleted, and the test restores the prior builtin-visibility setting. Native screenshot pixel parity has not been established for these screens.

Final channel settings/cancel/confirm OWW242 test passed (36s Gradle run). The rendered title centering was corrected after screenshot inspection. Archived APK SHA-256 `cf26515420f3452890f84055bfeb6e673cc5e4f73692e81635b4f30149642697` matches installed `base.apk`; evidence is `artifacts/channel-{tests,typecheck,build,device}.log` and `podjs-channel-{detail,settings,confirm}.png`. Earlier reader test receipts describe earlier builds; they were not rerun as a complete suite for this increment.

### 2026-09-13: background refresh and visible original prefetch

This supersedes the previous increment's missing-background-refresh note. Native source inspection distinguishes two operations: `ChannelDetailViewModel.setOriginalContentEnabled` schedules a channel refresh with `refreshAll=true`; `FeedScreen` requests originals only for visible article indices when scrolling has stopped. It does not download originals for the entire channel on toggle. `FeedViewModel` deduplicates article IDs and the repository pauses original updates during scrolling.

PodJS now persists the switch immediately and performs its RSS refresh asynchronously. Repeated toggles cancel superseded downloads; manual refresh joins an existing channel refresh; deletion cancels that channel's job. Completed refreshes update the local channel metadata and the active feed without reopening the screen. The settings explanation now uses the native wording, `刷新时抓取原文正文与图片`.

The feed computes actual viewport intersections, excluding renderer overscan. Only enabled, visible, not-yet-requested article IDs are sent to prefetch while the feed is active and stationary. The cache validates source membership and skips already cached articles without hydrating their HTML. Downloads share requests with foreground reading, use at most two slots, and prioritize a queued article when opened. The setting gates background work; explicit per-article reading remains available when the channel default is off. Failed empty originals remain retryable. Identity checks and conditional transaction writes prevent an old response from being stored under a deleted/recreated article ID.

Original and preview writes wait for scrolling to settle. Original HTML remains separate from RSS content. Original previews fill missing summary/image fields without replacing an existing RSS summary. Feed updates are also deferred while dragging or flinging so a returned image does not resize rows mid-gesture. Existing read/favorite/note state is unaffected. The HTTP charset handling and paged large-body reads from the prior increment are retained.

OWW242 `feedOriginalPrefetchWaitsForSettledVisibilityAndUsesBackgroundRefresh` passed: the delayed local feed refresh runs after a switch change, the hidden feed makes no original requests, exactly three initial visible articles are cached, holding a drag produces no new requests, newly visible articles are fetched after release, and all eight fixture articles remain unread. Captured cards display the original image while retaining `RSS保留摘要`. The fixture restores builtin visibility and removes only its seeded source and dependent rows. This proves the tested behavior on the physical renderer; it is not a native pixel-equivalence assertion.

The remaining full migration scope still includes native reader chrome/source-anchor/long-press behavior, reader presets, media-conditional channel settings, import-channel actions, synchronization and cache management. This increment does not implement the native neighboring-thumbnail prefetch radius or cross-device original-cache synchronization.

Original preview metadata is stored separately in `article_original_previews`. A feed refresh uses the original summary/image only when the refreshed RSS preview lacks that field, so an old RSS image is not mistaken for the canonical original image. Legacy original caches are upgraded from a bounded 16384-character first-chunk snippet without downloading or hydrating the full HTML. Regression tests cover an RSS image disappearing and legacy cache preview repair.

Final validation: 146 Bun tests (18664 assertions), TypeScript and build passed. The 17-test OWW242 suite passed before the final queue-priority/preview-metadata changes (4m38s). The final build passed three targeted OWW242 tests (1m48s), including the 540000-character original/cache flow, settings persistence and confirmation, and visible prefetch with refresh preserving original images. Post-test database checks found no orphan rows in original metadata, original chunks, original previews or feed previews. Native reference source diff fingerprint remains unchanged. Archived ARM APK SHA-256 `704ab6bfcace7031deffeced78af582e5d784316efc8d469a0e734b986a31954` matches installed `base.apk`. Logs: `artifacts/prefetch-{tests,typecheck,build,device,full-device,final-device,runtime-errors}.log`; screenshots: `podjs-prefetch-{settled,refreshed,scrolled}.png`.


### 2026-09-13: RSS enclosures and channel playback lifecycle

Native reference `ContentScreen`, `ChannelSettingsActivity`, `RssPlayerActivity` and the provider player activities distinguish RSS attachment media, provider links and per-channel background playback. The PodJS reader now appends actual image/video enclosures after parsed body blocks, deduplicates existing media, and uses the same construction for RSS and fetched-original modes. Derived feed-preview images are deliberately separate from actual attachment images. Audio enclosure metadata is retained; a complete native-equivalent audio reading interface remains outstanding.

Recognized Bilibili IDs/links resolve through the existing Bilibili metadata/player path; Douyin links resolve through the existing detail client and playback headers. Strict provider host matching excludes lookalike domains. Async navigation checks prevent a late result opening the player after leaving its originating reader. Provider parsing has fixture coverage; this increment has no new live provider playback acceptance.

Media-bearing RSS channels expose the native `在后台继续播放` setting, default off, persisted in a separate channel-bound preference table. Original-content and reader-preset preferences remain intact. Direct RSS video uses this preference and supports the existing player controls and bounded pan. The Android host pauses video on inactive lifecycle transitions, including an activity pause while its window remains visible. The TS player also suppresses its deferred explicit autoplay after preparation if the app became inactive; returning active requires a manual play. Retrying clears the previous root error banner.

The dedicated OWW242 test uses an owned, silent 320x180 H.264 fixture, first serves invalid bytes to exercise retry, then delays valid bytes while transitioning inactive during preparation. It checks paused preparation, no implicit resume, a real play-button tap, PixelCopy of the composited decoded green video, background off/on progression, player shutdown on back, and the persisted channel flag. The initial 128x64 test clip was rejected by this watch's hardware decoder; replacing that fixture does not claim a codec compatibility improvement. Fixture cleanup removes only its uniquely seeded channel and restores prior settings.

Initial dedicated test passed: background-off position 1259 to 1263 ms remained paused; background-on position 632 to 987 ms remained playing. The test now waits for the loading HUD to clear before pressing play, because native duration availability can precede JS UI readiness. Final suite and expanded/rotated pan results are recorded below when available. This does not close native pixel parity, physical user acceptance, audio playback, source sync or the remaining migration gates.

The first final 18-test run passed 17 tests and failed the unrelated memo-dialog flow. That test used generic first-bitmap readiness; it now waits for the actual home bitmap before navigating and saves its pre-add screen. Its dedicated rerun passed. The initial added pan assertion incorrectly used a rectangular crop bound of 91 dp; the native player uses the circle chord formula, yielding about 207.1 dp for this 233 dp viewport and 320x180 fixture. The corrected bound is 208 dp with rounding tolerance. These initial failed logs are retained.

Screenshot inspection identified a dark play triangle in the old reader tile. `DetailContentBlocks.kt` uses centered on-surface `PlayCircle`, size 24 dp, with a default 16:9 placeholder. The reader now uses the existing light PlayCircle asset, centers it in the media row, removes the extra caption and uses that native default aspect ratio. This is source-based alignment of the tile; native video-frame cover extraction and complete screenshot equivalence remain unverified. The corresponding layout expectation is 56.25 dp plus a 6 dp gap at 100 dp width. All 150 application tests and TypeScript pass after this correction.

Final execution evidence: all 18 OWW242 tests passed in 5m08s before the tile adjustment. The final tile build passed its complete media lifecycle/pan test in 44s; its light-icon pixel assertion passes. Installed and archived APK SHA-256 both equal `a00e4852d9136a69daf52d7ab6006d97ce73a452694b6cec48f374f67f9ac6af`. Application checks remain 150/150 and TypeScript passing. Logs are `rss-media-final-full-device.log`, `rss-media-final-tile-device.log` and `rss-media-stable-tile-device.log`.

**Correction to the initial screenshot interpretation:** the allegedly missing-header PNG and the first-open PNG are byte-for-byte identical after RGBA decoding: zero different pixels. Both contain 618 light title pixels and 552 light original-button pixels in the checked regions. The earlier preview interpretation was wrong and did not establish an application rendering defect. Evidence is `rss-media-reader-correction.json`, `podjs-rss-media-reader-first-open.png` and `podjs-rss-media-reader-second-open.png`.

All experimental renderer/cache/shader changes used during that investigation were removed. The original archived APK and the clean rebuild have identical ZIP entry contents. The strengthened instrumentation now uses actual window PixelCopy and explicit title/button pixel checks through six successive playback/background-setting cycles. It passes both on the clean build and on the original archived APK (68.705 s direct instrumentation run). Logs are `rss-media-clean-six-pass.log` and `rss-media-archived-six-pass.log`. This corrects the reported header defect; it does not claim complete native visual parity or close the remaining migration gates.

### 本地导入频道清空（2026-09-13）

- 对照原生 `ImportedContentIds.isDeletableLocalContentChannel`，仅对 import-content / import-epub 前缀及精确 phone-imports URL 显示“清空内容”。服务和仓库再次校验频道类型。
- 确认提示采用原生文案“清空后将移除这个频道内的本地条目”，按原生 466 单位尺寸移植圆形取消/删除按钮。取消保留数据，确认清空条目后仍留在频道设置。
- 取消并等待正在运行的刷新，取消原文预取，然后在同一事务内写入持久删除日志与删除文章。关联正文分块、原文缓存、预览、文章笔记和收藏状态通过外键级联清理；频道、阅读设置和其他频道条目保留。
- `local_article_deletions` 保留频道 URL、文章 URL/去重键、删除前收藏/稍后再看状态和时间，避免级联删除丢失身份。它是本地待同步日志；尚未接入原生 SavedSyncState、设备 ID、稳定文章哈希和文章 change-seq，不代表手机/云同步已完成。
- 应用测试 152/152 通过，包含普通 RSS 不受清空影响、关联缓存清理、重复清空、删除失败事务回滚、刷新取消与迟到响应不复活文章。TypeScript 检查通过。
- 构建/设备测试曾发现确认框使用了框架不支持的 `fontSize` 样式，已改为 17px 字体槽配合原点缩放；新 SVG 调整为框架要求的 32×32 资源尺寸。最终设备结果见后续记录。
- 尚未宣称整页逐像素等同原生：现有频道删除确认仍沿用旧布局，清空行的图标、整页尺寸与独立原生截图对照仍待继续；离线媒体文件回收和端到端同步也在后续验收范围内。

本批最终验证：OWW242 全量 19/19 通过（6 分 2 秒，文本换行修正之前）；修正测量字体槽后，最终清空专项通过（29 秒）。最终 PNG 的两行文本像素计数为 3260 / 1455，两侧 30px 区域无文字像素；取消与删除图标均可见。最终 APK SHA-256 `b60444262c308a6402eeb52ec1bf60afb698420824ab118712bdd814babfab2a`，与 OWW242 安装包一致。

证据：`artifacts/rss-clear-apk-receipt.json`、`rss-clear-tests.log`、`rss-clear-typecheck.log`、`rss-clear-full-device.log`、`rss-clear-wrap-device.log`、`podjs-rss-local-clear-confirm.png`、`podjs-rss-local-clear-complete.png`。旧媒体验证 APK 另存为 `watchrss-podjs-rss-media-a00e4852.apk`，不把旧版本全量结果表述为最终文字修正版的全量结果。下一步继续阅读页原生结构和频道设置/确认框细节对齐，完整迁移目标仍未达成。

### 频道设置原生布局与圆角绘制边界（2026-09-13，后续批次）

频道设置改为原生全宽 52dp 行，补齐红色删除图标、左对齐的 12sp 说明、标题与分组间距；频道删除与本地清空共用圆形确认框，取消色改为原生 surfaceVariant `#23272A`。确认框以覆盖方式显示，取消后保留底层滚动位置。

新增 `scripts/reference/capture-channel-settings.sh`，直接调用生产 Compose 的频道设置与确认组件，输出普通/本地/媒体频道设置以及两种确认框。参考包独立使用 `com.lightningstudio.watchrss.reference`，构建 release 以保证 `BuildConfig.DEBUG=false`；原生 `WatchSurface` 的渐变仅在 DEBUG 开启，不能据调试截图要求迁入发布界面。原生仓库已有源代码差异保持不变。

第一轮三个设备专项均通过。对照原始截图后还发现开关超出预期尺寸。直接读取设备资源确认 density=2.0，进一步在框架圆角快速路径中复现了半整数拐角分别取整导致的越界：13×13 圆形会画到第14列；30×17 胶囊也会越过底边。修复将拐角及中间填充带都按共享端点量化，保持宽高边界。新增边界测试覆盖两档栅格密度及圆形、横向和纵向胶囊，修复前确实失败；修复后框架 146 项测试通过。

最终设备结果及截图差异记录见后续记录。尚未声明逐像素相同：框架整数逻辑坐标及字形/矢量栅格化仍可能留下 1px 边界和抗锯齿差异。

本批最终验证：框架 146/146、应用 152/152、OWW242 全量 19/19 通过（6分7秒）。设备新增检查验证开关轨道回到 60px，圆钮不再越出取整后的26px边界。实际 PNG 测得轨道60×34、圆钮26×26；原生分别60×35、25×25。框架整数逻辑坐标造成的这一级尺寸差异仍保留，不能说完全相同。设置行仍比原生低1px；5页平均RGB绝对误差为1.156—5.729/255，包含文字和矢量边缘差异。

最终 APK SHA-256 `c725f493658d307b7f4ca6bee2f5e9d6f8e8f42476e2e29ef5118617c54afc1a`，与手表实际安装包相同。证据为 `artifacts/channel-settings-apk-receipt.json`、`channel-reference-release-receipt.json`、`channel-settings-native-comparison.json`、`channel-rounded-full-device.log`、`rounded-core-tests.log`、`rounded-odd-before.log`。可在 `artifacts/channel-settings-comparison.html` 拖动分界线逐页查看原始对照。
