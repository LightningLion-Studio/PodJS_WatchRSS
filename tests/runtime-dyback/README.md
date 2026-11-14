# Offline swipe-back emulator fixture

Use only a dedicated 466×466 WatchRssPodJsMigration emulator. The application ID
is `com.lightningstudio.watchrss.dyback.test`. Do not install on a watch/phone or
use the production application ID.

`prepare.py <absolute-output-directory> [--baseline --baseline-ref <commit>]` copies the production
sources outside the checkout. `--baseline` reads the committed root/player with
`git show <commit>:<path>` (default `origin/master`). Pin the original commit
when comparing behavior. The fixture changes only:

- Initial routes: home → synthetic Douyin entry → a local video at index 2.
- Diagnostic KV values `dyback.state` and `dyback.player` for assertions.
- An unused Wi-Fi-settings shim: the supplied migration SDK lacks the
  `systemSettings` export required by master. This does not validate a full
  production build and must not enter a release bundle.

The test entry mounts the production WatchRSS root synchronously. It does not
start cloud sync, phone sync, or onboarding. The Douyin transport throws before
native IO. Playback-header, local-cache lookup, queue persistence and history
ports use synthetic data. No cookie or credential is imported. Keep Wi-Fi and
mobile data disabled.

Build the generated `tests/runtime-dyback` project with the migration framework
CLI. Generate a local 480×270 H.264/AAC clip, and copy it as `fixture-0.mp4` and
`fixture-1.mp4` into the test app's `files/podjs/files/` directory. All eight
synthetic queue entries repeat those two files. The initial Douyin player uses
expanded scale to reproduce the original unreachable horizontal-pan boundary.

Example physical gesture (always specify the authorized emulator serial):

```sh
adb -s emulator-5584 shell input swipe 60 233 410 233 500
adb -s emulator-5584 exec-out screencap -p > after.png
adb -s emulator-5584 shell run-as com.lightningstudio.watchrss.dyback.test \
  cat files/podjs/podjs-kv.json
```

After settling, `dyback.state.pages` must be `["home"]`. Leftward or short
rightward swipes must retain the player. Vertical swipes must select adjacent
local queue items. The progress display in the current production player has
no scrub recognizer; verify its existing seek buttons separately.

The fixture defaults `dyback.platform` to `douyin`. To compare `bili` and `rss`,
stop only this test application, change that key in its own KV file, and restart.
These modes use the same local clip and synthetic parent route. Standard mode
returns to that parent. Expanded mode first pans to the image boundary, then
allows Back. Do not interpret the synthetic parent as platform business routing.

Stop the emulator by its recorded launch PID. Unit regressions are in
`douyin-back-target.test.ts`, `right-swipe-back.test.ts`, and the three DYBACK
cases in `douyin-player-component.isolated.ts`.
