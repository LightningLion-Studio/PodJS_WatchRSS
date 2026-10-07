# U7 framework migration

Baselines: app `da18c00`, framework `e717726`. Both own wt-impl trees are on
`impl/upstream-6`. Framework implementation: `108187d`.

Four candidate groups completed at source/host level:

- #19: QR raster and QRCode texture component in `@podjs/framework/qr`.
  App retains native low-correction/UTF-8/inverted/bitmap profile, dimension defaults,
  Chinese error text and payload callers. Non-power-of-two padding is unchanged.
- #21: image-preview geometry, image-tiles planning and TiledImage lifecycle moved
  into separate framework subpaths. App retains ManagedCache provider, the two
  native full-resolution thresholds, applyExif:false/rgb565:true and error text.
  Four-decode/four-delete concurrency, busy retry, halo, sampled upload, source
  lease lifetime, overview, cancellation and callback order are retained.
- #23: SerialWriteQueue, TextHistory, AutoScrollController and generic DraftAutosave
  moved to async/editing/navigation. App retains note fields and identity, newline
  normalization, 200/500 history preset, 600ms autosave preset and business callers.
- #15: restorable-input owns epoch, pending, dismiss, active-owner and late-result
  coordination on top of existing host APIs. Route IDs/key prefix and error copy
  remain app-owned. No host/native persistence or takeover code changed.

#22 ManagedCache is intentionally deferred: directory namespace validation,
producer pins, download deduplication and maintenance require a separate extraction
with policy callbacks. No claim that existing source-provider wiring migrates it.
The 25-group status table is updated for the four completed groups only.

## Frozen oracle

`tests/fixtures/upstream-u7` contains exact `git show da18c00:src/<path>` copies;
14 original files have SHA-256 entries in `sha256.json`. Context-only snapshots and
components with app imports use `.txt` suffixes. The isolated loader resolves app
boundary imports without rewriting the frozen files. Original existing tests and
assertions were not modified.

Differentials cover QR pixel bytes/error strings and texture/tree/padding/cleanup,
180 geometry/threshold/halo cases, 1000 edit sequences, invalid scroll inputs,
write rejection/tail ordering, slow saves with newer edits and normalized responses,
errors, tiled decode limit/sample uploads/busy-delete retry/late lease release,
and restored input with stale epoch, disposal, missing input and callback failure.

## Verification

- App `bun run test`: 1242 pass, 0 fail, 211 files (123224 assertions).
- App final `bun test tests/upstream-u7.test.ts tests/upstream-u7-components.test.ts`:
  7 pass, 0 fail, 4084 outer assertions. The isolated subprocess adds 3 passing
  component scenarios / 20 assertions using `bun --conditions=browser test`.
- App `bun run typecheck`: exit 0. Initial nominal oracle-constructor annotations
  were corrected to structural public interfaces; no test intent changed.
- Framework `bun run test`: exit 0, including browser/native-host tests and Rust
  105 pass / 4 ignored. After QR option separation and primitive autosave support,
  affected final framework contracts: 7 pass / 32797 assertions; app differential
  rerun remained green. Framework `bun x tsc --noEmit`: exit 0.
- Explicit framework style/target plus U7 contracts: 13 pass before the additional
  primitive autosave contract; style/target portion 7 pass. Both diff checks clean.
- Required main CLI and own wt-impl CLI `build --target=android-watch
  --project=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-impl`: exit 0;
  99 pak entries / 69,473,376 bytes; bytecode 1,647,470 bytes. 577 style records.
  No APK created. Logs: app `.codex-tmp/wrss-u7-*.log`, framework `.codex-tmp/u7-*.log`.

## Remaining acceptance

No device/ADB operations. Device acceptance is PENDING. The device owner should
use the protected upgrade flow and first compare home dimensions with the density-2
reference, then check both QR profiles, non-power-of-two QR clipping/scannability,
image preview pinch/pan/back, large-image seams and cancellation/reopen, note undo/
redo/autosave, reader autoscroll/background and input restoration/dismissal across
activity/process recreation. Host tests cannot establish these runtime results.

Preserved limitations: autosave flush requires save results to converge to the
current draft (permanently different normalization does not converge); dispose only
clears scheduled due time. TiledImage expects stable source identity within a mount.
