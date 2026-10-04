# Ordinary RSS aliases and incoming synchronized articles

An RSS entry may use a feed GUID as its local deduplication key while the synchronization protocol identifies its URL by a canonical hash. Incoming metadata-only updates must resolve the original saved RSS body before inserting a canonical synchronized row. Native Room creates that new row and retains the original RSS row and its saved entries. Favorite and watch-later state bindings move independently only when each incoming state wins.

`LocalArticleManifestStore.resolveIncomingBody` follows native saved-state item bindings, then native source/dedup fallbacks. Description-only text does not qualify as stored body for metadata-only reuse. `SyncArticleReceiver` verifies the body before committing the canonical row, aliases, anchor promotion, saved projection and reading state in one transaction. The immutable alias table permits several local items per canonical article; ordinary binding still cannot replace an established anchor. Controlled promotion requires matching aliases and a canonical destination.

Saved-entry creation time is now stored separately from the latest state operation clock. Repeated active remote saves preserve native creation time. Main-app save actions prepare a URL alias and journal the operation atomically. A persistent cryptographic UUID is initialized once, retaining an existing identity. Schema changes and backfills run in one database transaction.

## Evidence

The unmodified native production repository was invoked with 14 Room cases through `AliasReceiveReferenceTest`: newer/older and independent state winners, equal-clock device ordering, unsaves, zero clocks, authoritative state, absent stored body, corrupt hash, absent state, and full-body fallback. Captured item rows, saved-entry creation times and per-type bindings are compared exactly by both Bun tests and the isolated QuickJS harness.

The application suite passed 294 tests / 45,967 assertions; TypeScript checking passed. The hand-held device harness passed all 14 native cases plus transaction rollback, binding protection, stable UUID, first local-save journaling, ordinary RSS metadata-only receive and subsequent old-alias writes. Whole-harness elapsed time was 13,095 ms; this is not a synchronization benchmark.

Artifacts: `alias-device-kv.json`, `reference-alias-receive-device.json`, `alias-all-unit.log`, `alias-typecheck.log`. `alias-receipt.json` records final package identity and cleanup; `alias-data-verification.json` records the main upgrade audit. Populated old-schema upgrade/rollback is covered in automated tests; the installed main database contained no articles before this upgrade.

## Remaining scope

This closes the ordinary-RSS alias gap described in `sync-local-manifest.md` for the captured native cases. The full phone transport/session controller, incoming deletion orchestration, source synchronization, outgoing wire batches, peer cursor/change sequence and final acknowledgment still require integration and end-to-end evidence. Native applied-count reporting is not yet reproduced by the article receiver. Whole-library memory use, orphan-file collection and final physical UI acceptance remain unqualified.
