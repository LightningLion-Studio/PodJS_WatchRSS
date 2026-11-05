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
change the legacy cursor or write business rows. Projection tables have the
`syncv2_` prefix; the framework's transaction guard is `podjs_sql_cas_guard`.
The separate, same-database `business_sync_revision` table is a single tiny
business revision witness. The original library remains authoritative.

Call `open()`, then `beginScan(binding)`. Run one `scanPage(source)` per scheduling
slice, then `catchUpPage(source)` while the checkpoint is in its tail phase.
Pages atomically commit mappings, candidates, change-log entries and the checkpoint
with the shared state version. The change log retains revision/entity/hash markers;
current candidates own the metadata/state payload. Mapping, candidate construction,
content work and encryption all run outside the original business transaction.
A short projection writer fences both stateVersion and the business revision.

Native business triggers only upsert the single `(epoch, revision)` witness.
They do not access projection state, outbox, mappings, candidates, logs or crypto.
A projection failure or exhausted projection counter therefore cannot roll back
an otherwise valid business edit. Genuine business constraints still fail normally.
The witness remains active while projection is disabled. Missing witnesses and
SQLite integer rollover receive a new epoch; revision reads use decimal text.
The projection materializes exact local revision deltas outside the business
transaction. It also persists awaiting-user state there, when required.

Completed checkpoints are reusable only with matching scan binding and business
revision. A global witness has no row locators, so changed revisions conservatively
rescan in bounded pages. Unchanged candidates and radix paths retain their bytes.
A fresh store resumes an in-progress prefix within the same epoch; changes observed
during a pass require another bounded tail pass after the current pass finishes.
Each invocation returns after one page; continuously changing input does not cause
an internal unbounded restart loop. `beginTailWindow()` starts this reconciliation
after a completed scan. The old outbox table is retained without new business
writes or automatic cleanup.

An unmaterializable legacy row or missing tombstone stops its checkpoint. It does
not synthesize a business identity/deletion or discard the original row. The
materializer interface accepts bounded, read-only domain readers.

Rollback can use `await store.disable()` or `await gate.close()`. Closing the gate
immediately blocks the caller and durably clears `syncv2_control.enabled`.
A default-off `initialize()` or factory `open()` also stops an earlier opt-in and
replaces old projection-writing business triggers with witness-only triggers.
A pristine default-off database only gets one read to discover an earlier install;
no schema, identity, crypto, secure-store or network work starts there.
Keep the new tables; do not delete the original library, identity mappings, old
cursors, pairing or pending edits. The business witness continues to track edits.

`receiveLegacy()` is a shadow encrypted inbox. It returns `ack:false` and never
claims business application. The scope, peer, negotiated version and opaque
cursor identify each input. Duplicate complete input hashes are idempotent.
All unresolved keys remain reachable. No cloud/local choice application is
implemented or enabled in P1.

The strict Capture guard requires exactly five frozen, enumerable own data properties.
`Reflect.ownKeys` rejects hidden string and Symbol properties. The guard shares a
complete canonical current-account check with capture creation. Historical test
adapters are not product dependencies.

Claude's P1 exception preserves `note_merge_conflicts` and its current semantics.
`DeferredNoteConflictProjection` reserves the future interface. P1 does not call
it or write conflict candidates. Conflict mutations only advance the business
witness. A subsequent schema-bound P2 migration must project the preserved conflict
rows after the specification author freezes the wire schema and shared vectors.

Cloud writes, repo-init, segments, rotation, account apply, local_objects, GC and
automatic cleanup remain closed. Candidate metadata/state are local encrypted
preparation values. The framework radix index persists a bounded local candidate inventory. Single
changes rebuild only their radix paths, in the candidate/checkpoint transaction.
These local nodes are not published WRS2 objects or a wire Merkle tree.
Host SQLite tests, child-process exits and the 12,500-record benchmark do not
prove Android/QuickJS bridge throughput, emulator power failure, physical-device
memory budgets or production correctness.
