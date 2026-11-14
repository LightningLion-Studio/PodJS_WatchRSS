# Video reload acceptance fixture

Uses the production VideoPlayerScreen with synthetic Bili/RSS-like or immersive
Douyin-like metadata. It never constructs a platform client. The local resolver
and CDN are provided by server.py on 127.0.0.1:18764. Use `adb -s <owned-emulator-serial> reverse tcp:18764 tcp:18764` to keep all
fixture requests on loopback. No account or physical device is required.

Generate a local H.264 MP4 (90 seconds, 320x240, 15 fps), then run:

```sh
python3 tests/runtime-video-reload/server.py --media /owned/evidence/video.mp4 --log /owned/evidence/requests.jsonl
```

Build with the isolated framework CLI `build android-watch --project=<fixture>`.
Assemble the debug APK using the generated dist directory, app ID
`dev.podjs.reloadfixture`, `-PpodAbis=x86_64`, `-PpodCleartextTraffic=true`,
`-PpodResDir=<app>/android/res`, and
`-PpodAppTheme=@style/Theme.WatchRSS.PodJS`. Use the task's heavy-command lock,
16 GiB cap and `--no-daemon -Dorg.gradle.workers.max=2`.

Run only on a newly owned 466x466 circular emulator. Every adb command must name
its verified emulator serial. The fixture writes bounded position evidence to its private media path
`reload/evidence.json`. Stop the owned server and emulator by recorded
PID after collecting screenshots and logs. Never use adb without a serial.

- `manual`: first three resolved URLs return 403. After two automatic reloads,
  the error page remains. Press Retry to obtain the fourth URL, which plays.
- `resume`: first URL expires after eight seconds. Play, switch away or turn
  the screen off, wait for expiry, then return. The resolver returns a new URL.
  Compare native position before suspension and the new prepare seek.
- `slow`: resolution takes 3.5 seconds and media headers take six seconds.
  Capture getting-video, buffering-over-three-seconds, and playing states.
- `sessions`: same expiry scenario using the actual immersive session backend.

`/control?action=reset` resets counters. `/control?action=expire` invalidates all
issued addresses. It is useful for making a playing address invalid while the
emulator is suspended. All addresses, tokens and IDs in this fixture are local
synthetic data.
