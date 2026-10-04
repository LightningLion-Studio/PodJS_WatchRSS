# SQL library session integration

`SqlLibrarySessionRepository` now connects the session coordinator to source
merge/export, article reception/deletion, local manifests, authoritative SQL
replacement and durable peer cursors. One instance serializes its session
operations. A required cleanup port receives removed item/channel identities;
real offline media and preview-cache integration still belongs to the main
transport integration work.

Local deletion journal pages are converted and consumed atomically before a
remote merge. They cannot replay later and undo a subsequent authoritative
remote clock. Snapshot signatures supplement timestamp repair, so changes to
reading progress or read status are recorded even when the article timestamp
has not changed. Revision checks span snapshot collection, signature logging,
and sequence-window selection. Concurrent changes retry preparation up to
three times; persistent mutation fails instead of advertising a mixed window.

Signature writes and retained-identity staging respect the host's 2048-statement
transaction limit. Metadata queries page below its 1000-row query limit. Local
manifest body rows are read individually; a single row exceeding the host's
512 KiB response limit still fails rather than silently truncating its body.
Large inline/chunked RSS rows need further streaming integration.

Authoritative replacement follows native literal `dedupKey` retention and
normalized source URL retention. It removes omitted rows, prunes saved/source
states, and resets logs/cursors/fingerprints in one guarded SQL transaction.
Room may retain a dangling saved-state item reference after a channel cascade;
PodJS nulls that reference through its foreign key. The fixtures explicitly
compare both as resolving to no local item, without claiming identical internal
references. Media cleanup is tested only as an identity callback, not as actual
file removal or playback acceptance.

The main service now records an exportable source tombstone and change-log entry
in the same transaction as local channel removal. It also exposes committed
SQLite transaction counts to the data layer. The full repository adapter is
verified in the isolated device harness; the main phone-sync entry and radio
transport are still pending.

## Android-only query bug found during integration

The first two device runs passed the 29 source/deletion cases but failed the
same-clock reading delta. Their captured state showed a new sequence record and
reading progress 0.75 in the full manifest, while the delta was empty. The host
used `rawQuery(String[])`, converting numeric parameters to SQLite TEXT. The
aggregate predicate `HAVING MIN(seq)>?` consequently rejected the row.

The host now binds original JSON scalar types through `rawQueryWithFactory`.
The final device run verifies integer, real, text and null parameter types and
the numeric aggregate comparison, then verifies that the reading edit is sent.
The failure capture is retained at `artifacts/adapter-device-query-failure.json`.

## Verification

- Native replacement instrumentation: six actual production repository cases,
  isolated Room databases in the reference app; passed in 2.119 seconds.
- Native fixture corpus: 16 source, 13 deletion, six replacement cases.
- New adapter unit suite: 14 tests, including concurrent sequence capture,
  post-window edits, journal restart/rollback, replacement rollback, 1200
  signatures and native replacement outcomes.
- Application unit suite: 369 tests / 46385 assertions passed. TypeScript passed.
- Framework suite: 57 tests / 325 assertions passed.
- PodJS Android harness: all 35 native fixture cases and the adapter checks
  passed through the actual host URI, body codec and SQLite services in
  41728 ms. This is whole-suite elapsed time, not sync throughput or latency.
- Main CLI build and Android packaging are recorded separately from harness
  evidence. Deployment/data-preservation results are in the adapter receipt.

Remaining: real Bluetooth/IP connection and main sync UI, complete media/cache
side effects, nonchunked/unsolicited-body modes, oversized inline RSS streaming,
and final physical interaction/visual acceptance. This increment does not mark
the overall migration complete.

## Main deployment

The main APK was rebuilt and installed after the passing device run. Before
installation the stopped app was archived (172 files, 23 existing tables).
After installation and initialization, every existing table's columns, row
count and canonical row hash matched, and every existing non-database file hash
matched. Seven schema tables were added, including SQLite's sequence table.
The preexisting content tables were empty; this comparison proves preservation
of the actual files/identity present, not a populated-library migration test.

The main process started with no fatal/script errors in the captured process
log. A system charging-duration warning covers the display, so the captured
screen is not evidence of the main UI and visual acceptance remains pending.
The app was reopened after the stopped post-deployment archive was collected.
