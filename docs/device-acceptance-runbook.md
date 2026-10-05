# OWW242 首轮设备验收工具包（D1）

基线：应用 master `8445a96`（Q1），设备 OWW242 / `e3aca8af`。本轮只有离线工具验证，**所有设备项 PENDING**。本文件是 `acceptance.md` 的执行手册，不替代其 release gate。先记录应用/原生/framework HEAD、APK SHA256、设备系统/密度/字体倍率、日期与测试数据集。M5、I1 在此基线尚未合入；后续合入后再执行对应项。

## 最短执行顺序

在应用 worktree 根目录执行，Python 3、ADB、Android SDK apkanalyzer、Pillow（比较）、Java/Gradle/NDK（测试编译）需可用。框架预构建 JNI 必须与 framework lock 一致；不要复用来历不明的旧 APK。

```sh
D=scripts/device/acceptance.py
E=artifacts/device-acceptance/round-001
# 任意命令末尾加 --dry-run：只显示计划，不访问设备、不创建目录。
$D upgrade --apk /absolute/path/watchrss.apk --out "$E/upgrade" --dry-run
# 接入设备后先检查授权；不轮询等待。
adb devices -l
# 正式包升级，不清数据、不卸载；失败立即停止，不自动重装。
$D upgrade --apk /absolute/path/watchrss.apk --out "$E/upgrade"
$D cold-start --out "$E/launch"
$D logs --label launch --out "$E/launch"
# 先按 lead brief 打包 app，确保 dist 是当前源码。
bun /home/wilf/data/PodJS/podjs-watch/packages/cli/src/cli.ts build --target=android-watch --project="$PWD"
# 独立包 fixture；会改变独立包的测试数据。
$D routes --allow-destructive --out "$E/routes"
$D framework-tests --out "$E/framework"
```

默认 `--serial e3aca8af`，可用 `ANDROID_SERIAL` 或 `--serial` 指定。`--framework /path/to/podjs-watch` 可覆盖框架路径。测试入口构建后仅 `adb install -r`，不使用可能在收尾卸载包的 connectedAndroidTest。框架测试安装 `dev.podjs.runtime.test`；路由测试固定安装 `com.lightningstudio.watchrss.podjs.acceptance` 和其 `.test`，不允许通过参数改成正式包。运行新版本前 lead 应核对 dist 与目标源码、签名以及框架 JNI 一致。所有 worktree 默认写同一个 framework dist；设备安装前必须串行重建并记录产物 SHA256，禁止在其他 worktree 正在打包时把共享产物当作本分支版本。

单独保存 receipt：`$D digest --label before --out "$E/manual"`。停止应用后以 run-as 流式读取 databases/files/shared_prefs；需 debuggable/run-as 权限，权限不足或目录缺失时失败，不静默输出空 receipt。SQLite 及 WAL/journal 仅临时保留，用完删除；不产生 userdata tar。receipt 复用 `scripts/verification/library-data-digest.py` 的文件 SHA256 与表行排序/序列化算法，新增 integrity/package/serial，省略 archiveSha256（没有磁盘归档）。正式包安全存储的密文文件也纳入文件 hash，但 receipt 不是可恢复备份。

upgrade 在安装前用 apkanalyzer 核对包名，生成 before/after，再严格比较所有文件/表；变化以非零退出并记录 data-compare.json。此处不启动新应用，因此是**安装完整性**检查；首次启动触发迁移后，再单独 digest 并人工审阅 schema、KV、阅读进度等预期变化，不能把所有差异当作合理迁移。安装失败仍保留 before，不自动回滚/清数据。每次使用新输出目录，保留失败证据。快照使应用 force-stop，应先完成用户的保存操作。

仅当需要重置独立 fixture 时：`$D reset-isolated --package com.lightningstudio.watchrss.podjs.acceptance --allow-destructive`。正式包与原生包永远不能走此入口。不要直接运行旧 `scripts/android-smoke.sh`：其默认目标是正式包。

## 同屏原生对照与记录规范

每一区域使用相同数据、同一设备分辨率/密度、字体倍率、主题、预设、滚动偏移、网络状态；先原生后 PodJS，到同一页面/状态，等待动画结束，再分别截图。不要通过拉伸/缩放或隐藏差异降低 MAE。

```sh
# 用户实体操作停在原生页面后：
$D capture --label notes-native --out "$E/notes"
# 用户实体操作停在 PodJS 相同页面后：
$D capture --label notes-podjs --out "$E/notes"
$D compare --reference "$E/notes/notes-native.png" --actual "$E/notes/notes-podjs.png" --label notes --out "$E/notes"
```

`compare` 复用 `scripts/compare-ui.py`：输出 RGB 各通道 MAE（0..255）、差异像素比例与 bounds；尺寸不一致失败。MAE 是定位依据，不设自动 PASS 阈值。需要离线重算时直接执行 `python3 scripts/compare-ui.py native.png podjs.png`（此底层既有工具不需要设备）。若截图被充电层覆盖或黑屏，检查 capture 的 window.txt，实体关闭遮挡后重拍。既有 `tests/android/.../WatchRssSmokeTest.java` 用 PixelCopy/TextureView 保存应用图；此类图必须与同样应用窗口图比较，不能混用全屏截图。

已检查主目录 `.codex-tmp` 与 `artifacts`：前者未发现可复用 Python MAE 脚本；后者有特定备案 fixture 的 `beian-animation-final/compare-1.8.py`、`beian-native-presentation/compare-1.8.py` 等，依赖旧路径和固定布局。因此入口复用通用 `scripts/compare-ui.py`。历史 `artifacts/*-before-digest.json`、`*-after-digest.json`、`note-reader-code-data-compare.json` 可参考 receipt 结构，不能当本轮证据。`scripts/reference/compare-*.py` 是按特定场景组织的原生基线工具，复跑前审查其安装/写数据行为，禁止直接对正式包执行。

每个下表条目记录：状态 PENDING/PASS/FAIL/BLOCKED、包 HEAD/APK hash、测试输入、实际/预期、原生/PodJS PNG、MAE JSON、日志、实体操作者、未覆盖项。每一区域均要验证冷启动→入口→返回、loading/empty/error、触摸/长按/滑动/旋钮；无适用状态记 N/A 与理由。自动 fixture 不覆盖全部新路由，不等于区域 PASS。

## acceptance.md 全区域执行矩阵

“半自动”均指自动日志/截图/比较加用户实体操作；“全自动”只对指定命令/fixture 成立。请仅使用独立测试数据进行删改、退出登录、账号/网络切换和同步，正式数据变更另需用户明确授权。

| 区域 | 自动化程度与步骤 | 期望结果和原生对照状态 |
|---|---|---|
| Launch and onboarding | 半自动；独立包首次启动，逐页拒绝/同意隐私，完成 OOBE；返回/重开；阅读中退出再 cold-start；深链重进与进程结束后恢复 | 未同意不进入主界面；同意持久化；启动遮罩退出、恢复路由/阅读位置与原生一致；拍 consent/OOBE/home/恢复后各一对 |
| Home and RSS | 半自动；首页长按频道置顶/排序；添加有效/重复/畸形 RSS、Atom；推荐分组→订阅，搜索、刷新、频道详情/设置；测试频道删除及撤销，收藏/稍后读切换 | 排序、未读数、单项状态、撤销重启后正确；拍首页、频道空/错/加载、搜索、推荐、saved；routes fixture 仅自动覆盖既有首页/设置/about 返回 |
| Article reading | 半自动；同一 HTML/plain text/图片/音视频文章，选择原文，滚到中部返回/重启；长按操作、TTS 暂停/速率、自动滚动、图片缩放、媒体失败/重试 | 文本布局和 byte position 稳定，read 单调；TTS 定位/高亮、后台播放、返回一致；拍首屏/中部/图失败/播放控制；旋钮与真实音频仅人工 |
| Notes | 半自动；独立 note/folder 创建编辑、固定/排序、删除恢复；同步冲突与 tombstone 后保存草稿；markdown、表格/代码、长文、缺图→下载二维码 | 内容/版本/资产不丢，冲突可见；拍列表、编辑器焦点、表格/代码、缺图弹窗；实体滑动、输入法、旋钮需单独确认 |
| Reader customization | 半自动；新建/切换/编辑预设，预览真实行距；日夜计划，字体/背景同步；缺失/无效 asset；返回重开 | 活跃预设不被坏资源破坏；主题/尺寸/段落/预览与原生一致；拍浅/深两套正文、预览及错误 |
| Settings and profile | 半自动；修改设置后重启；TTS 与 LLM 成功/超时/失败，摘要错误重进；token usage 页面驻留并发请求；账号有效/过期 | 值持久化、用量实时、错误稳定；API key 不出现在 UI 导出/应用日志；拍设置、profile、account、summary/usage；用测试 key 审阅日志 |
| Phone connection | 半自动需配对手机；入口→蓝牙/不可用/声波说明→QR/HTTP 服务，授权/拒绝/断开重连；扫码导出收藏/稍后读/Bili 历史进度 | 能力和不可用解释准确，服务生命周期/二维码比例一致，导出内容正确且认证保护；拍连接态/QR/不可用；不把扫码可见当连接成功 |
| Bluetooth diagnostics and sync | 半自动需手机 v13/v14；见后续 transport matrix；预览 reader 连续帧、取消、超时、重连、日志拉取；replace/clear 只在独立库确认执行 | received/applied 分离、阶段/字节进度真实；恢复后去重，确认前不替换/清库；拍进度、确认、失败和最终两端状态 |
| Bilibili | 半自动需测试账号；登录/过期、推荐缓存分页/频道/搜索历史与 AV/BV 跳转；detail 分P、离线正文、评论→回复详情；播放重试、点赞/投币/收藏、历史/saved | 分P cid/位置恢复、评论分页/空错/返回，状态与原生一致；点赞/投币等有外部影响仅用户实体确认；拍 feed/detail/分P/comment/reply/player/error |
| Douyin | 半自动需测试账号；登录/二次验证/取消/禁用，频道原始模式、RSS 重解析；feed→沉浸→动作→详情/历史，切网、续播、退出重进 | 网关、codec fallback、离线预设正文、队列/位置恢复一致；拍登录两阶段/禁用/feed/detail/history/player mask；I1 合入前多实例拖动动画 BLOCKED |
| Information and support | 半自动；about→协作者/联系/加群/info/备案，滚动后返回恢复；日志隐私拒绝/同意→上传结果；打开站内浏览器、HTTP/HTTPS/无效链接并返回 | 文案/布局/二维码/无障碍标签、隐私 gate、错误可重试；未同意不上传；拍 info 滚动/备案/隐私/上传/浏览器；真实上传由用户操作 |
| Performance/debug | 半自动；确认正式导航无 debug 入口；独立包 opt-in 大列表/大文章有限时滚动，记录 gfxinfo/日志和温度体感 | 无卡死/崩溃/无界增长；与原生同数据/同操作比较帧统计；debug fixture 不代表正式持续运行性能，实体滚动仅人工 |

## 数据与行为 gates

| Gate | 具体操作与期望 | 自动化程度/证据 |
|---|---|---|
| RSS | 同源重复抓取、304、RSS/Atom/坏 XML、URL 规范化；dedupKey 去重，标题/description/content/original/link/guid/date/images/audio/video/summary 完整 | 半自动；手机/测试服务构造输入，前后 receipt+列表/正文截图 |
| Read/saved | 两端冲突 read 合并不倒退；favorite/watchLater 独立增删与 tombstone；排序/undo 重启；replace/clear 先取消再在独立库确认 | 半自动；表 hash 只能检测变化，另核对预期条目/时间戳；截图操作前后 |
| Notes/assets | 同 base version 并发编辑、modifiedBy、tombstone；asset hash/size/metadata 校验、缺图重取 | 半自动；两端版本/内容检查，缺图恢复配对截图 |
| Offline/cache | 下载后用户断网，重进；删除测试 item 后其资源释放，缓存达到边界后修剪不删活跃数据 | 半自动；资源文件 digest+离线页面/错误截图 |
| Security | 测试 key、错误 challenge/token、过期 token、HTTP 降级尝试；拒绝未经认证请求，检查加密 store 与脱敏导出 | 半自动+人工审计；不把 hash/加密文件存在视为安全证明；原始 logs 仅本地保存 |
| Cloud | DEBUG 测试配置跑 bootstrap/register/heads/reserve/complete/ack、加密 manifest/chunk，断网重试 | 半自动需服务；原生 release 取消 cloud worker 的边界见 backlog，不能把 release 无入口误报为测试通过；验收合同变更由 lead 决定 |
| Migration/release | 在复制的 v18 DB/stores 上跑 migration dry-run，核对逐表/资产/设置并再启动；手机 v13/v14 均覆盖 | 半自动；复用 scripts/migration，只传副本路径；原始 v18 不改；收齐视觉/实体证据后 lead 才能评 release |

## Transport matrix（每行记录输入、手机版本、两端应用结果）

| 测试 | 操作与期望 | 自动化程度 |
|---|---|---|
| RFCOMM/frame | 手机连接 `WatchRSS Bluetooth Sync` / `bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861`；4-byte BE+UTF8；1..2MiB 正常、0/超长/截断拒绝；16KiB chunks，进度含 prefix | 半自动手机测试 harness；连接和 UI 实体确认 |
| 协议/阶段 | v13、v14 手机分别跑 cursor→manifest→probe→articles→complete；legacy v4 单列兼容结果；v8 metadata-only/change sequence 不重复正文 | 半自动；协议日志+表/界面核验 |
| 动作全集 | ping、remoteInput、pullSavedItems、syncLibrary、clearLibrary、syncReader、previewReader、syncAccount、syncLlmTokenUsage、pullDebugLog、syncNotes、syncNoteAsset、syncSession 各发一次正常/一次无效输入 | 半自动；可复用 scripts/verification/run-*-peer.py 的协议结构，审查包/数据/连接参数后在独立环境执行 |
| 会话/恢复 | manifest batching/resource chunk ACK/forceFull；传输中取消、断开后 resume；空闲15分钟后超时；complete/abort 都关闭正确 | 半自动；需要真实时间/链路；received 不算 applied，比较最终数据 |
| 替换/清库 | merge 默认；phoneToWatchReplace/watchToPhoneReplace 各先取消，再独立库明确确认；删项/保留项核对 | 仅人工发起确认+自动 receipts；不在正式库执行 |
| IP/BLE/Wi-Fi | `_watchrss-sync._tcp.` protocol v2、WebSocket `/sync`；BLE UUID 按 `IpSyncProtocol.kt`；断蓝牙转 IP、Wi-Fi `/pullRemoteInput`/tokenized paths 与非法 token | 半自动需手机/网络；错误 endpoint 不应用数据，UI与原生配对 |

## 本轮新增功能追踪（来源 git log + lead backlog）

以下是上面矩阵的必测增量；每行独立签收，不以旧 fixture 通过替代。

| ID / 提交 | 增量测试与预期 |
|---|---|
| A1/B2/C2 `b857422` | 首页长按频道、平台统一收藏/稍后读与撤销；删除导入文章后 restart，其他频道与文件保留 |
| B1 `0954193` | 连续 previewReader 帧、probe capability 与主机实际一致、分块字节进度；断连可恢复 |
| B3 `1744667` | Bili 缓存首页→下一页→重进，搜索历史删除/AV/BV 直达、原始模式保持 |
| B4 `ba0ea98` | 分P cid/position 恢复；like/coin/fav 成功/失败；播放源重试保持位置；离线 detail |
| B5 `9e13e05` | HTTP 四类 export（收藏、稍后读、Bili 历史/进度）入口可达，返回格式/内容和授权符合原生 |
| B6 `911a56d` | 测试账号退出 Bili/Douyin，清对应凭据/缓存，其他平台和用户内容保留；无网登录提示 |
| C3 `c4cbe8d` | 沉浸入口、feed 窗口恢复、页内 actions/channel info；单播放器限制记录，拖动分页动画不可标 PASS |
| C4 `7ef2bf3` | 频道驱动原始模式和旧 KV 迁移；RSS 点击播放重新解析失效 URL |
| C5 `289aa4c` | 公告/更新请求成功失败；版本公告 flag 默认 OFF；host packageUpdate 缺失、分发 appId 差异是 BLOCKED/产品决策，不承诺自动更新 |
| C6 `03b1619` | 日志隐私页拒绝/同意、加密上传、失败/重试；M3 后核对全子系统覆盖及有界脱敏 |
| C7 `bee3e71` | 独立蓝牙连接页、不可用页入口/返回，能力说明与状态准确 |
| C8 `db75a8d` | Douyin logout 清 WebView site data；无 WebView 时不继续登录 |
| C9 `d716e07` | 从原文、支持/法律等实际调用点打开站内 WebView、加载失败/重定向/返回保留原页 |
| C10 `74447e2` | Douyin 离线 detail/阅读预设、历史队列、markWatched、切网遮罩、退出重进队列恢复 |
| C11 `bb8c0d7` | Bili 评论分页、空错、楼中楼详情返回、图标与原生同屏 MAE |
| M1 `aceee5e` | 首页朗读 card 实时频谱；播放/暂停/停止/无音频时匹配真实音频状态，不能仅看模拟条 |
| M2 `7e85fb0` | syncAccount identity/backlog 与重复同步；pullDebugLog maxChars 边界、空/大值、脱敏和截断 |
| M3 `d293e2d` | RSS/reader/sync/media/error 都产生应用日志，bounded/redacted，phone pull 与上传一致 |
| M4 `69e253f` | 登录二维码→二次验证二维码/等待/成功/取消/失败，status 更新顺序与原生一致 |
| M5 未合入此 HEAD | 合入后按实际提交核对 release usage telemetry 事件/上传/重试/禁用隐私边界；目前 PENDING，不虚构事件清单 |
| W1 `e0090ec` | log upload、BT/unavailable、HTTP export 导航，Douyin logout 回首页、home notices；版本公告 OFF 保持 |
| F1 `9506ec4` | `PodWebViewServicesTest`：availability 与 site-data 清理；实体退出后再次登录不残留测试会话 |
| F2 `4201150` | `PodSpeechSpectrumTest`：频谱事件；另用实体声音验证采样/暂停/恢复 |
| F3 `144848a` | `PodInAppBrowserTest`：站内 WebView 生命周期/返回；实体页面网络/触摸另验 |
| F4 `7956455` | `PodBrowserAuthStatusTest`：授权状态事件；真实扫码/二次验证另验 |
| F5 `3b13dd9` | `PodVideoSessionServicesTest`：显式 video session；I1 应用消费未合入，后续再验 prewarm/promote/拖动动画 |
| A5/A6/A7/A8 | `4c879b1` 启动恢复/登录卡；`454b542` 摘要错误/token/account；`82cb7ea` back/background 最终进度 flush 与行距预览；`18cc10c` info 状态/加群 a11y/QR 比例/live token/启动退出动画 |

## 结果与边界

`framework-tests` 运行五个实际 `dev.podjs.runtime.*Test` 类，保存完整 instrumentation 输出；ADB 返回0但无 `OK (...)` 或有 failure/crash 仍失败。`routes` 只跑 `WatchRssSmokeTest#launchesRendersAndInitializesChannelsDatabase` 与 `#migratedRoutesReturnToHomeRoot`。它们验证渲染/导航，不覆盖真实物理输入，也不覆盖新增平台全流程。

`logs` 抓取最近2000行 logcat、package/window/gfxinfo/getprop，不清日志、不上传。原始系统日志可能含账号或 URL，分享前人工脱敏；不能拿原始系统日志的秘密存在直接判定应用脱敏失败。

无设备下运行 `python3 scripts/device/selftest.py`，验证命令计划、无设备错误、安全拒绝、流式 receipt 算法与差异检测。工具验证 DONE 不代表设备验收完成；任何失败/缺设备/无账号/无手机都保留 PENDING/BLOCKED，不将区域标为 PASS。
