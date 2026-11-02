# DYSWIPE local emulator route

This fixture mounts the production VideoPlayerScreen with 400 local sources and
starts at index 100. Eight 12-second H.264/AAC videos repeat by index modulo eight.
No DouyinClient, account client, browser, background service, or credentials are
loaded. Keep emulator Wi-Fi and mobile data disabled. Do not use open-douyin.

Generate the clips with `python3 tests/runtime-dyswipe/make-videos.py /tmp/dyswipe-videos`.
Build with the task framework worktree CLI using
`bun packages/cli/src/cli.ts package android-watch --project=<app>/tests/runtime-dyswipe`.
Use x86_64 only and the task's assigned emulator port 5556. Install with T-EMU's
`emu-douyin.sh install 5556 <debug-apk>`. Copy clips through `/data/local/tmp` into
`run-as com.lightningstudio.watchrss.podjs`'s `files/podjs/files/` directory.
Do not clear application data or import credentials.

Set `log.tag.PodJSService=DEBUG` before starting the debug host to enable its
existing bounded native input timestamps and the fixture's selected-index trace.
Start `com.lightningstudio.watchrss.podjs/dev.podjs.androidwatch.MainActivity` and
tap LOCAL SWIPE. Restart the activity between cases to reset the input trace cap.
The task evidence directory contains local-matrix.py and run-final.py with the
exact matrix, closed telemetry parser, and per-case source-index checks.

This route does not test production network delivery, icons, login, the watch,
or physical audio. player_paused is a native player-state diagnostic; it is not
previous_audio_stopped mixer proof. Emulator timings are informational only.

## Slow loopback CDN (T-DYINTENT)

The same production screen can select SLOW FRONT or SLOW TAIL from the fixture
menu. Each item has a unique numeric URL. The two clips contain the same 12s
240x240 AVC/AAC payload. Their 3.8MB size and explicit front/tail `moov` positions
are recorded by the generator. Covers are absent. Neither layout contacts Douyin.

```sh
python3 tests/runtime-dyswipe/make-slow-videos.py /tmp/dyintent-videos
python3 tests/runtime-dyswipe/slow-cdn.py --root /tmp/dyintent-videos \
  --kbps 300 --ttfb-ms 600 --port 18756 --log /tmp/dyintent-cdn.jsonl
adb -s emulator-5556 reverse tcp:18756 tcp:18756
```

The server binds only 127.0.0.1. ADB reverse keeps all media traffic on loopback.
It implements single HTTP byte ranges, delays each response by 600ms and limits
each connection to 300KiB/s. Both values are configurable. Completed/cancelled
connections log only numeric item index, layout, range offset, bytes and timing.
Disable emulator Wi-Fi and mobile data. No cookie import or open-douyin is used.
The menu's logical y coordinates are 61 (local), 111 (front), 161 (tail).
Use physical y=222 or 322 on the 466px emulator.

`onSelectTarget` publishes the selected index synchronously on release. Cold
prepares are interrupted by the next release. The route neither replays an
intent queue nor waits for URL registration/first-frame decoding to select the
next item. Production URL registration publishes an immediate metadata-only
page and fences every older asynchronous result. An identity-matched cached
actual frame can appear while loading; a cover never replaces a decoded frame.

The matrix is 50 next, 50 previous and 50 rapid-forward inputs at both 1000ms and
500ms. Run both layouts. Record native input DOWN/UP, gesture release, selected
index per release, stale prepare cancellations, decoder_count maximum and the
final gesture's incoming_first_frame. Missing frames remain missing. These
numbers describe emulator functionality, not watch performance acceptance.

With `setprop log.tag.PodJSService DEBUG`, native `decoder_budget in_use=N peak=M`
lines record every successful lease acquisition and every release. `peak` includes
short-lived leases between samples and stays monotonic for the process. These
counts are shared decoder leases, not a system-wide MediaCodec process count.


## Reverse history boundary (T-DYLOSS)

SLOW FRONT / SLOW TAIL start at index 100 for 50 continuous previous selections.
BOUND FRONT / BOUND TAIL start at index 4, then rebound at zero without leaving
this player. Their physical tap coordinates are (120, 410) and (326, 410).
Each boundary release has direction=cancel, delta=0, reason=boundary. It neither
pauses nor retires the current source. Native snap_back requires the retained
decoded surface and an actual frame commit. The route adapter uses the same
canSelectTarget predicate as production media.tsx; production controller tests
also exercise the previous boundary without the fixture callback.
Other release reasons are release, threshold, cancelled and network_prompt.
Use the assigned task port (T-DYLOSS: 5558). The slow URL port stays 18756 inside
the emulator; the host server can use a private port via adb reverse.

## Network-first keyframe comparison (T-DYNET)

The fixture supports two independent loopback authorities and a per-connection
TLS-like setup delay. It still serves only generated media, with no upstream.

```sh
python3 tests/runtime-dyswipe/slow-cdn.py --root /tmp/dynet-media \
  --port 18766 --alternate-port 18767 --kbps 300 \
  --ttfb-ms 600 --alternate-ttfb-ms 120 --handshake-ms 350 \
  --log /tmp/dynet-server.jsonl
adb -s emulator-5556 reverse tcp:18756 tcp:18766
adb -s emulator-5556 reverse tcp:18757 tcp:18767
```

`connection`, `cold`, and `host` are numeric connection/authority diagnostics.
Both authorities serve identical bytes. `host=0` is the primary; `host=1` is the
alternate. The handshake delay is applied only to a connection's first request.
The log contains no request URL, header, credentials or account information.
Limits are per connection, as in the original fixture, not a model of aggregate
radio capacity. The 350 ms setup delay is not real TLS or DNS measurement.

Build the framework's `PodMediaNetworkTest` with the local runtime:

```sh
ANDROID_HOME=/home/wilf/Android/Sdk ./gradlew :runtime:assembleDebugAndroidTest \
  -PpodAbis=x86_64 -x externalNativeBuildDebug -x mergeDebugNativeLibs
adb -s emulator-5556 install -r runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk
adb -s emulator-5556 shell am instrument -w -r \
  -e class dev.podjs.runtime.PodMediaNetworkTest -e phase candidate -e samples 10 \
  dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner
```

Run Gradle from the framework's `platforms/android` directory. This standalone
instrumentation APK exercises production Java cache/transport and the Android
media decoder, without JNI, the account app, or a UI cover. Use T-EMU's harness
to boot/stop the assigned emulator. Do not import cookies. Install the standalone
APK with serial-scoped ADB because the harness installer targets the account-app
package. The same instrumentation test can compile on the card's base; unknown
`alternates` are ignored there. `-e race false` disables alternates for ablation.

`decodable_ms` ends at a successful cache-only MediaMetadataRetriever frame at
time zero. It includes polling and decode cost. `network_bytes` is application
transport bytes at that time, including any concurrent remainder read. Neither
is a UI first-frame measurement. Inspect `keyframe_prefix` separately and compare
`keyframe_end` with ffprobe's first video packet `pos + size`. A byte plan is not
a decoder result. The first candidate's 128 KiB probe was too short for the
extractor's read-ahead; the final stage uses 192 KiB plus a sample-derived guard.
