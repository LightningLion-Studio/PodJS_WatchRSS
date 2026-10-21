# 正式版云同步与 BLE 发现

手机账号页在正式与调试构建均显示云同步卡片，仍只对已登录且应用授权通过的账号启用。
密钥初始化、旧设备批准、恢复、会员读写权限和隐私同意检查保持原逻辑。

当前PodJS手表接管版的云协调器在release/debug均可启动；宿主构建信息缺失或异常
则关闭。前台由StartupGate完成隐私与引导后启动，后台重新读取同一版本的明确
同意记录，没有同意不读账号、不访问网络。前台五分钟合并触发、后台六小时非计费
网络、端到端加密和计费网络仅传小状态的政策保持原有实现。

框架后台使用显式cloud.host授权，核验安装包manifest与源码哈希，保留方法白名单、
预算、原子合并和进程间writer lease。旧debug.cloudHost仅供旧调试包兼容。

BLE通过已配对手机获取和验证端点，正文仍由LAN/RFCOMM同步。在“连接手机”中
点击“启用附近手机发现”授予发现权限；旧Android请求coarse与fine location组。
读取前请求MTU517以兼容旧手机动态描述符，协商拒绝或失败时仍按有界读取处理。
新手机在同一设备的长读期间保留同一份描述符，在断开、超时或新读失败时清理，
防止拼接多个签名版本。该修改未启用后台持续扫描，系统蓝牙开关可维持开启。

云同步与选取的BLE修复合入正式源码分支，framework.lock固定对应框架提交。
T39的批次续传、性能缓存和schema改造不在这次选择性合并中。其它调试工具仍受
debugGate约束，冻结原生v40参考不变。公开发布须另走版本/渠道登记与设备验收；
release构建和单测不等于已经升级设备或完成真实云端双向同步。

## Cloud v2 logic and UI integration

PodJS currently implements encrypted snapshot schema 2, **not records v1**. Its
registration deliberately omits `rssRecordsVersion`; a participating PodJS watch
therefore keeps the mini-program on the compatible snapshot channel. Epoch,
verified commitments/rotation chains and own-device attestation gate snapshot
reads/writes. A new account library requires an explicit local clear or merge
choice; logging out retains its owner while clearing that account's cloud secrets,
sequence/applied/hash state and encrypted cache.

`createCloudAuthorization` exposes `verifiedReady`, fresh backend `trust`, batch
`acceptDelivery`, `currentKeyVersion`, confirmed `reregister`, and an `approval()` requester state machine.
The QR handler requires these functions instead of a `cloudKeyVersion > 0`
shortcut. A single anonymous legacy `key` envelope is rejected with
`client_upgrade_required`. Bind the Lead's pairing panel to the new handler;
its layout is not part of this implementation. `phoneMasked` remains a peer
label, not an authenticated identity proof. The QR secret, session and userId
bind the pairing SAS under R6.

Approval UI consumes `idle/pending/code/complete/cancelled/expired/error` and the
8-digit `code` (display as `1234 5678`). Start only on an explicit user action,
use `setForeground(false)` on background and `setForeground(true)` on resume,
and poll only in foreground. Retain this instance across background; explicit
abandonment/logout calls cancel/dispose. `expiresAt` is display-only; only server
`expired` or `409 approval_expired` ends the session as expired (R22/R23). Show
“请在已登录设备上核对此码”; the watch never approves another device. Membership
changes do not alter the authorization owner identity.

Crypto staging files are removed in normal finally paths and swept under the
shared cloud lease before the next sync following a crash. No source service
argument logging remains; release prebuild also asserts `PERF_TRACE = false`.

### SPEC section 10 decisions

Both approval peers now confirm the SAS. The watch UI must call
`approval.confirmCode(true)` for “一致” or `confirmCode(false)` for “不一致”.
Merely receiving `delivered` leaves the requester in `code` with
`confirmed=false`; no envelope is unwrapped or saved. Background bootstrap also
cannot establish a fresh root from anonymous server envelopes. Only confirmed
approval/QR delivery, already authorized scoped keys, or matching legacy keys
(R8) can establish that root. Watches never publish legacy commitments.

QR `SetupPorts` receives `{sessionId, secret}` from its live QR channel and
`confirm(label, sas)` must obtain local SAS agreement. Treat the phone mask as an
unverified label. The `key` request carries one `payload` JSON string with the
approval envelope array and attestation. The watch rejects payload UTF-8 lengths
over 14 KiB and directs the user to approval v2. Relay chunking is unchanged.

All new manifests use WRSSCM3 with per-snapshot HKDF; WRSSCM2 is read-only
compatibility. Reader migration heads accept only `reader/*` objects. SPKI
comparisons use decoded DER; device aliases stay `userId+deviceId` per R13.
Logout attempts epoch-fenced local-device revocation before clearing local
session/keys/state/cache, and continues local cleanup if the remote attempt
fails. The backend must allow a watch principal to revoke only its own device.

Section 11 keeps the watch's 14 KiB QR payload defense; the scanning peer checks
final relay wire/ciphertext limits after encryption and wrapping. New snapshot
uploads use the backend's epoch-proxy PUT URLs, raw ciphertext and a refreshed
account bearer plus epoch. The target must be the exact current backend
reservation route. The production foundation never falls back to TUS; existing
TUS helpers remain for isolated legacy compatibility tests. Already-issued
Storage URLs expire under the accepted R18 migration boundary.


### SPEC section 12 and cross-client review

Configure receipts include `userId`, `deviceId`, `bound: true` and verified
`cloudReady`. Key receipts include `deviceId`, `cloudReady: true` and the highest
locally verified `keyVersion` (the native receiver shape). The shape regression
runs the production mini-program `lib/watch-setup.js` against the PodJS handler,
with real ECIES envelopes and local crypto, and checks that dropping either
required field is detected. It reads the sibling cloud-v2 checkout without
writing to it or making network requests.

A failed rotation/envelope/attestation candidate leaves the still-valid scoped
key prefix available, including after manager restart. All retained keys are
rechecked against the current epoch/commitments/chain. The failed batch never
publishes candidate keys; a commitment mismatch still clears cloud trust. The
former write-only quarantine marker is deleted during bootstrap; a fresh
bootstrap retries the server envelopes. Legacy keys remain until successful
verified migration (R21); watches never publish commitments (R19/R26).

Same-epoch trust cleanup keeps the device ECDH identity (R20). For
`device_key_conflict`, show “重新登记本机” and invoke
`authorization.reregister(true)` only after explicit local agreement; `false`
performs no I/O. This revokes self, clears account cloud trust and registers the
preserved local public key, without attestation; approval is still required.
Epoch reset clears cloud trust without logging out the account (R25).
R24/R27 have no PodJS configuration-client or phone-change path.
