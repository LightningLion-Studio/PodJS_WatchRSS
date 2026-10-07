# U6 upstream migration

Baselines: app `2e84513`, framework `58ab3c4`; both own `wt-impl` trees were
fast-forwarded before creating `impl/upstream-5`. Framework implementation:
`a6100957a15be464a6883f7277e1af5609d78d92`.

Three U1 candidates delivered:

- #13 PARTIAL: `navigation.ActivityStateHub` now owns synchronous namespace merge.
  Application wrapper preserves `navigation.activityPublish` trace. Route registry,
  page whitelist, validation, route context/restored signals and lifecycle wiring
  remain application-owned; no claim that all M1/M2 has migrated.
- #14 DONE: `navigation.ScrollRestoration` and snapshot validation/types moved
  unchanged; application source is a compatible re-export.
- #18 DONE for the generic mechanism: `logging.createLogRedactor` and `FileLogger`
  provide configurable credential/header rules, FIFO file operations and byte-limit
  rolling. Application adapter retains exact vocabulary, initialization/clear/error
  messages, 5MiB strict threshold, 20% line policy, console privacy facade, singleton
  and UTF-16 debug-log reply. Upload encryption/protocol/native inventory stay app.

The plan now records all 25 groups and distinguishes supporting framework work in
K15/RS1/RS2/K21/K22/K23/RS3 from remaining app orchestration. No markup, styles,
assets, platform business logic, secure store or device code changed.

## Frozen oracle provenance

`tests/fixtures/upstream-u6` comes from `git show 2e84513:src/<path>`.
The logger's diagnostic-log relative import is relocated; all other bytes match.
SHA-256 of original source:

- navigation/activity-state.ts: `56e54d401d3e39551ed44c3c4642eee9165481be2b0ff3d60856ac3ee1deca67`
- navigation/scroll-restoration.ts: `263eb0352590c6e134fca7c55c2e855884262600c5d7241b339551292ef09fcb`
- logs/app-logger.ts: `63abca6b45cfdf347e2ee0aec6d2db7ec6b4f5b2467fe47a7a2e7cc11eeaaed1`

Differentials compare reordered publish acknowledgements/rejections, 250 scroll
sequences including late rows and cancellation, credential dialect output, and exact
file operations/console output/pull results across legacy scanning, strict size
boundary, UTF-8 rotation and write failure. Existing application tests are unchanged.
Framework contracts use alternative keys, header rules and trim policy, plus default
Date/output construction. This is host/source compatibility, not device evidence.

## Verification

- App `bun run test`: 1235 pass, 0 fail, 209 files.
- App `bun run typecheck`: exit 0. Initial new differential-test annotations used
  nominal class types; changed to a union of the independent oracle/current types.
- Final app `bun test tests/upstream-u6.test.ts`: 4 pass, 12708 assertions.
- Framework `bun run test`: exit 0, including U6 5 contracts, existing browser/host
  suites and Rust runtime tests (105 pass, 4 ignored).
- Framework `bun x tsc --noEmit`: exit 0.
- Framework `bun test tests/style-props-check.test.ts tests/targets.test.ts`:
  7 pass, 0 fail. Both repository whitespace checks pass.

- Required main CLI and wt-impl CLI `build --target=android-watch
  --project=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-impl`: both exit 0;
  99 pak entries / 69,473,376 bytes; bytecode 1,644,577 bytes. Style collection
  produced 577 records. No APK generated. Logs: `.codex-tmp/wrss-u6-*.log`.

## Device handoff — PENDING

No ADB, device access, APK generation or installation. The designated device owner
should use the protected upgrade flow and first compare home dimensions against the
approved density-2 reference. Then verify navigation/process recreation preserves
startup/content namespaces and draft state, scroll restoration across partial/late
lists and explicit user scrolling, and local log viewing/clearing/export with
synthetic credential markers. Do not use real secrets or alter platform account data.

Remaining work: route context/restored signals and modal input coordinator, then
ManagedCache after extracting path/bucket/eviction policy. No next task started.
