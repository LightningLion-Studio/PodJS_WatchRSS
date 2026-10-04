# 抖音共享服务迁移

`src/douyin` 从 Android `sdk/douyin` 与 `data/douyin/DouyinRepository` 迁移可复用的数据边界。服务保留精选流 `POST /aweme/v2/web/module/feed/`、详情 `GET /aweme/v1/web/aweme/detail/`、原参数集合、User-Agent、Referer、Cookie 和 `a_bogus` 签名流程。网络、密钥存储、历史存储和签名器均由调用端注入，测试只使用清洗后的本地响应。

Cookie 只进入 `DouyinSecureStorage`，不会出现在普通状态对象。与原 `DouyinRepository.applyCookieHeader` 一致，`applyCookie` 只拒绝 trim 后的空值，并不额外要求 `sessionid`；登录是否有效由后续真实接口响应确认。`logout` 只清 Cookie，播放历史、收藏和稍后再看会保留。宿主必须把 `DouyinSecureStorage` 接到平台安全存储。内存或明文实现只适用于测试，不能作为生产配置。

`fetchFeedPage`、`fetchDetail` 和 `resolvePlayback` 返回带判别字段的 `DouyinResult`。成功的精选流项目会在进程内缓存 5 分钟，与 Android 播放 URL TTL 一致；`fetchDetail` 和 `resolvePlayback` 默认优先使用仍新鲜的完整精选流数据，避免点击后重复请求。需要主动刷新时可调用 `fetchDetail(awemeId, { forceRefresh: true })`；刷新失败但旧缓存仍新鲜时仍会返回明确标记为 `source: "feed-cache"` 的合法快照。没有缓存或缓存过期时返回详情接口的真实错误。播放流沿用详情或精选流响应中的 `play_addr`/码率变体，并通过 `buildPlaybackHeaders` 返回 Android 同款请求头。公开的 `DOUYIN_PUBLIC_MEDIA_HEADERS` 只包含 User-Agent 和 Referer，供封面请求使用，不包含 Cookie。

观看历史是本地功能，按 `awemeId` 去重并保留最近 200 条，同时保留最多 1000 个已看 ID；清空历史会同时清除两者。收藏和稍后再看对应 Android 的两个本地 RSS `SaveType`，`DouyinSavedStore` 分开持久化，并给每条记录携带 `platform: "douyin"`、`awemeId` 和分享链接，供根收藏页合并及恢复详情路由。它们不调用抖音互动接口。原 Android 仓库没有远端搜索、点赞、远端收藏、关注或评论契约，因此 `search` 和 `interact` 明确返回 `UNSUPPORTED` 且不发请求。此迁移不以打开网页代替这些能力，也不会自动产生任何用户互动。

运行限制：QuickJS 没有 `TextEncoder`、`URL` 或 WebCrypto；实现复用项目的便携 UTF-8 编解码并手工构造查询串。默认 `ABogusSigner` 是原 Android `ABogus`/SM3 的便携实现；测试也可注入确定性签名器，签名失败会终止请求，不存在未签名降级。WebView 登录与 WebView Cookie 同步仍属平台 UI/宿主责任；共享层支持安全导入最终 Cookie header，但不会模拟登录成功。
