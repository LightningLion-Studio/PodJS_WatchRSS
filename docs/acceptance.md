# PodJS WatchRSS acceptance checklist

This is a source-derived contract for the PodJS rewrite. It describes the current Android watch app at `Android_WatchRSS` and is a checklist, not proof that any item works on a PodJS device. Every item below starts as **NOT VERIFIED** until exercised on the target runtime and, where applicable, against a paired phone.

## Evidence snapshot

- Android source HEAD: `0835b84cbc03b654bafde347862e734215502237`.
- Android worktree has 14 modified files (RSS repository/DAOs, Bluetooth server/protocol, IP manager, build/test fakes). Diff stat: 220 insertions, 58 deletions.
- Redacted change fingerprint (SHA-256 of `git diff --no-ext-diff` bytes; no diff contents or secrets): `87c601a6aa4ff5bf9feab97e72e5b51303cf9d17186c23b578b4d818464ff5ab`.
- This document intentionally records the dirty source behavior as the current contract. Recompute both values immediately before implementation if the source changes.

## User-visible surface

Mark each row PASS only after a cold launch, navigation, back behavior, loading/error/empty states, and touch/scroll/crown behavior have been checked on the target watch. Activity names are the Android entry-point evidence; screen names are the Compose surface evidence.

| Area | Current activities / screens | Required acceptance | Status |
|---|---|---|---|
| Launch and onboarding | `MainActivity`, `OobeActivity` / `HomeScreen`, `OobeScreen`, `PrivacyPolicyConsentScreen` | Launch routes through consent/OOBE when required; resume and deep-link state survives process death; consent is explicit. | NOT VERIFIED |
| Home and RSS | `HomeFeedListActivity`, `FeedActivity`, `AddRssActivity`, `RssRecommendActivity`, `RssRecommendGroupActivity`, `ChannelDetailActivity`, `ChannelSettingsActivity`, `RssSearchActivity`, `SavedItemsActivity` / `HomeComposeScreen`, `FeedScreen`, `AddRssScreen`, `RssRecommendScreen`, `ChannelDetailScreen`, `ChannelSettingsScreen`, `RssSearchScreen`, `SavedItemsScreen` | Show pinned/orderable channels, unread/read state, pull refresh, add/edit/delete, recommendations, search, saved items, undo and empty/error/loading states. | NOT VERIFIED |
| Article reading | `DetailActivity`, `ItemActionsActivity`, `ImagePreviewActivity`, `RssPlayerActivity`, `ReadAloudPlaybackActivity`, `AutoScrollControlActivity` / `DetailScreen`, `ImagePreviewScreen`, `ReadAloudPlaybackScreen`, `AutoScrollControlScreen` | Render HTML/plain text/images/audio/video safely; preserve read state and reading progress/byte position; support original-content choice, TTS, auto-scroll, media and back navigation. | NOT VERIFIED |
| Notes | `NotesActivity`, `NoteDetailActivity`, `NoteActionsActivity` / note surfaces in `NotesActivity`, `NoteDetailActivity` and `NoteActionsActivity` | Create/edit/delete/restore notes and folders, markdown/plain text, pin/sort, conflict-safe update, and asset handling. | NOT VERIFIED |
| Reader customization | `ReaderPresetActivity`, `ReaderPresetPreviewActivity` / reader preset runtime and preview screens | List/select/edit presets, light/dark scheduling, font/background assets, preview and sync; reject invalid or missing assets without corrupting active preset. | NOT VERIFIED |
| Settings and profile | `SettingsActivity`, `AdvancedSettingsActivity`, `TtsSettingsActivity`, `LlmPromptPresetActivity`, `LlmSummaryActivity`, `LlmTokenUsageActivity`, `ProfileActivity`, `AccountStatusActivity` / `SettingsScreen`, `TtsSettingsScreen`, `LlmPromptPresetScreen`, `LlmSummaryScreen`, `LlmTokenUsageScreen`, `ProfileScreen` | Persist settings, API-key boundaries, account status, LLM/TTS calls and failures, usage records, profile and theme controls. Secrets must never appear in logs or exported payloads. | NOT VERIFIED |
| Phone connection | `PhoneConnectionActivity`, `BluetoothConnectionActivity`, `AcousticConnectionActivity`, `PhoneConnectionUnavailableActivity`, `ShareQrActivity`, `ServerActivity` / `PhoneConnectionScreen`, `ShareQrScreen`, `ServerScreen` | Explain capabilities, pair securely, discover/connect, show QR/server state, recover disconnects, and provide clear unsupported/unavailable states. | NOT VERIFIED |
| Bluetooth diagnostics and sync | `DebugBluetoothSyncActivity`, `DebugAcousticConnectionActivity` / diagnostic screens | Verify framing, phase progress, received versus applied ACK, cancellation, timeout, resume, debug-log pull, merge and explicitly confirmed replace/clear modes. | NOT VERIFIED |
| Bilibili | `BiliEntryActivity`, `BiliListActivity`, `BiliDetailActivity`, `BiliChannelInfoActivity`, `BiliSettingsActivity`, `BiliLoginActivity`, `BiliPlayerActivity`, `BiliVideoActionsActivity`, `BiliCommentActivity`, `BiliReplyDetailActivity`, `BiliSearchActivity`, `ImagePreviewActivity` / corresponding `Bili*Screen` surfaces | Login/session expiry, feed/channel/search/detail/player, comments/replies/actions, saved/read state and media failure paths. | NOT VERIFIED |
| Douyin | `DouyinEntryActivity`, `DouyinChannelInfoActivity`, `DouyinHistoryActivity`, `DouyinSettingsActivity`, `DouyinLoginActivity`, `DouyinPlayerActivity`, `DouyinVideoActionsActivity`, `DouyinDetailActivity` / `DouyinFeedScreen`, `DouyinRssFeedScreen`, `DouyinHistoryScreen`, `DouyinLoginScreen`, `DouyinLoginBannedScreen`, `DouyinImmersiveScreen` | Login/banned state, feed/history/detail/immersive playback, paging, resume position, saved state and codec/runtime fallback. | NOT VERIFIED |
| Information and support | `AboutActivity`, `CollaboratorsActivity`, `ContactDeveloperActivity`, `JoinGroupActivity`, `InfoActivity`, `BeianActivity`, `LogUploadPrivacyActivity`, `LogUploadActivity`, `WebViewActivity` / `AboutScreen`, `CollaboratorsScreen`, `ContactDeveloperScreen`, `JoinGroupScreen`, `InfoScreen`, `BeianScreen`, `LogUploadPrivacyScreen`, `LogUploadScreen`, `WebViewScreen` | Legal/support content, privacy gate before log upload, bounded redacted log export, external/web navigation and failure handling. | NOT VERIFIED |
| Performance/debug | `debug.PerfEntryActivity`, `debug.PerfLargeListActivity`, `debug.PerfLargeArticleActivity` | Keep debug-only entry points out of production navigation; large-list/article probes must remain opt-in and bounded. | NOT VERIFIED |

## Data and behavior gates

- **RSS:** parse RSS/Atom and malformed feeds; normalize URLs; deduplicate by `dedupKey`; retain title/description/content/original content/link/guid/pubDate/images/audio/video/summary; handle conditional refresh and source errors. **NOT VERIFIED**.
- **Read/saved semantics:** read is monotonic during merge; favorite and watch-later have independent timestamps/tombstones; sorting and undo survive restart. Dirty source adds authoritative replace semantics and explicit library clear. **NOT VERIFIED**.
- **Notes and reader assets:** content hashes, base versions, modified-by identity, tombstones, asset SHA-256/size/metadata and missing-asset recovery. **NOT VERIFIED**.
- **Offline media/cache:** downloads, local paths, deletion with item deletion, bounded cache behavior. **NOT VERIFIED**.
- **Security:** encrypted stores, pairing challenge/token validation, HTTPS/provider key handling, redacted diagnostics. **NOT VERIFIED**.
- **Cloud:** bootstrap, device registration, heads/snapshot reserve/complete/ack and encrypted manifest/chunks; failures remain retryable. **NOT VERIFIED**.

## Transport acceptance

- Bluetooth RFCOMM service name `WatchRSS Bluetooth Sync`, UUID `bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861`.
- Frame is a 4-byte big-endian length followed by UTF-8 JSON; length is 1..2 MiB; transfer progress counts prefix and body, with 16 KiB body write/read chunks.
- Library sync protocol is v14; minimum phone protocol is v13; legacy is v4. Required phases are `cursor`, `manifest`, `probe`, `articles`, `complete`; v8 adds change sequences and metadata-only articles.
- Actions include `ping`, `remoteInput`, `pullSavedItems`, `syncLibrary`, `clearLibrary`, `syncReader`, `previewReader`, `syncAccount`, `syncLlmTokenUsage`, `pullDebugLog`, `syncNotes`, `syncNoteAsset`, and `syncSession`.
- `pullDebugLog` has a read-only production-phone RFCOMM receipt in [debug-log-sync.md](debug-log-sync.md). It exports a bounded PodJS sync timeline; native all-subsystem AppLogger parity and the visible phone export workflow remain open.
- Library modes are `merge` (default), `phoneToWatchReplace`, and `watchToPhoneReplace`; dirty source advertises `supportsAuthoritativeLibraryReplace`, `forceFull`, persistent sessions, manifest batching, resource chunk ACK and transfer-byte progress.
- ACK must distinguish `received` from `applied`; a successful transport receipt is not application success. Session endings are `complete` or `abort`; persistent-session idle timeout is 15 minutes.
- IP fallback advertises `_watchrss-sync._tcp.`, protocol v2, WebSocket `/sync`, and BLE endpoint discovery UUIDs in `IpSyncProtocol.kt`; guided Wi-Fi uses `/pullRemoteInput` and tokenized action paths. **All target-device transport gates NOT VERIFIED**.

## Release gate

The rewrite is acceptable only when all rows are PASS, migration dry-runs preserve a copied v18 database and stores, paired phone tests cover v13 and v14, replace/clear tests require the intended confirmations, and visual/device evidence is attached. Build or unit-test success alone does not close these gates.

## Release installation chain (data preservation)

Only the designated device owner runs this flow. The currently installed app must be debuggable and its protected-data snapshot must succeed before any installation. Do not start the app between snapshots.

```sh
ANDROID_SDK_ROOT=/path/to/sdk python3 scripts/device/acceptance.py upgrade-chain \
  --serial <watch-serial> --package com.lightningstudio.watchrss.podjs \
  --apk /path/release-v2.apk \
  --verify-apk /path/release-debuggable-v3.apk \
  --out /private/fresh-release-chain-receipts
```

Repeat `--apk` to install additional intermediate packages in the supplied order. The final `--verify-apk` must be debuggable. All application IDs must match; versionCodes must strictly increase from the currently installed version; all chain APKs must have the same effective signing certificates for the device SDK. Host preflight requires `apkanalyzer` and `apksigner` on PATH or under `ANDROID_SDK_ROOT`/`ANDROID_HOME`.

The command force-stops the app, preflights all APKs, records `before-digest.json`, installs each APK with `adb install -r`, force-stops again, then reads back versionCode/debuggable and verifies the installed base APK's signing certificate SHA256. Finally it records `after-digest.json` and the same strict `data-compare.json` format used by `upgrade`. `chain-install.json` records each attempted step and its readback, including partial failures. No launch, downgrade, uninstall or data clearing is performed. A failure stops subsequent steps; retain receipts and ask the lead to review the actual installed state.

Require exit0 **and** `data-compare.json` `equal=true`. This proves preservation across the installation chain; it does not prove a later launch or schema migration preserves data. The release-signed debuggable APK is temporary and must not be published or used for release performance measurements. Afterwards the device owner installs a higher-version ordinary non-debuggable release with the same signing policy, checks its identity/flags, and first compares homepage sizing with the required reference before proceeding to runtime acceptance. Existing `upgrade` still requires run-as for its after snapshot, so it cannot perform that final non-debuggable installation.

`--dry-run` prints the offline chain plan without accessing a device or creating digest receipts.
