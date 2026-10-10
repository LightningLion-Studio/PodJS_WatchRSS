# 声波 debug 外部启动与返回

`android.debugExternal` 声明 `com.lightningstudio.watchrss.AcousticConnectionActivity` 和 `com.lightningstudio.watchrss.DebugAcousticConnectionActivity` 两个别名，均发送 `com.lightningstudio.watchrss.debug.action.OPEN_ACOUSTIC`。仅 debug source set 生成，exported 入口要求 `android.permission.DUMP`；普通 release 不生成这些组件。应用还独立检查实际 debug build。

入参使用 Android 原生类型：`mode`（PURE_SOUND / SOUND_GUIDED_WIFI），`preferred_ability`（能力枚举名称），`debug_auto_listen`（boolean），`debug_guided_payload_base64`（string），`return_remote_url`（boolean）。默认引导 WiFi；未知能力名称按原生视为未指定。非空 payload 优先于自动监听，自动路径强制引导 WiFi。payload 没有指定能力时从协议 envelope 取能力；显式能力必须匹配。自动监听默认 REMOTE_INPUT，并调用实际麦克风/引导 WiFi 权限路径。payload 直接进入现有 WiFi/HTTP 会话，不伪造手机响应。

请求打开现有声波页面，等页面激活后执行一次。`return_remote_url=true` 的 URL 成功结果为 Android RESULT_OK（-1）和 `remote_url` string extra，跳过订阅输入 inbox；false 沿用 inbox，并返回 RESULT_CANCELED（0），与原生不设置成功 result 的分支一致。页面退出、后台、停止、超时取消请求并关闭实际 session。调试失败保留页面重试；非 URL 的保存列表同步完成后保留结果页面，退出时取消 Activity result。只允许一个声波外部请求拥有页面。

入口 Activity 在 MainActivity 下等待结果，用 REORDER_TO_FRONT 保留已有 MainActivity 和 result owner，避免 CLEAR_TOP 销毁 owner。默认请求期限 120 秒；配置重建/进程丢失不重放 debug 操作。业务 payload 不落盘、不回显到 debug 回复。请求字段不写入持久化导航快照。

shell 启动示例（仅用于后续授权设备验收）：

```sh
adb shell am start -n com.lightningstudio.watchrss.podjs/com.lightningstudio.watchrss.AcousticConnectionActivity \
  --ez debug_auto_listen true --es preferred_ability REMOTE_INPUT --ez return_remote_url true
```

`am start` 本身不能证明 Activity result 往返；lead 需使用具备 DUMP 权限的 startActivityForResult 调用方验证。T33 只做源码/CLI 生成/SDK/应用/Android JVM 测试，不连接设备、不生成签名安装包。验收包必须同时更新框架和应用，只有 JS 更新不能提供 Android setResult 能力。
