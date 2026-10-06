# Sync receive → export clock audit (S1)

Audited 2026-10-06 from application master `02d3983`, in `c/sync-clock`.
Native repositories were read only. No device or production backend was accessed.
This is source and host SQLite evidence, not device synchronization acceptance.

## Native rule and its boundaries

Watch `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/rss/DefaultRssRepository.kt`:

- `applySyncedSaveState` and `applySyncedTombstoneState` store the incoming
  `favoriteChangedAt` / `watchLaterChangedAt` as `SavedSyncStateEntity.changedAt`.
  Ordinary receipt compares the incoming timestamp, then the **immediate sender**
  device ID. It does not replace the received timestamp with `now`.
- `exportSyncedSavedArticlesInternal` and `exportLightweightSavedArticleManifests`
  use `state.changedAt ?: savedEntry.savedAt ?: 0`, separately for each list.
  The save-entry creation time may remain older when an existing save is updated;
  it is not the LWW operation clock. Tombstones also export persisted clocks.
- `exportSyncedIndependentArticles` / `exportSyncedImportedContentArticles` and
  their lightweight equivalents use `toSyncedChannelArticle` /
  `toSyncedChannelArticleManifest`, which set both saved-list clocks to **zero**.
  These active IDs suppress the later tombstone branch. Native watch therefore
  has the same last-list-cancellation hole for standalone/imported articles.

Phone `Android_WatchRSS_Phone/app/src/main/java/com/lightningstudio/watchrss/phone/data/repo/PhoneCompanionRepository.kt`:

- `mergeArticleByLatest` chooses each list's winning flag, timestamp and sort
  order together. It stores the winner's timestamp verbatim, without receipt time.
  Its explicit content-merge conflict action is a separate path using maxima.
- `getArticlesForSync` exports the stored `PhoneArticleEntity`;
  `toSyncManifestEntry` copies its individual saved-list clocks unchanged.
  Body hydration/hash generation does not retimestamp the saved operation.

S1 applies the native **persisted-clock** rule to every PodJS saved-list article
projection, including the native watch branch with the zero-clock hole. This is
an intentional correction of that hole, not a claim of byte-for-byte parity with
those native zero values. Wire version, fields and conflict comparator are unchanged.

## Projection inventory

| State / projection | Receipt and re-export path | Finding / disposition |
| --- | --- | --- |
| Favorite / watch-later, active saved groups | `SyncSavedStateStore.remoteStatements` → `sync_saved_states`; `LocalArticleManifestStore.snapshot` saved groups | Clocks already came from the journal. **Fixed flag/clock inconsistency**: a bound journal cancellation can coexist with a still-saved old RSS alias. Export now uses that bound journal's flag alongside its clock, not the obsolete alias flag. Missing-item tombstones retain native saved-entry semantics. |
| Favorite / watch-later, standalone articles | Same journal; snapshot's `watchrss://phone-imports` branch → `prepareRow` | **Fixed lost clock**: previously omitted saved state after the last list was cleared. Active body rows now export both journal clocks/orders, including cancellation. |
| Favorite / watch-later, imported TXT/EPUB/local content | Same journal; imported-channel branch → `prepareRow` | **Fixed same hole** as standalone. Zero remains valid only when no list operation exists. |
| Favorite / watch-later, ordinary RSS without active saves | Journal/local unsave state → snapshot tombstones | Timestamp already retained. Fixture also covers the transition through a materialized standalone alias and back to RSS. Local aliases remain independently writable; S1 changes the outbound logical state, not their UI rows. |
| Article deletion tombstones | `SyncArticleDeletionStore` → `sync_article_deletions`; snapshot tombstones | `changed_at` survives as `deletedAt` / `independentChangedAt`; saved-list cancellation clocks are retained separately. No receipt→export clock-zero bug found. Missing-item tombstones deliberately do not mutate unrelated extant saved entries, as native fixtures establish. |
| Full article batches / lightweight manifest / deferred body cache | `prepareArticle` or `prepareCachedArticle`; `materializeRequested`; `buildManifestResponse`; `buildChunkedResponseFrames` | All copy the projected individual clocks. Cache materialization checks manifest equality. S1 covers both advertised manifest and serialized/parsed article frames. |
| Cloud state, full relay, background library | `SqlLibrarySessionRepository.cloudSnapshot`; `WatchCloudLibraryAdapter.exportPayloads`; `createBackgroundLibrary` | Foreground and background use the same fixed SQL projection. The adapter strips bodies for state exports, not clocks; its snapshot `exportedAt` is intentionally 0. No separate clock replacement found. Cloud snapshot assertions use local SQLite only. |
| Reading progress / byte position | `SyncArticleReceiver` → `article_reading_state`; `ROW_SELECT` / `cloudReadingStates` | Incoming position time is stored verbatim for a new row; ordinary updates use the existing/incoming max, authoritative receipt can replace it. Export reads `r.changed_at`; no zeroing found for active rows. Native body-change semantics may select a different position while retaining the larger clock. Saved tombstones intentionally carry no reading state. |
| Read/unread boolean | Receiver ORs read unless authoritative; local read action journals the article; manifest/cloud copy `is_read` | No dedicated read/unread LWW clock exists in the native wire. Received read survives receipt→export; ordinary unread cannot undo read. This is not timestamp loss and S1 does not add a clock. |
| Standalone membership / article metadata time | Receiver stores `fetched_at=max(updatedAt,importedAt)` or `now` for absent clocks; standalone export derives independent time/order from `fetched_at` | **Derived-clock limitation, unchanged**: arbitrary independent operation clocks are not stored separately, and can differ on re-export. Native watch also derives these from fetched time. This audit does not claim general independent-state LWW convergence. |
| Active RSS source metadata / placement | `SqlSourceSyncStore.merge` → channel fields; export uses `max(last_fetched_at, logical sort_order, created_at)` | **Derived-clock limitation, unchanged**: a distinct remote `updatedAt` greater than all persisted channel fields is not retained as such. Receipt journals the local derived state; native watch `syncUpdatedAt` / `toSourceSyncState` behave likewise. A source fixture can supply `updatedAt=900, sortOrder=100, createdAt=10` and re-export 100 when no fetch time exists. |
| RSS source deletion | Source merge → `sync_source_states` deleted row; export deleted rows | Incoming positive `updatedAt` / `deletedAt` retained, with native fallback for absent clocks. No zero-clock hole found. Native source deletion handling is unconditional; it is not ordinary article LWW. |
| Memo notes / note tombstones | `parseSyncedNotes` → `MemoRepository.merge`; `allIncludingDeleted` → `syncNotes` | `createdAt`, `updatedAt`, `deletedAt`, `modifiedBy` retained exactly. File-SQLite three-hop tombstone fixture confirms this with default repository clock/ID factory. The native memo conflict rule uses edit baselines, not universal timestamp-only LWW. |
| Reader presets / fonts / backgrounds / deletion history | `parseReaderManifest` → `mergeReaderManifest` → `ReaderPresetStore.mergeManifest` / `exportManifest` | Entity `updatedAt` / `modifiedBy` retained; deletion history `deletedAt` / `deletedBy` retained. No receipt-time stamping found. Deletion-history replacement is native replacement semantics, not a maximum-clock merge. |
| Reader preview / note assets / reader binary resources | Sequence-scoped preview; hash-addressed file chunk receivers | These do not project durable saved-list LWW timestamps. Preview uses session sequence; file verification/commit does not assign entity operation time. |
| Account, diagnostics, token usage, saved-link pulls | Account replacement; diagnostic snapshots; token record mapping; list projection | No bidirectional saved-state LWW clock is defined for these actions. Token/account timestamps describe those records or expiry, not favorite/watch-later conflict order. Saved-link pulls expose only active links by design. |
| Change log / cursors / fingerprints | `reconcileSnapshotLog`; `SqlLibrarySequenceStore` | Change-log `changed_at` derives from entity operation clocks; `created_at` and peer success times are local bookkeeping. They are not substituted for received entity clocks. S1 makes cancellation eligible for downstream manifest selection by retaining its actual list clock. |

## Fix and host regression evidence

`tests/sync/clock-relay.test.ts` creates three real file-backed SQLite databases
in a temporary directory, uses the production `SqlLibrarySessionRepository`
constructor **without injecting `now`**, and encodes/parses native-compatible
manifest and article frames. It does not instantiate a network transport.

Coverage includes both saved lists, independent/imported/RSS sources,
A→B→C and A→B→A, cancel at 4000 after save at 3000, re-save at 5000,
late saves/cancels, both equal-clock delivery orders with native sender tie-break,
a local default-clock cancel/re-save, file reopen, another list remaining active,
active progress/read retention, and memo deletion clocks. Receivers reuse an
instance with a previously cached manifest, so revision invalidation is exercised.
Cloud snapshots are checked alongside outbound frames.

Running the same 12 cases against the unmodified `02d3983` projection produced
**3 pass / 9 fail**. The fixed cases pass. Existing native fixture captures were
not changed; in particular, unbound missing-item tombstone behavior stays intact.
Final `bun run test`: 1188 pass / 0 fail across 186 files.
`bun run typecheck`: exit 0. The required CLI build with
`--project=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-c`: exit 0.
The commit and full command/log locations are in the wrss-c S1 report.

## Convergence limits retained from native

Strictly newer saved operations now retain their original clock through the
covered relays and cannot be overwritten by an older saved operation. The equal
clock tests establish the existing comparator for **received** frames, with
sender ordering and arrival order stated explicitly. They are not proof of
arbitrary equal-clock conflicts converging through every topology:

1. Native active exports stamp the exporting device ID, and receipt resolves
   equal saved clocks using the immediate sender. The wire has one article
   `sourceDeviceId`, not per-list operation origins. Relay hops can therefore
   change tie-break provenance; this task preserves native behavior.
2. Native `LibrarySyncPayload.buildBodyRequestsForRemoteArticles` and PodJS
   `selectArticleBodyRequests` generally select strictly newer clocks. Identical
   body/equal timestamps with conflicting save metadata are not necessarily
   requested merely because a sender ID would win. Equal-clock tests that force
   receipt bypass this selection only where explicitly marked `selected=false`.
3. Active RSS alias UI rows, standalone derived clocks, active RSS source clocks,
   and native memo/reader replacement rules need separate product/protocol
   decisions before claiming universal distributed LWW convergence.

Device validation remains **PENDING**. A device owner should repeat cancel,
re-save, restart and peer relay using isolated test data; host builds do not
prove physical Bluetooth transport, native-peer behavior, or formal user-data
integrity.
