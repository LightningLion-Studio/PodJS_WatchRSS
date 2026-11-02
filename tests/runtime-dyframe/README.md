# DYFRAME local slow-CDN fixture

This fixture mounts the production `VideoPlayerScreen` and `DouyinVideoSessionPool`. It registers 12 synthetic local sources and starts at index 4, leaving five following and two preceding items available. The footer reports the current item, decoded-frame count and live decoder count. Tap **SLOW KEYFRAMES**, wait for `frame 7`, then swipe in both directions. Single-item looping avoids unsolicited navigation during measurement.

Use the card's isolated framework and app worktrees. Do not run the main checkout's absolute-path package scripts. Build the x86_64 runtime in the isolated framework first. Then:

```sh
# From the isolated app; E is a new evidence directory owned by this run.
python3 tests/runtime-dyswipe/make-slow-videos.py "$E/media"
python3 tests/runtime-dyswipe/slow-cdn.py --root "$E/media" --port 18758 --kbps 300 --ttfb-ms 600 --log "$E/requests.jsonl"
adb -s emulator-5558 reverse tcp:18758 tcp:18758
# FW and APP refer to the isolated worktrees.
PODJS_ANDROID_ABIS=x86_64 ORG_GRADLE_PROJECT_podAbis=x86_64 bun "$FW/packages/cli/src/cli.ts" package android-watch --project="$APP/tests/runtime-dyframe"
```

Use the shared task harness to boot emulator 5558 with `-no-audio` and install the generated debug APK. The activity is `dev.podjs.androidwatch.MainActivity`. This fixture never calls Douyin, loads credentials or obtains detail URLs. Its registered sources all point to `127.0.0.1:18758`. Apply the task's non-loopback UID network block before launch. Keep the owned emulator awake and dismiss its charging overlay (emulator-only `dumpsys battery unplug`; restore with `dumpsys battery reset` during cleanup).

For controlled native measurements, assemble and install `:runtime:assembleDebugAndroidTest`, then run:

```sh
adb -s emulator-5558 shell am instrument -w -r -e class dev.podjs.runtime.PodVideoKeyframeDeviceTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner
```

The instrumentation APK writes `files/dyframe-evidence/measurement.json`, `cached-frame-zero.png` and `live-frame-zero.png` under its `run-as dev.podjs.runtime.test` directory. It measures dispatch-to-HWUI-window-commit latency for five live-standby, five cached and six cold samples. Cold timing includes retiring the previous live surface. It verifies seven frame buffers survive sequential worker release, exact frame-zero parity within MAE < 2, and more than three live decoders on the tested ranchu AVC profile. The visibility probe requires window focus and a real window commit. A 250 ms commit wait timeout never counts as success: it re-arms within the 18 second deadline, and `commitWaitTimeouts` records this condition. All that wait stays in the measured latency. It records PSS, cache bytes and active/peak decoder leases, then checks zero owned cache bytes and leases after close.

These measurements do not include gesture delivery and do not prove physical display latency. Emulator results are not watch acceptance. The physical-device live decoder ceiling remains three; only the tested small AVC/ranchu profile may admit eight. Do not run this instrumentation class on the watch.
