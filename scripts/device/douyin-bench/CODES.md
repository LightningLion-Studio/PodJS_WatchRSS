# Timing sources and missing closed codes

This inventory was read offline, not observed on build 1196. Application paths
refer to `ffb73a86`. Framework paths refer to the current `podjs-watch` checkout;
Lead must check the actual APK source revision. No product instrumentation was
added in this patch. A parser for proposed events is not proof they exist.

## Existing sources

Framework root: `/home/wilf/data/PodJS/podjs-watch`.

| Source | Existing signal | Limitation |
|---|---|---|
| `platforms/android/runtime/src/main/java/dev/podjs/runtime/PodBrowserAuthServices.java:104` | Direct release logcat `PodBrowserAuth code=requested` | No explicit attempt ID/uptime |
| Same file, lines 167,174,313 | `page_started`, `page_finished`, `opened` | Navigation/dialog events, not visible QR |
| Same file, lines 152,183 | `browser_script_error`, `webview_renderer_gone` | Script diagnostic is any page console ERROR; renderer event lacks PID binding |
| Same file, lines 351,474 | `completed`, `qr_ready` | Native completion/QR extraction; not app persistence/rendered QR proof |
| Same file, lines 109,360 | `service_closed`, `unavailable`, `busy`, `invalid_argument`, `webview_unavailable`, `cancelled`, `webview_http_<status>`, `webview_load_<integer>` | `service_closed` can occur with no pending request |
| `PodBrowserAuthDeadline.java:6,24-27` | `browser_auth_timeout`, `browser_qr_timeout`, `browser_script_error` | 300 s session deadline; 75 s no-QR deadline; diagnostic and terminal code can share spelling |
| `src/logs/logger-host.ts:11-14` | AppLogger forwards redacted lines to console | Does not guarantee a fixed Android logcat tag or release availability; do not parse arbitrary free text |
| `src/ui/douyin/ImmersiveEntry.tsx:64,75` | `DouyinEntry` feed requested/settled with reason/item count/login state | Settled JS state is not a presented card; free-text format, no gesture correlation |
| `src/douyin/client.ts:257`, `src/ui/VideoPlayerScreen.tsx:147,170` | `DouyinTiming` resolve, firstFrameObserved; `VideoPlayer` ready | First frame polling can be delayed, no common release timestamp; ready can still show a cover |
| `src/media/video-opt.ts:82-88` | `VideoOpt` JSON stages api/candidate/prepare/first_frame/sample/exit; numeric sourceGeneration/firstFrameMs/rebuffer/dropped fields | Douyin metrics require the metrics feature flag; optional/debug evidence, not unconditional release codes |
| `src/ui/douyin/video-sessions.ts:148,192` | Debug lookahead prewarm start / promotion messages | Contains platform IDs; intentionally not persisted by this harness; start is not prewarm completion |
| `platforms/android/runtime/src/main/java/dev/podjs/runtime/PodVideoSessionServices.java` | Session state/capability/transition/promote/hasRenderedFirstFrame fields | No unconditional release timing log for touch release, audio cutoff, or displayed target frame found |
| `src/cloud/background-diagnostic.ts:39`, framework `PodCloudWorker.java:32-54,99-101,126` | Closed/numeric CloudRecords file diagnostics are summarized as `PodJSCloudWorker guestStage=… outcome=…`, progress/stage, finished/status | Collector preserves an allowlisted coarse activity subset. Not continuous running/idle restore coverage; finished may schedule another window |

The harness captures only `PodBrowserAuth`, proposed `DYBENCH`, and coarse
`PodJSCloudWorker` from logcat. It never dumps private app_log.txt or retains
free-text console logs. Existing browser events are counted, not automatically
paired into trustworthy latency: overlapping requests, missing begins, and the
shared script-error spelling make inferred request numbering unsafe.

## Proposed unconditional release contract for Lead

Emit a dedicated native Android tag **DYBENCH**, INFO level, with closed codes,
booleans, and bounded nonnegative integers only. A generic framework telemetry
host method can carry the closed app event; do not add arbitrary text logging to
release. No URLs, cookies, tokens, QR pixels/payloads, content IDs, user IDs,
descriptions, title text, or service arguments.

Wire format example:

```text
I DYBENCH: code=gesture_release seq=41 mono_ms=5060123 direction=next prewarmed=true generation=18 source_generation=17
I DYBENCH: code=incoming_first_frame seq=41 mono_ms=5060160 generation=18
```

Every event carries `mono_ms = SystemClock.uptimeMillis()` at the actual event,
not after async logging. Uptime shares the HWUI frame clock domain; **do not use
elapsedRealtime** (deep sleep changes that offset). `seq` is a monotonically
increasing action ID for the capture; auth events also carry `attempt`. Never
reuse a seq in one capture. Every begin and its terminal observation carry the
same `(seq, attempt)`; duplicates/overlap/missing IDs invalidate that sample.
For mute ON and OFF, allocate separate seq values. Emit failures as `code=error`
with the corresponding IDs; never substitute a success endpoint on failure.

| Code | Exact emission point and required fields |
|---|---|
| `entry_start` | Cold entry/controller activation or explicit post-logout re-entry, before work; seq |
| `home_entry` | Home Douyin activation handler before navigation/work; seq |
| `first_card` | First actual feed card presented by renderer, not feed fetch resolution; same seq |
| `refresh_start` | Accepted pull-to-refresh release before network work; seq |
| `refresh_done` | Result UI actually presented (normal/error UI), same seq; accompany closed error on failure |
| `player_visible` | Foreground player-only heartbeat every ≤1 s, state=present/absent; present only while unobscured by auth/settings/system UI. Required fresh (≤2 s) before automated swipe/record; missing heartbeat stops safely. |
| `gesture_down` | Native gesture owner accepts touch; seq, direction |
| `gesture_release` | ACTION_UP/gesture commit decision; seq, direction=next/prev/cancel/fling, prewarmed=true/false, generation=target, source_generation=old |
| `previous_audio_stopped` | **Observed mixer** old track silent/inactive, not pause request completion; seq, source_generation, backend=mixer. If verified silent before release, emit current verified observation at release (zero delay). Never invent this from player state. |
| `incoming_first_frame` | Target generation decoded frame is **presented at target bounds**, after promotion; same seq/generation. Hidden prewarm first-frame callback is not this event. |
| `spinner_shown` | Loading ring first visibly rendered after the 400 ms first-frame wait, same seq/generation; no hidden/prewarmed spinner endpoint. |
| `snap_back` | Cancel settles original bounds and original generation resumes, same seq/generation (release generation=original for cancel) |
| `fling_done` | One fling settles the actual target two indices away; same seq, delta=2 (absolute index difference; no content ID) |
| `mute_changed` | System mute change observed while current generation plays; seq, kind=on/off, muted=true/false |
| `player_audio_applied` | Current player gain read-back equals the applied request; same seq and kind, observed muted=true/false, backend=player. This is not mixer/PCM or physical sound evidence and never satisfies mute latency acceptance. |
| `mixer_match` | Calibrated actual mixer/PCM state matches requested transition; same seq, kind, muted, backend=mixer. Requested player volume is **not** evidence. |
| `login_entry` | Login UI activation before opening WebView; seq, attempt |
| `login_tap` | 登录 handler before any auth/navigation change; seq, attempt |
| `qr_ready` | QR image first **visibly rendered** in login UI; same seq, attempt. Distinct from PodBrowserAuth extracted QR status. |
| `scan_accepted` | Watch receives scanned/verified status from auth flow; seq, attempt. This measures watch receipt→persisted, not the unknown physical phone scan instant. |
| `auth_persisted` | Application credential persistence succeeds and logged-in UI state is published; same seq, attempt. No credential data. |
| `logout_start` | Approved logout action handler before async work; seq |
| `logout_feedback` | First visible feedback frame after that handler; same seq |
| `auth_cleared` | Actual auth clear operation executes; same seq/attempt when applicable. Count as regression during login_tap. |
| `auth_state` | Before and after login tap, closed state=present/absent; no account identity. Preserve existing auth state across tap. |
| `needs_login` | 需要登录 UI is first presented on entry; same seq as entry_start |
| `refreshing` | 刷新中 UI is presented on the post-logout entry. Its presence is a regression even if needs_login follows. |
| `restore_state` | Foreground heartbeat every ≤1 s; state=running/idle/unknown, mono_ms. State comes from authoritative restore coordinator, covers between windows; idle only after verifying no active restore/continuation. Log transitions immediately. No mutation of restore state. |
| `renderer_process` | Known WebView renderer is bound to this app/auth attempt; pid, attempt. Supply independent attribution evidence; candidate ps name alone is insufficient. |
| `error` | Terminal closed error observation for current action, seq/attempt; no message/body |

Required additions are the events in this table plus stable seq/attempt/uptime
correlation. None is silently inferred from existing free-text logging. The
`renderer_process` event is retained for attribution review; the harness does
not blindly trust a reused PID across process lifetimes. Attach the capture's
app/process/renderer relationship and mark the manifest only after review.

## Actual audio dependency and acceptance provenance

`dumpsys audio`/`media.audio_flinger` are sampled today for ringer/master-mute/focus
metadata. Dump schemas and session bindings must be verified on OWW242 before
adding a per-track adapter. Polling these large dumps every 5 s cannot establish
50–100 ms behavior. Lead must provide an audited ≤20 ms native mixer observer or
external capture with timestamps and track binding to support the proposed audio
codes. A host player volume callback alone must never emit `backend=mixer`.

Supply the adapter/capture path and SHA256 with results. Set
`audio_adapter_reviewed` only after this check. For the mute scenario also retain
`mute_restored_by_operator=true` from the runtime prompt. Without both, mute
acceptance stays PENDING. Soak needs `renderer_attribution=true` plus PID binding
proof; the runner deliberately leaves that false by default.


## PREWARM candidate contract (offline verified, device PENDING)

The historical inventory above describes the baseline. The PREWARM candidate
adds these codes to the production native/guest allowlists and the collector:

| Code / field | Meaning and authority |
|---|---|
| `prewarm_policy`, `slots`, `reason` | Probed codec/session capacity; `bidirectional` (three slots), `single_neighbour` (two), or `capacity` (unavailable). Not a measured memory/thermal guarantee. |
| `prewarm_requested` | Pool dispatched a host preparation. No content ID or URL. |
| `prewarm_ready`, `buffered_ms` | Host returned a decoded hidden first frame; same request seq. Does not prove on-screen presentation. |
| `prewarm_evicted`, `reason` | Slot invalidated: `stale`, `capacity`, `release`, `failure`, or `timeout`. |
| `background_gate`, `state`, `reason` | Native foreground-media owner pauses/resumes background admission. `paused/foreground_media` and `running/media_stopped`; running means admission reopened, not a restore ACK. |
| `restore_state` | Native worker heartbeat each second, including media wait. `running` means an active worker, `paused` means foreground-media policy holds it. End emits `unknown`. This does not establish logical idle or provide coordinator coverage between windows. |
| `spinner_shown`, `buffered_ms`, `network_stalled`, `reason` | Visible ring commit includes `buffered_ms=0 network_stalled=true reason=network_stalled`. The boolean comes from native transfer progress (800ms without bytes). Missing fields remain PENDING; false stall or positive buffer is FAIL. |
| `error_page`, `reason` | `candidate_retry` means the player suppresses a transient overlay while same-item recovery runs. `exhausted` means terminal overlay. The collector stops before another swipe on this state. `player_visible` also becomes absent for error/network overlays. |
| `fling_done`, `delta=2` | A fast release (at least 1800 px/s) selects the item two positions away without committing the intermediate item. Native emits completion only after target-frame commits and guest cover removal. The release timestamp precedes target resolution/prewarm. At a queue boundary a single-item fallback has no two-item completion. |

All fields remain closed enums, booleans or nonnegative integers. This candidate
does not add mixer/PCM evidence and does not turn hidden first frames into
`incoming_first_frame` observations.

## T-DYERR candidate production wiring (offline verified; device not measured)

- `src/ui/routes/home.tsx`: accepted Home Douyin activation begins `home_entry`
  before navigation. `src/douyin/bench.ts` transfers that sequence to the next
  `ImmersiveEntry` activation and marks `entry_start` on the same action.
- `src/ui/douyin/ImmersiveEntry.tsx`: an accepted explicit refresh begins
  `refresh_start`. Completion or its 1500 ms UI deadline requests native
  `refresh_done` presentation on the same sequence. Failures also mark `error`.
  Cached content stays navigable during replacement, but cache availability
  alone does not emit refresh completion. An interrupted action cancels the
  pending presentation instead of manufacturing a terminal timing.
- The entry passes its sequence with the selected playback request.
  `src/ui/routes/media-controller.ts` requests `first_card` only after the player
  reports a decoded first frame. The request precedes `afterPaint` to avoid
  measuring an extra frame. The native `benchmark.presented` callback supplies the actual HWUI commit
  timestamp. Leaving that route cancels the pending observation. The title page
  and successful cache/API reads never substitute for a visible feed card.
- A title-only cold/home trial must explicitly enter the video flow to collect
  this `first_card` endpoint. Merely waiting on the title page has no card sample.
- Source failures return closed codes and cooldown duration to the entry's retry
  UI. A failed entry action marks `error`; a subsequent attempt allocates a new
  entry sequence. No credential, URL or content identity enters these events.

The 1500 ms deadline leaves 500 ms of the approved 2000 ms refresh p95 budget for
presentation. This is a configured UI budget, not measured device latency or a
claim that a new network feed succeeded within 1500 ms. Slow or failed requests
show a retryable error while retaining cached content. Network, renderer and JS
scheduling can still exceed the target; actual paired device samples decide it.

### T-1200 closed request outcomes

`douyin_request` uses the existing synchronous release PodBenchmark path. Native
owns seq and uptime. All eight fields are mandatory; extra fields are rejected:

- `category`: `feed`, `detail`, `auth_probe`, `media`.
- `http_status`: integer 0..599; 0 means no response status observed.
- `douyin_status_code`: integer -1..2147483647; -1 means absent/unreadable/not applicable.
- `challenge`: boolean; API uses the existing leading HTML detector. Media does
  not inspect payload bytes, so false does not rule out an upstream challenge.
- `signing_ok`: boolean; true only means local signing returned successfully. It
  does not prove that the server accepted the signature. Media is unsigned here
  and reports false (not applicable).
- `cookie_present`: boolean; presence in the request headers only. This does not
  prove server-side authentication.
- `retry_after_ms`: nonnegative safe integer; response Retry-After or actual
  policy delay. Zero means no delay was observed, not permission to retry.
- `error_code`: `success`, `forbidden`, `http`, `signing`, `challenge`, `empty`,
  `blocked`, `api_status`, `timeout`, `cancelled`, `network`, `cooldown`,
  `client_limit`, `decode`.

Each signed attempt reports separately, including its single policy retry.
Cooldown transitions and suppressed calls report `cooldown` with HTTP 0/API -1;
these are not network requests. The detail request also covers play-URL resolve.
Cache-only resolves do not imply a network outcome. Probe cancellation is logged
when the actual operation settles, not fabricated when its timeout wins a race.
Media sources report open/read failure, EOF, or intentional close exactly once.
A prefix close can be successful without downloading the entire video. Both
prefetch range sources and foreground cache misses use the same native wrapper;
cache hits alone do not fabricate a network request.

No URLs, content identifiers, cookies, tokens, raw errors or body text enter this
path. Existing performance counters do not use request events as frame evidence.

## Closed player failure fields (T-1201-ERR)

`error` and `error_page` may include the fields defined in `player-error-schema.json`.
Native and collector independently reject unknown enum values and out-of-range numbers.
`failure_origin` separates guest, explicit sessions and legacy player observations.
`failure_stage` distinguishes entry timeout, prepare, playback and control RPC failures.
`failure_code` and `exception_kind` are fixed categories; no exception message or stack is copied.
`media3_code=0` means no Media3 error number was available. A nonzero value is the actual
`PlaybackException.errorCode`. `codec_kind`, dimensions, `content_kind`, `source_kind`,
`surface_state`, `slot_limit`, `decoder_count` and `is_prewarm` describe the failing operation.
`slot_limit` in session failures is the last evaluated memory admission limit.
`source_kind=cache` records only the URI scheme category, never the URL or cache key.
`content_kind=unknown` is missing header evidence, not proof of an unsupported format.
A failed foreground session retains its original terminal error for state polling while
releasing its decoder. It must not turn into `unknown_video_session` after removal.
HTTP 200/206 proves a request result, not media decoding, surface readiness or playback.
The 1500 ms entry watchdog reports slow loading; it does not prove a failed network request.

`player_visible` also carries closed `visibility_reason`, `player_state`,
`has_frame`, and bounded absolute route offset in thousandths of a pixel.
Native changes a guest `present` to `absent` with `native_hidden` or
`native_unfocused` when its real rendering view is hidden or lacks window focus.
These observations do not replace native decoded-target/commit proof and do not
relax the input guard. Unknown player states map to `unknown`.

T-1201 Audio: `player_visible` may carry `audio_gain_milli` (0..1000, actual Media3 gain readback) and `audio_track` (selected audio format present). These do not prove audible PCM or speaker output. No URL, track identifier or codec description is recorded.

T-1201 MUTESYNC: `player_visible` additionally accepts `system_index`, `system_max` (integers 0..1024), and `system_muted` (boolean). These are active STREAM_MUSIC readbacks. The overlay derives its rounded percentage from index/max. `audio_gain_milli` must remain 1000 for an active video. A system mute no longer produces a private zero-gain `player_audio_applied` receipt. Prewarm silencing disables its audio track and never changes system mute.

`startup_stage` carries only a closed `startup_stage` enum and optional decoder `duration_ms`. Native uptime and seq correlate input, source, persistence, surface, decoder, and first frame. `home_first_frame` is a real native HWUI commit; it is distinct from guest home construction. Process start uses Android Process.getStartUptimeMillis, never host wall time.

The `stock_saved` startup stage carries `slots=0..3`, the saved stock metadata count. It is readiness bookkeeping, not a decoded playback frame or a cache-hit proof. Actual first-frame cache counters remain required.

`PodMediaCache cache_first_card` is a numeric counter snapshot from the same native visible frame commit as `first_card`. It carries that action's seq and uptime. The older `cache_stats` line is a decoded-frame observation and is not the visible-frame counter proof for a reserved initial decoder.

Cold prepare substages (native uptime, same entry seq): `prepare_admitted` after capability/memory/session admission, `player_constructed` after ExoPlayer construction, `prepare_dispatched` after setMediaSource/prepare, `video_format_ready` when the extracted video input format reaches the renderer. These are diagnostic stages, not visible frame proof.

`player_paused`: native-only session diagnostic. Emits after playWhenReady becomes false, with matching action/source generation and backend=player. Native uptime is the event clock. This does not prove mixer/PCM silence and does not replace previous_audio_stopped.
