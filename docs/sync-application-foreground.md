# Application foreground synchronization

The main application now starts `ApplicationForegroundSync` after repository initialization and disposes it with the application. It combines actual lifecycle, display interactivity/resume state and Bluetooth availability/permission with the existing foreground policy. Navigation does not create a separate listener. The settings switch controls optional silence playback; its default remains disabled. Library session completion schedules collection refresh through the application library event.

The SDK exposes guest-scoped `displayPower` and `silencePlayback` ports. Display ownership applies `FLAG_KEEP_SCREEN_ON` only while resumed and preserves a pre-existing flag. Audio owners share an optional looping zero-PCM AudioTrack; releasing the last owner or disabling the setting stops it. The bootstrap screen lease ends at session completion, while audio retains the native 30-second handoff grace. Disposal closes listeners and releases both resources.

Native comparison used `WatchBluetoothForegroundSyncManager.kt`, `BluetoothTransferScreenOnController.kt`, and `SyncMediaKeepAlive.kt` directly. A real-device failure exposed an invalid static AudioTrack initialization assumption: the track reports STATE_NO_STATIC_DATA before writing PCM. The SDK now writes before requiring STATE_INITIALIZED; original Android source was not modified.

## Verified evidence

- 396 application tests, 61 framework tests and application typecheck passed. Two Android instrumentation tests passed on the watch, covering actual window flags, multiple owners, lifecycle release, and real AudioTrack enable/disable/disposal.
- The deployed main app answered a version-14 read-only Bluetooth probe from the already-paired physical phone on the public WatchRSS UUID. Its returned device ID is checked against the pre-install main database. The main window held KEEP_SCREEN_ON during the peer ACK delay and cleared it afterward.
- The isolated application test used the same production repository/controller/display/audio/radio services and a separate UUID. During the real phone connection it acquired display/audio resources, then completed in a paused activity. The guest explicitly received the successful applied ACK. Display ownership was released, audio handoff grace remained, and disposal closed both recorded listeners and released all owners. The test contained no article writes.
- The background fixture deliberately delays ACK by 15 seconds and uses a test-only 30-second ACK timeout. Production remains at 10 seconds. The initial 15-second/default-10-second attempt failed with a phone broken pipe and is retained as `power-background-*-ack-timeout-failure.*`; its earlier guest pass is invalid evidence. The corrected fixture requires `appliedAckReceived: true`.
- Main data was archived with the app stopped before installation and after probes. All 30 table digests and all existing non-database file hashes match (172 files total). The actual main article library was empty; this does not prove populated end-to-end article exchange.

Evidence is collected in `artifacts/power-receipt.json`; raw probe, window, unit/instrumentation and guest KV records are retained beside it. `scripts/verification/run-power-background-peer.py` coordinates the already-installed isolated fixture and paired-phone instrumentation. It does not install or reset applications.

## Remaining migration work

Full paired-phone article exchange, remaining non-library actions, IP upgrade and ownership integration, reader preset/assets support, Android 12+ permission UI, physical screen-off behavior, and interaction/visual parity are still pending. A read-only probe and background ACK are not full phone synchronization acceptance. The main probe truthfully advertises unsupported reader capabilities and `ipUpgradeAccepted: false`.

The main action dispatcher now includes [note synchronization](sync-notes.md); the historical power receipt predates this increment.


Follow-up: [IP synchronization bootstrap](ip-sync.md) adds descriptor acceptance and authenticated WebSocket sessions. Its paired-device evidence uses an explicitly identified ADB relay; wireless discovery/routes and normal companion acceptance remain unverified. Earlier pending statements describe the earlier receipt.
