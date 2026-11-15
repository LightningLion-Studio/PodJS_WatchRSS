# DYENTRY offline acceptance fixture

Mounts production ImmersiveEntry, VideoPlayerScreen and startupActivityNavigation.
The DouyinClient uses a synthetic in-memory cookie and a throwing HTTP adapter.
The only host HTTP source is http://127.0.0.1:18788/fixture.mp4. No platform client
request can reach the network. No account or physical watch is used.

Generate a 90-second H.264/AAC test-pattern MP4 named fixture.mp4 in an evidence
directory. Static SMPTE bars keep the mock transfer small. Playback timestamps
provide the lifecycle position evidence. Use this command under the task lock:

```sh
ffmpeg -f lavfi -i smptebars=size=320x480:rate=15 -f lavfi -i anullsrc=r=44100:cl=mono -t 90 -c:v libx264 -preset ultrafast -crf 30 -c:a aac -movflags +faststart fixture.mp4
```
Serve it with `python3 tests/runtime-dyentry-session/server.py --media <fixture.mp4> --log <requests.jsonl>`.
The server listens on loopback and supports HTTP ranges.
Create a new AVD with DYENTRY in its name. Verify its AVD name with the explicit
emulator serial before every test run. Reverse only port 18788 on that emulator.
Build this project with the locked framework CLI, then assemble a debug x86_64 APK
with appId dev.podjs.dyentryfixture and the project's Android resources/theme.
Use the task's flock lock, capmem 16G, --no-daemon and two Gradle workers.

1. Launch and press Open Douyin mock. Wait: cover stays visible, no play event.
2. Tap the arrow: one play event, then first_frame and increasing progress.
3. Screen off/on: same video resumes at the last position without a new play event.
4. Home/relaunch: same video resumes without a new play event.
5. To repeat a fresh home entry, clear only this fixture app on the owned AVD.
   Hardware Back on this API 35 host dismisses the fixture to the watch face;
   it is outside this fixture's navigation acceptance.
6. Force-stop/relaunch while playing: saved player restores its parent cover.
7. Capture private `files/podjs/files/dyentry/evidence.json`, native video logcat,
   screenshots, and localhost server requests.
   `forbidden_request` and `fixture_failed` must be absent.

All adb commands must use the owned emulator serial. Stop the owned server and
emulator by PID after evidence collection. Keep generated media/APKs/logs outside
commits. This fixture verifies mock navigation and lifecycle, not live Douyin.
