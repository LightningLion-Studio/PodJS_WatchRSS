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
