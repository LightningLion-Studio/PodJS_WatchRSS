# Sync Objects v2 P1 local projection

P1 is an additive, opt-in local module. `watchLocalProjection()` defaults to
`enabled:false`. Import and factory creation perform no I/O. No production
runtime, scheduler, network transport or UI enables the experiment.

An approved existing repo identity must first be installed by
`WatchIdentityStore`. The watch can receive a delivery or recovery capsule; it
cannot create a repo or generate a replacement identity key. The pending request
and complete installed key/pin use one secure-store compare-and-set record.

The caller supplies the existing local metadata reader. Its explicit
`readOnlyProjection` mode does not initialize old caches, scan article bodies,
change the legacy cursor or write business rows. All new app tables have the
`syncv2_` prefix; the framework's transaction guard is `podjs_sql_cas_guard`.
The original library remains authoritative.

Call `open()`, then `beginScan(binding)`. Run one `scanPage(source)` per scheduling
slice, then `catchUpPage(source)` to the fixed R1. Pages atomically commit mappings,
candidates, change-log entries and the checkpoint with the shared state version.
A fresh store resumes the same committed keyset token. `beginTailWindow()` captures
another fixed tail after completion; it does not restart the initial scan.
The change log retains revision/entity/hash markers; current candidates own the
metadata/state payload. Native business changes append locator-only outbox entries in the same SQLite
transaction. They increment exact decimal state/local revisions without converting
them to a JavaScript Number or SQLite signed integer. Content work and encryption
run outside the SQL transaction. Stale state rejects the complete prepared write.

An unmaterializable legacy row or missing tombstone stops its checkpoint. It does
not synthesize a business identity/deletion or discard the original row. The
materializer interface accepts bounded, read-only domain readers.

Rollback calls `store.disable()` to persist the closed trigger gate before the
opt-in caller is removed. Keep the new tables; do not delete the original library,
identity mappings, old cursors, pairing or pending edits. A disabled fresh factory
performs zero SQL, crypto, secure-store or network calls.

`receiveLegacy()` is a shadow encrypted inbox. It returns `ack:false` and never
claims business application. The scope, peer, negotiated version and opaque
cursor identify each input. Duplicate complete input hashes are idempotent.
All unresolved keys remain reachable. No cloud/local choice application is
implemented or enabled in P1.

The strict Capture guard requires exactly five frozen own data properties.
`Reflect.ownKeys` rejects hidden string and Symbol properties. The guard shares a
complete canonical current-account check with capture creation. Historical test
adapters are not product dependencies.

Claude's P1 exception preserves `note_merge_conflicts` and its current semantics.
`DeferredNoteConflictProjection` reserves the future interface. P1 does not call
it or write conflict candidates. Conflict outbox entries retain their original
business table; a subsequent schema-bound P2 migration must project them after the
specification author freezes the wire schema and shared vectors.

Cloud writes, repo-init, segments, rotation, account apply, local_objects, GC and
automatic cleanup remain closed. Candidate metadata/state are local encrypted
preparation values. The framework radix index persists a bounded local candidate inventory. Single
changes rebuild only their radix paths, in the candidate/checkpoint transaction.
These local nodes are not published WRS2 objects or a wire Merkle tree.
Host SQLite tests, child-process exits and the 12,500-record benchmark do not
prove Android/QuickJS bridge throughput, emulator power failure, physical-device
memory budgets or production correctness.
