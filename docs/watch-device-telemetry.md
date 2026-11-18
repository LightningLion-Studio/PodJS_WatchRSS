# Device-profile telemetry identity and host dependency

The model profile uses a separate random installation UUID stored only at
`watchrss.device-profile.install-id`. It is generated after policy consent and
release-host checks. It is not shared with usage telemetry, accounts, sync or
any other feature. No existing ID is copied, hashed or migrated into this key.
The backend retains purpose-scoped HMAC digests for cross-day deduplication;
this is de-identified data, not completely anonymous data. It must not be joined
to account install_id/device_id/user_id statistics.

`framework.lock.json` pins the `watchrss-migration` revision used by the build.
The locked framework includes `settings.openWifi` (PR #5, 9762be42) and
`device.info` (PR #6, 394c57be). Use the pinned source for install, build and
packaging.

The companion backend docs/watch-device-telemetry.md and the Android-watch
privacy policy define retention and deployment. APK, real-device and production
acceptance are separate from local unit/type/host tests.

型号统计与账号统计独立调度。每次前台进入后随机等待30～180分钟，
每次只上传一个去重日期；失败、剩余日期和后台返回均重新等待随机时机。
网络恢复不得跳过等待。后台取消定时器，不唤醒设备。
服务端只保留日期，不保存型号记录的精确接收或更新时间。
本版本服务端迁移删除所有旧格式型号记录，不建立新旧摘要映射；
迁移完成后，旧版去标识型号记录已清除。
