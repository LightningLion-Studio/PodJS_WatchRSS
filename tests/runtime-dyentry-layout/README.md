# Douyin entry layout fixture

Mounts the production `ImmersiveEntryContent`. It constructs no account client,
HTTP transport, feed or playback controller. Its only capabilities are touch and
private test KV. The app ID is `com.lightningstudio.watchrss.dyentry.layout.test`.

Set `dyentry.layout.case` in this test app's private `files/podjs/podjs-kv.json`
before starting its process. Cases 0–13 are pairs with/without the notice:
loading, slow loading, timeout, logged out, request failure, normal, unknown auth.
Restart the process for each screenshot to isolate native resource reuse.
The diagnostic `dyentry.layout.case` marker includes the selected case number.

In timeout cases, Retry replaces the error with the loading subtitle. In unknown
auth cases, tapping the title injects locally completed auth. These actions never
perform requests. Capture the transition as well as the initial frame.

Build the fixture with the same pinned framework as the app:

```
flock /tmp/wrss-heavy-PodJS_WatchRSS.wt-dyentry.lock capmem 16G bun ../podjs-watch-framework-pinned/packages/cli/src/cli.ts build android-watch --project="$PWD/tests/runtime-dyentry-layout"
```

Package the resulting assets in an isolated Android build directory, targeting
x86_64 and the test app ID. Use `--no-daemon -Dorg.gradle.workers.max=2` and the same
lock/memory wrapper for Gradle. Do not package against another task's native build
outputs. The `assets` symlink provides the production icons to the asset compiler.

Use only a newly owned emulator, verify `ro.kernel.qemu=1` and its AVD name, disable
its Wi-Fi/mobile data, and pass its explicit serial to every ADB command. Preserve
other emulators and all physical devices. Shut down only the owned emulator PID.
