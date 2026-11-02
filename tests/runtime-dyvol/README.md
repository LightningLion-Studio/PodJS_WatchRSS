# DYVOL local functional fixture

This page mounts the production `VideoPlayerScreen`, framework bridge, Media3 player and system audio observer. It makes no Douyin account request. Three local sources exercise swipes. The magenta entry page provides a pixel reference for see-through checks. This fixture does not test product icon assets; use the full app for that UI check.

Use only the task emulator `emulator-5558`. Never install this configuration on the watch.

1. Build this project with the paired framework CLI and x86_64 ABI:

   ```sh
   PODJS_ANDROID_ABIS=x86_64 ORG_GRADLE_PROJECT_podAbis=x86_64 bun "$FW/packages/cli/src/cli.ts" package android-watch --project="$APP/tests/runtime-dyvol"
   ```

2. Generate a local video with an audio track:

   ```sh
   ffmpeg -f lavfi -i color=c=0x1450c0:s=320x480:r=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k -shortest dyvol-local.mp4
   ```

3. Install the debug APK. Push the video to `/data/local/tmp/dyvol-local.mp4`. Use `run-as com.lightningstudio.watchrss.podjs` to copy it to `files/podjs/files/dyvol-local.mp4`.
4. Start `dev.podjs.androidwatch.MainActivity`. Capture the magenta entry, then tap its center.
5. Set STREAM_MUSIC with `adb -s emulator-5558 shell cmd audio set-volume 3 N`. Compare the percentage with `round(100 * index / max)` from `dumpsys audio` and `cmd media_session volume --stream 3 --get`.
6. Inject crown events with `adb -s emulator-5558 shell cmd input rotaryencoder scroll --axis SCROLL,1`. Use `SCROLL,-1` for the reverse direction. Positional `scroll 1` did not deliver the intended axis in this AVD.
7. For a controlled exposed-floor image, drag down from the first item and capture while held. Restart the fixture before testing valid next-item swipes. Use a long upward swipe and capture during its injected motion to test the real transition.

`T-DYVOL` evidence contains per-action screenshots, the system stream blocks, OCR results, mixer state, and exact build hashes. Emulator timing does not establish watch or human listening acceptance.
