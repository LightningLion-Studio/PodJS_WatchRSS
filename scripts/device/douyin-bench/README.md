# DYBENCH — Douyin device acceptance

Offline delivery from app baseline `ffb73a86`. No APK is installed by this tool.
Thresholds are **proposals for Lead review**, not measurements of build 1196.
`PASS`, `FAIL`, `PENDING`, and `SKIPPED` describe acceptance evidence. A successful
command or synthetic test does not establish device parity.

## Offline quick start

Python 3.10+, Pillow, ffmpeg with `libx264rgb`, and ffprobe are required for video
analysis/tests. Core log/dump analysis uses the Python standard library. Install
missing dependencies in an operator-owned environment, never main node_modules.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/device/douyin-bench -v
python3 scripts/device/douyin-bench/bench.py plan
python3 scripts/device/douyin-bench/bench.py dry-run --out /tmp/dybench-fixtures
python3 scripts/device/douyin-bench/bench.py analyze /tmp/dybench-fixtures
```

The fixture generator creates a **synthetic** epoch logcat recording, a 0.4 s
lossless MP4, reference images, HWUI/memory fixtures, and calibration JSON. It
contains 30 successful event pairings with one deliberately slow 250 ms switch,
one black frame, and one spinner. The expected summary is **FAIL**, with
`p50=50`, `p95=50`, `max=250` for incoming-frame latency. This verifies that the
analyzer catches defects. `synthetic=true` always blocks device `PASS`, even
when all synthetic limits are met. Existing fixture directories are never replaced.

## Ownership and embedded safety

Only the Lead-assigned device owner runs `run`. The owner file is fixed at the
main checkout's `.codex-tmp/device/DEVICE_OWNER`. `--owner wrss-NAME` must match it
before **every** ADB invocation. The serial is fixed to `e3aca8af`; there is no
phone selector. The tool neither claims nor releases ownership. A host flock
prevents two DYBENCH runners from overlapping; it does not supersede DEVICE_OWNER.

The live interface contains only center swipes, sleep/wake, screen protection,
read-only logcat/dumpsys/ps, and harness-owned screenrecord files. There is no
install/uninstall, clear, force-stop, SQL, account API, arbitrary tap, login,
network-setting, or phone command. Never like, follow, comment, favorite, or
share during manual steps. Never use account credentials as command arguments.

Before automated work, `screen.json` journals the original brightness, brightness
mode, and timeout. Brightness becomes 10 in manual mode. A long timeout (>120 s)
is replaced with 30 s and remains 30 s at restoration, as DEVICE_BRIEF requires.
Other original values, including unset (`null`), are restored. Waiting at a host
prompt sleeps the watch unless the QR/user scan step must remain visible. Final
cleanup sleeps the watch and reads back all three settings. An owner change or
disconnection can prevent restoration: check `screen.json` and do not claim
restoration. After reconnect/assignment, recover with:

```sh
python3 scripts/device/douyin-bench/bench.py restore-screen --execute \
  --owner wrss-device --journal /private/dybench/run/screen.json
```

`SIGINT`, `SIGTERM`, exceptions, and ordinary exits run cleanup. A host kill/power loss
cannot execute cleanup; the durable journal is the recovery source. If interrupted
while recording, the own 7 s screenrecord expires naturally. Only the unique
`/sdcard/dybench-<uuid>.mp4` file is removed. Existing recordings/artifacts are
never removed. No settings change is made for network degradation.

Automated swipes/recording require a fresh (≤2 s) `player_visible state=present`
heartbeat. Missing/stale/hidden player state stops before input/capture. An auth
request during a recording discards that own clip without pulling it. A scenario
name alone never establishes that the current page is safe to record.

## Device preflight and build 1196

1. Lead builds/installs the approved APK using the separate device protocol.
   DYBENCH cannot install it. Preserve the formal package's data verification.
2. Owner confirms package and build from the installation handoff. Both known
   package names are supported; require `--package`, never guess from history.
3. Compare the current home with
   `.codex-tmp/device/shots/s4-k8-home-after-cold.png`, using pixel statistics and
   dimensions. Stop if the physical 466×466 layout differs. The runner requires
   `layout-ok`; that assertion is operator evidence, not automatic layout proof.
4. Confirm the center swipe corridor contains the player, with no account action
   buttons. The fixed gestures use **physical** coordinates on a 466×466 display.
   Use `--step` to recheck the page before every swipe. Stop on unexpected pages.
5. Handle charging/system overlays according to DEVICE_BRIEF outside DYBENCH.
   The tool does not click overlays or inject the crown key.
6. The user performs any required login/scan. Do not operate the phone. No login
   page/QR screenrecord is permitted by the runner.
7. Ensure release timing codes in [CODES.md](CODES.md) are available. Without them,
   collect evidence but expect `PENDING`. Missing logs never mean zero latency.

## Run each scenario twice

For each scenario below, run once with `--restore idle` and once with
`--restore running`, into distinct new private directories. The tool detects
mode from continuous logcat `restore_state` heartbeats, **not** the flag. A gap
>2 s, a mode transition, a missing initial heartbeat, or unknown state blocks
mode verification. Current cloud worker progress is retained as coarse activity
only. Worker completion does not prove idle or final restore ACK. The runner
never starts, pauses, clears, or completes a restore itself.

Example commands (replace owner/package with the installation handoff):

```sh
python3 scripts/device/douyin-bench/bench.py run --execute \
  --owner wrss-device --package com.lightningstudio.watchrss \
  --scenario next --restore idle --record --step --out /private/dybench/idle-next
python3 scripts/device/douyin-bench/bench.py run --execute \
  --owner wrss-device --package com.lightningstudio.watchrss \
  --scenario next --restore running --record --step --out /private/dybench/restore-next
```

Use `--scenario` with each row below. `--count` supports short diagnostic runs,
but cannot reduce the acceptance sample minimum. The default `plan` command
prints all 24 scenario/mode combinations and minimum durations. Time estimates
exclude navigation, dump overhead, calibration, and human approval/scan waits.
Budget about 60–90 minutes **per mode**, plus manual video review; a complete
matrix takes roughly 2–3 hours before review, depending on device/dump speed.

| Scenario | Minimum samples per mode | Driver / preparation | Lower-bound duration |
|---|---:|---|---:|
| `cold_open` | 5 | Owner closes/opens app manually, opens Douyin. Never stop the cloud worker. Log `entry_start` on cold controller creation. | 75 s |
| `home_entry` | 5 | Owner navigates home, activates Douyin after ENTER. | 75 s |
| `refresh` | 30 | Owner performs one pull-to-refresh per ready prompt. | 5 min |
| `next` | 30 | Automatic center upward swipe; begin with available prewarmed neighbor. | 4 min |
| `prev` | 30 | Automatic center downward swipe; seed enough history. | 4 min |
| `cancel` | 30 | Automatic 20 px drag (below commit threshold); confirm same generation resumes. Adjust only after reviewing gesture policy. | 4 min |
| `fling` | 30 | Owner makes one fast fling across two cards. Requires `fling_done delta=2`; two separate swipes do not substitute. | 4 min |
| `soak` | 200 | Automatic next swipes, no account actions; keep CPU/memory sampler running. | 27 min |
| `mute` | 20 ON + 20 OFF | At every ready prompt, owner toggles system mute ON then OFF on the watch while the same video plays. Restore original mute state. | 5 min |
| `login` | 1 user-assisted cycle | Explicit **WAIT FOR USER SCAN** prompt; observe up to 120 s per trial, then mark missing completion PENDING. User scans only when present. | 2.5 min + user |
| `logout` | 1 explicitly approved cycle | See runtime approval below; re-enter and verify `needs_login` immediately. | 15 s + user |
| `login_tap` | 1 per available auth state | Owner taps 登录 once. Verify QR, no auth-clear effect, and auth-state snapshots before/after. Exercise both absent/present states when the button is available; never force an account state. | 15 s + user |

For `fling`, `refresh`, home/cold entry, mute, and auth tests, ENTER starts an
observation window; **ENTER is never the latency origin**. Perform the action
within the 5 s window (15 s for mute/logout). The origin is the actual host/UI event. Login has a longer
120 s observation window with bounded wake pulses every 15 s. Missing an event yields `PENDING`, not a fabricated
host-command latency. For swipe scenarios use `--record`; other scenarios use
closed UI events. Do not record login, logout, or QR/account pages.

Logout requires both the flag and a new typed approval for this run:

```sh
python3 scripts/device/douyin-bench/bench.py run --execute \
  --owner wrss-device --package com.lightningstudio.watchrss \
  --scenario logout --restore idle --allow-logout --out /private/dybench/idle-logout
```

The operator must type `APPROVE LOGOUT`. The runner still never taps logout.
The user/operator performs the approved action within the 15 s observation window. Re-entry after logout must show
`需要登录` without an intermediate `刷新中`. A later login is user-controlled;
authorization for this logout does not authorize future logouts or scans.

**Degraded network: SKIPPED.** No verified safe watch-only throttling control was
provided. Do not change Wi-Fi, mobile data, router, or phone settings to invent
this case. Lead can define a reviewed watch-settings procedure later, preserving
and restoring original network state, then repeat the same matrix in a separate
condition. Cloud restore state must still be detected independently.

## Proposed acceptance limits

`thresholds.json` is the executable source. Each run copies it for reproducible
reanalysis and stores its SHA256 in `summary.json`. Percentiles use nearest rank;
report `n`, missing pairs, p50, p95, max. Small runs never pass sample coverage.
Measure with monotonic **uptime** timestamps, not log arrival times.

| Metric | p95 | max / absolute limit |
|---|---:|---:|
| Cold/home entry → first card | 2000 ms | 4000 ms |
| Refresh request → settled new card/error | 2000 ms | 4000 ms |
| Release → previous audio stopped (mixer observation) | 50 ms | 100 ms |
| Release → incoming frame presented for target generation | 100 ms | 200 ms |
| Cancel release → original generation snapped back | 200 ms | 300 ms |
| One fling → two-card target settled | 300 ms | 500 ms |
| System mute ON → matching actual audio state | 100 ms | 200 ms |
| System mute OFF → matching actual audio state | 100 ms | 200 ms |
| Login UI entry → rendered QR visible | 5000 ms | 10000 ms |
| Scan accepted by watch → app auth persisted | 2000 ms | 5000 ms |
| Logout tap → visible feedback | 100 ms | 200 ms |
| Post-logout re-entry → 需要登录 visible | 100 ms | 200 ms |
| Prewarmed spinner frames / drag black gap / discontinuity | 0 | 0 confirmed frames |
| HWUI >16.667 ms frames | — | ≤5% (confirm panel refresh rate with owner) |
| Per-process memory growth, after first minute | — | ≤1 MiB/min; ≥5 samples over ≥2 min |
| Renderer crashes / closed error events | — | 0 |
| Login tap clears auth / logout entry shows 刷新中 | — | 0 |

No threshold is silently relaxed for background restore. Keep running/idle
results separate. Known regressions fail even when other evidence remains
missing. A missing metric, uncalibrated video, unknown restore state, or failed
screen cleanup prevents a whole-scenario PASS. Summary PASS is limited to the
listed checks; it never proves overall parity or cloud final-head ACK.

## Video analysis and calibration

The runner records one bounded 7 s clip per swipe, at 500 kbit/s. Budget about
90 MiB for a 200-swipe soak, plus small JSON; no userdata/APK snapshots. Keep
outputs in private storage outside the repo, mode 0700. Outputs can show user
video content; share only reviewed statistics. Raw logcat, cookies, URLs, QR
payloads, descriptions, and account identifiers are not persisted. Login video
is blocked. Generated fixtures are tiny and contain no personal data.

Analyze actual screenrecord with a separately reviewed calibration file:

```sh
python3 scripts/device/douyin-bench/bench.py video /private/dybench/idle-next/clip-000.mp4 \
  --calibration /private/dybench/idle-next/calibration-000.json
python3 scripts/device/douyin-bench/bench.py analyze /private/dybench/idle-next
```

Calibration example (normalized x0,y0,x1,y1; values below are illustrative):

```json
{
  "seq": 101,
  "content_roi": [0.25, 0.2, 0.75, 0.8],
  "spinner_roi": [0.4, 0.4, 0.6, 0.6],
  "template": "spinner-reference.png",
  "previous": "previous-reference.png",
  "incoming": "incoming-reference.png",
  "offsets": {"35": 0.25, "36": 0.5, "37": 0.75},
  "window_ms": [1000, 1800],
  "sync_error_ms": 15,
  "human_reviewed": true,
  "black_level": 12,
  "black_fraction": 0.98,
  "change_mae": 8,
  "spinner_mae": 12,
  "strip_mae": 18
}
```

Use actual video **PTS**, not assumed 30/60 fps. Restrict `window_ms` to the
annotated gesture. Align the gesture to the release event by a reviewed visual
marker/input trace; record synchronization uncertainty. Record launch brackets
are stored but **are not** video synchronization. If uncertainty exceeds 20 ms,
video remains uncalibrated. Numeric `seq` must match a unique observed release.

Select content ROI inside the round active viewport, excluding letterboxing,
action icons, and unrelated overlays. Review dark source content before calling
it a black gap. Match a spinner template through 12 rotations using pixel MAE.
Annotate actual translations with source-reference strips at selected drag
frames; the analyzer constructs the expected old/new composition and measures
MAE. Use time-matched references if either video moves. For reverse drags, rotate
clip/reference images 180° before annotation, or analyze an equivalent upward
coordinate system. Verify the original images/coordinates in the handoff.

`first_changed_pts_ms` is only pixel change from the first analyzed frame. A cover
or overlay can change pixels. It **never substitutes** for generation-bound
incoming decoded/presented-frame evidence. The report includes per-frame pixel
statistics, black runs, spinner count, strip error count, and p50/p95/max of clip
observations. Unreviewed video statistics are observations, not confirmed defects.

## Audio, graphics, memory, and missing evidence

- Every ~5 s: sample both `dumpsys audio` and `dumpsys media.audio_flinger`.
  Persist only closed/numeric metadata, acquisition interval, and dump length.
  Focus count, ringer mode, and master mute are supporting evidence. They do not
  prove which decoder is audible. Generic dumps cannot resolve 50–100 ms latency.
- No vendor mixer-table layout is guessed. An audited per-track mixer adapter or
  external PCM capture is required for audio acceptance, with PID/session binding,
  timestamp uncertainty ≤20 ms, sample period ≤20 ms, and source SHA256. Only then
  can Lead set `audio_adapter_reviewed=true` in the run manifest and supply
  corresponding normalized mixer events. `backend=player` never satisfies actual
  audio metrics. Preserve the adapter/proof with the report. This adapter is a
  **known missing device-specific dependency**, not implemented/verified offline.
- `gfxinfo framestats` is cumulative; repeated rows are deduplicated. Nonzero flags,
  missing/invalid rows, and unfinished sentinel frames are excluded. Host uptime
  event bounds restrict frames to the observed run. Without bounds, graphics
  observations are unscoped and cannot establish jank acceptance. HWUI timing
  does not measure decoder/TextureView presentation; use video/frame codes too.
- Sample app processes and WebView/sandboxed-process candidates separately with
  `dumpsys meminfo <PID>`. Unknown/denied PSS is missing evidence, not zero. First
  minute is warmup; never join a regression across PID restarts. Candidate WebView
  processes may belong to another app. `renderer_attribution` defaults false.
  Lead must attach reviewed renderer→app PID evidence, label corresponding memory
  rows `role=renderer_attributed`, and set that flag for soak acceptance. If the
  renderer is absent for the entire run, attach the process evidence and set
  `renderer_absent_verified=true` instead of fabricating memory rows. No app/renderer is killed to simplify memory readings.
- Browser codes are counted separately. `browser_script_error` is an ERROR-console
  diagnostic; it can precede `qr_ready/completed`. `service_closed` can occur
  without an active request. Neither alone proves login failed. A renderer-gone
  callback counts as a renderer crash observation. Native `completed` is distinct
  from app auth persistence and UI entry state.

See [CODES.md](CODES.md) for the exact existing-source inventory and proposed
closed-code contract. Baseline builds will intentionally report PENDING for
unsupported timing, actual audio, renderer attribution, and restore coverage.
