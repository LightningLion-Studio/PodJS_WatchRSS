# R2 平台说明 UI 复核

基线：应用 `master=4920c7b`，工作树 `PodJS_WatchRSS.wt-impl`，分支 `impl/notice-review`。原生依据为 [M1 审计及带行号的源码附录](native-upstream-m1.md) 中的 `origin/main=e0936f16`；未更改原生或框架。R2 只修输入/生命周期接线，没有改变颜色、尺寸、字体、文字或标签位置。

## 时机、顺序和状态

| 项目 | 复核结果 / 证据 |
| --- | --- |
| Home 公告／推送优先 | `screen.tsx:485` 的 `homeNoticeVisible` 同时检查公告和消息；`homeDisclosure.pending(true)` 暂不显示初次说明。公告/消息消失后显示初次说明。组件测试分别覆盖公告和 push。 |
| 版本公告分发策略 | `announcement/home.ts` 的 `VERSION_ANNOUNCEMENTS_ENABLED=false` 未改。测试公告场景只替换 `loadHomeNotices` 的返回边界，不假装生产目前启用版本公告。 |
| 首次持久确认 | `announcement/platform.ts:3` 使用 KV `watchrss.transparency.initial_app_disclosure_v1`；只有初次确认写 true。默认 `entryDisclosure` 使用实际 KV，组件测试确认后销毁/重新创建 WatchRSS，说明不再显示。 |
| Bili/Douyin 初次进入 | `routes/media.tsx:85` 仅 entry 触发；未确认初次说明时先“我已了解”，再“知道了，继续”；标题同为“使用前说明”，正文不同。两个平台都用真实 MediaRoutes/PendingDisclosure 测试。 |
| 每个新入口再次确认 | `entry-disclosure.ts` 的 WeakMap 按 RouteEntry 对象保留 session；平台确认不写 KV。离开入口回 Home，再打开新的入口对象，平台确认再次出现。 |
| 子页返回 | 子页使用独立 RouteEntry，入口对象留在栈内；返回原对象复用已确认 session，不再次弹出。组件测试实际打开 channel-info，并经 BackMotion 返回。 |
| Back / 横向返回 | 原 `internalBack` 虽最终阻止 pop，但系统 Back 先启动动画。本次在 `screen.tsx:1273` 提前吞掉 pending disclosure 的系统 Back，并从横向手势 region 排除该状态。入口测试在连续 5 帧检查偏移始终为 0。 |
| 后台输入 | 原 HomeRoutes 丢失 active，HomeScreen 无 active 参数；Bili entry 列表/侧菜单未使用 active。本次补 active→inputActive 接线；媒体确认只在 owner 当前 active 时挂载。Home 说明/公告/push 显示时真实 HomeScreen 列表 inputActive=false。 |
| 焦点及表冠 | 说明容器复用框架现有 FocusScope，将方向键焦点限制在说明内部。说明列表暴露 ref，screen 的表冠回调优先送该列表，关闭后清理引用；Home 远程公告显示时不滚动后台 Home。测试检查确认按钮获得焦点、表冠送说明列表且 Home 无滚动。 |

原生 SharedPreferences `watchrss_transparency/initial_app_disclosure_v1` 与 PodJS KV 是不同存储。R2 证明 PodJS 自身持久化，未证明接管安装保留原生这项确认；当前应用平台说明代码没有原生该 prefs 的读取。若接管要求不重弹，需要单独检查迁移映射。这不是账户授权或隐私协议同意状态。

异步远程公告尚未返回时，初次说明可能先显示；返回后按优先级隐藏。这里与现有异步加载流程一致，R2 没有引入“先等网络才能进入”的新规则。尚未做设备首帧检查。

## 文案逐字

离线脚本将 `announcement/platform.ts` 的实际导出数据与 M1 附录 `ThirdPartyPlatformNotice.kt` 字符串比较：**28 处标题、段落及确认按钮文案精确匹配**（包括两平台展开和完整非 compact 标签）。证据：`.codex-tmp/wrss-impl-r2-copy.json` 与 `wrss-impl-r2-copy.log`。

- 初次说明：标题 + 5 段 + “我已了解”，与原生一致。
- 两平台确认：各标题 + 2 段 + “知道了，继续”，与原生一致；PodJS 分两段 row，原生两段以双换行分隔，属于排版差异。
- compact 标签：保留前两项标题/说明；不渲染完整标签的付费关系第三段，符合原生 `compact=true`。
- 范围卡：标题 + 3 段，包含“需要手机版设备授权”的中文引号、`¥6` 和分号，均一致。
- 授权边界卡：标题 + 2 段，`WatchRSS` 无多余空格，均一致。
- 两频道信息标题分别为“腕上RSS · 哔哩哔哩频道”和“腕上RSS · 抖音频道”；账号页顺序为 Bili 标签、Douyin 标签、手机版设备授权包卡。

## 尺寸、颜色和字体

下列是源码参数复核，不是截图或像素级验收。

| 元素 | 原生记录 | PodJS 结果 |
| --- | --- | --- |
| compact 标签 | 12dp 圆角；horizontal10/vertical6；gap2；标题9/11、SemiBold；描述12/14、居中 | `PlatformNotice.tsx:25` 参数相同；标题使用字体 slot24/`font-bold`，描述 slot0。 |
| 标签颜色 | surfaceVariant `#23272A` × .72；前景 `#F5F5F5` / `#B6B6B6` | `#23272ab8`（184/255）及前景相同；alpha 是 8bit 量化。 |
| scope/access 卡 | 12dp 圆角；padding10×8；gap3；标题14/17、SemiBold；正文9/11 | `PlatformNotice.tsx:35` 参数一致；标题 `font-bold`，正文 slot19。 |
| 卡片颜色 | surfaceVariant `#23272A` × .46 | `#23272a75`（117/255），符合 8bit 量化。 |
| 标题字重 | 原生 SemiBold，并使用 watch_sans 字体声明 | PodJS 二值 regular/bold atlas；配置 bold 字体为 reader_default_bold.ttf，不能声称字体/字形逐像素一致。本任务未改字体资源。 |
| 说明 dialog | Material3 AlertDialog；首次 text 列间10dp；主题正文14/17、`#F5F5F5`；primary `#FF6026` | 全屏纯黑；18dp 水平/40dp 垂直安全区；标题18/23 bold；正文14/20；gap10；橙底、黑字17/23、高48、宽≤160 的确认 pill。 |
| 原生 dialog 默认尺寸 | 源码未固定 dialog width/shape/title/button dp | 不虚构 Material3 数值。PodJS dialog 结构/行高/按钮样式与原生默认不同，属于 lead 的圆屏设计；纯黑符合用户 UI 规则。 |
| 外层常驻标签位置 | 通常外层 padding8×4，置于 Column 顶部，下部 weight(1) | 应用 list 多为18/22dp padding、8dp gap；标签和卡随内容滚动。这不是固定顶部标签的几何等价实现。 |

## 有意偏差与建议

| 偏差 | 评估 | 建议 |
| --- | --- | --- |
| 标签在标题下／操作按钮后 | 圆屏可读性与既有按钮布局可以保留；但按钮后标签会晚于操作进入视野，滚动后标签也消失，不满足原生“常驻顶部”的严格含义。 | 可作为明确的设计豁免；lead 若要求严格常驻，统一在页面内容外提供固定区域，并做设备尺寸验收。R2 不移动标签。 |
| Bili 扫码登录不加标签 | QR 需要安全尺寸，可理解布局原因；原生 BiliLoginActivity 有 compact 标签，当前页面无法独立说明非官方关系。 | 不作为原生 parity 已完成项。由 lead 选择不挤压 QR 的提示入口或固定说明，再验收可扫性。 |
| 抖音沉浸入口不加标签 | 入口确认提供一次性提醒，但默认 originalContentEnabled=true 的 ImmersiveEntry 在确认后没有持久关系说明。 | 推荐至少在沉浸流的标题/入口页放 compact 标签，保留视频页的沉浸布局；需要 lead 设计。 |
| OOBE 不单独首次弹窗 | OOBE 的网络/协议流程不操作第三方平台，之后 Home/entry 会拦截；在这个前提下可以接受延后。 | 明确记录为豁免；如果今后 OOBE 可直接进入第三方功能，应在该功能之前确认。不得把平台说明当作隐私协议或 telemetry consent。 |

## 另外发现的覆盖缺口

1. 原生 BiliEntryActivity 的顶部标签包住导航图，因此搜索、历史、收藏、详情等子页也保留标签；当前 PodJS Bili 只有 entry、actions 显式添加 compact 标签，搜索等子页没有统一父级标签。
2. 原生 BiliPlayerActivity / DouyinRssPlayerActivity 有顶部 compact 标签；实际 `routes/media.tsx` 渲染的 `VideoPlayerScreen.tsx` 没有平台标签。模型 `createPlatformNoticeRoute({page:'video',...})` 导出 notice，不能当作 UI 已接线证据。
3. Douyin 登录页只在非 blocked 的登录内容分支放 compact 标签；不可用/拦截状态页不显示。需由 lead 判断是否与原生网络不可用分支一致，以及“第三方关系”是否要覆盖这些页面。
4. 窄逻辑宽度时 scope/access 标题未单独 wrap，卡片高度按一行17计算；233dp 当前目标的短标题可容纳，其他更窄尺寸与大 fontScale 尚未验证。

这些涉及视觉布局及覆盖范围，R2 按“代理不改视觉设计”保留并交 lead 判断；不能据本次全测/构建宣称全部原生 UI parity。

## 验证范围与设备步骤

`tests/platform-disclosure-component.isolated.ts` 使用实际 WatchRSS/HomeRoutes/HomeScreen/MediaRoutes/PendingDisclosure、Solid 响应式 owner、默认 KV 与生产 BackMotion。mock 仅覆盖宿主服务、list 渲染和媒体内容边界；list 在测试中渲染全部 row，不证明设备虚拟化、圆屏裁切或 native 手势命中效果。

设备 **PENDING**。只执行一次 `adb devices`，未安装、截图或输入。授权设备 agent 后需：

1. 仅 e3aca8af；正式包用 acceptance.py upgrade，前后 digest JSON `equal=true`，先对比规定首页参考尺寸。不生成 userdata tar。
2. 仅在独立测试数据中清除首次说明 key；不要清除正式包账户/数据库或改用户平台账号。验证 OOBE→Home、公告/push→首次说明、确认后冷启动不再出现。
3. 两平台分别验证初次→平台顺序、硬件 Back/横滑不会移动或离开说明、表冠长文与确认按钮可达、后台列表/侧菜单不会触发。
4. 入口→channel-info→返回不重弹；回 Home 后新入口重弹平台确认。检查原文、圆屏安全区、字体、卡片范围与上述视觉豁免。
5. 截图结论记录原 PNG 尺寸、非 RGB0 像素数、目标 ROI 颜色分布和参照 MAE；不从预览印象判断空白/裁切，也不把 host tests 当作设备证明。
