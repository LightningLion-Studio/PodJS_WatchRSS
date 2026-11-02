# DYENTRY local fixture

Mounts the production ImmersiveEntry and VideoPlayerScreen. The feed port has a
fixed 1600 ms successful response. Initial cached items are local; all playback
uses one H.264/AAC file. No account client, credentials, HTTP transport, browser,
or background service is instantiated. Icon placeholders are not icon acceptance.

Use the assigned emulator-5558 only. Boot and install through
`.codex-tmp/cloud-v2/tools/emu-douyin.sh` in the parent OPPO_Develop directory.
Disable emulator Wi-Fi and mobile data. Never call open-douyin/import-cookies.

With private dependencies linked to the paired framework worktree, build via:

```
PODJS_ANDROID_ABIS=x86_64 ORG_GRADLE_PROJECT_podAbis=x86_64 bun <framework>/packages/cli/src/cli.ts package android-watch --project=<app>/tests/runtime-dyentry
bash tests/runtime-dyvol/make-video.sh /tmp/dyentry-local.mp4
adb -s emulator-5558 push /tmp/dyentry-local.mp4 /data/local/tmp/dyentry-local.mp4
adb -s emulator-5558 shell run-as com.lightningstudio.watchrss.podjs mkdir -p files/podjs/files
adb -s emulator-5558 shell run-as com.lightningstudio.watchrss.podjs cp /data/local/tmp/dyentry-local.mp4 files/podjs/files/dyentry-local.mp4
adb -s emulator-5558 shell setprop log.tag.PodJSService DEBUG
adb -s emulator-5558 shell am start -n com.lightningstudio.watchrss.podjs/dev.podjs.androidwatch.MainActivity
```

At the entry, drag downward to refresh. Tap the bottom arrow to play. Wait for a
fresh native player_visible/playing/has_frame=true record before audio checks.
Physical mute button bounds are x=169..297, y=128..192 at 466x466. A drag between
y=300 and y=190 overlaps it. Drag recognition must suppress its tap handler.

Evidence scripts and the 30-refresh, 92-audio-action, and 40-drag matrices live in
`evidence/T-DYENTRY/`. They hardcode emulator-5558. Emulator timings do not prove
watch performance, mixer output, physical audio, or real-feed behavior.
