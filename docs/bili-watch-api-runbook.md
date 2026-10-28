# B 站手表接口选路与关闭

推荐与取流默认首选手表接口；未配置客户端标识、开关关闭、响应错误/解析失败/空轨/过期URL时按次回退现有Web/WBI。历史、收藏、稍后看、搜索、详情、进度和登录仍走Web。没有新增OAuth或appsecret处理。

数字视频ID在手表/legacy取流使用aid，WBI取流使用avid。WBI签名不包含未提供的bvid/platform；宿主实测确认aid-only旧参数返回-400，改为avid后成功。

## 配置与轮换

源码默认 `biliWatchApi=true`，不包含任何客户端标识值。正式候选必须由可信发布配置提供 `appkey,mobiApp,platform,device,build`；缺任一项会跳过手表请求并记录 `unconfigured`，不能称为实际启用完成。

提供两种入口，均不接受任意API host、Cookie、token或appsecret：

- 构建期：把批准的标识JSON放仓库外0600文件，通过 `BILI_WATCH_BUILD_CONFIG=/private/client.json bun scripts/bili-watch/inject-build-config.ts --project=/absolute/isolated-project` 注入**隔离发布副本**，然后用正常PodJS CLI构建该副本。脚本拒绝修改共享checkout及其子目录、拒绝符号链接逃逸。带标识的生成文件和产物不加入Git；本地/远程配置可覆盖构建值。
- 远程配置应用入口：可信宿主配置接收端调用 `applyWatchConfig(kv, payload)`（`src/bili/watch-api/config.ts`），写 `watchrss.bili.watch-api.remote.v1`；读取时逐请求生效，可替换上述字段轮换。这里只实现配置快照/应用接口，没有擅自新增远程服务地址、推送订阅或后台抓配置网络请求。生产控制面需由Lead接入可信传输后交付。

已登录用户默认保留Web路径。`webCookieVerified` 默认false；只有本人账号实际对照确认Cookie登录态和画质权益后，才允许由可信配置置true。验证模式复用现有安全存储的Web Cookie，不兑换/制造OAuth token；实际画质低于请求档会回Web。

## 一键关闭

在既有可信宿主KV管理入口执行 `kv.set('biliWatchApi', false)`。恢复设置true，或删除本地覆盖。远程 `applyWatchConfig(kv, {biliWatchApi:false})` 也可关闭，任一false优先；远程恢复需重新带上所需标识或保留构建默认值。没有新增普通用户控制台/管理UI。

下一次推荐/取流会直接走Web；播放器仍可继续当前已经播放的流，关闭不清账号、不清本地进度、不伪造远端上报。下一次打开播放器会拒绝复用已关闭的手表预取源。手表直链失败后本播放会话只切一次Web解析，沿用原positionMs；保存预览下载失败也会在原有最多3次尝试内转为forceWeb，之后不再请求手表取流；后续自动候选/本地预览沿用原有上限，手动重试不自动重开手表路径。

## 限制和诊断

- 手表每操作一次请求，10秒请求超时、2MiB响应上限、推荐最多20条，游标最多4096字符；durl最多8项、每轨备用最多8条、DASH轨最多16条，播放器候选最多16个。
- HTTP403/412/429或业务-352/-412/-509使手表断路器打开2小时，写 `watchrss.bili.watch-api.cooldown-until`；当前操作只回退Web一次，后续不重试手表。不要通过清cooldown、更换身份或无限手动重试绕过限制。
- `BiliRoute`仅含operation/route/固定原因枚举/elapsedMs；`VideoOpt` B站api/candidate/first_frame包含数字apiRoute（0未知/本地、1手表、2Web）和session，不记录URL/标题/视频ID/凭据。首帧只在真实宿主回调观测到后记录，不能用playurl成功替代。
- 本机研究脚本与App断路器是不同边界：研究遇任何风控立即停止全部B站访问，保留STOP至少2小时；冷却后还需本轮明确授权才可低频复测。本轮已获Lead授权，未获准读取设备或他人会话。

## 放行前

核对配置来源/默认开和关闭；跑单测、类型检查和宿主配对。DEVICE_OWNER排队后在手表验证匿名与本人登录、首帧/退后台、失败回退保进度、关开关、资源预算。现有设备ANR属于其他owner现场，不能以本轮离线构建代替实机验收，也不能覆盖其安装现场。未获实际设备证据时生产就绪保持PENDING。
