# WatchRSS → PodJS 功能对齐差距审计（任务 1A-2）

> 审计日期：2026-10-04  
> 审计范围：文章阅读、阅读预设、设置与账号、备忘录（仅高影响缺口）。  
> 证据规则：以当前 `Android_WatchRSS` 原生源码与 `PodJS_WatchRSS/src/` 为依据；`parity-gap-audit-a.md` 仅用于格式参考，不沿用旧文档结论。原生路径除特别说明外相对于 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/`。  
> 状态含义：**已实现**＝PodJS 已有可达的对应产品路径；**部分实现**＝已有基础能力但关键交互、持久化或协议语义不完整；**缺失**＝当前 `src/` 未找到对应产品路径。工作量为补齐当前差距的粗估：S（小）、M（中）、L（大）。  
> 本任务仅静态源码审计，不跑测试、不构建、不安装；`adb devices` 无设备，真机交互、视觉与互通验证为 PENDING。已实现不代表验收通过。

## 3. 文章阅读

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 正文分块排版、标题与图片/视频入口、RSS/原文切换、离线媒体失败重试 | **已实现** | 原生 `ui/screen/rss/DetailScreen.kt:144-210`；PodJS `src/ui/ReaderScreen.tsx`、`src/ui/ReaderBody.tsx`、`src/reader/original-cache.ts`、`src/reader/offline-media.ts` | 高 | S |
| 阅读位置持久化、正文字符锚点与导入长文分块恢复，布局变化保持阅读位置 | **已实现**：已有保存/恢复路径；退出落盘保证另列 | 原生 `ui/screen/rss/DetailScreen.kt:316-338,796-844`；PodJS `src/ui/ReaderBody.tsx`、`src/reader/progress.ts`、`src/reader/sql-progress.ts`、`src/reader/imported-document.ts` | 高 | S |
| 返回或进入后台时确保最后阅读进度写入完成 | **部分实现**：PodJS 每秒、失活和清理时触发保存，但用 `void store.save`，返回栈不等待写入；原生返回及生命周期保存使用 `runBlocking`，进程紧接退出时的最后进度保证不同 | 原生 `ui/screen/rss/DetailScreen.kt:1026-1055`；PodJS `src/ui/ReaderBody.tsx`、`src/ui/screen.tsx`、`src/reader/sql-progress.ts` | 中 | M |
| 收藏、稍后再看、分享及取消；读到底后返回稍后再看列表时自动移除 | **已实现** | 原生 `ItemActionsActivity.kt:55-110`、`DetailActivity.kt:119-135`；PodJS `src/ui/RssScreens.tsx`、`src/ui/ReaderScreen.tsx`、`src/ui/screen.tsx`、`src/reader/watch-later-completion.ts` | 高 | S |
| 本地导入内容的单篇删除及确认，并从后续同步中移除 | **缺失**：PodJS 条目操作只有收藏、稍后再看、分享、取消；清空频道不能代替单篇删除 | 原生 `ItemActionsActivity.kt:98-129`、`ui/viewmodel/ItemActionsViewModel.kt:30-53`；PodJS `src/ui/RssScreens.tsx`、`src/ui/screen.tsx` | 高 | M |
| 图片单击退出、双击缩放、双指缩放/平移/惯性、横向边界与返回手势仲裁、缺图提示 | **已实现（源码级）**：手势常数及物理体验仍需设备验收 | 原生 `ImagePreviewActivity.kt:18-46`、`ui/screen/rss/ImagePreviewScreen.kt:65-73,198-225,266-379`；PodJS `src/ui/ImagePreviewScreen.tsx`、`src/ui/image-preview.ts`、`src/ui/TiledImage.tsx` | 高 | S |
| RSS 媒体解析后播放、暂停/快进快退、旋转缩放、滚轮音量、防误触与开播音量上限、按频道后台续播、失败重试/浏览器打开 | **已实现（源码级）** | 原生 `RssPlayerActivity.kt:49-89`（复用 BiliPlayerScreen）；PodJS `src/ui/screen.tsx`、`src/ui/VideoPlayerScreen.tsx`、`src/media/start-volume.ts` | 高 | S |
| RSS 内抖音媒体播放失败后重新解析有效播放地址 | **部分实现**：首次打开会解析抖音地址；播放器“重试”只重新 prepare 原 source，没有回调重新 resolvePlayback，过期地址会重复失败 | 原生 `RssPlayerActivity.kt:69-70`、`ui/viewmodel/RssPlayerViewModel.kt:119-137`；PodJS `src/ui/screen.tsx`、`src/ui/VideoPlayerScreen.tsx` | 高 | M |
| 大声朗读、长按指定位置朗读、逐段高亮与跟随、暂停/继续/停止、上一篇/下一篇、自动连播和语速调整 | **已实现（源码级）** | 原生 `DetailActivity.kt:163-190`、`ReadAloudPlaybackActivity.kt:29-43`；PodJS `src/ui/ReaderBody.tsx`、`src/ui/SpeechPlaybackScreen.tsx`、`src/reader/speech-playback.ts`、`src/reader/speech-highlight.ts` | 高 | S |
| 朗读播控的“返回文章”与“查看当前文章”两种入口语义 | **部分实现**：从文章进入后的返回已实现；PodJS 固定 `popPage()`，没有原生非文章入口按当前朗读 article.id 打开文章的分支（与首页朗读入口缺口相关） | 原生 `ReadAloudPlaybackActivity.kt:45-61`；PodJS `src/ui/SpeechPlaybackScreen.tsx`、`src/ui/screen.tsx` | 中 | S |
| 自动滚动控制：阅读会话播放/暂停、返回文章、自动开始开关、0.5–10 行/秒调速与持久化；手动滚动/后台暂停 | **已实现** | 原生 `AutoScrollControlActivity.kt:25-69`、`ui/screen/rss/DetailScreen.kt:215-218`；PodJS `src/ui/AutoScrollSettingsScreen.tsx`、`src/ui/ReaderBody.tsx`、`src/reader/autoscroll.ts`、`src/settings/store.ts` | 高 | S |

本区域结论：核心阅读与媒体交互已有对应路径；优先补单篇导入内容删除和 RSS 抖音播放地址失效恢复。阅读位置退出持久化保证、非文章入口的“查看当前文章”需要进一步对齐。AI 总结集中列入设置与账号区域。

## 4. 阅读预设

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 深色/浅色/自动主题、浅色与深色预设选择、深色跟随浅色、展示当前预设与手机下载引导 | **已实现** | 原生 `ReaderPresetActivity.kt:140-215,299-348`；PodJS `src/ui/ReaderPresetScreen.tsx`、`src/reader/preset-store.ts`、`src/ui/screen.tsx` | 高 | S |
| 自动主题固定时间切换、时间选择器、按当前位置日出日落切换、定位权限/失败提示 | **已实现（源码级）**：通过宿主 location/timeInput 接口接入，真机定位未验证 | 原生 `ReaderPresetActivity.kt:101-134,220-289,380-427`；PodJS `src/ui/ReaderPresetScreen.tsx`、`src/reader/theme-schedule.ts`、`src/reader/preset-store.ts` | 中 | S |
| 预设选择菜单中以该预设的真实正文样式和背景展示单行预览 | **部分实现**：PodJS 菜单仅用字号映射的内置字体、文字颜色和纯色背景；没有使用该预设的字体资源、完整正文样式或图片/视频背景 | 原生 `ReaderPresetActivity.kt:352-375`；PodJS `src/ui/ReaderPresetScreen.tsx`（menuItems/render）、`src/ui/ReaderBackground.tsx` | 中 | M |
| 预设记录、字体/背景资源同步与选择持久化，实际阅读应用对应字体和背景 | **已实现（源码级）**：不据此声称手机互通或所有字体视觉一致 | 原生 `data/reader/ReaderPresetRepository.kt:123-175,330-380`、`ReaderPresetActivity.kt:200-211`；PodJS `src/reader/preset-store.ts`、`src/reader/font-assets.ts`、`src/reader/background-assets.ts`、`src/sync/reader-actions.ts`、`src/sync/reader-resources.ts`、`src/ui/ReaderBody.tsx`、`src/ui/ReaderScreen.tsx` | 高 | S |
| 手机实时预览会话：完整更新/增量、序号去重、心跳、停止、20 秒超时、33ms 合并发布、资源传输延长至 120 秒 | **已实现（源码级）** | 原生 `data/reader/WatchReaderPresetPreviewSession.kt:37-173`；PodJS `src/reader/preview-session.ts`、`src/sync/reader-preview.ts`、`src/sync/application-actions.ts` | 高 | S |
| 独立预览页展示多种文本角色及背景，资源传输时保留旧画面、结束/超时退出、可见期间保持亮屏；预览不覆盖正式预设 | **已实现（源码级）** | 原生 `ReaderPresetPreviewActivity.kt:74-138,169-211`；PodJS `src/ui/ReaderPreviewScreen.tsx`、`src/reader/preview-host.ts`、`src/ui/screen.tsx`、`src/reader/preview-session.ts` | 高 | S |

本区域结论：预设选择、定时主题和手机实时预览均已有源码路径；明确差距在选择菜单的缩略预览未使用完整预设渲染。独立预览页已有系统排版/栅格接口，不能把菜单差距扩大为整个预览能力缺失。

## 5. 设置与账号

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 设置入口：阅读预设、朗读、自动滚动、手机输入、高级、备案，及账号具备条件时显示 AI 选项 | **已实现** | 原生 `SettingsActivity.kt:33-58,78-86`、`ui/screen/rss/SettingsScreen.kt:94-177`；PodJS `src/ui/SettingsScreen.tsx`、`src/ui/screen.tsx` | 高 | S |
| 字号选项调整与持久化 | **已实现（设置层）**：已有可写设置；实际正文主要使用预设字号，不能仅由设置值变化判定所有正文生效或视觉一致 | 原生 `ui/viewmodel/SettingsViewModel.kt:36-38,101-105`、`data/settings/SettingsRepository.kt:151-153`；PodJS `src/ui/SettingsScreen.tsx`、`src/settings/store.ts`、`src/ui/screen.tsx` | 中 | S |
| 滚轮音量开关、防干扰、静音开播音量上限及播放器接线 | **已实现（源码级）** | 原生 `ui/settings/MainSettingsCatalog.kt:19-31`、`RssPlayerActivity.kt:49-89`；PodJS `src/ui/media-volume-settings.tsx`、`src/ui/VideoPlayerScreen.tsx`、`src/ui/SpeechPlaybackScreen.tsx`、`src/media/start-volume.ts` | 高 | S |
| 高级设置：缓存用量和上限、正文图片预取档位、同步无声音频保活、按设备能力显示系统分享开关 | **已实现（源码级）**：设置已接入缓存维护、正文预取和同步运行时；熄屏保活效果未验证 | 原生 `AdvancedSettingsActivity.kt:22-32`、`ui/screen/rss/SettingsScreen.kt:199-230,705-718`；PodJS `src/ui/advanced-cache-settings.tsx`、`src/ui/SettingsScreen.tsx`、`src/ui/screen.tsx`、`src/main.tsx`、`src/cache/managed.ts` | 高 | S |
| 正式版朗读语速页、手机扫码配置语音源/API Key 并保存配置 | **已实现（源码级）**：有独立语速存储与配置传输；本任务未试听 | 原生 `TtsSettingsActivity.kt:25-37`、`ui/screen/rss/TtsSettingsScreen.kt:99-109,285-295`；PodJS `src/ui/SettingsScreen.tsx`、`src/ui/TtsConfigScreen.tsx`、`src/tts/config-store.ts`、`src/tts/config-http.ts`、`src/tts/speech-port.ts` | 高 | S |
| debug 版手表端详细 TTS 配置：选择引擎、本地/后端默认、状态信息与连通性测试 | **缺失（仅 debug 能力）**：PodJS 手表 UI 只有语速和手机配置入口；已有配置数据和合成能力不能代替详细设置/测试界面 | 原生 `ui/screen/rss/TtsSettingsScreen.kt:113-278,341-342`、`ui/viewmodel/TtsSettingsViewModel.kt:104-149,238-283`；PodJS `src/ui/SettingsScreen.tsx`、`src/ui/TtsConfigScreen.tsx` | 低 | M |
| debug 设置内重新进入新手引导及大列表/大文章性能工具入口 | **缺失（仅 debug 能力）**：PodJS 设置未提供这些入口；不是正式版主流程缺口 | 原生 `SettingsActivity.kt:59-76`、`ui/screen/rss/SettingsScreen.kt:538-550,657-684`；PodJS `src/ui/SettingsScreen.tsx`、`src/ui/screen.tsx` | 低 | S |
| AI 总结启用/自动总结、四种提示词名称和说明、选中状态与持久化 | **已实现** | 原生 `LlmPromptPresetActivity.kt:23-33`、`ui/viewmodel/LlmSummaryViewModel.kt:63-71`；PodJS `src/ui/LlmPromptPresetScreen.tsx`、`src/ui/SettingsScreen.tsx`、`src/settings/store.ts` | 中 | S |
| AI 总结等待原文、正文截取与清理、调用后端默认模型、授权刷新重试、失败重试与消耗记录 | **已实现（源码级）**：PodJS 通过阅读页内联卡片展示总结；不因没有同名 Activity 判定整个总结功能缺失 | 原生 `DetailActivity.kt:151-161`、`ui/viewmodel/LlmSummaryViewModel.kt:126-204,227-311`；PodJS `src/ui/ReaderScreen.tsx`、`src/llm/source.ts`、`src/llm/summary.ts`、`src/llm/runtime.ts` | 高 | S |
| 总结结果按“显示 Token 用量”设置展示本次输入/输出/总 Token；完整错误原因可回看 | **部分实现**：PodJS 有开关和 SummaryState 计数，但阅读页不接收/读取 llmShowTokenUsage，也不渲染计数；错误原因只短暂 toast，卡片固定“总结失败，点击重试” | 原生 `LlmSummaryActivity.kt:31-37`、`ui/screen/rss/LlmSummaryScreen.kt:163-185,214-276`；PodJS `src/ui/SettingsScreen.tsx`、`src/ui/ReaderScreen.tsx`、`src/llm/summary.ts` | 中 | M |
| Token 消耗统计：累计、近 7 天、供应商/模型、最近 200 条、图表和二次确认清空 | **已实现** | 原生 `LlmTokenUsageActivity.kt:22-27`、`ui/viewmodel/LlmTokenUsageViewModel.kt:20-39`、`ui/screen/rss/LlmTokenUsageScreen.kt:121-154`；PodJS `src/ui/LlmUsageScreen.tsx`、`src/llm/usage.ts` | 中 | S |
| Token 统计页面打开期间随新增消耗自动更新 | **部分实现**：原生订阅数据库 Flow；PodJS 进入时抓取快照，清空后重载，没有消耗变更订阅 | 原生 `ui/viewmodel/LlmTokenUsageViewModel.kt:20-34`；PodJS `src/ui/LlmUsageScreen.tsx`、`src/llm/usage.ts` | 低 | S |
| 个人页账号、收藏、稍后再看、连接手机、设置、关于、联系开发者与备案导航 | **已实现** | 原生 `ProfileActivity.kt:17-62`；PodJS `src/ui/ProfileScreen.tsx`、`src/ui/screen.tsx` | 高 | S |
| 账号未绑定引导、脱敏手机号、会员方案/有效状态、诊断开关状态、Access/Refresh Token 状态及重新进入读取 | **已实现** | 原生 `AccountStatusActivity.kt:31-51,79-110`；PodJS `src/ui/AccountStatusScreen.tsx`、`src/account/status.ts`、`src/account/store.ts`、`src/ui/screen.tsx` | 高 | S |
| 账号页展示会员云中继状态、已用/总空间、首次手机批准说明，以及非会员云存储说明 | **缺失（账号页）**：PodJS 账号页止于 Token 状态，没有接入云中继状态和配额；不能由此推断所有云 API 都缺失 | 原生 `AccountStatusActivity.kt:111-131`；PodJS `src/ui/AccountStatusScreen.tsx`、`src/account/status.ts`、`src/cloud/client.ts` | 中 | M |

本区域结论：主要设置和账号基础状态已有接线。明确未完成的是总结页 Token 开关的消费端、账号页云状态，以及仅限 debug 的详细 TTS/工具入口；统计页还有实时刷新差异。字号和朗读语速的端到端实际效果仍须单独验收，不能以保存成功替代。

## 6. 备忘录（仅高影响缺口）

| 具体功能点 | 状态 | 当前源码证据（原生 → PodJS） | 用户影响 | 补齐工作量 |
|---|---|---|---|---|
| 已有笔记的草稿保存，在原记录被同步删除/不存在时保持记录身份和基线语义 | **部分实现**：普通自动保存、关闭前等待保存、后台保存都存在；但 PodJS `save` 用仅查未删除记录的 `get` 取得 old，若编辑中同步收到删除墓碑，后续保存会报“笔记不存在”；关闭编辑又必须先 flush 成功，当前 UI 没有另存或冲突恢复出口，未保存草稿无法正常提交并退出。原生 `dao.get` 包含墓碑，保存沿用原 ID/元数据并恢复记录；ID 真正不存在时双方都会报错。风险是远端删除与本地编辑交错时阻塞草稿保存，不是静默新建副本 | 原生 `data/note/WatchNoteDao.kt:17-21`、`data/note/WatchNoteRepository.kt:24-54`、`NotesActivity.kt:777-815`；PodJS `src/notes/repository.ts`（get/save）、`src/notes/draft-autosave.ts`、`src/ui/NotesScreen.tsx`（编辑期间跳过 refreshKey 重载） | 高 | M |

本区域结论：本次静态比对确认上述一个高影响边界缺口，尚未通过运行复现。已检查列表/置顶/移动/删除、原始文本编辑及撤销重做、草稿串行保存、缺图及图片预览、笔记合并路径；不重复列已有功能或低影响视觉差异，也不据此宣称备忘录全面对齐。

## 建议增量（按优先级）

1. **导入文章单篇删除（M）**：补条目操作按钮与确认，串通本地正文/分块/资源清理和同步删除语义；保证普通 RSS 文章不误显示入口。
2. **备忘录保存身份边界（M）**：明确已有 ID、墓碑和真正不存在记录的区别，对齐原生保存行为，避免墓碑导致草稿无法保存/关闭，保留文件夹、置顶与 base 字段；后续验证编辑中远端删除及保存交错场景。
3. **RSS 抖音媒体错误恢复（M）**：播放器错误/重试接回地址解析，使用新地址重建播放源；验证过期 URL、重新解析失败和后台续播设置。
4. **补齐已有设置和返回入口的展示行为（M）**：接通总结 Token 展示与持久错误说明、账号云状态/配额，并在补首页朗读入口时实现“查看当前文章”；预设菜单的完整样式预览和退出进度写入保证作为后续独立增量。
