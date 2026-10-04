# Bounded sync storage and production repository ports

`readSyncSqlText` fetches text in at most 32768 UTF-8 bytes per row.
A four-byte boundary probe prevents splitting supplementary characters; BLOB
length/substr preserves embedded NULs. Missing/null and empty values remain
distinct. Surrounding repository revision checks reject concurrent edits.
The manifest metadata query no longer selects inline or concatenated bodies;
it hydrates inline, fallback, and original chunks using bounded reads.
Cache publication checks the captured revision inside its transaction instead
of sending the entire old body back as SQL parameters.

`getLibrarySyncRepository` uses the real SQLite instance, Android/Java URI
services, host body codec, immutable content writer, hydration, and reading
migration. Source/article removal and snapshot replacement cancel applicable
refresh and original-content work after a successful database commit. Started
original-content jobs are awaited so their temporary files are cleaned up.
Immutable body files follow native retention behavior. Offline media integration
is still absent.

RSS ingestion now moves a 64000-character chunk boundary back by one when it
would split a UTF-16 surrogate pair. The regression test failed before this
change and passes afterward.

## Current verification

- Application suite: 390 tests, 46512 assertions, zero failures.
- TypeScript and main CLI build passed.
- Bounded SQL tests cover inline, RSS chunks, original chunks, embedded NUL,
  supplementary characters, message-size limits, and a same-length concurrent
  body replacement. Five tests passed.
- Removal tests distinguish committed deletion from failed transactions and
  verify resource cancellation occurs only after successful removal.
- The isolated `tests/runtime-storage` harness calls the actual production
  repository factory with three oversized bodies and checks export, metadata-only
  receive, immutable file publication, replacement and fixture cleanup.
  The device run passed in 800018 ms (about 13 minutes 20 seconds). It exercised
  three texts of about 1.08 MB UTF-8 each, repeated snapshots, metadata-only
  receive and replacement. This is whole-fixture elapsed time, not a transfer
  benchmark. The runtime log shows substantial guest CPU time; acceptable
  large-body sync performance is not established.
- After completion and stopping the isolated process, its database contained
  zero fixture articles/channels/cache/chunks, and its body-file directory was
  empty. No main-library records were used in this fixture.

The main application does not yet instantiate this full repository from a live
Bluetooth/IP session. This increment does not establish phone interoperability,
large-body throughput, physical interaction or visual parity. Historical native
fixture results are documented separately and predate this storage change.

## Device regression and deployment

The separate PodJS oracle harness replayed all 35 captured native cases
(16 sources, 13 deletions, six replacements) and its typed SQL, incremental
reading, rollback and journal checks successfully in 45840 ms. It uses the
current bounded-read implementation. The native Kotlin implementation was not
rerun in this increment; the comparison targets are the existing captures.

The main APK includes the RSS Unicode boundary fix. The long-storage harness
was compiled just before that independent change and seeds its data directly,
so it does not prove that RSS ingestion fix on-device. The new regression test
proves the ingestion behavior on desktop SQLite.

Main data was archived before installation and after initialization while the
app was stopped. The receipt compares all 30 preexisting tables and hashes of
existing non-database files across the 172-file archives. The actual installed
library was empty; populated storage behavior is proven by the separate fixture,
not inferred from this upgrade comparison. Startup process logs contain no
fatal/script exceptions. Main was reopened after the second archive.

See `artifacts/storage-receipt.json` for package identities and exact comparison
results. The currently installed isolated APK is the oracle harness; the storage
APK and its verified historical installed hash are retained separately.
