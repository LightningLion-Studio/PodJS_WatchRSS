# ADB shell commands (release and debug)

The installed application exposes `content://<applicationId>.podjs.shell` in both
release and debug. `call()` accepts only Binder UID 2000 (shell) or 0 (root).
Other UIDs receive the same `SecurityException("denied")` before arguments or
configuration are read. No signature permission, debuggable flag, caller package,
URI grant, or supplied UID can bypass that check. The provider has no query,
insert, update, delete or file data path.

Complete normal first-run setup before using commands. Start the launcher with
ADB before calling commands. Android 15 blocks a background provider from opening
an Activity; the channel does not bypass this platform restriction. It waits for
application command registration, then
executes commands in FIFO order on the main-thread guest. It holds at most eight
requests. Each call has a 15-second timeout including registration/queue wait.
Expired queued commands do not execute. Running handlers receive cancellation;
a completed navigation or playback action is not rolled back by a later timeout.
A process/guest replacement rejects pending work rather than replaying it.

| Method | JSON argument | Result / action |
|---|---|---|
| `douyin.open` | omitted or `{}` | Open the Douyin cover page; does not press its play arrow. |
| `douyin.play` | `{"index":0}` or `{"awemeId":"123456789"}` | Select and start video playback. Exactly one selector is required. |
| `douyin.pause` | omitted or `{}` | Pause the active Douyin player, including its current session. |
| `douyin.resume` | omitted or `{}` | Resume the active Douyin player. |
| `douyin.next` | omitted or `{}` | Start the next item in the playback queue. |
| `douyin.prev` | omitted or `{}` | Start the previous item; queue boundary returns `not_found`. |
| `douyin.state` | omitted or `{}` | Return the fixed playback fields below. |
| `diag.dump` | omitted or `{}` | Return numeric SQL worker totals and video session counters. |

`index` is zero-based, within the current playback playlist or restored feed.
If that index is missing, the app requests one bounded feed page (at most 20
items). Valid indices are 0–199. `awemeId` is 1–32 decimal digits in a string;
when absent from the playlist, normal playback resolution runs. The channel
rejects every other argument. Normal product network/authentication rules apply.
No shell command imports or exports authentication data.

Every response Bundle contains `ok` (boolean), `error` (fixed code, empty on
success), and `json` (serialized result, `null` on failure). Control commands
return a state snapshot after their action. `play`, `next` and `prev` wait up to
10 seconds for the player to report `playing`; this is not a first-frame or
performance guarantee. `pause` and `resume` target the actual active session.
Play success belongs to the requested target and its published source; an older
playing video cannot satisfy it. Cancellation or a failed wait closes this
request's pending source publications.

State fields: `page`, `playbackState`, `position` (milliseconds), `bufferedMs`
(buffered duration ahead), `rebufferCount`, `decoderInstances`, `pssKb`.
`decoderInstances` counts Media3 video decoder lifetimes observed by this process;
release initiation removes a decoder from the count. It is not the codec's
advertised maximum. `pssKb` is Android's current process PSS in KiB.
Background playback remains counted after the Activity detaches. The playback
service keeps the numeric observer until decoder release or player termination.
`diag.dump.sql` has `sql.query`, `sql.execute`, `sql.transaction`, and
`sql.gzipJson` categories. Each reports completed count, queue/wall/CPU nanoseconds,
and failures for the current foreground guest. These counters survive periodic
log emission and reset with that guest. Session `active`, `created`, and `released`
count explicit Media3 session objects, not decoder leases. Snapshots of different
lanes are not a simultaneous sample.

Errors include `unknown_command`, `invalid_argument`, `busy`, `timeout`,
`unavailable`, `not_ready`, `not_found`, `command_failed`, `result_too_large`.
Argument JSON is limited to 8 Ki characters. Result JSON is limited to 32 Ki
characters. Error messages never include caught exceptions, arguments, SQL,
URLs, file paths, cookies, accounts, or tokens.

Use an explicit serial. These examples assume an emulator assigned to this task:

```sh
adb -s emulator-5588 shell am start -W -n com.lightningstudio.watchrss.podjs/dev.podjs.androidwatch.MainActivity
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.open
adb -s emulator-5588 shell 'content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.play --arg '\''{"index":0}'\'''
adb -s emulator-5588 shell 'content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.play --arg '\''{"awemeId":"123456789"}'\'''
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.pause
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.resume
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.next
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.prev
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method douyin.state
adb -s emulator-5588 shell content call --uri content://com.lightningstudio.watchrss.podjs.podjs.shell --method diag.dump
```

There are no like, follow, comment, favorite, share, login, logout, arbitrary JS,
arbitrary SQL, file access, cookie, account, or token commands. The old debug-only
external interface remains a separate ABI; this channel does not call it.

## Offline acceptance fixture

`tests/adbentry/build-fixture.py <framework-cli.ts>` builds the same command and
player code as a signed, non-debuggable release. It substitutes the production
transport package import at build time and restores `package.json` in `finally`.
The installed fixture ID is `com.lightningstudio.watchrss.adbentry`.
`src/main.tsx` does not import the fixture entry. The fixture seeds only three
synthetic videos and a synthetic session marker. Its API transport never forwards
a request; its only media URL is `http://127.0.0.1:18876/video.mp4`.
Serve a generated test MP4 on the host and use task-owned emulator ADB reverse.
Before launching the fixture, use `tests/adbentry/isolate.py <serial>` to reject
its UID’s IPv4/IPv6 output outside loopback. System ADB traffic keeps its own UID.
Never run this fixture on a physical device or import real credentials.

`tests/adbentry/denied-app` is an ordinary app with no permissions. Build it with
`build-denied-app.sh <evidence-dir>`, install it beside the fixture, and launch
`dev.podjs.adbentry.denied/.MainActivity`. It must log `denied=3 unexpected=0` for
known, unknown, and malformed calls. Keep APKs, screenshots, and logs outside git.
