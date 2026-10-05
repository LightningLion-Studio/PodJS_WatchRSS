# C6 日志上传服务与独立组件

本增量未接路由。Lead 在日志上传隐私页面的 `onUploadLogs` 回调中打开独立 `LogUploadScreen`，传入 `height` 与 `createHostLogUploadOptions()`。创建 options 无网络副作用；组件挂载后自动收集并上传，与原生确认隐私说明后自动上传一致。退出销毁 controller，阻止后续阶段及过期 UI 更新。未修改 `screen.tsx` / `InformationScreens.tsx`。

## 原生协议依据

只读参考 `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/LogUploadActivity.kt` 和 `app/src/main/assets/log_upload/assets/index-Bp_zl61y.js`。

- Activity 读取 AppLogger 并注入 `window.logText`。PodJS 直接读取诊断源，避免字符串脚本注入；空字符串/null 为“暂无日志”，读取异常为“加载日志失败”。纯空白与网页一致显示“日志内容为空”。
- `Bw/Vw/Qw/Hw/qw/Gw/Yw/Jw`：UTF-8 → gzip → AES-256-GCM；12-byte 随机 IV，128-bit tag，无 AAD。文件为 `[IV长度单字节=12][IV][ciphertext || tag]`。32-byte AES key 用相同公钥 RSA-OAEP（SHA-256、MGF1-SHA256）包装并标准 base64 编码。gzip 压缩器头部/压缩流允许不同，但解压正文、密码算法和封装布局一致。
- SDK `lv`：PUT `https://api.instantdb.com/storage/upload`，headers `app_id`、`path`、`authorization`、`content-type: application/octet-stream`；body 为上述二进制。未登录与原 bundle 一致，authorization 为字面值 `Bearer undefined`。不创建匿名账号、不使用 admin API。
- 文件路径：`test-user-${mountTime}/log_${now}_${Math.random().toString(36).substring(7)}.enc`。服务也接受显式已登录身份，但 host 默认与原生新 WebView 一样使用 guest。
- WebSocket `runtime/session?app_id=...`：`init` 获得字段 ID，再发 `transact` add-triple，写 `logs` 的 id/code/encryptedAesKey/fileSize/charCount/createdAt/userId 并 link encryptedFile。支持反向字段及缺字段时 SDK 同型 add-attr。只有收到匹配 client-event-id 的 transact-ok 才显示成功。
- code 在客户端用 `floor(100000 + random * 900000)` 生成，不是从 HTTP 上传响应获取；HTTP 只解析 `data.id`。`parsePickupCode` 校验六位码或原生成功文案。字符数使用 JS UTF-16 length，时间为上海时区 zh-CN 同型日期。

## 日志范围差异

原生 AppLogger：全应用主动写入的 V/D/I/W/E、tag、message、异常栈，单线程落盘到 app_log.txt，约 5 MiB 超限后删除早期 20% 行，读取前等候 flush，并脱敏 Cookie、Authorization、令牌等。

PodJS 本次只读取 `SyncDiagnosticLog` 的 KV `watchrss.sync.diagnostics.v1`：最大 700,000 UTF-16 字符的 Bluetooth/IP 状态、允许列表 action 的 success、通用 failure；不记录 payload、peer ID、URL、异常 message。没有原生全应用 logger、console/logcat 捕获或历史日志迁移。SQL `sync_change_log` / snapshot-log 是同步数据，不当作诊断日志上传。此范围差异不能标成全日志 parity。

## 验证及边界

测试提取原生加密帮助函数与 SDK `lv` 为独立 fixture，所有 I/O 注入本地 stub；测试公钥换成临时 RSA pair 以解密验证双方封装，生产公钥参数另作断言。源码保留原生公钥。覆盖 metadata、阶段、错误、重复启动、卸载、ACK 关联与资源关闭。未向生产后端上传，未实测服务端权限。

宿主现有 AES bridge 单次输入上限 256 KiB；700,000 字符诊断源通常高可压缩，但压缩后超限会明确失败，不截断日志或改用不兼容加密。本任务不改框架。HTTP 使用现有可处理二进制 PUT 的临时文件 transport（目前模块名为 tts/transport）；WebSocket 无后台重试，单次读取 15 秒超时、最多 64 帧。页面退出不取消已经发出的网络请求，但不会发起后续阶段；文件已上传而记录失败/退出时可能留下孤立文件，与原生两阶段流程一样，不做可能产生重复记录的自动重试。

独立页面展示本次上传结果及取件码，不实现原生网页的历史 logs 实时查询。路由、产品入口、完整视觉对照和实体手表验收留给 lead；本机 ADB 无设备，标记 PENDING。
