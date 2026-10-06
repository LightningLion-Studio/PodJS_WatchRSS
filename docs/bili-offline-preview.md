# M3：B站保存预览与离线回退

## 原生核对

参考只读工作区 `Android_WatchRSS`（HEAD `734121c`；工作区有其他任务的未提交改动）。

- `BiliVideoActionsActivity.kt:194` 的 `persistLocalSaved`：远端收藏/稍后看成功后，先写统一保存记录，再调用 `cachePreviewClip`，下载结果不影响保存成功。
- `ui/viewmodel/BiliDetailViewModel.kt:267` 的 `syncLocalSaved`：保存时下载，取消保存时清理对应视频/CID。`updatePreviewCache=false` 的路径不触发下载。
- `data/bili/BiliRepository.kt:60`、`:634`、`:683`：保存预览 `qn=32`、最多 **30 分钟**；只取首个 MP4 durl。请求字节数是 `max(1, size * min(1800000, lengthMs) / lengthMs)`，Range 从 0 到字节数减 1。没有固定单片字节上限；也没有转封装或精确按帧截断。另一个详情预热路径是 60 秒（C07，不在 M3 范围）。
- 文件位于 `filesDir/offline/bili/<bvid或avID>_<CID或0>_q32.mp4`；`.tmp` 成功后改名。非空文件被复用，读取时更新时间。取消对应保存、退出账号、删除频道会清理预览；成功写入安排 managed cache 维护，按设置中的全局缓存上限、BILI_PREVIEW 桶顺序和修改时间淘汰。
- `cachedPreviewUri` / `cachedPreviewUriAny`（`:606`、`:618`）提供确切 CID / 同视频最近片段的 file URI。然而当前参考树的 `BiliPlayerViewModel.resolvePlaybackAttempt` **只构造 REMOTE**，全树未找到这两个 getter 的播放器调用点。因此 C05/任务中“原生播放失败或离线已回退”的描述不能作为当前源码或设备事实。M3 按明确任务要求实现这一回退行为，不声称与未验证的原生运行时等价。

## PodJS 实现

`src/bili/preview.ts` 是应用级预览队列，`preview-host.ts` 使用现有宿主能力；没有 framework 改动。

- `media-services.ts` 的 `onSaved` 先完成已有统一 SQL 保存/同步，再异步入队；取消保存撤销对应任务/索引/片段。失败只记录不含 URL/Cookie 的日志，不回滚已经成功的保存。
- 单 worker，最多 8 个不同目标；同目标共享任务。每次任务最多 3 次尝试，250/500ms 可取消等待；下载和等待均可取消。不会启动无限后台重试。缺 CID 与原生一样不下载。
- 同一 qn32/30分钟字节估算，1MiB Range 分块，最多 64KiB 文件读写；Cookie/Referer 来自当前账号。严格检查 206、Content-Range、字节数及强 ETag；仅完整且一次可下载的小文件允许 200。忽略部分 Range 不会变成整片下载。
- `.part` 的完整分块边界写入 `watchrss.bili.preview.v1`；强 ETag + 同源 URL/大小/时长摘要 + 文件长度匹配才续传。跨进程可在重新入队时续传。没有强验证器、URL/元数据变化、部分 append 中断、断点文件被淘汰时从 0 重启。索引最多 200 项，失效文件在重新入队/查询时剔除；达到仍有效的索引上限时拒绝新增，不静默遗失旧条目。重启不自动重排失败/未开始的任务。
- 写入 `managed-cache/bili-preview/<目标SHA256>.mp4.part`，完成后 hash + `file.commit` 原子提交到 `.mp4`。索引只把完整提交的文件暴露给播放器；校验目标和文件的摘要对应关系/实际大小，拒绝畸形或过期索引。
- ManagedCache 计入 `.mp4/.part/.chunk`，下载中 pin 自己文件；取消/完成后解除 pin 并维护。单片目标超过当前设置中的缓存上限时拒绝；同桶原有淘汰优先级保持。退出账号、删除频道以及已有清理路径会先取消队列/清索引，再清桶，不允许迟到下载复活文件。
- 原文/RSS 模式详情按钮均交由播放 controller 解析，不在 UI 提前截断离线链。保存列表中无 CID 的旧链接在详情请求失败时用同视频最近缓存的 CID。
- 初次远端解析失败/地址为空时使用本地；播放错误依次尝试已知 MP4/DASH 候选、一次重新解析、一次本地候选。失败过的本地片段不会自动循环。本地候选清空 Cookie、DASH audio/video 字段，传相对文件路径；现有 Android `PodVideoServices.sourceValue` 在 app root 内校验后转为 file URI。
- 预览从 0 播放，预览的 tick/ready/error/ended 不改整片 resume 和远端历史，也不会把预览结束当作整片看完。手动重新打开播放页会创建新的恢复预算。

## 验证边界与 lead 接手

本地 loopback Range 测试用确定性二进制数据验证字节与协议；它不是解码器或真实 B站 MP4 可播放性证明。生产 controller/MediaRoutes 与两种真实详情组件的隔离测试验证入口、故障回调、候选字段与进度隔离。框架全量测试包含实际 JVM HTTP/file 夹具；CLI 构建只证明打包。

设备 **PENDING**：M3 不使用 adb、不安装、不操作真实账号。请 lead 安排已授权隔离账号/媒体夹具，验证 qn32 MP4 的 moov/前缀可播放性、在线保存后断网播放、坏源/坏文件有限回退、分P/旧无CID链接、下载中清桶/退出/降低缓存上限、重建后的断点与整片进度保留。

没有改文案或样式；lead 如需下载状态、手动重试、队列满/容量不足提示或取消按钮，可围绕 `enqueue(...).result/cancel()` 另行接 UI。本任务没有增加这些控件。
