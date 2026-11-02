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
