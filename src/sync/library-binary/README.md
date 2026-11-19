# Library Binary v2, S2

The RFCOMM product entry is `BinaryApplicationService` →
`LibraryBinaryConnection` → `BinaryConnection` / `BinaryByteTransport`.
`RfcommLibraryListener` uses S1 `readBytes` / `writeBytes`. The locked framework
supplies raw file reads/writes and verified native staging; no framework change
is required. `RELEASE_B2_ENABLED=true` is the build default. A local integration
host can inject `b2Enabled` to exercise either setting.

The frozen r3 specification SHA-256 is
`3d1ed2b857be3d599d52221c02c04b2672f80b5b42e9443eaeab844632cad8cb`.
S2 advertises only `noteAsset`, in both directions, with 65536-byte blocks and
one pending DATA frame per direction. The watch advertises bounded local limits:
5 MiB per asset, 512 objects, 256 KiB total manifest and 1 KiB metadata per object.
The negotiated staging cap is no larger than the native cap, with a 32 MiB
journal commitment. Insufficient peak space is STOP, never a v1 retry.

## Connection and routes

An enabled, byte-capable, locally permitted listener advertises B2 only in
response to an explicit version probe. The legacy session validates the stable
peer and waits for successful account synchronization and its applied ACK.
`SwitchGate` validates the echoed capability digest. Its legacy response must
finish writing before `detachStream()` transfers the single reader. No legacy
ACK follows switch. Native reads request exact remaining ranges, including the
prefix; a socket-buffer tail cannot be consumed by the old decoder.

Business requests preceding switch pin the connection to v1. The phone's
pre-write route planner splits assets from the remaining domains and opens a
fresh authenticated connection for B2. Unknown/invalid B2 input, an account
failure or a local/business error stops the owner. There is no post-switch v1
path. IP remains on its existing implementation.

## Persistence and fencing

`BinaryStore` uses private `library_binary_*` tables in the existing business
SQLite database. It never changes the v1 or C-v1 journal schema. Every write
restores FULL and checks `pragma_synchronous` inside the actual transaction.
The connection/epoch guard and request bindings share the business transaction.
`BinaryAssets` publishes immutable native files before writing the business
reference and APPLIED receipt in that transaction. A conflicting local image
retains its canonical path; the received image uses `notes/asset-conflicts`.

Source freeze copies one 64 KiB block at a time, verifies both the source and
spool hashes, and persists the immutable witness and spool paths before offer.
Content-addressed spools are reused across snapshots. Witness comparison uses
field values; a Kotlin JSON field-order change cannot invalidate a frozen source.
Transfer reads only those spools. DATA uses a point descriptor lookup and a
constant-size persistent request-quota update, rather than scanning the journal. Whole-object finalize/hashing uses native
files. DATA never passes through Base64. Manifest roots, page chains and graph
bindings are revalidated on restore. COMPLETE resumes use durable receipts;
CANCELLED resumes cannot write. Cancellation fences both directions before
queuing durable tombstones and closing the raw transport.

Frozen files and journals retain at least 24 hours of recovery state. Bounded
collection retires at most four expired jobs and 64 unreferenced source files per
authenticated connection. Relational snapshot references protect live spools;
there is no dependency on SQLite JSON extensions. Business publications survive
native cleanup. Failed cleanup retains its peak reservation. Bounded journal/peak
accounting refuses new work when retained data consumes the local limit. Rollback must preserve these files and
tables; use a new versionCode with the build switch disabled.

## Timers and recovery

The reader runs independently of the single business writer lane. PLANNING
`missing(limit=0)` reads lightweight committed state and never scans objects,
reserves peak storage or allocates DATA slots. The source probes every eight
seconds using its independent control slot. Its 30-second deadline starts at
actual writer entry. A local-work watchdog uses actual work-unit callbacks;
heartbeat responses do not reset it. Production time samples come from native
`elapsedRealtime`, not wall-clock time.

`RecoveryRules` feeds the foreground listener through `stopAutomaticRecovery`.
Only current-stream I/O failures enter recovery. Partial ACK activity must match
the current epoch and next pending ACK sequence; duplicate ACKs cannot refresh
the idle deadline. A physical error is accounted
once. The three search, rapid-disconnect and no-progress limits retain their
logical state across authenticated reconnections. Semantic progress uses
content object IDs and chunk indexes rather than job IDs. Protocol/account/local
errors stop automatic retry. A deliberate route handoff detaches its interval.

## Checks

Use the task's `flock /tmp/wrss-heavy-<directory>.lock capmem 16G` prefix for
installation, tests, lint, typecheck and package builds; run one command at a time.
`bun test ./tests/library-binary/` includes fixed vectors, 259 legacy frame
comparisons, actual RFCOMM/session integration, native BUSY retry, file/SQLite business receipts,
recovery adapter tests and a baseline full-handshake comparison.
`B2_LEGACY_BASELINE_ROOT` selects a read-only baseline checkout.
`bun scripts/lint-library-binary.ts` checks types and unused symbols for the B2
code and its tests; `bun run typecheck` checks the complete app.

Host tests replace the Android service ports with files, SQLite and in-process
byte pipes. They run the product watch session and byte adapters. They do not
prove Android fsync behavior, device PSS, radio throughput or power-loss recovery.
