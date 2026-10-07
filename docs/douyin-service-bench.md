# K14 offline service callback probe

This is Linux QuickJS CPU evidence, not device ANR acceptance. The baseline is
app `a15ebdd`; the host is framework `3374954` / PocketJS `2ee82de`, with the
runtime's exact `rquickjs 0.12.2` dependency, bindgen feature and release build.
The after probe uses the new Rust codec and the default media yield operation.
No production backend, live credentials, private database or device is used.

The generator follows the existing native-compatible Douyin fixture (12 aweme
rows with author/statistics/play_addr/bit_rate); an ignored metadata string is
expanded to stress response size. These are synthetic, schema-shaped stress
inputs, **not archived MEM2 response bodies or observed production sizes**. A
near-8-MiB ASCII HTML error page covers the media transport's byte limit. The
Bili malformed HTML corpus repeats real `id="1-name"` candidates without `>`.

Three independent before/after process pairs alternate order. Median timings:

| Phase | Bytes | Before ms | After ms |
|---|---:|---:|---:|
|UTF-8 / mixed feed|1702207|192.441|2.732|
|Default Douyin refresh|1702207|193.853|7.034|
|UTF-8 / mixed feed|6814015|788.376|14.250|
|Default Douyin refresh|6814015|800.723|34.779|
|Default Bili history|6808651|765.391|29.260|
|ASCII HTML UTF-8|8388589|1338.477|4.861|
|Bili CSRF / missing closing bracket|48000|609.999|0.048|

The default client refresh measurements include signing, decoding, parsing and
cache writes. Fixture IO resolves locally. After timings include separate
simulated service turns but exclude Android Handler/JNI latency, networking,
Java, rendering, Vulkan and device GC. The Rust runner drains pending jobs,
then delivers runtime.delay results through the real framework service pump.
`host.summary.maxJobMs` includes **fixture generation and all probe phases**;
it must not be used as a production callback maximum.

Other suspects were measured separately:

- Default A-Bogus on the Kotlin differential sample: ~0.51 ms. Full production
  feed parameters captured from the default client: 1.71 ms (one supplemental
  run). No signing changes; existing Kotlin byte-for-byte vectors still pass.
- JSON.parse of the 1.70-MiB fixture: 1.73 ms; 6.81-MiB stress fixture: 12.72 ms.
  Feed parsing including projection: 2.26 / 10.44 ms. Detail parse is ~0.03 ms
  for the small aweme detail fixture.
- Normalize/append 200 items: ~0.42 ms; default 12-item queue construction:
  ~0.011 ms; 12-item serialized feed save: ~0.08 ms with fixture storage.
- Actual login status reducer: ~0.005 ms; applying a 4-KiB fixture cookie:
  ~0.03 ms with fixture storage. The DOM auth extraction script executes in
  WebView, not the QuickJS application realm; no WebView timing is claimed.
- A duplicate-only cursor sequence stops at exactly 40 requests in the actual
  default queue/client (~110 ms total CPU with immediate fixture IO). Production
  secure.get/download/file.read completions each arrive on separate host turns.
  This does not establish network wall time or identify a synchronous spin.
  Normal/error refresh has one request, without automatic retries.
- Redaction of a synthetic ~64-KiB log: ~17.9 ms. Full-file log initialization,
  log pull and trimming can be separate callback hotspots. The facade is not
  connected to a real log file in this probe; no user logs are included.

The largest observed native decode piece was 0.137 ms; portable pieces were
0.291 ms maximum in one supplementary run. At the task's **estimated** armv7
5–10x factor these correspond to ~0.7–1.4 / 1.5–2.9 ms. No physical armv7 timing
is established. The previous ~1338-ms HTML decode corresponds to an estimated
6.7–13.4-second uninterrupted turn and is consistent with the class of MEM2
stall, but does not prove which body or callback caused the three ANRs.

The fix uses a pure compiled Rust codec in <=16-KiB valid UTF-8 pieces, and a
legacy-compatible JS fallback in roughly 1-KiB pieces. The cut scan is bounded
to three continuation bytes even for invalid input. `runtime.delay(0)` creates
a fresh main-looper turn between pieces; a resolved Promise cannot do so.
Bili uses its original invalid-byte dialect. A linear HTML token scanner avoids
revisiting candidates before the same closing `>` and preserves the old match.
Signatures, response data, errors, UI appearance and stored formats are retained.

Large JSON parsing and the final string join are still synchronous. The
6.81-MiB parser can remain ~50–130 ms under the task's device estimate, and log
processing can be slower. Native decode runs synchronously within each bounded
piece; it is not an OS worker thread. GC stalls, larger retained item fields,
unbounded RSS page history, and renderer/input costs require device evidence.
The restored queue remains bounded to 200 and the normal immersive window to 40;
this task does not cap RSS history or remove real user items.

Reproduce from the app worktree (set `framework` to the matching framework tree):

```sh
framework=/path/to/podjs-watch
bun scripts/bench/douyin-service.ts --runtime=quickjs --framework="$framework" --source-ref=a15ebdd --out=/tmp/k14-before.js
bun scripts/bench/douyin-service.ts --runtime=quickjs --framework="$framework" --out=/tmp/k14-after.js
# In the framework worktree:
cargo run --release -p podjs-runtime --example service-bench -- /tmp/k14-before.js
cargo run --release -p podjs-runtime --example service-bench -- /tmp/k14-after.js
PODJS_BENCH_PORTABLE=1 cargo run --release -p podjs-runtime --example service-bench -- /tmp/k14-after.js
# In the app worktree; the default dependency path test is intentionally isolated:
bun --conditions=browser test ./tests/douyin/service-default.isolated.ts
```

Device handoff: protect formal data with acceptance.py upgrade and require
`equal=true`, verify density2 home layout against the K8 reference immediately,
then repeat MEM2's no-input refresh / BACK / channel-info scrolling twice, with
PodJSMem off. On a separate diagnostic launch, the device owner can explicitly
opt in to the bounded `PodJSService` completion-turn trace; collect categories
and times, restore the previous property and relaunch. Also repeat Bili details
and verify actual items/sign-in errors. A clean run with diagnostics off is
required; host benchmarks and a successful package build do not close ANR.
