# PodJS WatchRSS performance evidence

This note records the existing artifacts only. No APK, hash, device state, or worker experiment was changed for this report.

## Verified CPU/runtime evidence

- The previous `am` startup measurement used a **10,000 ms timeout**; the later single run reported **1302 ms**. `artifacts/startup-cpu-three.log` now records three CPU startup runs of **1221 ms, 1241 ms, and 1246 ms**. These are measured runs for the captured APK, not a release gate by themselves.
- `artifacts/boot-mapped.log` records mapped startup work of `mapMs=3.3`, `pakMs=845.5`, `validateMs=0.1`, `evalMs=163.8` ms for pid 5476. The later `artifacts/perf-after.log` records `mapMs=2.8`, `pakMs=676.9`, `validateMs=0.1`, `evalMs=167.7` ms for pid 5590. This supports the observed package mapping improvement; it does not by itself prove end-to-end startup latency.
- `artifacts/mem-after.txt` is a PSS snapshot for `com.lightningstudio.watchrss.podjs`: total PSS **121,740 KB**, RSS **170,136 KB**, swap PSS **467 KB**. Native heap PSS is 88,804 KB and graphics PSS is 17,072 KB. This is one snapshot, not a long-run memory profile.
- The baseline summary (`artifacts/perf-baseline-summary.json`) covers 20 one-second windows: mean JS **2.107 ms**, mean raster **9.777 ms**, mean present **2.638 ms**, maximum observed frame time **65.14 ms**, and measured callback rate **48.486 Hz**.
- Scroll logs show the runtime callback/draw counters directly. Baseline contains windows such as `ticks=59 draws=23`; after contains `ticks=60 draws=0` during idle portions and scroll windows such as `ticks=54 draws=33`; final contains idle windows such as `ticks=60 draws=0` and active windows such as `ticks=60 draws=51`. `ticks`/callback rate and `draws` are separate measurements.

## Interpretation boundary

`callbackHz` is the rate at which the runtime callback/tick loop ran. It is not FPS. `draws` is a draw count within each sampled window and is also not a presentation FPS measurement. The artifacts therefore do not establish 60 FPS. The separate graphics captures report jank and frame timing: baseline `gfx-baseline.txt` is 120 frames, average 24.94 ms, jank 69.17%; final `gfx-final.txt` is 120 frames, average 19.99 ms, jank 55.83%. Those results show improvement in the captured run while still falling short of a 60-FPS claim.

The worker-vsync experiment is retained as historical artifact (`gfx-worker-vsync.txt`, `mem-worker.txt`, and `PodRuntimeView-worker-experiment.java.txt`) but the lower-Hz worker approach was withdrawn. It is not the current implementation or acceptance evidence.

## GPU measurement stage (current tested APK)

- `artifacts/gfx-gpu.txt` reports a **120-frame gfxinfo sample**: average frame time **12.92 ms**, maximum **40.93 ms**, and jank **18.33%**. The sample is not a complete 60-second per-frame run and does not establish sustained 60 FPS. For comparison, the captured baseline was **24.94 ms / 69.17% jank** and the optimized CPU capture was **19.99 ms / 55.83% jank**.
- `artifacts/scroll-gpu.log`, restricted to sampled windows with **draws >= 20**, contains **62 windows** over **62,726.1 ms** and **3,164 draws**. Draw-weighted `presentMs` is **3.1656 ms**; the corresponding callback rate is **56.5793 Hz** (`ticks` summed over window duration). Every one of these active windows has `gpuDraws > 0` and `cpuDraws = 0`. The callback rate remains a callback metric, not FPS.
- `artifacts/smoke-gpu-final.log` passes both smoke tests in **8.644 s** (`OK (2 tests)`).
- GPU and CPU reference screenshots are pixel-identical in the recorded pairs: `perf-gpu-profile-final.png` versus `perf-cpu-profile.png` and `perf-gpu-home.png` versus `perf-cpu-home.png` each have a **0-pixel difference** (matching SHA-256 hashes in the artifact directory).
- These measurements describe the first GPU build. Later LRU and synchronization validation is recorded below; do not treat measurements from different APKs as a single run.

## Final Android development build

- APK: `artifacts/watchrss-podjs-0.1.0-dev.apk`, `com.lightningstudio.watchrss.podjs`.
- SHA-256: `c9bf6faaeef7574eee955cc6a6764f5e860011577d24e722c202cf865dabca8b`.
- Force-stopped process cold starts: **1358 / 1368 / 1372 ms**. View creation to first TextureView update: **1152 / 1153 / 1139 ms**. These are distinct from first native submission and from an empty Activity appearing. Source: `artifacts/startup-gpu-final-three.log`.
- Final short scroll: **120 gfxinfo frames, mean 15.09 ms, maximum 50.00 ms, jank 27.50%** (`gfx-gpu-sync-final.txt`), versus baseline 24.94 ms / 69.17%. The earlier 12.92 ms / 18.33% run is retained as a separate result, not substituted for the latest build. Native active-window callback rate is 54.40 Hz, draw-weighted GPU submit 3.55 ms, CPU fallback 0 (`gpu-sync-final-summary.json`).
- Final smoke: **3 tests passed in 11.938 s**, covering database startup, profile navigation/back, pause/resume, host destruction, and real Activity recreation with a fresh rendered host. Source: `artifacts/smoke-gpu-sync-final.log`.
- Final home/profile captures remain **pixel-identical to the pre-GPU renderer**: `artifacts/gpu-final-home-comparison.json`, `artifacts/gpu-final-profile-comparison.json`. This proves renderer preservation for those pages; it does not establish original WatchRSS page parity or validate every DrawList combination.
- Native host instrumentation: **15 tests passed**. App Bun: **25 passed**, TypeScript passed. Framework/CLI selected Bun: **14 passed**, Rust runtime **5 passed**, raster **17 passed**. GPU decoder assertions pass under ASan/UBSan; shader SPIR-V passes `spirv-val`. Gallery bundle regression build passes.

## Sustained device run

The LRU GPU build (`25d91a2700a303dc11393b43f9107fcc00213f1954bf51fb541ed089284019f9`) ran **602.71 seconds**, with **208 swipes** and **10 Home/resume cycles**. PID stayed 9734; captured logs contain no error or CPU fallback. PSS snapshots range **117119–118027 KB**. Sources: `gpu-soak.json`, `gpu-soak-logcat.txt`, `gpu-soak-mem-*.txt`.

The subsequent final build adds per-swapchain-image presentation semaphores, surface-error recovery and content-hash retry. It received the final smoke/recreation, three-start and short scroll checks above; the full ten-minute soak was not rerun after that synchronization-only change.

## Implementation and limits

Android now decodes the canonical DrawList to Vulkan graphics draws for rectangles, gradients, triangles, textured quads/triangles and cached glyph masks. GPU resources upload only when absent or changed. Glyphs are uploaded individually on demand. Resource identity distinguishes live generation-tagged image handles from font/glyph keys. RGBA payload caching uses a 1024-entry / 32 MiB GPU budget with eviction outside the current frame (driver allocation overhead is additional).

Android native asset mapping and uncompressed PAK packaging remove the large Java/native staging copies. Fonts and images already consumed by the runtime no longer retain a duplicate PAK. The APK is now roughly 94 MB because the PAK is stored uncompressed; coverage and display resolution are unchanged.

Unsupported native-text/compositor instructions, missing resources, unsafe triangle coordinates or over-budget frames return an explicit GPU failure and retain a counted CPU compatibility path. All captured WatchRSS GPU runs report zero CPU fallback. This does not imply all platforms or all native media/compositor features have been migrated.

Sustained 60 FPS, complete original-app visual parity, full WatchRSS functionality, migration and other-platform device acceptance remain outstanding. The original Android workspace was untouched (dirty diff SHA-256 remained `87c601a6aa4ff5bf9feab97e72e5b51303cf9d17186c23b578b4d818464ff5ab`).

Synchronization reference: [Khronos Vulkan synchronization examples](https://docs.vulkan.org/guide/latest/synchronization_examples.html).

## Avatar border fractional-scroll correction

Current APK SHA-256: `e98bc77afb9cefe32b9e1d48626d0db1509df3090f7fb99a788ab5c9e533a129`, installed on OWW242. The filled rounded border now quantizes its axis-aligned translation once for both outer and inset shapes. Previously, independent integer destination rounding changed the 0.7dp border contour at a 0.25dp scroll offset. The fix preserves fractional scroller state and leaves rotated transforms unchanged.

The core regression failed before the fix and passed afterward; the expanded matrix covers densities 1/2 and both axes with positive/negative fractional translations. All 131 core tests passed (`avatar-core-tests.log`). Device smoke passed all four tests in 22.776 seconds (`avatar-border-after.log`), including 40 slow-drag contour comparisons with an assertion that the avatar actually moved. The same device drag also passed on the previous APK (`avatar-border-before.log`), so it is a regression check, not a reliable device reproduction of the reported flicker. The renderer regression provides the red-to-green evidence.

Home and profile captures are pixel-identical to the previous renderer baseline (`avatar-home-comparison.json`, `avatar-profile-comparison.json`). This package received short device regression only; earlier startup/ten-minute figures above belong to the explicitly identified previous builds.

The border-fix short scroll captured 120 gfxinfo frames: mean 13.52 ms, maximum 45.03 ms, jank 16.67% (`avatar-scroll-perf.log`). This sample does not establish sustained 60 FPS.

## Rotary and interactive back (current package)

APK SHA-256: `4fc26e87ddc28b86bd13f7462d089b760ccfa1319a4fc71fadfb7bc8119f0307` (91,332,497 bytes), installed on OWW242. The app now applies positive PodJS axis deltas to positive list offsets; Android retains its existing native axis conversion. Internal navigation keeps mounted prior pages and moves the active page with the finger. Release commits at 40% width or a deliberate fast swipe; cancellation settles back without changing the route. Hardware back animates from the current position.

At root, OPPO/OPlus watches request `Window.FEATURE_SWIPE_TO_DISMISS`. Internal pages disallow parent interception. Hosts without this feature use an edge swipe that calls system back only after release; cancellation stays in the app. A new gesture cancellation entry point prevents Android `ACTION_CANCEL` from being interpreted as tap release or fling, including when the platform takes over a root gesture.

Validation: app Bun 30 passed; framework watch/gesture tests 37 passed; TypeScript and Gradle passed; gallery regression build passed. Android smoke **7 passed in 39.832 s** (`back-final-smoke.log`); native input tests **5 passed** (`back-host-motion-tests.log`). Smoke includes rotary in both directions, vertical scrolling without back, a held partial back frame, cancellation pixel restoration, committed back to retained home, root fallback cancellation/commit, and prior lifecycle tests. The fallback branch was forced by instrumentation on OWW242; this is not non-OPPO hardware verification. Earlier failed runs are retained as diagnostic evidence, including the test's incorrect rotary dispatch and the real native cancellation-to-tap bug.

Home/profile static captures remain pixel-identical (`back-home-comparison.json`, `back-profile-comparison.json`). The final 12-second device recording `watchrss-back-final.mp4` shows short swipe cancellation, long internal back, and native OPPO root dismissal to the launcher. Extracted frames were visually inspected (`back-final-contact.png`); `back-root-top.txt` confirms foreground `com.heytap.wearable.launcher/.Launcher`. Recent filtered runtime error log is empty apart from log-buffer headers (`back-final-errors.log`). No new sustained FPS or ten-minute stability claim is made for this package.

## Circular in-app back on round displays

Current APK SHA-256: `095444cdded4317179dd6f802b965972cfec46ffe4cda5105c2688a9646e9022` (91,279,366 bytes). A moving page on a round display is now clipped as a whole circle, including its background, text, images and lists. The circle translates with the finger at full screen diameter; its original bounds remain intact when it moves offscreen. Static pages retain their previous pixels. Rectangular displays retain rectangular transitions.

Core adds an opt-in rounded clip DrawList push (opcode 11), with nested intersections and the shared clip pop. CPU raster, damage parsing and the compositor scanner recognize it. Android Vulkan clips fragments through a 2 MiB host-coherent clip SSBO; it does not rasterize/read back the page on the CPU. Uploads happen after the prior frame fence, and resource capacity is checked before image acquisition. Legacy hosts default to the previous AABB clipping until their decoder supports the new command; Android/Wear enable it. Other-platform rounded transition acceptance remains pending.

Validation: Core 133 passed (`circle-back-core-tests.log`); decoder ASan/UBSan and strict host/NDK compilation passed; shader SPIR-V validation passed; TypeScript, Gradle and gallery build passed. Final compact APK device smoke **8 passed in 46.286 s** (`circle-back-final-smoke.log`). The new test compares every sampled pixel inside/outside the translated circle against the foreground/retained background, then verifies cancellation restores the page. Home/profile static comparisons are pixel-identical (`circle-back-*-comparison.json`). Captured native performance windows report zero CPU fallback (`circle-back-perf-log.txt`); no new sustained FPS claim is made.

Recorded `watchrss-circle-back.mp4` and inspected its extracted frames (`circle-back-contact.png`) plus held frame (`watchrss-circle-back-held.png`): short drags reveal the previous page outside the moving circle and cancel back; a longer drag commits. The video was captured before clean repackaging of the same source; the installed compact APK was subsequently tested again with all eight tests. Runtime error capture contains only log-buffer headers (`circle-back-errors.log`).
