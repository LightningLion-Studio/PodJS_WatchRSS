# Restore progress and one-chunk lookahead

`WatchCloudStatus.restoreProgress` exposes `RestoreProgress` to UI callers. No UI
copy is changed by this patch. `ready=false` means that the complete authenticated
manifest plan is unavailable. Never render zero as a known denominator in that
state. An opaque head also leaves `ready=false`.

The plan is the current head set, scoped by account/backend/epoch/generation and
full versus state-only restore. Its hash and numeric progress live in the existing
v1 journal header's optional `restoreProgress` field. Receipt names, projection
names, journal shards, `SNAPSHOT_RESTORE_VERSION`, and work counters keep their
existing meaning. Old readers ignore the extra header field. New readers rebuild
the counters from the authenticated plan plus v1 receipts; there is no upgrade
reset, historical backfill, or change to an old checkpoint value.

Each phase contains `total`, `done`, `totalBytes`, and `doneBytes`:

| Phase | Unit | Byte definition |
| --- | --- | --- |
| `download` | Distinct ciphertext SHA256 in the selected descriptors and entryRef backing objects, across all target heads | Manifest `ciphertextBytes` |
| `decompress` | Compressed manifested object, completed after its authenticated output is available | Manifest `originalBytes`; verified independent gzip-member output can advance bytes before the object count |
| `apply` | Supported manifested object selected for this restore mode, completed by its durable applied receipt | Manifest `originalBytes` |
| `projection` | Normalized 256 KiB output unit per manifested object, including its final short unit | Manifest `originalBytes` |

Projection done units are the whole 256 KiB equivalents of authenticated output
bytes, plus the final short unit only after the object reaches its declared size.
They do not claim physical file counts or contiguous output positions.

These are logical work-satisfied counters, not network traffic, physical files,
internal archive entries, SQL rows, or elapsed-time estimates. Shared download
hashes count once. Objects on different heads count separately for apply and
projection. EntryRef backing objects participate in output/download work even
when they are not independently selected for apply. Nested archive extraction is
represented conservatively by the parent object's apply completion; its unknown
internal work is never invented from journal receipt counts. Each phase has its
own denominator. Do not add the four percentages or use receipt rate as an ETA.

Existing applied heads/objects satisfy their prerequisite work without requiring
another network transfer. Existing verified output/input receipts can likewise
satisfy source-download work. Unknown partial legacy gzip output does not count
until the output authenticates. Corrupt projections invalidate their completion
as before; a repair can therefore reduce counters. Ordinary interruption/resume
with valid durable data is monotonic. No monotonicity promise hides corruption.

`headsDone` only counts ACK hashes saved in the progress header after
a successful server ACK. These are metadata, not body-work receipts: they do not
increment work or reset the repeated-source guard. An old applied head without
this metadata retries its
idempotent ACK. Failed ACKs never mark completion. A UI completion state requires
`ready && full && headsDone === headsTotal`, as well as all four phases complete.
An empty target set is complete for this snapshot lane only. Public inventory,
records, and outgoing upload are separate sync work.

`restore_progress` is emitted once at the end of each service window, including
early failure windows (`ready=0`). The release sanitizer accepts only its event
name and fixed nonnegative integer fields. It never exports hashes, head IDs,
object names, account scope, arbitrary stage text, or URLs.

## Fetch ordering and memory

The codec may fetch exactly the next chunk while it verifies/decrypts/materializes
the current chunk. The lookahead retains one ciphertext response, at most the
validated 8 MiB descriptor limit, in addition to existing current-object storage.
It starts no speculative plaintext work. Existing object/memo buffers are not
included in that extra one-chunk bound. The production download client checks
ciphertext length/hash; the cache independently checks the hash before storing
it. Such authenticated ciphertext can survive a window ending before AEAD work.
The codec still checks the descriptor/header, AEAD tag, plaintext size/hash, gzip
checks, and optional object hash before publishing decoded/applied receipts.

Account, foreground, lease, and deadline fences run before/after fetch and before
publication. On cancellation/error the codec drains the one in-flight request
before it returns to the lease owner. The current transport has no per-request
abort API: cancellation prevents further work/publication, but cleanup waits for
that bounded host request to finish or time out. A fetched corrupt cache entry is
reloaded once under the existing validation rules.

For writes of at most 1 MiB, index/body/receipt operations share an existing
account read transaction. This reuses an account read under its cross-guest
account lease. Per-piece cancellation/deadline checks and atomic receipts remain.
Larger legacy writes keep their original checks and do not hold an object-sized
account lease. Keys remain session-local and are zeroed on close. Journal shard
merging and native file publication are unchanged.

## Offline measurement

Run `bun scripts/perf/restore-speed.ts` in this worktree. Set `RESTSPEED_BASE` to a
clean b76c0d3e worktree with equivalent dependencies. Set `RESTSPEED_OUTPUT` to
save JSON. The fixture uses real SHA256/HKDF/AES-256-GCM, two synthetic heads,
1,293 references / 1,109 distinct chunks, and 88,647,085 ciphertext bytes. The
first head shares 184 chunks totaling 63,867,663 bytes; chunk extrema are 533
and 1,048,627 bytes. These match the published aggregate shape, not private data. Its
identity encoding is explicit because the production decrypted manifests were
not supplied. The benchmark injects 2 ms network and source-decrypt latency and
1 ms per account read and lease acquire/release. Three interleaved rounds report
both wall throughput and call counts. It is an offline host-cost experiment, not
a watch/production throughput or ETA measurement.
