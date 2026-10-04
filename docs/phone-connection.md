# Phone connection migration

The profile's “连接手机” entry now opens the native phone-side operation instructions and “下载手机端App以完成手机连接同步” row. The download dialog uses the native malink URL, QR proportions, close/browser actions, and the subtitle threshold at a 360 dp container. Reader presets use this same dialog. Back closes the dialog before leaving the page; the covered page's scroll input is suspended.

Oracle: `Android_WatchRSS/.../PhoneConnectionScreen.kt`, `DownloadPhoneAppDialog.kt`, `WatchDesignTokens.kt`, and `Type.kt`. The native page does not start a server. Its application-wide foreground manager owns listening. That manager, the SQL session adapter's production cleanup ports, and other sync action dispatchers still need production integration. The main app currently does not listen for phone synchronization.

The SDK now advertises classic RFCOMM and byte streams through both target profiles and the JNI boot list. Its permission operation requests only Bluetooth connect permission on Android 12+. Cancellation is scoped to a request so cancelling another queued request cannot discard the current dialog's callback.

The isolated `tests/runtime-rfcomm` app runs through the guest/host boundary on the watch. It checks actual advertised capabilities, already granted authorization, a real secure listener using a separate test UUID, cancellation, reopening, closing, bounded accept failure, SQL while accept is waiting, and invalid stream handle dispatch. The observed short accept failure is `host_error: Try again`; it is recorded as a bounded failure, not a portable typed timeout. There is no remote client in this test. It never reads or writes the user's library.

Validation records: `artifacts/rfcomm-guest-kv.json`, `rfcomm-enable-native-test-result.log`, `phone-ui-all-unit.log`, `phone-ui-typecheck.log`, and `phone-connection-receipt.json`. Native stream tests cover six transport/concurrency cases. Desktop application tests remain 374; they do not establish rendered layout or physical Bluetooth transfer.

Still unverified: Android 12+ system permission interaction, actual paired-phone RFCOMM exchange, production foreground listening and full action support, and physical navigation/visual acceptance of the new page. The watch's system charging warning has previously obscured display capture; a resumed activity alone is not visual proof.
