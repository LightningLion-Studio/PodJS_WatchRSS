# Reader preset synchronization

The shared RFCOMM/IP application dispatcher now implements native `syncReader` phases: `manifest`, `pushResource` and `pullResource`. Live `previewReader` support was subsequently deployed; see [reader-preview.md](reader-preview.md). Local font and background rendering now have bounded evidence in [reader-fonts.md](reader-fonts.md) and [reader-backgrounds.md](reader-backgrounds.md).

## Manifest and local state

The manifest retains native preset envelopes (`payloadJson` plus entity metadata), font/background metadata and deletion history. It validates all incoming records before changing storage. Newer timestamps win; at equal timestamps a tombstone wins over a live entity, then `modifiedBy` breaks ties. Font/background SHA uniqueness and deletion-history replacement match the native DAO's `REPLACE` behavior. A deletion-history entry alone does not delete an entity. Empty exchanges retain the legacy KV representation byte for byte.

Existing local payload records are exported as wire envelopes without rewriting them during read-only exchange. A changed manifest saves the merged records and resource metadata together while preserving theme selection and schedule. Rendering filters entity tombstones before decoding their payload. A scoped change listener reloads the current UI's preset state and is removed when the UI owner is disposed.

## Resource transfer

Font, background and watch variant resources use the native 1 MiB chunks and 512 MiB resource ceiling. Paths remain within `reader_assets/fonts`, `reader_assets/backgrounds` and `reader_assets/variants`. Each chunk and completed file is hash checked. The signature sidecar records expected hash, size and chunk count; duplicate chunks can be acknowledged, changed transfers restart from the first chunk, noncontiguous/conflicting chunks fail, and interrupted partial chunks retain their prefix before retry. The target remains intact until validated commit.

The portable host adapter streams reads and writes in 64 KiB operations. For interrupted partial-chunk truncation, it copies the retained prefix to a temporary file and atomically commits it using the existing file API; no new native SDK operation was introduced. Pull responses return the requested range, hash, total size and native chunk count. Missing-resource reporting includes live fonts, background masters and `watch`/`watchPoster` variants.

## Verification, 2026-09-14

- All 459 application tests and typecheck/build passed. Tests cover atomic validation, legacy state preservation, selection retention, timestamp/tombstone/device conflicts, unique hashes, deletion history, missing resources, retries, invalid paths and complete pull responses.
- Desktop JVM comparison executes the native wire and resource code plus the original conflict predicates: 4 parsing cases, 64 conflict combinations and 5 transfer steps. Android's JSON sources are used with annotations removed; Android Context is replaced by a temporary `filesDir`. The native Room merge is not executed by this oracle.
- An isolated PodJS package on the physical watch passed a 1,048,583-byte resource roundtrip, duplicate chunks, an interrupted second chunk, preserved old target, final hash, selected 23sp preset and actual KV/file persistence. It completed in 43,641 ms; this is a functional fixture, not a throughput benchmark. Its resource is deterministic binary test data, not a renderable font. The initial fixture selected the light preset while the theme was dark; the assertion correctly failed. The fixture was corrected to select the dark preset before rerunning.
- Main APK `b174feda77606f0de50e9859fe4862f61df799a3becc6f731a0494f169874242` is installed and resumed. An authenticated physical-phone session read the existing two preset records, made three token-usage requests and two library probes, then completed normally. The session used a labelled temporary ADB relay and proves read-only manifest transport, not resource phone transport or real wireless operation.
- The stopped comparison preserves all 30 application tables and 188 non-database files, including preset KV state. Only WorkManager's `Preference.last_force_stop_ms` changed; its other eight tables match. Main location permissions and disabled Wi-Fi are unchanged. Both network observers returned after initialization. The temporary watch fixture, phone test package and relay rules were removed; pre-existing test packages were left alone.

`artifacts/reader-sync-deployment-receipt.json` binds the source, native comparisons, runtime fixture, installed main APK and preservation evidence. `scripts/verification/collect-reader-sync-receipt.py` checks those relationships. Earlier deployment receipts remain historical.

Live preview/session expiry and local font rendering have subsequent evidence in [reader-preview.md](reader-preview.md) and [reader-fonts.md](reader-fonts.md). Physical-phone resource transfer over bonded Bluetooth now has end-to-end evidence in [reader-resource-transfer.md](reader-resource-transfer.md). Still open: native companion UI acceptance, broader background qualification, normal companion discovery, Wi-Fi transport, and complete visual/interaction acceptance. Resource transfer does not by itself prove that the renderer uses every imported asset.
