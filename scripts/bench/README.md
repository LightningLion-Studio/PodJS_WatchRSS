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
