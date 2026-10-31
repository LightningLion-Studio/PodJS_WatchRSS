# Reader scroll replay

This offline harness runs the actual production Solid transform, PocketJS renderer,
ReaderBody, ScrollEntries, ReaderTextRow and SystemTextLine in Bun. Native HostOps,
text metrics/raster, image decode, layout and service replies are mocks. It does not
measure QuickJS, Android, GPU or device frame rate. Instrumentation applies only to
the generated harness; it is absent from the app package.

```sh
bun scripts/bench/reader-scroll.ts --framework=/path/to/podjs-watch --out=/tmp/after.js
bun scripts/bench/reader-scroll.ts --framework=/path/to/podjs-watch --source-ref=39efb43 --out=/tmp/before.js
bun /tmp/before.js --html=/path/to/article.html --timing=/path/to/t04-scroll-timing.json --repeats=10 --out=/tmp/before.json
bun /tmp/after.js --html=/path/to/article.html --timing=/path/to/t04-scroll-timing.json --repeats=10 --out=/tmp/after.json
```

`--retain-rows=0` on the build command isolates stable visible-array identity from
text-row retention. Alternate before/after order across separate processes. The
JSON contains per-frame offsets, total measured synchronous work plus microtasks,
nested phase times, calls and resource peaks. Phase times overlap and must not be
summed. `visible` includes binary search and history maintenance; `forDiff` includes
row mount/cleanup; ReaderTextRow includes SystemTextLine setup; onFrame includes
its nested reactive work. Signal writes count attempts, not actual notifications.
Host counts cover renderer operations. `serviceCounts` covers warmup and measured
scroll, while `counts` and phase times cover only measured frames. Absence of
measureText/wrapText counters during scrolling means zero calls during that period;
initial document layout runs before the timed replay.

Timing JSON uses `elapsedSeconds` and `gestures` with `startSeconds` and direction
`up`/`down`. The replay assumes 250ms touch duration and +/-500 logical pixels/sec,
then runs the real scroller fling kinetics. Original ADB command elapsed time is
used for gaps, not as touch duration. Speed is an estimate: the fixture does not
contain the device's full touch trajectory. Neutral analog input is undefined.

Use a public/local HTML fixture; do not commit user databases or private articles.
Mock text widths use 14/7 logical pixels, image source dimensions use declared HTML
sizes or 512x256 fallback. Actual article wraps, decoded dimensions, native fonts
and services must still be tested on device. The K9 recorded fixture is issue 407,
not Task 04's issue 411; raw HTML and timing inputs are deliberately not committed.

The harness asserts that Reader teardown releases all SystemTextLine requests,
cache entries, text textures and frame callbacks, and reports the separate existing
media texture cache. It also rejects double texture frees or component errors.

K20 SQL completion diagnostic (read-only local snapshot, no backend):

```sh
bun scripts/bench/sql-turn.ts --db=/absolute/path/to/podjs.sqlite \
  --framework=/absolute/path/to/framework-worktree \
  --out=/tmp/sql-turn-fixture.json --bundle=/tmp/sql-turn.js
cargo run -p podjs-runtime --example reader-entry -- \
  /tmp/sql-turn.js /absolute/path/to/android-watch/main.pak
```

Run Cargo from the selected framework worktree. This extracts the current
production `getArticle` and mapper at build time, uses actual row12569/channel40
SQLite results, and mounts the WatchRSS reader restoration route in QuickJS.
Initialization/migrations are bypassed; other native IO is synthetic and network
requests fail closed. The script compares the complete reader result with the
Bun/SQLite reference, including HTML blocks and flattened text. It does not
reproduce a physical tap, Android SQL worker timing, native raster/GPU time, or
all synchronous Rust KV IO (the fixture uses a JS KV boundary). The host example's
`maxMicrotaskTurnMs`, not the JS pump's wall sample, includes drained Promise jobs.
The generated fixture and loader contain private article data; do not publish
them. Labels and printed result summaries contain only code identity/counts.

RS2 HTML differential (existing fixture literals/JSON, local real 411/407 captures,
2000 malformed random fragments, Unicode/oversized fallback):

```sh
bun scripts/bench/html-fragment.ts --framework=<minor-framework> --out=<private-output>/html.js
# Run from the framework checkout, using the same rquickjs dependency/features.
cargo run -p podjs-runtime --release --example service-bench -- <private-output>/html.js
PODJS_BENCH_PORTABLE=1 cargo run -p podjs-runtime --release --example service-bench -- <private-output>/html.js
```

RS2 note probes use `note-reader.ts` to compare complete geometry/anchors with the
frozen collector and the stable early heading/image prefix, and `reader-entry.ts
--mode=note --timer-floor=16 --native-delay=16` to mount the real note screen on
QuickJS/UiSurface. Use `--source-ref=b361e25` for the RS2 baseline. Entry output
includes title/body/image/raster milestones, scheduler jobs, all delivered native
layout batch turns, and CPU before the first body. Those IO replies are synthetic;
CPU scaling by 5–10 is an estimate, and physical visibility/GPU/Android scheduling
must be checked separately. Outputs containing captured HTML/Markdown remain
local and must not be committed.

`--cpu-scale=5` / `--cpu-scale=10` use a scaled monotonic clock for the default
1 ms work budget, retain unscaled 16 ms IO timers, and report raw CPU separately.
For a conditional device estimate, add `(scale-1)*rawCpuBeforeBodyMs` to modeled
elapsed time and anchor title appearance to a recorded device title upper bound.
This is a conservative scheduling scenario, not a calibrated armv7 emulator;
its complete-document estimate may overpredict actual device latency.

K21 refresh-all replay uses a read-only local SQLite snapshot and a temporary
copy for the exact production SQL. RSS/Atom documents are reconstructed from
actual stored article shapes, not asserted to be upstream response captures.
Network/Android SQL worker, UI/KV and GPU timing are not modeled. All private
fixtures/bundles stay outside source control:

```sh
bun scripts/bench/refresh-all.ts --db=<snapshot> --framework=<framework> --out=<private>/refresh.js
cargo run -p podjs-runtime --example service-bench -- <private>/refresh.js
bun scripts/bench/refresh-differential.ts --framework=<framework> --fixture=<private>/refresh.js.fixture.json --out=<private>/diff.js
cargo run -p podjs-runtime --example service-bench -- <private>/diff.js
```

The replay checks exact transaction statements and returned channel metadata,
including unread aggregates. Compare before/after fixture JSON to establish
cross-version equivalence; a replay against its own golden is not that proof.
Home refresh does not request original-content prefetch; that is a separate
visible-feed path. Both feed/original full-file decodes use the bounded SDK codec.

Optionally set `PODJS_BENCH_KV_DIR=<private scratch>` when running `service-bench`
to exercise the production home-snapshot writer through the real Rust KV store.
The K21 probe's unrelated 830000-character value is explicitly synthetic; SQL
article/channel shapes come from the local snapshot. KV readback comparison
sorts object keys because serde canonicalizes their ordering, preserving values.

JSON projection differential (synthetic feed, not a production response capture):
`bun scripts/bench/json-projection.ts --out=/tmp/json-projection.js` then run the
framework `service-bench` example on that bundle. It compares raw JSON projection
and async feed mapping with the existing parser, including malformed values,
duplicates, numeric edge cases, Unicode and cancellation.

K23 full Douyin navigation: `bun scripts/bench/douyin-entry.ts --framework=<framework wt> --out=/tmp/entry.js`, then `PODJS_BENCH_KV_DIR=<new private scratch directory> cargo run -p podjs-runtime --example service-bench -- /tmp/entry.js` in the framework worktree. `--source-ref=dc26f46 --framework-ref=872698b` compiles the K23 baseline, `--original=false` covers RSS mode, and `--trace=false` checks default-off diagnostics. The runner mounts production WatchRSS/Solid routes, presses the actual connected home card, completes restore, BACKs, and validates persistent resume, Activity snapshots, and telemetry. Compare the `durable` objects between variants. Renderer/font/network/secure IO is synthetic; scratch KV uses real Rust lock/fsync/rename. Lifecycle clocks are deterministic while CPU profiling uses native `__benchNow`. There is no device/FPS assertion.

`bun scripts/bench/feed-restore.ts --framework=<framework wt> --out=/tmp/restore.js` + the same `service-bench` command (scratch KV not needed) checks cached feed restoration against the old mapper on native QuickJS: 618 cases, preserving all item fields, own `__proto__`, key order, negative zero, nonfinite numbers, surrogate strings, malformed/mixed shapes, and feed/queue limits. It uses the production default host scheduler.

READERPERF uses generated public-shaped inputs (20 images, or a 300k-character
text chapter) and independent natural image dimensions:

```sh
bun scripts/bench/readerperf-fixtures.ts /tmp/readerperf
bun scripts/bench/reader-scroll.ts --framework=/path/to/framework --source-ref=3406c78b --out=/tmp/before.js
bun scripts/bench/reader-scroll.ts --framework=/path/to/framework-worktree --out=/tmp/after.js
bun /tmp/after.js --html=/tmp/readerperf/images.html --dimensions=/tmp/readerperf/dimensions.json --timing=/tmp/readerperf/timing.json --start=0 --out=/tmp/after.json
```

The runner completes synthetic timer replies and requires restored, complete
geometry before timing. Source-ref also freezes the parser and content layout.
`--start=0` traverses the article instead of replaying only the tail. Generated
media dimensions are independent of the declared/unknown HTML dimensions.
The runtime `reader-memory` example accepts `--warmup`, `--start`, and emits
`bench.frame-times` CPU percentiles per round. These include QuickJS, Rust layout
and synthetic service draining; they exclude Android decode, GPU and presentation.
Use `--runtime=quickjs` with the builder and run the example against an isolated
copy of a built package's `main.pak` and `pod.manifest.json`. Its image service
currently returns synthetic 512x256 source geometry; this differs from the Bun
runner's natural-size map and must not be described as a matching image decoder.
