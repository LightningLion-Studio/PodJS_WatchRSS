# Saved-state receive persistence

`src/sync/saved-state.ts` implements the saved-state portion of the native receive merge. It does not start a phone connection or acknowledge a batch. The phone coordinator still needs article selection, stable ID resolution, body/reading-position application, article deletion, media lifecycle, change-log/peer cursor and acknowledgement handling.

The coordinator must initialize a persistent local device identity, resolve an article's native ID, and bind it to an existing SQLite article before applying a normal remote saved state. `initializeDevice(candidateId)` stores the first candidate and returns the persisted identity on subsequent calls. The future host coordinator must supply a newly generated UUID, not reuse a hardware ID, a constant, or the reference app's identity. Main UI initialization does not activate this identity yet.

`remoteStatements` can be appended to the coordinator's article transaction. Timestamp and device ID comparisons occur in the SQLite UPSERT at commit time. The UI projection and sync state commit or roll back together. Completion of `apply` means only that these saved-state statements committed; it is not an article/batch acceptance count and must not trigger a phone ACK by itself.

Normal non-authoritative false states with nonpositive timestamps are ignored. Otherwise, a new state wins when its timestamp is later, or at the same timestamp when its source device ID compares greater using Kotlin UTF-16 ordering. Authoritative mode replaces the state regardless of timestamps. Missing-article tombstones accept only false states and store zero sort order, without modifying saved entries. Normal updates to unbound or deleted articles are skipped. Invalid or unsafe JavaScript numeric values are rejected rather than rounded from Kotlin Long values.

Native sort order is descending; current PodJS UI sort order is ascending. The sync table keeps native sort order, while the UI projection uses its negation. The local repository writes its save change and sync provenance in the same transaction for mapped articles. No-op local saves preserve the existing remote provenance. Unmapped RSS items remain local until the coordinator resolves their native IDs.

The mapping is immutable while its item exists. Deleting the item nulls its mapping and sync pointers but preserves the sync records. This does not itself generate native whole-article deletion state; existing `local_article_deletions` still needs coordinator reconciliation. Binding a recreated item may reuse the surviving identity. Binding seeds pre-existing local save states only when no sync state exists.

## Evidence and limits

`capture-saved-state.py` extracts the two native method bodies verbatim from `DefaultRssRepository.kt`, executes them on the JVM against in-memory DAO and media doubles, and records source and extracted-method hashes. The 144-case corpus covers normal/tombstone modes, authoritative replacement, absent/current state, zero/older/newer/equal timestamps, and ASCII/non-BMP/private-use device IDs. These are actual native method results, not a separately rewritten oracle, but they do not validate Room transactions or media effects.

`tests/sync/saved-state.test.ts` checks those native results with Bun SQLite, plus interleaved local updates, both rollback directions, identity retention, binding constraints and cascades. `tests/runtime-sync-state` runs the same 144 native vectors through production modules on the watch's QuickJS/SQLite host, plus concurrency ordering, rollback, identity retention and cascade/tombstone checks. It uses a separate application ID and no production application data.
